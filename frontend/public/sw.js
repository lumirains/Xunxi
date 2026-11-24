/* ============================================================
   Xunxi PWA Service Worker（P4，night-plan-pwa §1 策略逐条手写实现）
   作用域 /（public/ 直拷 dist 根）。手写极简，不引 workbox（纪律 #6）。

   runtime 策略：
   · 导航请求（document）：network-first + cache 回退——离线可开上次页面；
     成功响应按请求 URL 暖缓存（不 precache 具体资产：构建 hash 不可预知，
     首次访问即暖缓存）。
   · /assets/*（Vite hash 文件名 = immutable 语义）：cache-first。
   · /api/*（含 SSE /api/events 与媒体 /api/media/:id）：永不缓存、不经手
     ——刻意不做离线消息队列（白皮书 §8）；POST /api/web/send 等非 GET
     一律放行给网络。
   · 其余同源静态（index.html 的 favicon/manifest 引用等）：不拦截不改写，
     保持服务器响应头语义（manifest/icons 保持 no-cache，如实反映现网）。
   ============================================================ */

const CACHE = 'xunxi-pwa-v1';

self.addEventListener('install', () => {
  // 不 precache：安装零网络零等待，新 SW 立即可激活。
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 清理旧版本缓存（CACHE 名升级时）；接管未受控页面。
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // 发送/上传等一切非 GET 永不经手
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨源不经手

  if (url.pathname.startsWith('/api/')) return; // API 与 SSE 永不缓存

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNav(req));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
  }
  // 其余同源 GET（/manifest.webmanifest、/icons/*、/favicon.svg、/sw.js …）：
  // 不 respondWith = 浏览器直连。sw.js 自身因此不被自己缓存，更新检查照常。
});

/* 导航：network-first + cache 回退。成功才写缓存（离线错误页/重定向链
   终点照实返回但不污染缓存）。回退链：本 URL（忽略 query）→ 任一已缓存
   导航页（=「开上次页面」）→ 极简离线提示（正常装成 HTML，fetch 失败不
   落到浏览器恐龙页）。 */
async function networkFirstNav(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req.url, fresh.clone());
    return fresh;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    // 本 SW 只暖缓存两类条目：导航页与 /assets/*——非 assets 即导航页，
    // 取其一作「上次页面」（不依赖 Request.mode：字符串 URL 入缓存后键为
    // 默认 mode，按 mode 判导航不可靠）。
    const keys = await cache.keys();
    const last = keys.find((k) => !new URL(k.url).pathname.startsWith('/assets/'));
    if (last) {
      const any = await cache.match(last);
      if (any) return any;
    }
    return new Response(
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">' +
      '<title>Xunxi · 离线</title><p style="font-family:system-ui;padding:24px">离线且无缓存页面，联网后重试。</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  }
}

/* /assets/*：cache-first（hash 文件名内容不可变）。未命中回源并暖缓存。 */
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req.url, fresh.clone());
    return fresh;
  } catch {
    return new Response('', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}
