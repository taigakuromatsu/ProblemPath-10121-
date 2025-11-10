// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { provideAnimations } from '@angular/platform-browser/animations';

import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { provideStorage, getStorage } from '@angular/fire/storage';
import { provideMessaging, getMessaging } from '@angular/fire/messaging';
import { provideFunctions, getFunctions } from '@angular/fire/functions';

import { provideServiceWorker, SwUpdate } from '@angular/service-worker';
import { APP_INITIALIZER } from '@angular/core';

import {
  provideAppCheck,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken as getAppCheckToken,
} from '@angular/fire/app-check';

import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserPopupRedirectResolver,
} from 'firebase/auth';

import { environment } from './environments/environment';

// === ローカル用 App Check デバッグトークン ===
const isLocal =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if (isLocal) {
  (window as any).FIREBASE_APPCHECK_DEBUG_TOKEN =
    'BB6EB0CC-9784-4B6B-B11C-82FED1FDCDA8';
}

// === FCM SW（ngsw と別スコープ） ===
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/firebase-messaging-sw.js', {
      scope: '/firebase-cloud-messaging-push-scope',
    })
    .then((reg) => console.log('[FCM SW] registered:', reg.scope))
    .catch((err) => console.error('[FCM SW] register error', err));
}

bootstrapApplication(App, {
  ...appConfig,
  providers: [
    ...(appConfig.providers ?? []),

    // Angular Service Worker（PWA用）
    provideServiceWorker('ngsw-worker.js', {
      enabled: environment.production,
    }),

    // バージョンアップ検知
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [SwUpdate],
      useFactory: (sw: SwUpdate) => () => {
        if (!sw.isEnabled) return;
        sw.versionUpdates.subscribe(() => {
          if (
            confirm(
              '新しいバージョンがあります。ページを更新しますか？',
            )
          ) {
            location.reload();
          }
        });
      },
    },

    // ===== Firebase App 本体 =====
    provideFirebaseApp(() => initializeApp(environment.firebase)),

    // ===== App Check（siteKey があれば）=====
    ...(() => {
      const siteKey = (environment as any).appCheck?.siteKey as
        | string
        | undefined;
      if (!siteKey) {
        console.warn('[AppCheck] siteKey 未設定。スキップ');
        return [];
      }
      return [
        provideAppCheck(() => {
          const appCheck = initializeAppCheck(getApp(), {
            provider: new ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true,
          });
          // 起動時に一度トークン取っておく（失敗しても無視）
          getAppCheckToken(appCheck, true).catch(() => {});
          return appCheck;
        }),
      ];
    })(),

    // ===== Firebase 各サービス（全部このAppにぶら下げる）=====
    provideMessaging(() => getMessaging()), // ← MessagingService がこれを inject
    provideFunctions(() => getFunctions(getApp(), 'asia-northeast1')),
    provideFirestore(() => getFirestore(getApp())),
    provideStorage(() => getStorage(getApp())),

    // Auth（既存ロジックそのまま）
    provideAuth(() => {
      const app = getApp();
      try {
        return initializeAuth(app, {
          persistence: [
            indexedDBLocalPersistence,
            browserLocalPersistence,
          ],
          popupRedirectResolver: browserPopupRedirectResolver,
        });
      } catch {
        // すでに初期化済みならそれを使う
        return getAuth(app);
      }
    }),

    provideAnimations(),
  ],
}).catch(console.error);

// DevTools 用ヘルパー
import { getAuth as _getAuth } from '@angular/fire/auth';
(globalThis as any).ppGetToken = async () => {
  const auth = _getAuth();
  const u =
    auth.currentUser ||
    (await new Promise<any>((r) => {
      const off = auth.onAuthStateChanged((x) => {
        off();
        r(x);
      });
    }));
  if (!u) {
    console.warn('No currentUser');
    return null;
  }
  const t = await u.getIdToken(true);
  console.log('ID_TOKEN=', t);
  return t;
};


