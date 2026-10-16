/**
 * Service Worker：离线壳
 *
 * 职责：只预缓存「静态壳」（HTML / CSS / JS / manifest 内联图标），让断网时应用外壳仍可打开。
 * 硬性边界：
 *   1) 绝不缓存任何 API 响应（天气 / 空气 / 地名 / 海拔 / 逆地理），业务数据一律走 core/cache.js 的 localStorage 快照；
 *   2) 绝不缓存瓦片字节（瓦片失败一次即切「无地图纯坐标模式」，不重试）；
 *   3) 跨域请求直接放行，不做任何代理或改写。
 *
 * 零依赖：无第三方库、无 CDN、无构建步骤。
 */

/** 预缓存清单：必须与仓库实际文件一一对应，缺一个都会导致 install 失败。 */
const SHELL_CACHE = 'geoscope-shell-v40';

/**
 * 壳资产指纹：SHELL_ASSETS 全部文件内容按清单顺序拼接后的 sha256 前 16 位（CRLF 已规范为 LF）。
 *
 * ★为什么需要它：浏览器只看 sw.js 自身字节判断要不要更新，改了业务文件而 sw.js 没变，
 *   真机会一直用旧壳 —— 而且**没有任何报错**。tools/check.mjs 第 22 节拿它重算比对，
 *   不一致就报红；改完壳资产跑一次 node tools/bump-shell.mjs 即可（本脚本自动维护它）。
 */
const SHELL_FINGERPRINT = '6f76beb9eec1dcda';

const SHELL_ASSETS = [
  './',
  './index.html',
  './selfcheck.html',
  './compass.html',
  './settings.html',
  './compare.html',
  './roadtrip.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './src/ui/app.js',
  './src/ui/now.js',
  './src/ui/selfcheck.js',
  './src/ui/compass.js',
  './src/ui/settings.js',
  './src/ui/compare.js',
  './src/ui/roadtrip.js',
  './src/ui/poilist.js',
  './src/ui/roadmap.js',
  './src/ui/theme.js',
  './src/ui/download.js',
  './src/ui/map.js',
  './src/ui/placesearch.js',
  './src/ui/legend.js',
  './src/i18n/zh.js',
  './src/i18n/en.js',
  './src/i18n/index.js',
  './src/ui/locale.js',
  './src/ui/errtext.js',
  './src/core/http.js',
  './src/core/cache.js',
  './src/core/store.js',
  './src/core/geo.js',
  './src/core/sun.js',
  './src/core/wmo.js',
  './src/core/mag.js',
  './src/core/format.js',
  './src/core/backup.js',
  './src/core/csv.js',
  './src/core/apikeys.js',
  './src/core/roadtrip.js',
  './src/core/tripstore.js',
  './src/data/sources.js',
  './src/data/openmeteo.js',
  './src/data/photon.js',
  './src/data/tiles.js',
  './src/data/health.js',
  './src/data/wmm2025.js',
  './src/data/osrm.js',
  './src/data/amap.js',
  './src/data/roadsources.js',
  './src/data/climate.js',
];

self.addEventListener('install', (event) => {
  // 单个资源失败不阻断安装，避免整站离线壳失效
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // allSettled 保证「一个资源 404 不拖垮整站离线壳」，但它会把失败静默吞掉：
      // 资源不在壳缓存里，断网那一刻才暴露，而现场（哪个 URL 那个原因）已经丢了。
      // 这里只补可观测性 —— 照样不阻断 install、照样继续激活，多打一条 warn。
      const results = await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      const failed = results
        .map((r, i) => (r.status === 'rejected' ? `${SHELL_ASSETS[i]}（${r.reason}）` : ''))
        .filter(Boolean);
      if (failed.length > 0) {
        console.warn('[sw] 壳缓存写入失败：', failed);
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event && event.data === 'skip-waiting') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只处理 GET；非 GET（本应用不产生）直接放行
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 跨域（六路数据源 / 瓦片）：直接放行，不拦截、不缓存
  if (url.origin !== self.location.origin) return;

  // 同源静态资源：cache-first，命中即返回；未命中回源并把成功响应写回壳缓存
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(request, { ignoreSearch: false });
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res && res.ok && res.type === 'basic') {
          cache.put(request, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        // 断网且无缓存：导航请求按**请求的页面**回退对应的静态壳，
        // 否则断网点开 selfcheck.html 会被送回此刻屏（页面与预期不符）。
        if (request.mode === 'navigate') {
          const wanted = url.pathname.endsWith('.html') ? `.${url.pathname}` : './index.html';
          const hit = await cache.match(wanted);
          if (hit) return hit;
          const shell = await cache.match('./index.html');
          if (shell) return shell;
        }
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })()
  );
});
