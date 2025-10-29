// src/app/services/messaging.service.ts
import { Injectable, inject, Injector, NgZone, runInInjectionContext } from '@angular/core';
import { Messaging, getToken, onMessage, isSupported } from '@angular/fire/messaging';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { environment } from '../../environments/environment';
import { Observable, Subject } from 'rxjs';

export type FcmNotice = { title?: string; body?: string };

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
  }

  /** すでに通知許可が granted の場合だけ、トークンを返す（あれば保存もする） */
  async getTokenIfGranted(): Promise<string | null> {
    if (!this.messaging) return null;
    if (typeof Notification === 'undefined') return null;
    if (Notification.permission !== 'granted') return null;
    
    const isSupportedResult = await runInInjectionContext(this.injector, () => isSupported());
    if (!isSupportedResult) return null;

    const swReg =
      (await navigator.serviceWorker.getRegistration()) ??
      (await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' }));

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
      throw new Error(`Permission was not granted: ${perm}`);
    }

    const swReg =
      (await navigator.serviceWorker.getRegistration()) ??
      (await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' }));

    const token = await runInInjectionContext(this.injector, () =>
      getToken(this.messaging!, {
        vapidKey: (environment as any).messaging?.vapidKey,
        serviceWorkerRegistration: swReg,
      })
    );

    if (!token) throw new Error('Failed to acquire FCM token.');

    await this.saveToken(token);
    return token;
  }

  /** users/{uid}/fcmTokens/{token} に保存（read禁止ルールに合わせて getDoc は使わない） */
  private async saveToken(token: string): Promise<void> {
    // 多重保存防止
    if (this.savingToken.has(token)) {
      return;
    }
    
    const u = this.auth.currentUser;
    if (!u) return;

    this.savingToken.add(token);
    
    try {
      // Injection Context内でFirestore操作を実行
      const ref = runInInjectionContext(this.injector, () => {
        return doc(this.fs as any, `users/${u.uid}/fcmTokens/${token}`);
      });

      const data: Record<string, unknown> = {
        token,
        userAgent: navigator.userAgent || '',
        platform: (navigator as any)?.userAgentData?.platform ?? navigator.platform ?? '',
        language: navigator.language || '',
        lastSeenAt: serverTimestamp(),
      };
      data['createdAt'] = serverTimestamp();

      await runInInjectionContext(this.injector, () => {
        return setDoc(ref, data, { merge: true });
      });
    } catch (e) {
      console.warn('[FCM] saveToken error:', e);
    } finally {
      this.savingToken.delete(token);
    }
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
          const title: string | undefined = payload?.notification?.title ?? 'ProblemPath';
          const body: string | undefined = payload?.notification?.body ?? '';
          
          // NgZone内でObservableに通知
          this.zone.run(() => {
            this.fg$.next({ title, body });
          });

          // OS通知も出す（見落とし防止）
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

  // Service Worker からのメッセージリレーをリッスン
  private setupServiceWorkerMessageListener() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return;
    }

    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'FCM_BG') {
        const { title, body } = event.data;
        // NgZone内でObservableに通知
        this.zone.run(() => {
          this.fg$.next({ title, body });
        });

        // OS通知も出す（見落とし防止）
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(title || 'ProblemPath', { body });
          }
        } catch {}
      }
    });
  }
}

