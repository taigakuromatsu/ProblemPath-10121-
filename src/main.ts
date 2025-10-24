// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { provideAnimations } from '@angular/platform-browser/animations';

import { provideFirebaseApp, initializeApp, getApp } from '@angular/fire/app';
import { provideFirestore, getFirestore } from '@angular/fire/firestore';
import { provideAuth, getAuth } from '@angular/fire/auth';
import { provideStorage, getStorage } from '@angular/fire/storage';

import {
  provideAppCheck,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  getToken as getAppCheckToken,
} from '@angular/fire/app-check';

import { environment } from './environments/environment';

// === 1) ローカル開発時だけ Debug トークン（固定値）を設定 ===
//   ※ Firebase コンソール > App Check > デバッグトークンを管理 に
//      'dev-local-fixed-token-1234' を登録しておくこと。
const isLocal =
  location.hostname === 'localhost' || location.hostname === '127.0.0.1';
if (isLocal) {
  (window as any).FIREBASE_APPCHECK_DEBUG_TOKEN = 'BB6EB0CC-9784-4B6B-B11C-82FED1FDCDA8';
}

// === 2) アプリ起動 ===
bootstrapApplication(App, {
  ...appConfig,
  providers: [
    ...(appConfig.providers ?? []),

    // Firebase App
    provideFirebaseApp(() => initializeApp(environment.firebase)),

    // === 3) App Check（siteKey があるときだけ有効化） ===
    ...(() => {
      const siteKey = (environment as any).appCheck?.siteKey as
        | string
        | undefined;

      if (!siteKey) {
        // siteKey 未設定なら App Check はスキップ（バックエンド側の強制はまだ有効化しない想定）
        console.warn('[AppCheck] siteKey が未設定のためスキップします。');
        return [];
      }

      return [
        provideAppCheck(() => {
          const appCheck = initializeAppCheck(getApp(), {
            provider: new ReCaptchaEnterpriseProvider(siteKey),
            isTokenAutoRefreshEnabled: true,
          });

          // 初回で確実にトークンを取得（メトリクスが「確認済み」に乗りやすくなる）
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
