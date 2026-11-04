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

// 네트워크가 이 시간 안에 응답을 시작하지 않으면(반쯤 끊긴 Wi-Fi 등) 마지막으로 받은 버전을 연다
const SLOW_MS = 4000;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 다른 사이트(글꼴 등)와 버전 확인 파일은 그대로 네트워크로
  if (url.origin !== self.location.origin || url.pathname.endsWith('/version.json')) return;
  const nav = req.mode === 'navigate';
  const key = nav ? './' : req;
  // 브라우저 HTTP 캐시에 남은 예전 페이지를 쓰지 않도록 서버에 다시 확인
  const fresh = nav
    ? new Request(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(req, { cache: 'no-cache' });
  let saved = Promise.resolve();
  const net = fetch(fresh).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      saved = caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  });
  // 저장된 버전을 먼저 보여 줬더라도, 늦게 온 새 버전은 끝까지 받아서 저장해 둔다 (다음에 열 때 적용)
  e.waitUntil(net.then(() => saved).catch(() => { }));
  e.respondWith((async () => {
    const cached = await caches.match(key);
    if (!cached) return net; // 처음 여는 경우: 네트워크를 기다림
    let timer;
    const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SLOW_MS); });
    const res = await Promise.race([net.catch(() => null), slow]);
    clearTimeout(timer);
    // 오프라인·응답 없음·서버 오류면 저장된 버전
    return res && res.ok ? res : cached;
  })());
});
