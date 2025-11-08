/* eslint-disable no-undef */
// Firebase v10+ 用の Messaging Service Worker
// ※ scope: /firebase-cloud-messaging-push-scope 想定

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
 * - 「data-onlyメッセージ」の場合だけ OS 通知をここで表示
 * - FCM が自動表示する notification メッセージの場合は showNotification しない
 * - どの場合も開いているタブには postMessage で橋渡し
 */
messaging.onBackgroundMessage((payload) => {
  const notif = payload.notification || {};
  const data = payload.data || {};

  // notification ペイロードがあれば「FCM側ですでに OS 通知を出す前提」とみなす
  const hasNotificationPayload =
    (typeof notif.title === 'string' && notif.title.length > 0) ||
    (typeof notif.body === 'string' && notif.body.length > 0);

  const title =
    notif.title ||
    data.title ||
    'ProblemPath';

  const body =
    notif.body ||
    data.body ||
    '';

  const icon =
    notif.icon ||
    '/assets/icon-192.png';

  // functions 側の webpush.fcmOptions.link や data.link 相当を拾う（互換的に）
  const fcmLink =
    (payload.fcmOptions && payload.fcmOptions.link) ||
    data.fcmLink ||
    data.link ||
    null;

  const options = {
    body,
    icon,
    data: {
      fcmLink,
      ...data,
    },
  };

  // ★ここが重複対策の肝★
  // notification 付きメッセージの場合は FCM が OS 通知を出すので、
  // ここでは showNotification しない。
  if (!hasNotificationPayload) {
    self.registration.showNotification(title, options);
  }

  // アクティブなクライアント（タブ）があれば、内容をブリッジ（アプリ内表示用）
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

      const urlObj = new URL(targetUrl, self.location.origin);

      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === urlObj.origin) {
            await client.focus();
            return;
          }
        } catch (_) {
          // ignore parse error
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })()
  );
});


