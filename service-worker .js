// ============================================================
// LAPSE CORE – Service Worker  v5
// ・アプリ本体(index.html等)は「ネットワーク優先」。
//   電波がある限り常に最新版を取得し、取得できたものをキャッシュに保存しておく。
//   オフライン時のみ、直近に取得できたキャッシュ版を表示する（プールサイドの電波対策）。
// ・アイコン等の静的アセットは変化がほぼ無いため「キャッシュ優先」のまま。
// ・status.json（遠隔利用停止フラグ）は、キャッシュを一切使わず必ずネットワークに取りに行く。
//   取れなければ何も返さない（＝呼び出し側でエラー扱いになり、いつも通り使える）。
// ============================================================
const CACHE_NAME  = 'lapsecore-v5';
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
  const isStatusFile = url.indexOf('/status.json') !== -1;
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
