// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { provideAnimations } from '@angular/platform-browser/animations';

import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';           // ← DI は AngularFire 経由でOK
import { provideStorage, getStorage } from '@angular/fire/storage';
import { provideServiceWorker } from '@angular/service-worker';
import { APP_INITIALIZER } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

import {
  provideAppCheck,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken as getAppCheckToken,
} from '@angular/fire/app-check';

import {
  // ★ Auth の“本体”初期化は firebase/auth から直接 import する
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
} from 'firebase/auth';

import { environment } from './environments/environment';

// === ローカル用 App Check デバッグトークン ===
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if (isLocal) {
  (window as any).FIREBASE_APPCHECK_DEBUG_TOKEN = 'BB6EB0CC-9784-4B6B-B11C-82FED1FDCDA8';
}

// === FCM SW（ngsw と別スコープ） ===
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' })
    .then(reg => console.log('[FCM SW] registered:', reg.scope))
    .catch(err => console.error('[FCM SW] register error', err));
}

bootstrapApplication(App, {
  ...appConfig,
  providers: [
    ...(appConfig.providers ?? []),

    provideServiceWorker('ngsw-worker.js', { enabled: environment.production }),

    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [SwUpdate],
      useFactory: (sw: SwUpdate) => () => {
        if (!sw.isEnabled) return;
        sw.versionUpdates.subscribe(() => {
          if (confirm('新しいバージョンがあります。ページを更新しますか？')) location.reload();
        });
      },
    },

    provideFirebaseApp(() => initializeApp(environment.firebase)),

    // App Check（siteKey があれば）
    ...(() => {
      const siteKey = (environment as any).appCheck?.siteKey as string | undefined;
      if (!siteKey) { console.warn('[AppCheck] siteKey 未設定。スキップ'); return []; }
      return [
        provideAppCheck(() => {
          const appCheck = initializeAppCheck(getApp(), {
            provider: new ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true,
          });
          getAppCheckToken(appCheck, true).catch(() => {});
          return appCheck;
        }),
      ];
    })(),

    provideFirestore(() => getFirestore(getApp())),
    provideStorage(() => getStorage(getApp())),

    // ★★★ 重要：Auth を initializeAuth で明示初期化し、resolver を渡す ★★★
    provideAuth(() => {
      const app = getApp();
      try {
        return initializeAuth(app, {
          persistence: [indexedDBLocalPersistence, browserLocalPersistence],
          popupRedirectResolver: browserPopupRedirectResolver, // ← これが無いと auth/argument-error
        });
      } catch {
        // 既に初期化済みなら既存を返す
        return getAuth(app);
      }
    }),

    provideAnimations(),
  ],
}).catch(console.error);

// DevTools からトークン確認用
import { getAuth as _getAuth } from '@angular/fire/auth';
(globalThis as any).ppGetToken = async () => {
  const auth = _getAuth();
  const u = auth.currentUser || await new Promise<any>(r => {
    const off = auth.onAuthStateChanged(x => { off(); r(x); });
  });
  if (!u) { console.warn('No currentUser'); return null; }
  const t = await u.getIdToken(true);
  console.log('ID_TOKEN=', t);
  return t;
};


