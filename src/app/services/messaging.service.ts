
// src/app/services/messaging.service.ts
import { Injectable, inject } from '@angular/core';
import { Messaging, getToken, onMessage, isSupported } from '@angular/fire/messaging';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { environment } from '../../environments/environment';
import { Observable, Subject } from 'rxjs';

export type FcmNotice = { title?: string; body?: string };

@Injectable({ providedIn: 'root' })
export class MessagingService {
  private messaging = inject(Messaging, { optional: true });
  private fs = inject(Firestore);
  private auth = inject(Auth);

  private fg$ = new Subject<FcmNotice>();
  private listenerStarted = false;

  /** Home等から購読するプロパティ */
  readonly onMessage$: Observable<FcmNotice> = this.fg$.asObservable();

  constructor() {
    // アプリ起動時に一度だけフォアグラウンド受信リスナーを張る
    this.ensureListener();
  }

  /** すでに通知許可が granted の場合だけ、トークンを返す（あれば保存もする） */
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

    await this.saveToken(token);
    return token;
  }

  /** users/{uid}/fcmTokens/{token} に保存（idempotent / merge） */
  private async saveToken(token: string): Promise<void> {
    const u = this.auth.currentUser;
    if (!u) return;
    try {
      const ref = doc(this.fs as any, `users/${u.uid}/fcmTokens/${token}`);
      const existing = await getDoc(ref);
      const platform =
        (navigator as any)?.userAgentData?.platform ?? navigator.platform ?? '';
      const data: Record<string, unknown> = {
        token,
        userAgent: navigator.userAgent || '',
        platform,
        language: navigator.language || '',
        lastSeenAt: serverTimestamp(),
      };
      if (!existing.exists()) {
        data['createdAt'] = serverTimestamp();
      }
      await setDoc(ref, data, { merge: true });
    } catch (e) {
      console.warn('[FCM] saveToken error:', e);
    }
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
