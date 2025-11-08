// src/app/services/messaging.service.ts
import { Injectable, inject, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { Messaging, getToken, onMessage, isSupported } from '@angular/fire/messaging';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc as fsDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { environment } from '../../environments/environment';
import { Observable, Subject } from 'rxjs';

export type FcmNotice = {
  title?: string;
  body?: string;
  /** 受信時刻（epoch ms）。ない場合は表示側で非表示扱いにする想定 */
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

  private fg$ = new Subject<FcmNotice>();
  private listenerStarted = false;
  private savingToken = new Set<string>(); // 多重保存防止

  /** Home等から購読するプロパティ */
  readonly onMessage$: Observable<FcmNotice> = this.fg$.asObservable();

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
  
    // ★ FCM用 SW registration を共通ユーティリティから取得
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
            this.fg$.next(notice); // アプリ内（FG）通知
          });
        
          // OS通知（見落とし防止）
          try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification(title ?? 'ProblemPath', { body });
            }
          } catch {}
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

        // ★ここ重要★:
        // BGでの OS 通知は Service Worker 側が showNotification 済みとみなす。
        // ここではアプリ内（FG）用ストリームに流すだけにして、
        // new Notification() は呼ばない → 二重三重表示を防ぐ。
        this.zone.run(() => {
          this.fg$.next(notice);
        });
      }
    });
  }
}

