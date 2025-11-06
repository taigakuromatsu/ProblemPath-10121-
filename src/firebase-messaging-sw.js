/* eslint-disable no-undef */
// Firebase v10+ 用の Messaging Service Worker
// ※ アプリ本体とは別スコープ（/firebase-cloud-messaging-push-scope）で登録される想定

importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-messaging-compat.js');

// 必要最小限の初期化（Compat）
firebase.initializeApp({
  apiKey: "AIzaSyDgfe0dX1VPD9ggmYc2xbk5OjY3ZmjzVWQ",
  authDomain: "kensyu10121.firebaseapp.com",
  projectId: "kensyu10121",
  storageBucket: "kensyu10121.firebasestorage.app",
  messagingSenderId: "210275340301",
  appId: "1:210275340301:web:6f6d12b2c000bd883a8544",
});

const messaging = firebase.messaging();

/**
 * バックグラウンドメッセージ受信時:
 * - OS通知を1回だけ表示
 * - 開いているタブがあれば内容を postMessage でブリッジ（アプリ内表示用）
 */
messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const title = notification.title || 'ProblemPath';
  const body = notification.body || '';
  const icon = notification.icon || '/assets/icon-192.png';

  // functions 側で設定した webpush.fcmOptions.link が payload から見える場合に拾う
  const fcmLink =
    (payload && payload.fcmOptions && payload.fcmOptions.link) ||
    (payload && payload.data && payload.data.link) ||
    null;

  const options = {
    body,
    icon,
    data: {
      // クリック時に使うために保持
      fcmLink,
      // その他 data もあれば引き継いでおく
      ...(payload && payload.data ? payload.data : {}),
    },
  };

  // ★ OS通知はここで1回だけ
  self.registration.showNotification(title, options);

  // ★ アクティブなクライアント（タブ）があれば、中身をブリッジ（アプリ内通知用）
  self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    if (!clients || clients.length === 0) return;
    clients.forEach((client) => {
      client.postMessage({
        type: 'FCM_BG',
        title,
        body,
        data: options.data || null,
      });
    });
  });
});

/**
 * 通知クリック時:
 * - 既存タブがあればフォーカス
 * - なければリンクを開く
 * - link は functions 側の webpush.fcmOptions.link / data.link / デフォルトURLの順で決定
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl =
    data.fcmLink ||
    data.link ||
    'https://kensyu10121.web.app/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      // 既に対象URL(または同一オリジン)のタブがあればそれをフォーカス
      const urlObj = new URL(targetUrl, self.location.origin);
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === urlObj.origin) {
            await client.focus();
            return;
          }
        } catch (_) {}
      }

      // なければ新規タブで開く
      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});

