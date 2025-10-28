// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { provideAnimations } from '@angular/platform-browser/animations';

import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
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

import { environment } from './environments/environment';

// === 1) ローカル開発時だけ Debug トークン（固定値）を設定 ===
const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if (isLocal) {
  (window as any).FIREBASE_APPCHECK_DEBUG_TOKEN = 'BB6EB0CC-9784-4B6B-B11C-82FED1FDCDA8';
}

// === 1.5) FCM用 SW を ngsw と“別スコープ”で登録（競合回避） ===
//  - ファイルは /firebase-messaging-sw.js（プロジェクトroot or public直下）
//  - スコープは Firebase 推奨の '/firebase-cloud-messaging-push-scope'
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' })
    .then(reg => console.log('[FCM SW] registered:', reg.scope))
    .catch(err => console.error('[FCM SW] register error', err));
}

// === 2) アプリ起動 ===
bootstrapApplication(App, {
  ...appConfig,
  providers: [
    ...(appConfig.providers ?? []),

    // Angular の PWA SW（ngsw）は production のときだけ有効化
    provideServiceWorker('ngsw-worker.js', { enabled: environment.production }),

    // 新バージョン検知 → リロード案内（簡易）
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [SwUpdate],
      useFactory: (sw: SwUpdate) => () => {
        if (!sw.isEnabled) return;
        sw.versionUpdates.subscribe(() => {
          if (confirm('新しいバージョンがあります。ページを更新しますか？')) {
            location.reload();
          }
        });
      },
    },

    // Firebase App
    provideFirebaseApp(() => initializeApp(environment.firebase)),

    // App Check（siteKey があれば有効化）
    ...(() => {
      const siteKey = (environment as any).appCheck?.siteKey as string | undefined;
      if (!siteKey) {
        console.warn('[AppCheck] siteKey 未設定のためスキップします。');
        return [];
      }
      return [
        provideAppCheck(() => {
          const appCheck = initializeAppCheck(getApp(), {
            provider: new ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true,
          });
          getAppCheckToken(appCheck, /* forceRefresh */ true).catch(() => {});
          return appCheck;
        }),
      ];
    })(),

    // 他の SDK
    provideFirestore(() => getFirestore(getApp())),
    provideAuth(() => getAuth(getApp())),
    provideStorage(() => getStorage(getApp())),

    provideAnimations(),
  ],
}).catch(console.error);

