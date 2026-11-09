/**
 * Service Worker：离线壳
 *
 * 职责：预缓存「静态壳」（HTML / CSS / JS / manifest 内联图标），并**限量**缓存已成功显示的
 *       ArcGIS 底图瓦片，让断网时应用外壳与上一屏底图仍可打开。
 * 硬性边界：
 *   1) 绝不缓存任何 API 响应（天气 / 空气 / 地名 / 海拔 / 逆地理），业务数据一律走 core/cache.js 的 localStorage 快照；
 *   2) 瓦片只缓存 server.arcgisonline.com 的成功图片，上限 24 张，缓存名随壳版本失效
 *      （残余风险：占位/过期瓦片也可能被存下，靠小上限 + 版本失效兜底，绝不无限增长）；
 *   3) 除上面这条瓦片缓存外，其它跨域请求直接放行，不做任何代理或改写。
 *
 * 零依赖：无第三方库、无 CDN、无构建步骤。
 */

/** 预缓存清单：必须与仓库实际文件一一对应，缺一个都会导致 install 失败。 */
const SHELL_CACHE = 'geoscope-shell-v109';

/**
 * 壳资产指纹：SHELL_ASSETS 全部文件内容按清单顺序拼接后的 sha256 前 16 位（CRLF 已规范为 LF）。
 *
 * ★为什么需要它：浏览器只看 sw.js 自身字节判断要不要更新，改了业务文件而 sw.js 没变，
 *   真机会一直用旧壳 —— 而且**没有任何报错**。tools/check.mjs 第 22 节拿它重算比对，
 *   不一致就报红；改完壳资产跑一次 node tools/bump-shell.mjs 即可（本脚本自动维护它）。
 */
const SHELL_FINGERPRINT = '40c1208f5dbbd76a';

/** 瓦片缓存名：由壳版本派生，壳一升版旧瓦片缓存就在 activate 里被清掉。 */
const TILE_CACHE = SHELL_CACHE.replace('shell', 'tiles');
/** 只缓存这一台底图主机（与 src/data/tiles.js 的 TILE_BASE 同源）。 */
const TILE_HOST = 'server.arcgisonline.com';
/** 上限 24 张：够铺满一屏即可，不让离线缓存无限增长。 */
const TILE_LIMIT = 24;

const SHELL_ASSETS = [
  './',
  './index.html',
  './selfcheck.html',
  './compass.html',
  './settings.html',
  './compare.html',
  './manifest.webmanifest',
  // 图标（tools/make-icons.mjs 生成）：离线时安装横幅 / 桌面图标也得拿得到
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './styles/tokens.css',
  './styles/app.css',
  './src/ui/app.js',
  './src/ui/now.js',
  './src/ui/selfcheck.js',
  './src/ui/compass.js',
  './src/ui/settings.js',
  './src/ui/compare.js',
  './src/ui/theme.js',
  './src/ui/download.js',
  './src/ui/map.js',
  './src/ui/placesearch.js',
  './src/ui/legend.js',
  './src/ui/install.js',
  './src/ui/defaultplace.js',
  './src/ui/pull.js',
  './src/ui/shellupdate.js',
  './src/i18n/zh.js',
  './src/i18n/en.js',
  './src/i18n/index.js',
  './src/ui/locale.js',
  './src/ui/errtext.js',
  './src/core/http.js',
  './src/core/cache.js',
  './src/core/store.js',
  './src/core/geo.js',
  './src/core/zhvariant.js',
  './src/core/sun.js',
  './src/core/wmo.js',
  './src/core/mag.js',
  './src/core/format.js',
  './src/core/backup.js',
  './src/core/csv.js',
  './src/core/pinyin.js',
  // 二十四山表：地理页 compass.js 的静态依赖，断网打开地理页也要能加载
  './src/core/shan24.js',
  // 分享海报绘制：气候页 now.js 的静态依赖（在地候单文件诊断产物的闭包内）
  './src/core/poster.js',
  './src/data/sources.js',
  './src/data/openmeteo.js',
  './src/data/photon.js',
  './src/data/tiles.js',
  './src/data/health.js',
  './src/data/wmm2025.js',
  './src/data/climate.js',
  // 地名搜索别名表：v99 起唯一的别名数据源（原 search-alias.json 已删除，
  // 与 JS 内置表双份维护必然漂移，且离线时 JSON 拿不到会走另一套别名）
  './src/data/search-alias.js',
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
      // 保留当前壳与当前版本的瓦片缓存；旧版本 / 无关缓存一律删除
      const keep = [SHELL_CACHE, TILE_CACHE];
      await Promise.all(names.filter((n) => keep.indexOf(n) === -1).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/**
 * 页面 → SW 的消息通道。
 *
 * 两种形态都要认：
 *   - 裸字符串 `'skip-waiting'`：最早的调用方与既有测试都在用它，**必须原样保留**；
 *   - `{ type: 'skip-waiting' }`：与下面 shell-version 同一套信封，新代码一律用这种；
 *   - `{ type: 'shell-version' }`：回包本壳的版本号与资产指纹。
 *
 * ★为什么要有 shell-version 这条：浏览器判断 SW 要不要更新只看 sw.js 自身的字节，
 *   真机可能一直跑着一份很旧的壳 —— 页面是旧的、但**没有任何报错**。
 *   以前只能靠猜到底哪一份在跑，现在设置页问一句就知道：它拿到的 `SHELL_CACHE`
 *   就是这台设备上实际在用的那一份（SW 自己报出来的，不是页面读常量拼出来的）。
 */
self.addEventListener('message', (event) => {
  if (!event) return;
  const data = event.data;

  // 裸字符串形态（向后兼容，勿删）
  if (data === 'skip-waiting') {
    self.skipWaiting();
    return;
  }
  if (!data || typeof data !== 'object') return;

  if (data.type === 'skip-waiting') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'shell-version') {
    // ★event.source 可能是 null（消息来自已经关闭的 client）。SW 里抛错是**静默**的：
    //   页面收不到回包、控制台也不一定有东西，这种错最难查，所以先判空再发。
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage({
        type: 'shell-version',
        version: SHELL_CACHE,
        fingerprint: SHELL_FINGERPRINT,
      });
    }
  }
});

