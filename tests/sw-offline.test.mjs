/**
 * sw.js 离线壳「行为」测试（不是存在性测试）。
 *
 * 背景：sw.js 是零依赖 PWA 的离线壳，头注释里写着三条硬性边界 ——
 *   1) 绝不缓存任何 API 响应（业务数据走 core/cache.js 的 localStorage 快照）；
 *   2) 瓦片只缓存 ArcGIS 主机的成功图片，上限 24 张，缓存名随壳版本失效；
 *   3) 除瓦片外的跨域请求直接放行，不拦截、不改写。
 *
 * 存在性测试（grep 一下 `caches.open` 就算过）证明不了任何一条：真正会回归的是
 * fetch 处理器的**分支走向**。其中最容易回归的一条是断网导航回退 ——
 * 早期实现无条件回退 `./index.html`，导致断网点开 selfcheck.html 被送回此刻屏。
 * 现在的代码先按「请求的页面」找缓存（`.${url.pathname}`），找不到才回退 index.html。
 * 本文件把这条钉死。
 *
 * 做法：sw.js 是 classic script，用的是全局 self / caches / fetch，不是 ES Module，
 * 所以用 node:vm 建一个沙箱上下文注入这些全局，runInContext 执行后直接调用它
 * 注册的 install / activate / fetch 处理器，断言真实行为。
 *
 * 零第三方依赖：node:test + node:assert + node:vm。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SW_SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');

/** 沙箱里「同源」的基准地址；跨域一律指向别的 origin。 */
const ORIGIN = 'https://geoscope.test';
const BASE = `${ORIGIN}/`;

/** 从 sw.js 源码解析常量，避免测试与实现漂移（与 static.test.mjs 同一手法）。 */
const SHELL_CACHE = SW_SOURCE.match(/const SHELL_CACHE\s*=\s*'([^']+)';/)[1];
/** 瓦片缓存名由壳版本派生（见 sw.js 的 TILE_CACHE）。 */
const TILE_CACHE = SHELL_CACHE.replace('shell', 'tiles');
/** ArcGIS 瓦片主机（见 sw.js 的 TILE_HOST）。 */
const TILE_HOST = 'server.arcgisonline.com';
const SHELL_FINGERPRINT = SW_SOURCE.match(/const SHELL_FINGERPRINT\s*=\s*'([^']+)';/)[1];
const SHELL_ASSETS = (SW_SOURCE.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/)[1]
  .match(/'([^']+)'/g) || [])
  .map((literal) => literal.slice(1, -1));

/** Cache 的键：一律归一化成绝对 URL（浏览器里相对 URL 按 SW 作用域解析）。 */
function resolveUrl(input) {
  const raw = typeof input === 'string' ? input : input.url;
  return new URL(raw, BASE).href;
}

/**
 * 沙箱里的 Request。
 *
 * 两处必须偏离 Node 原生 Request：
 *   1) 相对 URL（'./index.html'）在原生 Request 里会抛 Failed to parse URL，
 *      但浏览器里是按 SW 作用域解析的 —— 这里显式按 BASE 解析；
 *   2) fetch 规范禁止在 Request 构造函数里传 mode: 'navigate'，
 *      但真实 FetchEvent.request.mode 就是 'navigate' —— 这里用实例属性覆盖。
 */
