import { Injectable, inject, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { Messaging, getToken, onMessage, isSupported } from '@angular/fire/messaging';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc as fsDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { environment } from '../../environments/environment';
import { Observable, Subject, BehaviorSubject } from 'rxjs';

export type FcmNotice = {
  title?: string;
  body?: string;
  /** 受信時刻（epoch ms）。ない場合は push 時に埋める */
  receivedAt?: number;
  /** Functions / SW 側から渡される追加情報（将来用も含む） */
  data?: {
    projectId?: string;
    problemId?: string;
    issueId?: string;
    taskId?: string;
    problemTitle?: string;
    issueTitle?: string;
    taskTitle?: string;
    type?: 'comment' | 'file' | 'due';
    [key: string]: any;
  };
};

@Injectable({ providedIn: 'root' })
export class MessagingService {
  private injector = inject(Injector);
  private zone = inject(NgZone);
  private messaging = inject(Messaging, { optional: true });
  private fs = inject(Firestore);
  private auth = inject(Auth);

  // === 既存: 1件ごとの通知ストリーム（下位互換用） ===
  private fg$ = new Subject<FcmNotice>();
  /** 既存用途向け: 通知1件ずつ流れるストリーム（互換のため残す） */
  readonly onMessage$: Observable<FcmNotice> = this.fg$.asObservable();

  // === 新: 通知センター用ストア ===
  private noticesSubject = new BehaviorSubject<FcmNotice[]>([]);
  /** 通知センター表示用: 直近の通知一覧（新しい順） */
  readonly notices$: Observable<FcmNotice[]> = this.noticesSubject.asObservable();

  private listenerStarted = false;
  private savingToken = new Set<string>(); // 多重保存防止

  private readonly MAX_NOTICES = 20;
  private readonly EXPIRE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24時間

  constructor() {
    // アプリ起動時に一度だけフォアグラウンド受信リスナーを張る
    this.ensureListener();
    // Service Worker からのメッセージリレーをリッスン
    this.setupServiceWorkerMessageListener();
    // 権限がすでに拒否ならUI状態を反映
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        this.updateFcmStatus({ enabled: false, lastError: 'permission:denied' });
      }
    } catch {}
  }

  // 共通の SW registration を取得
  private async getFcmSwRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;

    // main.ts で登録している scope を明示指定
    let reg = await navigator.serviceWorker.getRegistration('/firebase-cloud-messaging-push-scope');
    if (reg) return reg;

    // 念のため未登録環境向けに同じ設定で登録
    reg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
      scope: '/firebase-cloud-messaging-push-scope',
    });
    return reg;
  }

  /** すでに通知許可が granted の場合だけ、トークンを返す（あれば保存もする） */
  async getTokenIfGranted(): Promise<string | null> {
    if (!this.messaging) return null;
    if (typeof Notification === 'undefined') return null;
    if (Notification.permission !== 'granted') return null;

    const isSupportedResult = await runInInjectionContext(this.injector, () => isSupported());
    if (!isSupportedResult) return null;

    const swReg = await this.getFcmSwRegistration();
    if (!swReg) return null;

    try {
      const token = await runInInjectionContext(this.injector, () =>
        getToken(this.messaging!, {
          vapidKey: (environment as any).messaging?.vapidKey,
          serviceWorkerRegistration: swReg,
        })
      );
      if (token) {
        await this.saveToken(token);
        return token;
      }
      return null;
    } catch (e) {
      console.warn('[FCM] getTokenIfGranted error:', e);
      await this.updateFcmStatus({ enabled: false, lastError: String(e) });
      return null;
    }
  }

  /** 通知権限をリクエストし、許可されたらトークンを返す（保存もする） */
  async requestPermissionAndGetToken(): Promise<string> {
    if (!this.messaging) {
      throw new Error('FCM is not supported on this browser.');
    }

    const isSupportedResult = await runInInjectionContext(this.injector, () => isSupported());
    if (!isSupportedResult) {
      throw new Error('FCM is not supported on this browser.');
    }

    if (typeof Notification === 'undefined') {
      throw new Error('Notifications API is not available.');
    }

    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      await this.updateFcmStatus({ enabled: false, lastError: `permission:${perm}` });
      throw new Error(`Permission was not granted: ${perm}`);
    }

    const swReg = await this.getFcmSwRegistration();
    if (!swReg) {
      await this.updateFcmStatus({ enabled: false, lastError: 'sw:none' });
      throw new Error('Failed to get Service Worker registration.');
    }

    let token: string | null = null;
    try {
      token = await runInInjectionContext(this.injector, () =>
        getToken(this.messaging!, {
          vapidKey: (environment as any).messaging?.vapidKey,
          serviceWorkerRegistration: swReg,
        })
      );
    } catch (e: any) {
      console.warn('[FCM] requestPermissionAndGetToken error:', e);
      await this.updateFcmStatus({ enabled: false, lastError: String(e) });
      throw new Error('Failed to acquire FCM token.');
    }

    if (!token) {
      await this.updateFcmStatus({ enabled: false, lastError: 'token:null' });
      throw new Error('Failed to acquire FCM token.');
    }

    await this.saveToken(token);
    return token;
  }

  /** users/{uid}/fcmTokens/{token} に保存（read禁止ルールに合わせて getDoc は使わない） */
  private async saveToken(token: string): Promise<void> {
    if (this.savingToken.has(token)) return; // 多重保存防止

    const u = this.auth.currentUser;
    if (!u) return;

    this.savingToken.add(token);
    try {
      const ref = runInInjectionContext(this.injector, () =>
        fsDoc(this.fs as any, `users/${u.uid}/fcmTokens/${token}`)
      );

      const data: Record<string, unknown> = {
        token,
        userAgent: navigator.userAgent || '',
        platform: (navigator as any)?.userAgentData?.platform ?? navigator.platform ?? '',
        language: navigator.language || '',
        lastSeenAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      };

      await runInInjectionContext(this.injector, () => setDoc(ref, data, { merge: true }));
      await this.updateFcmStatus({ enabled: true, lastError: null });
    } catch (e) {
      console.warn('[FCM] saveToken error:', e);
      await this.updateFcmStatus({ enabled: false, lastError: String(e) });
    } finally {
      this.savingToken.delete(token);
    }
  }

  /** UI用のFCM状態を users/{uid}/fcmStatus/app に保存 */
  private async updateFcmStatus(params: { enabled?: boolean; lastError?: string | null }) {
    const u = this.auth.currentUser;
    if (!u) return;
    const ref = fsDoc(this.fs as any, `users/${u.uid}/fcmStatus/app`);
    const data: any = { lastTokenSavedAt: serverTimestamp() };
    if (typeof params.enabled === 'boolean') data.enabled = params.enabled;
    if (params.lastError !== undefined) data.lastError = params.lastError;
    await runInInjectionContext(this.injector, () => setDoc(ref, data, { merge: true }));
  }

  // === 通知センター内部処理 ===

  /** 通知をセンターに追加し、古いものを整理（兼 下位互換 onMessage$ 発火） */
  private pushNotice(input: FcmNotice): void {
    const now = Date.now();
    const notice: FcmNotice = {
      ...input,
      receivedAt: input.receivedAt || now,
    };

    // 有効期限内の既存のみ残す
    const filtered = this.noticesSubject.value.filter(n => {
      if (!n.receivedAt) return false;
      return now - n.receivedAt <= this.EXPIRE_WINDOW_MS;
    });

    const next = [notice, ...filtered].slice(0, this.MAX_NOTICES);
    this.noticesSubject.next(next);

    // 既存の onMessage$ 利用箇所向けに 1件ストリームも流す
    this.fg$.next(notice);
  }

  /** Home等から: 指定 index の通知を既読扱い（一覧から削除） */
  markAsRead(index: number): void {
    const cur = this.noticesSubject.value.slice();
    if (index < 0 || index >= cur.length) return;
    cur.splice(index, 1);
    this.noticesSubject.next(cur);
  }

  /** Home等から: 通知一覧を全クリア */
  clearAll(): void {
    this.noticesSubject.next([]);
  }

  // --- 内部: onMessage リスナーを一度だけ開始 ---
  private async ensureListener() {
    if (this.listenerStarted) return;
    this.listenerStarted = true;

    try {
      if (!this.messaging) return;

      const isSupportedResult = await runInInjectionContext(this.injector, () => isSupported());
      if (!isSupportedResult) return;

      runInInjectionContext(this.injector, () => {
        onMessage(this.messaging!, (payload: any) => {
          const title = payload?.notification?.title ?? 'ProblemPath';
          const body = payload?.notification?.body ?? '';
          const data = payload?.data || undefined;

          const notice: FcmNotice = {
            title,
            body,
            receivedAt: Date.now(),
            data,
          };

          this.zone.run(() => {
            // アプリ内通知センターに追加
            this.pushNotice(notice);

            // OS通知（見落とし防止）: 既存挙動を維持
            try {
              if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                new Notification(title ?? 'ProblemPath', { body });
              }
            } catch {}
          });
        });
      });
    } catch (e) {
      console.warn('[FCM] onMessage setup error:', e);
    }
  }

  // Service Worker からのメッセージリレーをリッスン（BG→FG橋渡し）
  private setupServiceWorkerMessageListener() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'FCM_BG') {
        const { title, body, data } = event.data;

        const notice: FcmNotice = {
          title,
          body,
          receivedAt: Date.now(),
          data: data || undefined,
        };

        // BG 側で OS 通知は済んでいる前提なので、ここではアプリ内のみ
        this.zone.run(() => {
          this.pushNotice(notice);
        });
      }
    });
  }
}


