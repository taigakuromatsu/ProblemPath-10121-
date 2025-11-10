// src/app/services/fcm-tokens.service.ts
import { Injectable, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

function normLang(raw?: string): 'ja' | 'en' {
  const v = (raw || 'ja').toLowerCase();
  if (v.startsWith('en')) return 'en';
  if (v.startsWith('ja')) return 'ja';
  return 'ja';
}

function tokenDocId(token: string): string {
  return 'f-' + token.replace(/[^a-zA-Z0-9_-]/g, '');
}

@Injectable({ providedIn: 'root' })
export class FcmTokensService {
  private fs = inject(Firestore);
  private translate = inject(TranslateService);
  private auth = inject(AuthService);

  /** 現在のアプリ言語（ngx-translate設定を優先） */
  private currentLang(): 'ja' | 'en' {
    return normLang(this.translate.currentLang || (navigator as any).language);
  }

  /**
   * 通知ON時：トークン取得→ users/{uid}/fcmTokens/{doc} に言語付きで upsert
   *  - MessagingService と同じ FCM SW ( /firebase-cloud-messaging-push-scope ) を使う
   */
  async ensureRegistered(): Promise<string | null> {
    try {
      if (!(await isSupported())) return null;

      const messaging = getMessaging();
      const opts: Parameters<typeof getToken>[1] = {};

      // VAPID
      const vapidKey =
        (environment as any)?.messaging?.vapidKey ??
        (environment as any)?.firebase?.vapidKey ??
        (environment as any)?.vapidKey ??
        undefined;
      if (vapidKey) (opts as any).vapidKey = vapidKey;

      // ★ MessagingService と同じ SW registration を優先的に利用
      try {
        const swReg = await this.getFcmSwRegistration();
        if (swReg) (opts as any).serviceWorkerRegistration = swReg;
      } catch {
        // 取れなくても致命的ではないので握りつぶす
      }

      const token = await getToken(
        messaging,
        Object.keys(opts).length ? opts : undefined,
      );
      if (!token) return null;

      const uid = await firstValueFrom(this.auth.uid$);
      if (!uid) return null;

      const id = tokenDocId(token);
      const ref = doc(this.fs as any, `users/${uid}/fcmTokens/${id}`);

      await setDoc(
        ref,
        {
          token,
          language: this.currentLang(),
          platform: (navigator as any).platform || 'web',
          userAgent: navigator.userAgent,
          createdAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
        },
        { merge: true },
      );

      return token;
    } catch (e) {
      console.error('[FCM] ensureRegistered failed', e);
      return null;
    }
  }

  /** 言語切替時：このユーザーの fcmTokens 全件の language を一括更新 */
  async updateLanguageForAllMyTokens(langRaw?: string): Promise<void> {
    const lang = normLang(langRaw || this.currentLang());
    const uid = await firstValueFrom(this.auth.uid$);
    if (!uid) return;

    const col = collection(this.fs as any, `users/${uid}/fcmTokens`);
    const snap = await getDocs(col);
    if (snap.empty) return;

    await Promise.all(
      snap.docs.map((d) =>
        updateDoc(d.ref, {
          language: lang,
          lastSeenAt: serverTimestamp(),
        }),
      ),
    );
  }

  /** MessagingService と共通化: FCM 用 SW registration を取得 */
  private async getFcmSwRegistration(): Promise<ServiceWorkerRegistration | null> {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
      return null;
    }

    // main.ts で登録している scope と一致させる
    const reg = await navigator.serviceWorker.getRegistration(
      '/firebase-cloud-messaging-push-scope',
    );
    return reg || null;
  }
}