/**
 * 取一张 ArcGIS 瓦片：先查瓦片缓存，未命中再回源。
 *
 * 只把「2xx + content-type 为 image/*」的响应写进缓存：错误页、HTML 占位、
 * 空 body 一律不落盘，避免把一次坏请求固化成永久坏瓦片。
 *
 * @param {Request} request 瓦片请求。
 * @returns {Promise<Response>} 瓦片响应；断网且无缓存时回 504。
 */
async function _tileResponse(request) {
  try {
    const cache = await caches.open(TILE_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && type.indexOf('image/') === 0) {
      cache.put(request, res.clone()).then(() => _trimTiles(cache)).catch(() => {});
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

/**
 * 把瓦片缓存裁剪到 TILE_LIMIT 张：按写入顺序删除最旧的条目。
 *
 * @param {Cache} cache 瓦片缓存。
 * @returns {Promise<void>} 裁剪完成。
 */
async function _trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_LIMIT) return;
  const stale = keys.slice(0, keys.length - TILE_LIMIT);
  await Promise.all(stale.map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只处理 GET；非 GET（本应用不产生）直接放行
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // ArcGIS 底图瓦片：cache-first 的限量缓存；断网时回放上一屏已成功显示的底图
  if (url.hostname === TILE_HOST) {
    event.respondWith(_tileResponse(request));
    return;
  }

  // 其它跨域（六路数据源）：直接放行，不拦截、不缓存
  if (url.origin !== self.location.origin) return;

  // ★sw.js 本身不许经本 SW 拦截 / 缓存：
  //   ① 浏览器注册 SW 时会自带旁路，但「我的」页检查更新是手动 fetch('sw.js?ts=..')，
  //      这一类**会**走进来——若按带查询串的 URL 写缓存，每次点「检查更新」就多存一份
  //      `sw.js?ts=随机数`，壳缓存无界膨胀。
  //   ② sw.js 的更新由浏览器按字节比对独立管理，不该被壳缓存污染；放行走网络才拿得到
  //      真正的线上版本。
  if (url.pathname.endsWith('/sw.js')) return;

  // 同源静态资源：cache-first，命中即返回；未命中回源并把成功响应写回壳缓存
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // ★导航请求忽略查询串：搜索结果跳转是 `compass.html?lat=..&lon=..&name=..`，
      //   精确匹配必然 miss → 每次都回源，弱网下页面长时间空白，看着就是「卡死」。
      const isNav = request.mode === 'navigate';
      const hit = await cache.match(request, { ignoreSearch: isNav });
      if (hit) return hit;
      try {
        const res = await fetch(request);
        if (res && res.ok && res.type === 'basic') {
          // 导航按「去掉查询串」的地址落盘：同一页面只有一份壳，缓存不会被每搜一次撑大
          const putReq = isNav ? new Request(new URL(url.pathname, url.origin).href) : request;
          cache.put(putReq, res.clone()).catch(() => {});
        }
        return res;
      } catch (err) {
        // 断网且无缓存：导航请求按**请求的页面**回退对应的静态壳，
        // 否则断网点开 selfcheck.html 会被送回此刻屏（页面与预期不符）。
        // ★路径必须相对**本 SW 的作用域**取，不能直接 `'.' + url.pathname`：
        //   站点部署在子路径时（GitHub Pages 即 /geoscope-pwa/），pathname 已含该前缀，
        //   再拼 './' 会解析成 /geoscope-pwa/geoscope-pwa/compass.html —— 必然 miss，
        //   于是断网打开任意页面都被送回此刻屏，与这里要修的老毛病一模一样。
        if (request.mode === 'navigate') {
          const scopePath = new URL('./', self.location.href).pathname;
          const rel = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : '';
          const wanted = rel.endsWith('.html') ? `./${rel}` : './index.html';
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
