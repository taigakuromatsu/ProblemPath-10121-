// src/app/services/messaging.service.ts
import { Injectable, inject } from '@angular/core';
import { Messaging, getToken, onMessage, isSupported } from '@angular/fire/messaging';
import { environment } from '../../environments/environment';
import { Observable, Subject } from 'rxjs';

export type FcmNotice = { title?: string; body?: string };

@Injectable({ providedIn: 'root' })
export class MessagingService {
  private messaging = inject(Messaging, { optional: true });

  private fg$ = new Subject<FcmNotice>();
  private listenerStarted = false;

  /** Home等から購読するプロパティ（←関数ではなくプロパティに変更） */
  readonly onMessage$: Observable<FcmNotice> = this.fg$.asObservable();

  constructor() {
    // アプリ起動時に一度だけフォアグラウンド受信リスナーを張る
    // （複数回呼ばれても guard で一回だけ）
    this.ensureListener();
  }

  /** すでに通知許可が granted の場合だけ、トークンを返す（なければ null） */
  async getTokenIfGranted(): Promise<string | null> {
    if (!(await isSupported()) || !this.messaging) return null;
    if (typeof Notification === 'undefined') return null;
    if (Notification.permission !== 'granted') return null;

    const swReg =
      (await navigator.serviceWorker.getRegistration()) ??
      (await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/' }));

    try {
      const token = await getToken(this.messaging, {
        vapidKey: (environment as any).messaging?.vapidKey,
        serviceWorkerRegistration: swReg,
      });
      return token ?? null;
    } catch (e) {
      console.warn('[FCM] getTokenIfGranted error:', e);
      return null;
    }
  }

  /** 通知権限をリクエストし、許可されたらトークンを返す */
  async requestPermissionAndGetToken(): Promise<string> {
    if (!(await isSupported()) || !this.messaging) {
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

    const token = await getToken(this.messaging, {
      vapidKey: (environment as any).messaging?.vapidKey,
      serviceWorkerRegistration: swReg,
    });

    if (!token) throw new Error('Failed to acquire FCM token.');
    return token;
  }

  // --- 内部: onMessage リスナーを一度だけ開始 ---
  private async ensureListener() {
    if (this.listenerStarted) return;
    this.listenerStarted = true;

    try {
      if (!(await isSupported()) || !this.messaging) return;

      onMessage(this.messaging, (payload: any) => {
        const title: string | undefined = payload?.notification?.title ?? 'ProblemPath';
        const body: string | undefined = payload?.notification?.body ?? '';
        this.fg$.next({ title, body });

        // OS通知も出す（見落とし防止）
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification(title ?? 'ProblemPath', { body });
          }
        } catch {}
      });
    } catch (e) {
      console.warn('[FCM] onMessage setup error:', e);
    }
  }
}
