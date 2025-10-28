// src/environments/environment.ts
export const environment = {
  production: false,
  firebase: {
    apiKey: "AIzaSyDgfe0dX1VPD9ggmYc2xbk5OjY3ZmjzVWQ",
    authDomain: "kensyu10121.firebaseapp.com",
    projectId: "kensyu10121",
    //  バケット名に修正（ドメインではなく）
    storageBucket: "kensyu10121.firebasestorage.app",
    messagingSenderId: "210275340301",
    appId: "1:210275340301:web:6f6d12b2c000bd883a8544",
    measurementId: "G-DFR7RTB005"
  },
  messaging: {
    vapidKey: 'BKlCOw8Hi6CgWWXI5lEMbNttzad9-7KicIn4QnaFfqL6uMk3O3N5fnhwNmD6_9oyROxzVvgtM8ScEUh3o_WxL5o'
  },
  // App Check（reCAPTCHA Enterprise）のサイトキー
  appCheck: {
    siteKey: "6LfbAfQrAAAAAC3vk2WxyL2FTZTQ5mkLLZErGEfv",
    debugToken: 'BB6EB0CC-9784-4B6B-B11C-82FED1FDCDA8'
  }
};

  