class SWRequest extends Request {
  constructor(input, init = {}) {
    const { mode, ...rest } = init;
    super(resolveUrl(input), rest);
    const inherited = typeof input === 'object' && input !== null ? input.mode : undefined;
    Object.defineProperty(this, 'mode', {
      value: mode ?? inherited ?? 'no-cors',
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

/**
 * 造一个带身份标记的响应。
 * - `x-stub-tag` 用于断言「返回的到底是哪一个壳」，避免读 body 带来的流状态问题；
 * - `type` 覆盖成 'basic'：同源网络响应当然是 basic，但原生 Response 只有 'default'，
 *   而 sw.js 的写回条件是 `res.type === 'basic'`。
 */
function makeResponse(tag, opts = {}) {
  const res = new Response(opts.body ?? tag, {
    status: opts.status ?? 200,
    statusText: opts.statusText ?? 'OK',
    headers: { 'content-type': opts.contentType ?? 'text/html; charset=utf-8', 'x-stub-tag': tag },
  });
  Object.defineProperty(res, 'type', {
    value: opts.type ?? 'basic',
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return res;
}

/** 取响应的身份标记。 */
function tagOf(res) {
  if (!res || !res.headers) return null;
  return res.headers.get('x-stub-tag');
}

/**
 * 建一个跑 sw.js 的沙箱。每个用例都新建，状态天然隔离。
 */
function createSandbox() {
  const listeners = new Map();
  const stores = new Map(); // cacheName -> Map<absoluteUrl, Response>

  const state = {
    addCalls: [], // cache.add 收到的绝对 URL
    putCalls: [], // { url, status }
    matchCalls: [], // cache.match 查过的绝对 URL
    fetchCalls: [], // 桩 fetch 收到的绝对 URL
    openCalls: [], // caches.open 的名字
    deleted: [], // caches.delete 删掉的名字
    skipWaiting: 0,
    claim: 0,
    online: true,
    fetchImpl: null, // (url) => Response | throws
    failAdd: new Set(), // 让 cache.add 失败的绝对 URL
  };

  function storeOf(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function makeCache(name) {
    const store = storeOf(name);
    return {
      async match(input) {
        const key = resolveUrl(input);
        state.matchCalls.push(key);
        return store.get(key);
      },
      async put(input, res) {
        const key = resolveUrl(input);
        state.putCalls.push({ url: key, status: res ? res.status : null });
        store.set(key, res);
      },
      async add(input) {
        const key = resolveUrl(input);
        state.addCalls.push(key);
        if (state.failAdd.has(key)) {
          throw new TypeError(`Failed to fetch: ${key}`);
        }
        store.set(key, makeResponse(`SHELL:${key}`));
      },
      async keys() {
        return [...store.keys()];
      },
      // 瓦片缓存裁剪依赖 Cache.delete；CacheStorage.delete 在下面的 caches 对象里
      async delete(input) {
        return store.delete(resolveUrl(input));
      },
    };
  }

  const caches = {
    async open(name) {
      state.openCalls.push(name);
      return makeCache(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      state.deleted.push(name);
      return stores.delete(name);
    },
  };

  const self = {
    location: { origin: ORIGIN, href: BASE, pathname: '/' },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting() {
      state.skipWaiting += 1;
      return Promise.resolve();
    },
    clients: {
      claim() {
        state.claim += 1;
        return Promise.resolve();
      },
    },
  };

  async function fakeFetch(input) {
    const url = resolveUrl(input);
    state.fetchCalls.push(url);
    if (!state.online) {
      throw new TypeError(`Failed to fetch: ${url} (offline)`);
    }
    if (state.fetchImpl) return state.fetchImpl(url);
    return makeResponse(`NET:${url}`);
  }

  const context = vm.createContext({
    self,
    caches,
    fetch: fakeFetch,
    Request: SWRequest,
    Response,
    URL,
    console,
  });

  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });

  function handlersOf(type) {
    return listeners.get(type) ?? [];
  }

  /** 造一个 lifecycle 事件（install / activate），只捕获 waitUntil。 */
  function dispatchLifecycle(type) {
    const waitUntilPromises = [];
    const event = {
      type,
      waitUntil(p) {
        waitUntilPromises.push(Promise.resolve(p));
      },
    };
    const handlers = handlersOf(type);
    assert.equal(handlers.length, 1, `sw.js 应注册且仅注册一个 ${type} 处理器`);
    handlers[0](event);
    return Promise.all(waitUntilPromises);
  }

  /**
   * 造一个 fetch 事件并派发。
   * 「未拦截」的唯一判据就是 respondWith 从未被调用 —— 这正是跨域/非 GET 的红线。
   */
  function dispatchFetch(request) {
    const record = { respondWithCount: 0, respondWithArgs: [] };
    const event = {
      type: 'fetch',
      request,
      respondWith(p) {
        record.respondWithCount += 1;
        record.respondWithArgs.push(p);
      },
      waitUntil() {},
    };
    const handlers = handlersOf('fetch');
    assert.equal(handlers.length, 1, 'sw.js 应注册且仅注册一个 fetch 处理器');
    handlers[0](event);
    return record;
  }

  /** 取出 respondWith 交给 SW 的 promise 并等待它落地。 */
  async function settle(record) {
    assert.equal(record.respondWithCount, 1, '应恰好调用一次 respondWith');
    return Promise.resolve(record.respondWithArgs[0]);
  }

  return {
    state,
    stores,
    handlersOf,
    dispatchLifecycle,
    dispatchFetch,
    settle,
    /** 预置缓存内容：entries 是 { './index.html': 'INDEX-SHELL' } 这样的标记表。 */
    seed(cacheName, entries) {
      const store = storeOf(cacheName);
      for (const [key, tag] of Object.entries(entries)) {
        store.set(resolveUrl(key), makeResponse(tag));
      }
      return store;
    },
    setOnline(online) {
      state.online = online;
    },
    setFetchImpl(fn) {
      state.fetchImpl = fn;
    },
    failAdd(...urls) {
      for (const u of urls) state.failAdd.add(resolveUrl(u));
    },
  };
}

/** GET 导航请求。query 参数用来绕过 cache-first，逼出回退分支。 */
function navRequest(path) {
  return new SWRequest(`${ORIGIN}${path}`, { mode: 'navigate' });
}

/** 同源子资源请求（默认非 navigate）。 */
function assetRequest(path, init = {}) {
  return new SWRequest(`${ORIGIN}${path}`, { mode: 'no-cors', ...init });
}

describe('sw.js 离线壳行为', () => {
  test('清单解析前置条件：SHELL_ASSETS 与实现一致', () => {
    // 不写死版本号（`geoscope-shell-vN` 里的 N）：版本号每次发布都要 +1，写死 N 等于
    // 让「正常 bump」和「这条断言」互相打架 —— 这次 bump v1→v2 就把它打红了，下一次还会。
    // 这条断言的**真实意图**是「解析成功 + 名字符合契约」（SHELL_CACHE 是从 sw.js 源码
    // 正则抠出来的，解析不到就是 undefined/抛错），所以断言命名契约而不是数字本身。
    assert.match(SHELL_CACHE, /^geoscope-shell-v\d+$/, `缓存名不符合 geoscope-shell-vN 契约：${SHELL_CACHE}`);
    // 不写死条目数：每新增一个运行时模块都要补清单，写死会让「加文件」和「改清单」
    // 这两件事互相打架。改为断言清单本身的性质 + 关键条目必须存在。
    assert.ok(SHELL_ASSETS.length > 0, '预缓存清单不应为空');
    for (const asset of SHELL_ASSETS) {
      assert.ok(asset.startsWith('./'), `清单条目必须是相对路径（SW 作用域内），实际：${asset}`);
    }
    assert.equal(
      new Set(SHELL_ASSETS).size,
      SHELL_ASSETS.length,
      '清单不应有重复条目（重复意味着有人重复补了同一个文件）'
    );
    assert.ok(SHELL_ASSETS.includes('./'), '清单必须包含导航根 ./');
    assert.ok(SHELL_ASSETS.includes('./index.html'));
    assert.ok(SHELL_ASSETS.includes('./selfcheck.html'));
    assert.ok(SHELL_ASSETS.includes('./styles/tokens.css'));
    assert.ok(SHELL_ASSETS.includes('./styles/app.css'));
  });

  test('install：预缓存清单里每一项都被 cache.add 请求过', async () => {
    const sb = createSandbox();
    await sb.dispatchLifecycle('install');

    const expected = SHELL_ASSETS.map((a) => resolveUrl(a));
    assert.deepEqual([...sb.state.addCalls].sort(), [...expected].sort());
    assert.equal(sb.state.skipWaiting, 1, 'install 结束后应 skipWaiting');

    const store = sb.stores.get(SHELL_CACHE);
    assert.ok(store, '应创建壳缓存');
    assert.equal(store.size, SHELL_ASSETS.length, '每一项都应真的落进壳缓存');
    for (const url of expected) {
      assert.ok(store.has(url), `${url} 未被缓存`);
    }
  });

  test('install：单个资源失败不阻断安装，其余项照常缓存', async () => {
    const sb = createSandbox();
    const broken = './styles/app.css';
    sb.failAdd(broken);

    // 关键：这里不能抛。整站离线壳不能因为一个 CSS 404 就全军覆没。
    await sb.dispatchLifecycle('install');

    const expected = SHELL_ASSETS.map((a) => resolveUrl(a));
    assert.deepEqual([...sb.state.addCalls].sort(), [...expected].sort(), '失败项也要被尝试请求');

    const store = sb.stores.get(SHELL_CACHE);
    assert.equal(store.size, SHELL_ASSETS.length - 1, '除失败项外全部入缓存');
    assert.ok(!store.has(resolveUrl(broken)), '失败项不应出现在缓存里');
    assert.ok(store.has(resolveUrl('./index.html')), '其余项照常缓存');
    assert.ok(store.has(resolveUrl('./src/core/geo.js')), '其余项照常缓存');
    assert.equal(sb.state.skipWaiting, 1, '有失败也应继续 skipWaiting');
  });

  test('activate：清掉非当前版本的旧缓存并 claim', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL' });
    sb.seed('geoscope-shell-v0', { './index.html': 'OLD-SHELL' });
    sb.seed('random-junk', { './index.html': 'JUNK' });

    await sb.dispatchLifecycle('activate');

    assert.deepEqual([...sb.state.deleted].sort(), ['geoscope-shell-v0', 'random-junk']);
    assert.ok(!sb.stores.has('geoscope-shell-v0'), '旧版本缓存必须被删');
    assert.ok(!sb.stores.has('random-junk'), '无关缓存必须被删');
    assert.ok(sb.stores.has(SHELL_CACHE), '当前版本缓存必须保留');
    assert.equal(sb.state.claim, 1);
  });

  test('跨域 GET 不被拦截：不 respondWith、不发网络、不查缓存（隐私红线）', async () => {
    const sb = createSandbox();
    const req = new SWRequest('https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4', {
      mode: 'cors',
    });

    const record = sb.dispatchFetch(req);

    assert.equal(record.respondWithCount, 0, '跨域请求绝不能被 respondWith 接管');
    assert.equal(sb.state.fetchCalls.length, 0, 'SW 不得自己发这个请求');
    assert.equal(sb.state.matchCalls.length, 0, 'SW 不得查缓存');
    assert.equal(sb.state.putCalls.length, 0, 'SW 不得写缓存');
    assert.equal(sb.state.openCalls.length, 0, 'SW 连壳缓存都不该打开');
  });

  test('跨域瓦片 GET 同样不被拦截（tile.openstreetmap.org）', async () => {
    const sb = createSandbox();
    const req = new SWRequest('https://tile.openstreetmap.org/12/3413/1567.png', { mode: 'cors' });

    const record = sb.dispatchFetch(req);

    assert.equal(record.respondWithCount, 0, '非 ArcGIS 瓦片字节绝不能被 SW 碰');
    assert.equal(sb.state.fetchCalls.length, 0);
    assert.equal(sb.state.matchCalls.length, 0);
    assert.equal(sb.state.putCalls.length, 0);
  });

  /** ArcGIS 瓦片请求（主机与 data/tiles.js 的 TILE_BASE 一致）。 */
  function tileRequest(path = '/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/12/26') {
    return new SWRequest(`https://${TILE_HOST}${path}`, { mode: 'cors' });
  }

  /** 让 put → trim 这条异步链跑完。 */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('ArcGIS 瓦片未命中 + 在线：回源后写入瓦片缓存，不碰壳缓存', async () => {
    const sb = createSandbox();
    sb.setFetchImpl(() => makeResponse('TILE-NET', { contentType: 'image/png' }));
    const req = tileRequest();

    const record = sb.dispatchFetch(req);
    const res = await sb.settle(record);
    await tick();

    assert.equal(tagOf(res), 'TILE-NET', '应返回网络瓦片');
    assert.deepEqual(sb.state.fetchCalls, [req.url], '应恰好回源一次');
    assert.ok(sb.stores.get(TILE_CACHE).has(req.url), '成功图片应落进瓦片缓存');
    assert.ok(!sb.state.openCalls.includes(SHELL_CACHE), '不应打开壳缓存');
  });

  test('ArcGIS 瓦片命中缓存：直接返回，不再回源', async () => {
    const sb = createSandbox();
    const req = tileRequest();
    sb.seed(TILE_CACHE, { [req.url]: 'TILE-CACHED' });

    const record = sb.dispatchFetch(req);
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'TILE-CACHED');
    assert.equal(sb.state.fetchCalls.length, 0, '命中后不该再回源');
  });

  test('ArcGIS 非图片 / 非 2xx 响应不写入瓦片缓存（错误页不落盘）', async () => {
    const sb = createSandbox();
    sb.setFetchImpl(() => makeResponse('HTML-ERR', { status: 404 }));

    const record = sb.dispatchFetch(tileRequest());
    await sb.settle(record);
    await tick();

    assert.equal(sb.state.putCalls.length, 0, '404 / HTML 一律不写瓦片缓存');
  });

  test('瓦片缓存上限 24 张：第 25 张写入后淘汰最旧的一张', async () => {
    const sb = createSandbox();
    const seeded = {};
    for (let i = 0; i < 24; i += 1) seeded[`${BASE}tile/${i}.png`] = `OLD-${i}`;
    sb.seed(TILE_CACHE, seeded);
    sb.setFetchImpl(() => makeResponse('TILE-25', { contentType: 'image/png' }));
    const req = tileRequest('/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/1/1');

    await sb.settle(sb.dispatchFetch(req));
    await tick();

    const store = sb.stores.get(TILE_CACHE);
    assert.equal(store.size, 24, '缓存应稳定在 24 张');
    assert.ok(!store.has(`${BASE}tile/0.png`), '最旧的一张应被淘汰');
    assert.ok(store.has(req.url), '刚写入的那张应保留');
  });

  test('非 GET 不被拦截：不 respondWith、不发网络', async () => {
    const sb = createSandbox();
    const req = assetRequest('/src/core/store.js', { method: 'POST' });

    const record = sb.dispatchFetch(req);

    assert.equal(req.method, 'POST');
    assert.equal(record.respondWithCount, 0, '非 GET 绝不能被 respondWith 接管');
    assert.equal(sb.state.fetchCalls.length, 0);
    assert.equal(sb.state.matchCalls.length, 0);
  });

  test('同源命中缓存：直接返回缓存里的响应，且不发起网络请求', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL' });

    const record = sb.dispatchFetch(navRequest('/index.html'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'INDEX-SHELL', '应返回缓存里的那份壳');
    assert.equal(sb.state.fetchCalls.length, 0, 'cache-first 命中就绝不该回源');
    assert.deepEqual(sb.state.matchCalls, [`${ORIGIN}/index.html`]);
  });

  test('同源未命中 + 在线：返回网络响应，并把成功响应写回缓存', async () => {
    const sb = createSandbox();
    const record = sb.dispatchFetch(assetRequest('/src/core/geo.js'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), `NET:${ORIGIN}/src/core/geo.js`, '应返回网络响应');

    const url = `${ORIGIN}/src/core/geo.js`;
    assert.deepEqual(sb.state.fetchCalls, [url], '应恰好回源一次');
    assert.deepEqual(sb.state.putCalls, [{ url, status: 200 }], '成功响应应写回壳缓存');
    assert.ok(sb.stores.get(SHELL_CACHE).has(url), '缓存里应真的存下这份响应');
    assert.equal(tagOf(sb.stores.get(SHELL_CACHE).get(url)), `NET:${url}`);
  });

  test('同源未命中 + 在线：非 2xx 响应原样返回，但不污染缓存', async () => {
    const sb = createSandbox();
    sb.setFetchImpl(() => makeResponse('NOT-FOUND', { status: 404, statusText: 'Not Found' }));

    const record = sb.dispatchFetch(assetRequest('/src/core/missing.js'));
    const res = await sb.settle(record);

    assert.equal(res.status, 404, '404 应原样透传');
    assert.equal(sb.state.putCalls.length, 0, '非 ok 响应不得写进壳缓存');
    assert.ok(!sb.stores.get(SHELL_CACHE).has(`${ORIGIN}/src/core/missing.js`));
  });

  test('同源未命中 + 在线：非 basic 类型响应不写缓存（跨域资源经同源代理的情况）', async () => {
    const sb = createSandbox();
    sb.setFetchImpl(() => makeResponse('OPAQUE', { type: 'opaque' }));

    const record = sb.dispatchFetch(assetRequest('/src/core/opaque.js'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'OPAQUE', '响应仍应返回给页面');
    assert.equal(sb.state.putCalls.length, 0, '非 basic 响应不得写进壳缓存');
  });

  test('断网 + 导航到 /selfcheck.html：必须回 selfcheck 的壳，不能是 index.html', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, {
      './index.html': 'INDEX-SHELL',
      './selfcheck.html': 'SELFCHECK-SHELL',
    });
    sb.setOnline(false);

    // 带 query 的导航：cache-first（ignoreSearch: false）会 miss，
    // 从而真正走进「断网导航回退」分支 —— 这是那条专门修过的 bug 所在处。
    const record = sb.dispatchFetch(navRequest('/selfcheck.html?from=shortcut'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'SELFCHECK-SHELL', '断网点开自检页必须拿到自检页的壳');
    assert.notEqual(tagOf(res), 'INDEX-SHELL', '绝不能被送回此刻屏');
    assert.deepEqual(sb.state.fetchCalls, [`${ORIGIN}/selfcheck.html?from=shortcut`], '确实尝试回源并失败');
    assert.ok(
      sb.state.matchCalls.includes(`${ORIGIN}/selfcheck.html`),
      '回退必须按「请求的页面」查缓存，而不是直接回退 index.html'
    );
  });

  test('断网 + 导航到 /selfcheck.html（无 query，走 cache-first）：同样是自检页的壳', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, {
      './index.html': 'INDEX-SHELL',
      './selfcheck.html': 'SELFCHECK-SHELL',
    });
    sb.setOnline(false);

    const record = sb.dispatchFetch(navRequest('/selfcheck.html'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'SELFCHECK-SHELL');
    assert.notEqual(tagOf(res), 'INDEX-SHELL');
  });

  test('断网 + 导航到没缓存过的 .html 路径：回退 ./index.html', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL' });
    sb.setOnline(false);

    const record = sb.dispatchFetch(navRequest('/nested/unknown.html'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'INDEX-SHELL', '未缓存的页面应回退到此刻屏');
    assert.equal(sb.state.fetchCalls.length, 1);
  });

  test('断网 + 导航到无扩展名路径：同样回退 ./index.html', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL' });
    sb.setOnline(false);

    const record = sb.dispatchFetch(navRequest('/settings'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'INDEX-SHELL', '非 .html 路径直接回退此刻屏');
  });

  test('断网 + 非导航请求（.js）：返回 504，绝不把 HTML 页面当 JS 返回', async () => {
    const sb = createSandbox();
    // 故意只缓存 index.html：最危险的回归就是拿这份 HTML 去顶任何未命中请求。
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL' });
    sb.setOnline(false);

    const record = sb.dispatchFetch(assetRequest('/src/core/geo.js'));
    const res = await sb.settle(record);

    assert.equal(res.status, 504, '断网非导航请求必须是 504');
    assert.equal(res.statusText, 'offline');
    assert.equal(tagOf(res), null, '绝不能是任何缓存里的 HTML 壳');
    assert.equal(await res.text(), '', '504 的 body 应为空');
    assert.ok(
      !(res.headers.get('content-type') ?? '').includes('text/html'),
      '504 绝不能带上 HTML 的 content-type（否则就是把 HTML 页面当 JS 返回）'
    );
  });

  test('断网 + 非导航请求（CSS）：同样 504，不回退 index.html', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './index.html': 'INDEX-SHELL', './styles/app.css': 'APP-CSS' });
    sb.setOnline(false);

    const record = sb.dispatchFetch(assetRequest('/styles/tokens.css'));
    const res = await sb.settle(record);

    assert.equal(res.status, 504, '未缓存的 CSS 断网时必须 504，而不是拿到 index.html');
    assert.equal(tagOf(res), null);
  });

  test('断网 + 导航根路径 /：回退 ./index.html', async () => {
    const sb = createSandbox();
    sb.seed(SHELL_CACHE, { './': 'ROOT-SNAPSHOT', './index.html': 'INDEX-SHELL' });
    sb.setOnline(false);

    // 根的缓存被清掉，只剩 index.html 可回退
    sb.stores.get(SHELL_CACHE).delete(`${ORIGIN}/`);

    const record = sb.dispatchFetch(navRequest('/'));
    const res = await sb.settle(record);

    assert.equal(tagOf(res), 'INDEX-SHELL', '根导航最终应回退到 index.html');
  });
});

