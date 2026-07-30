// ============================================================
// LAPSE CORE – Service Worker  v7
// ・アプリ本体(index.html等)は「ネットワーク優先」。
//   電波がある限り常に最新版を取得し、取得できたものをキャッシュに保存しておく。
//   オフライン時のみ、直近に取得できたキャッシュ版を表示する（プールサイドの電波対策）。
// ・アイコン等の静的アセットは変化がほぼ無いため「キャッシュ優先」のまま。
// ・status.json（遠隔利用停止フラグ）・cloud-config.json（クラウド機能の遠隔スイッチ）は、
//   キャッシュを一切使わず必ずネットワークに取りに行く。
//   取れなければ何も返さない（＝呼び出し側でエラー扱いになり、いつも通り使える）。
// ・【通知機能】アプリを閉じている間（バックグラウンド）に届いたプッシュ通知を、
//   OSの通知センターに表示する処理を末尾に追加している（index.html側と同じFirebaseプロジェクト設定）。
// ============================================================
const CACHE_NAME  = 'lapsecore-v7';
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
// 【通知機能】アプリを閉じている間（バックグラウンド）に届いた通知を表示する。
// index.htmlで使っているのと同じFirebaseプロジェクトの設定を、ここでも読み込む必要がある
// （Service Workerはindex.htmlの中のJavaScriptとは完全に別の場所で動くため、設定を共有できない）。
// ============================================================
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBQ2I3FlPcjWRSpLyv0M8dHrffc3bDM5RU",
  authDomain: "lapse-core.firebaseapp.com",
  projectId: "lapse-core",
  storageBucket: "lapse-core.firebasestorage.app",
  messagingSenderId: "462036977468",
  appId: "1:462036977468:web:207bdb0685897351848039"
});

const messaging = firebase.messaging();

/** アプリを閉じている間に届いた通知を、スマホ・PCのOSの通知センターに表示する。
 *  通知に紐づくデータ（例：どの記録の通知か）は data として保持しておき、
 *  タップされた時にどの画面へ遷移するか判断するのに使う。 */
messaging.onBackgroundMessage((payload) => {
  const n = (payload && payload.notification) || {};
  const title = n.title || 'LAPSE-CORE';
  self.registration.showNotification(title, {
    body: n.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: (payload && payload.data) || {},
  });
});

/** 通知をタップした時に、対象の画面を開く。
 *  通知データに遷移先（data.url、例：'./?openRecord=xxx'）が入っていればその画面へ、
 *  入っていなければこれまで通りアプリを開くだけ（フォーカスするだけ）にする。
 *  ※ data.url に何を積むか（どの記録を指すID等）は送信側（Cloud Functions）の対応が別途必要。 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath = (event.notification.data && event.notification.data.url) || './';
  const targetUrl = new URL(targetPath, self.location.href).href;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        if ('focus' in c) {
          if (targetPath !== './' && 'navigate' in c) { c.navigate(targetUrl).catch(()=>{}); }
          return c.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
