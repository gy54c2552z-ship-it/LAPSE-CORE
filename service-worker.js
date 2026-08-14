// ============================================================
// LAPSE CORE – Service Worker  v7
// ・アプリ本体(index.html等)は「ネットワーク優先」。
//   電波がある限り常に最新版を取得し、取得できたものをキャッシュに保存しておく。
//   オフライン時のみ、直近に取得できたキャッシュ版を表示する（プールサイドの電波対策）。
// ・アイコン等の静的アセットは変化がほぼ無いため「キャッシュ優先」のまま。
// ・status.json（遠隔利用停止フラグ）・cloud-config.json（クラウド機能の遠隔スイッチ）は、
//   キャッシュを一切使わず必ずネットワークに取りに行く。
//   取れなければ何も返さない（＝呼び出し側でエラー扱いになり、いつも通り使える）。
// ・【v7で追加】アプリを閉じている・バックグラウンドの間にプッシュ通知（Cloud Function
//   notifyOnNewActivity 等が送信）が届いても、今まで受け取って表示する処理が一切無く、
//   通知が画面に出ないことがあった。Firebase Messaging（compat版）をservice worker内でも
//   初期化し、バックグラウンド受信時に通知を表示する処理と、通知タップ時に該当画面へ
//   遷移する処理（notificationclick）を追加した。
//   なお、アプリを開いている間（フォアグラウンド）の通知表示は、index.html側の
//   firebase.messaging().onMessage()で従来通り別途処理している（ここでは扱わない）。
// ============================================================
const CACHE_NAME  = 'lapsecore-v6';
const STATIC_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-120.png',
  './icon-152.png',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});
/** ネットワーク優先：取得できたら常にそれを使い、キャッシュも更新する。失敗時のみキャッシュにフォールバック */
async function networkFirst(request){
  try{
    const fresh = await fetch(request);
    if(fresh && fresh.status === 200 && fresh.type !== 'opaque'){
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, fresh.clone());
    }
    return fresh;
  }catch(e){
    const cached = await caches.match(request);
    if(cached) return cached;
    // ナビゲーション（画面遷移）で完全にオフラインの場合は、最後にキャッシュできたアプリ本体を返す
    return caches.match('./index.html');
  }
}
/** キャッシュ優先：アイコン等、ほぼ更新されない静的アセット向け */
async function cacheFirst(request){
  const cached = await caches.match(request);
  if(cached) return cached;
  const fresh = await fetch(request);
  if(fresh && fresh.status === 200 && fresh.type !== 'opaque'){
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, fresh.clone());
  }
  return fresh;
}
/** ネットワークのみ：status.json専用。キャッシュには一切触れない（読まない・書かない）。
 *  取得できなければそのままエラーを投げ、呼び出し側（index.html）が「確認できなかった」として
 *  普段通りアプリを使わせる仕組みに委ねる。 */
async function networkOnly(request){
  return fetch(request, {cache:'no-store'});
}
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;
  const url = event.request.url;
  const isNavigation = event.request.mode === 'navigate';
  const isAppShell = url.endsWith('/index.html') || url.endsWith('./') ||
                      url.endsWith('/manifest.json') || url.endsWith('/service-worker.js');
  const isStatusFile = url.indexOf('/status.json') !== -1 || url.indexOf('/cloud-config.json') !== -1;
  if (isStatusFile) {
    event.respondWith(networkOnly(event.request));
  } else if (isNavigation || isAppShell) {
    event.respondWith(networkFirst(event.request));
  } else {
    event.respondWith(cacheFirst(event.request));
  }
});
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ============================================================
// 【v7で追加】プッシュ通知（バックグラウンド／アプリを閉じている時）
// ------------------------------------------------------------
// index.html側と同じFirebaseプロジェクトの設定でcompat版SDKを読み込み、
// firebase.messaging().onBackgroundMessage()でプッシュ受信時の表示を行う。
// 通知タップ時は、Cloud Function（notifyOnNewActivity）がdata.urlに積んでくれる
// 遷移先URL（例: './?openRecord=1&name=...&event=...&timeMs=...'）を使って、
// 既に開いているタブがあればそこへ遷移、無ければ新しいタブで開く。
// 読み込み・初期化に失敗しても（オフライン等）、キャッシュ・オフライン機能自体は
// 影響を受けないよう、try/catchで全体を囲む。
// ============================================================
try {
  importScripts(
    'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js'
  );
  firebase.initializeApp({
    apiKey: "AIzaSyBQ2I3FlPcjWRSpLyv0M8dHrffc3bDM5RU",
    authDomain: "lapse-core.firebaseapp.com",
    projectId: "lapse-core",
    storageBucket: "lapse-core.firebasestorage.app",
    messagingSenderId: "462036977468",
    appId: "1:462036977468:web:207bdb0685897351848039"
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const n = (payload && payload.notification) || {};
    self.registration.showNotification(n.title || 'LAPSE-CORE', {
      body: n.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: (payload && payload.data) || {}
    });
  });
} catch (e) {
  // Firebase Messagingの初期化に失敗しても、オフラインキャッシュ機能は通常通り動作させる
  console.warn('[sw] firebase messaging init failed:', e);
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          if ('navigate' in client) { try { client.navigate(url); } catch (e) {} }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