describe('sw.js 消息通道（壳版本查询 / skip-waiting）', () => {
  /**
   * 造一个 message 事件并派发给 sw.js 注册的 message 处理器。
   *
   * @param {Object} sb createSandbox() 的返回值。
   * @param {*} data event.data（字符串或信封对象）。
   * @param {Object|null} source event.source（传 null 模拟「消息来自已关闭的 client」）。
   * @returns {{sent: Array}} 收到的回包（source.postMessage 的实参）。
   */
  function dispatchMessage(sb, data, source) {
    const sent = [];
    const src =
      source === undefined
        ? {
            postMessage(msg) {
              sent.push(msg);
            },
          }
        : source;
    const event = { data, source: src };
    const handlers = sb.handlersOf('message');
    assert.equal(handlers.length, 1, 'sw.js 应注册且仅注册一个 message 处理器');
    handlers[0](event);
    return { sent };
  }

  test('{type:"shell-version"} 能拿到回包，version 就是 SHELL_CACHE、fingerprint 就是 SHELL_FINGERPRINT', () => {
    const sb = createSandbox();
    const { sent } = dispatchMessage(sb, { type: 'shell-version' });

    assert.equal(sent.length, 1, '应当回一个包');
    // ★逐字段比，不 deepEqual 整个对象：回包是在 vm 沙箱里造的，它的原型是那个
    //   realm 的 Object.prototype，deepStrictEqual 会因为原型不同而非内容不同报红。
    assert.equal(sent[0].type, 'shell-version');
    assert.equal(sent[0].version, SHELL_CACHE);
    assert.equal(sent[0].fingerprint, SHELL_FINGERPRINT);
    // ★这条是这张卡的立身之本：版本号必须是**正在跑的这份 SW 自己报的**。
    //   页面若改成读常量拼一个，显示的就是仓库最新版而不是本机实际在用的那份 ——
    //   那正是「发布成功了但用户还在旧壳上」这件事能静默两周的原因。
    assert.equal(sent[0].version, SHELL_CACHE, '版本号必须来自 SW 自身，不允许页面侧编造');
  });

  test('event.source 为 null 时不抛异常（消息来自已关闭的 client）', () => {
    const sb = createSandbox();
    // source 为 null：实现必须先判空再 postMessage。SW 里抛错是**静默**的 ——
    // 页面只是永远收不到回包，控制台也不一定有东西，这种错极难查。
    assert.doesNotThrow(() => dispatchMessage(sb, { type: 'shell-version' }, null));
    assert.doesNotThrow(() => dispatchMessage(sb, { type: 'skip-waiting' }, null));
  });

  test("裸字符串 'skip-waiting' 仍然可用（回归：老调用方与既有测试依赖它）", () => {
    const sb = createSandbox();
    dispatchMessage(sb, 'skip-waiting');
    assert.equal(sb.state.skipWaiting, 1, "字符串形态必须继续触发 skipWaiting");
  });

  test("信封形态 {type:'skip-waiting'} 同样触发 skipWaiting", () => {
    const sb = createSandbox();
    dispatchMessage(sb, { type: 'skip-waiting' });
    assert.equal(sb.state.skipWaiting, 1);
  });

  test('不认识的消息不触发任何动作（别的页面也可能在 SW 通道上广播）', () => {
    const sb = createSandbox();
    const { sent } = dispatchMessage(sb, { type: 'something-else' });
    dispatchMessage(sb, 'nonsense');
    dispatchMessage(sb, null);
    dispatchMessage(sb, undefined);
    assert.equal(sb.state.skipWaiting, 0, '无关消息不许触发 skipWaiting');
    assert.equal(sent.length, 0, '无关消息不许回包');
  });
});
