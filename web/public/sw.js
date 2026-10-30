/**
 * Service worker —— 只为「装到桌面」存在，不是离线优先的缓存策略。
 *
 * 这个应用是本机服务端的壳：数据全在 `/api`，断网时缓存下来的界面除了显示
 * 一个空壳之外没有用处。Chromium 系的「安装」入口确实要求有 service worker
 * （带 fetch 处理器），所以这里注册一个最小但诚实的：
 *
 * - `/api` 一律不碰。SSE、快照、会话列表全部直接走网络，任何一层缓存都会让
 *   界面显示已经过时的会话状态，这是比离线更糟的失败。
 * - 导航请求网络优先。服务端一直在本机，正常情况下每次都拿新的 `index.html`；
 *   缓存只在服务端没起来时兜底，免得用户看到浏览器的错误页。
 * - 带指纹的静态资源缓存优先。它们的名字里就有内容哈希，不存在过期问题，
 *   这一条顺带省掉了每次冷启动对同一批 JS/CSS 的重复请求。
 *
 * 版本号进缓存名：换版本时 `activate` 把旧缓存整个删掉，不留半新半旧的混合体。
 */
const VERSION = "v1";
const SHELL_CACHE = `anhe-claude-web-shell-${VERSION}`;
const ASSET_CACHE = `anhe-claude-web-assets-${VERSION}`;

/** 安装后立刻要有的东西：图标与清单一类小文件，失败会让安装判定不成立。 */
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/mark.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/favicon.ico",
];

/** 指纹资源攒太多会白占磁盘；超过这个数就丢最旧的。 */
const ASSET_LIMIT = 60;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 逐个加而不是 `addAll`：`addAll` 有一个 404 就整批失败，那会让整个
      // worker 装不上，连带把「安装到桌面」也一起弄没。
      await Promise.all(
        SHELL.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            // 单个图标缺失不该拖垮安装。
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !keep.has(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** 只接受同源、非 API 的 GET。其余请求原样交给网络。 */
function handled(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return false;
  return true;
}

async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  // `keys()` 按插入顺序返回，最旧的在前面。
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!handled(request)) return;

  // 导航：网络优先，离线才用缓存的壳。
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          // 存的是 `/`，不是带原始 query 的地址：壳对所有路由都是同一份。
          cache.put("/", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await caches.match("/", { cacheName: SHELL_CACHE });
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // 其余静态资源：缓存优先，未命中再取网并留一份。
  event.respondWith(
    (async () => {
      const cached = await caches.match(request, { cacheName: ASSET_CACHE });
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      // 只收干净的 200：`no-cors` 的 opaque 响应存下来也用不上。
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(ASSET_CACHE);
        cache.put(request, response.clone()).catch(() => {});
        void trim(ASSET_CACHE, ASSET_LIMIT);
      }
      return response;
    })(),
  );
});
