// 3D 사운드 웹 앱 — 서비스 워커
// 항상 네트워크를 먼저 써서 새 버전이 바로 적용되고, 인터넷이 없을 때만 마지막으로 받은 버전을 연다.
const CACHE = '3dsound-__WEB_BUILD__';
const CORE = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'favicon-48.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('3dsound-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 다른 사이트(글꼴 등)와 버전 확인 파일은 그대로 네트워크로
  if (url.origin !== self.location.origin || url.pathname.endsWith('/version.json')) return;
  e.respondWith((async () => {
    try {
      // 브라우저 HTTP 캐시에 남은 예전 페이지를 쓰지 않도록 서버에 다시 확인
      const fresh = req.mode === 'navigate'
        ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
        : new Request(req, { cache: 'no-cache' });
      const res = await fetch(fresh);
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? './' : req, copy));
      }
      return res;
    } catch (err) {
      const hit = (await caches.match(req)) || (req.mode === 'navigate' ? await caches.match('./') : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});
