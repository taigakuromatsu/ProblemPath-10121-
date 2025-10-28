/* eslint-disable no-undef */
// Firebase v10+ 用の SW。アプリ本体側の Firebase 初期化は不要。
// バックグラウンド通知を受け取ったときの処理。
importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.4/firebase-messaging-compat.js');

// ↓ 必要最小限の初期化（compat を使用）
firebase.initializeApp({
  apiKey: "AIzaSyDgfe0dX1VPD9ggmYc2xbk5OjY3ZmjzVWQ",
  authDomain: "kensyu10121.firebaseapp.com",
  projectId: "kensyu10121",
  storageBucket: "kensyu10121.firebasestorage.app",
  messagingSenderId: "210275340301",
  appId: "1:210275340301:web:6f6d12b2c000bd883a8544",
});

// バックグラウンドメッセージを受信したときの表示（最低限）
const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'ProblemPath';
  const options = {
    body: payload.notification && payload.notification.body,
    icon: '/assets/icon-192.png' // 任意（無ければ削除可）
  };
  self.registration.showNotification(title, options);
});
