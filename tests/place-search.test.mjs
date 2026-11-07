/**
 * 地点搜索端到端验证
 *
 * 背景：geocode 源（src/data/sources.js:107）与 parseGeocode()（src/data/openmeteo.js:228）
 * 早就写好，真机实测 5/5 通过，但界面上**没有任何入口** —— 用户只能看自己站的那一处，
 * 或者跳到自己已经收藏过的那几处，形成「只能看当前位置 → 收藏它 → 在收藏之间跳」的
 * 死锁。这一组用例钉死的是那条被补上的通路，以及它最容易塌的四个角：
 *
 *   1) **防抖**：连打三个字只发一次请求（否则每敲一下打一次网络）；
 *   2) **竞态**：先发的慢响应不得覆盖后发的快响应（照 ui/app.js 的 _epoch 守卫思路，
 *      用单调递增令牌，不是「最后一个响应胜出」）；
 *   3) **失败 ≠ 无结果**：超时 / 断网必须说「搜索失败」，不能说成「没有这个地方」——
 *      那会把网络故障伪装成「这地方不存在」；
 *   4) **同名多地能分开**：结果项次行 `admin1 · country`，且 null 不得渲染成 "null"。
 *
 * 环境：与 favorites.test.mjs 同一套路 —— 先装好假 DOM / 假 localStorage / 假 navigator，
 * 再 `await import()` 被测模块（now.js 顶层会引导主题，没有 document 会炸；cache.js 在
 * 模块加载期就决定走内存还是 localStorage）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeDom,
  installFetch,
  installNavigator,
  installStorage,
  FakeStorage,
  text,
} from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: null });
const fetchMock = installFetch();
const dom = createFakeDom([{ id: 'app' }, { id: 'banner' }]);

// sources.js 必须显式 import：它把源解析器注入 core/http.js，不装上的话
// request('geocode', …) 只会拿到 UNSUPPORTED。
await import('../src/data/sources.js');
const ps = await import('../src/ui/placesearch.js');
const zh = await import('../src/i18n/index.js');
const now = await import('../src/ui/now.js');
const app = await import('../src/ui/app.js');
// ★2026-10-17 导航重构：parsePlaceParam / resolveCoord 已从 ui/app.js 迁到 core/geo.js。
const geo = await import('../src/core/geo.js');

/** 等待指定毫秒（防抖窗口 + 余量）。 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 手控释放的 Promise。
 *
 * 竞态用例**必须**用它：靠 sleep 赌时序的用例在慢机器上会随机翻车，而「先发的慢响应
 * 晚于后发的快响应」这个顺序是要断言的对象，不能交给调度器决定。
 *
 * @returns {{promise:Promise<*>, resolve:(v:*)=>void}} 控制句柄。
 */
function deferred() {
  /** @type {(v:*)=>void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** 一个可跳转的候选。 */
const BJ = { name: '北京', lat: 39.9075, lon: 116.39723, country: '中国', admin1: '北京市' };

beforeEach(() => {
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  globalThis.navigator.onLine = true;
  dom.byId['app'].textContent = '';
  dom.byId['banner'].textContent = '';
});

/* ------------------------------------------------------------------ */
/* 1. 跳转链接（含中文名编码）                                           */
/* ------------------------------------------------------------------ */

test('placeHref：中文名必须 encodeURIComponent，坐标原样', () => {
  const href = ps.placeHref({ lat: 39.9087, lon: 116.3975, name: '北京 · 天安门' });
  assert.equal(
    href,
    'index.html?lat=39.9087&lon=116.3975&name=%E5%8C%97%E4%BA%AC%20%C2%B7%20%E5%A4%A9%E5%AE%89%E9%97%A8',
    '中文名拼进查询串前必须编码，否则跳过去是一串问号'
  );
  // 反过来解一次：证明这串东西真能被 app.js 的 parsePlaceParam 读回原样
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('name'), '北京 · 天安门');
  assert.equal(params.get('lat'), '39.9087');
  assert.equal(params.get('lon'), '116.3975');
});

test('placeHref：坐标不是有限数字时返回空串（不给一个跳不过去的链接）', () => {
  assert.equal(ps.placeHref({ lat: null, lon: 116.4, name: 'x' }), '');
  assert.equal(ps.placeHref({ lat: 39.9, lon: NaN, name: 'x' }), '');
  assert.equal(ps.placeHref({ lat: 'abc', lon: 1, name: 'x' }), '');
  assert.equal(ps.placeHref(null), '');
});

test('placeHref：name 缺失退化成空串，链接依然可用', () => {
  const href = ps.placeHref({ lat: 0, lon: 0 });
  assert.equal(href, 'index.html?lat=0&lon=0&name=', '0,0（几内亚湾）是真实地点，不得被当成空值');
});

/* ------------------------------------------------------------------ */
/* 2. 防抖                                                             */
/* ------------------------------------------------------------------ */

test('★防抖：连续输入三个字只发 1 次请求，且用最后一次的关键词', async () => {
  const calls = [];
  const ctl = ps.createPlaceSearch({
    fetch: async (id, ctx) => {
      calls.push({ id, kw: ctx.keyword, lang: ctx.lang });
      // ★必须返回非空：空结果会触发兜底（别名表/补后缀），那就不是「只发一次」了
      // ★_navigable 期望 lat/lon，不是 latitude/longitude
      return { ok: true, data: [{ name: '北京', lat: 39.9, lon: 116.4, country: '中国', admin1: '北京', population: 21890000 }] };
    },
    debounceMs: 40,
  });

  // ★选「北京」是因为上游有结果、且不在别名表里 —— 不会触发兜底，才能验证「只发一次」
  ctl.input('北');
  ctl.input('北京');
  await wait(40 + 90);

  assert.equal(calls.length, 1, `防抖后只应发 1 次请求，实际发了 ${calls.length} 次`);
  assert.equal(calls[0].id, 'geocode', '必须走已注册的 geocode 源');
  assert.equal(calls[0].kw, '北京', '必须是最后一次输入的完整关键词');
  assert.equal(calls[0].lang, 'zh');
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 3. 竞态                                                             */
/* ------------------------------------------------------------------ */

test('★竞态：先发的慢响应不得覆盖后发的快响应', async () => {
  const slow = deferred();
  const fast = deferred();
  const calls = [];
  const ctl = ps.createPlaceSearch({
    fetch: async (id, ctx) => {
      calls.push(ctx.keyword);
      return calls.length === 1 ? slow.promise : fast.promise;
    },
  });

  const first = ctl.run('北京'); // 先发（慢）
  const second = ctl.run('北京市'); // 后发（快）
  assert.deepEqual(calls, ['北京', '北京市'], '发起顺序必须是先「北京」后「北京市」');

  // 后发的先回 → 生效
  fast.resolve({ ok: true, data: [{ name: '北京市', lat: 39.9, lon: 116.4, country: '中国', admin1: '北京市' }] });
  await second;
  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.results.length, 1);
  assert.equal(ctl.results[0].name, '北京市', '后发的快响应必须生效');

  // 先发的后回 → 必须被整包丢弃
  slow.resolve({ ok: true, data: [{ name: '北海（陈旧响应）', lat: 21.4, lon: 109.1, country: '中国', admin1: '广西壮族自治区' }] });
  await first;
  assert.equal(ctl.status, 'ok', '陈旧响应不得把状态改回 loading 之外的样子');
  assert.equal(ctl.results.length, 1, '陈旧响应不得追加进结果列表');
  assert.equal(ctl.results[0].name, '北京市', '★最终必须是后发那条 —— 先发的慢响应被丢弃了');
  ctl.dispose();
});

test('★竞态：失败响应同样受令牌守卫（旧失败不得盖掉新成功）', async () => {
  const slow = deferred();
  const fast = deferred();
  let n = 0;
  const ctl = ps.createPlaceSearch({
    fetch: async () => {
      n += 1;
      return n === 1 ? slow.promise : fast.promise;
    },
  });

  const first = ctl.run('上海');
  const second = ctl.run('上海区');
  fast.resolve({ ok: true, data: [BJ] });
  await second;
  assert.equal(ctl.status, 'ok');

  slow.resolve({ ok: false, error: { code: 'TIMEOUT', message: zh.t('error.TIMEOUT', { ms: 6000 }) } });
  await first;
  assert.equal(ctl.status, 'ok', '★旧的失败响应不得把界面改成「搜索失败」');
  assert.equal(ctl.errorMessage, '', '陈旧失败的原因也不得写进状态');
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 4. 三种状态各自可达                                                  */
/* ------------------------------------------------------------------ */

test('输入不足 2 字：不发请求，状态 short，文案说明要几个字', async () => {
  let n = 0;
  const ctl = ps.createPlaceSearch({
    fetch: async () => {
      n += 1;
      return { ok: true, data: [] };
    },
    debounceMs: 5,
  });
  ctl.input('北');
  await wait(60);
  assert.equal(n, 0, '不足 2 个字一个请求都不许发');
  assert.equal(ctl.status, 'short');
  assert.equal(ctl.results.length, 0);
  const tip = zh.t('search.minChars', { n: ps.SEARCH_MIN_CHARS });
  assert.match(tip, /2/, '文案里必须真的出现最小字数');
  ctl.dispose();
});

test('无结果：ok=true 但 results 为空 → empty，且文案与失败态不同', async () => {
  const ctl = ps.createPlaceSearch({ fetch: async () => ({ ok: true, data: [] }) });
  await ctl.run('不存在的地名xyz');
  assert.equal(ctl.status, 'empty');
  assert.equal(ctl.results.length, 0);
  assert.notEqual(
    zh.t('search.empty'),
    zh.t('search.failed'),
    '「没有这个地方」与「搜索失败」必须是两句不同的话'
  );
  ctl.dispose();
});

test('请求失败：ok=false → error，并带上已本地化的原因', async () => {
  const ctl = ps.createPlaceSearch({
    fetch: async () => ({ ok: false, error: { code: 'TIMEOUT', message: zh.t('error.TIMEOUT', { ms: 6000 }) } }),
  });
  await ctl.run('北京');
  assert.equal(ctl.status, 'error', '失败绝不能落回 empty —— 那是把网络故障说成「没这地方」');
  assert.equal(ctl.results.length, 0);
  assert.match(ctl.errorMessage, /6000/, '失败原因要能看出是哪一种失败');
  ctl.dispose();
});

test('取数层直接抛异常（不是 SourceResult）也判为 error，不冒泡', async () => {
  const ctl = ps.createPlaceSearch({
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const res = await ctl.run('北京');
  assert.equal(res, null);
  assert.equal(ctl.status, 'error');
  assert.equal(ctl.errorMessage, 'fetch failed');
  ctl.dispose();
});

test('坐标缺失的候选会被滤掉（不放一颗点了没反应的死按钮）', async () => {
  const ctl = ps.createPlaceSearch({
    fetch: async () => ({
      ok: true,
      data: [
        { name: '有坐标', lat: 1, lon: 2, country: null, admin1: null },
        { name: '没坐标', lat: null, lon: null, country: null, admin1: null },
      ],
    }),
  });
  await ctl.run('有坐标');
  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.results.length, 1, '只有跳得过去的候选才应该留下来');
  assert.equal(ctl.results[0].name, '有坐标');
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 5. 选中                                                             */
/* ------------------------------------------------------------------ */

test('pick() 把选中的地点交给 onPick，且链接含编码后的中文名', () => {
  /** @type {Array<Object>} */
  const picked = [];
  const ctl = ps.createPlaceSearch({ onPick: (p) => picked.push(p) });
  ctl.pick({ name: '北京 · 天安门', lat: 39.9087, lon: 116.3975, country: '中国', admin1: '北京市' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, '北京 · 天安门');
  assert.equal(
    ps.placeHref(picked[0]),
    'index.html?lat=39.9087&lon=116.3975&name=%E5%8C%97%E4%BA%AC%20%C2%B7%20%E5%A4%A9%E5%AE%89%E9%97%A8'
  );
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 6. resolveCoord 语义（source 改名后仍然成立）                          */
/* ------------------------------------------------------------------ */

test('★source=explicit 时 isDefaultPlace 必须是 false', () => {
  const r = geo.resolveCoord({ lat: 31.2304, lon: 121.4737, name: '上海', source: 'explicit' });
  assert.equal(r.isDefaultPlace, false, '搜索 / 收藏跳过去绝不能显示「未取得定位，正在显示默认地点」');
  assert.equal(r.base.source, 'explicit');
  assert.equal(r.base.lat, 31.2304);
  assert.equal(r.base.lon, 121.4737);
});

/* ------------------------------------------------------------------ */
/* 7. 端到端：真 request + 真 parseGeocode + 真渲染                       */
/* ------------------------------------------------------------------ */

/**
 * 建好此刻屏骨架与标题区，并把搜索面板归一到**收起**态。
 *
 * 为什么必须归一：搜索控制器是 now.js 的模块级单例，状态跨用例存活 —— 上一个用例
 * 点开过面板，下一个用例一进来就是展开的，断言会读到一个不受自己控制的初始态。
 *
 * @returns {{root:Object, btn:Object}} 根节点与放大镜按钮。
 */
function renderNowScreen() {
  const root = dom.byId['app'];
  root.textContent = '';
  now.renderSkeleton(root);
  now.renderHeader(root, {
    atMs: null,
    coord: { lat: 22.5431, lon: 114.0579, source: 'gps' },
    placeName: '深圳',
    provenance: [],
  });
  const btn = root.querySelector('.hd-search-btn');
  assert.ok(btn, '标题区必须出现搜索入口按钮');
  if (btn.getAttribute('aria-expanded') === 'true') btn.click(); // 归一到收起
  return { root, btn };
}

test('搜索入口默认收起：槽位存在且隐藏，不为页面留白', () => {
  const root = dom.byId['app'];
  root.textContent = '';
  now.renderSkeleton(root);
  now.renderHeader(root, {
    atMs: null,
    coord: { lat: 22.5431, lon: 114.0579, source: 'gps' },
    placeName: '深圳',
    provenance: [],
  });
  const slot = root.querySelector('#card-search');
  assert.ok(slot, '骨架必须建出 #card-search 槽位');
  // 槽位顺序：搜索必须在天气卡之前（renderSkeleton 里建晚掉会跑到页面最底下）。
  // 第一个子节点是 .hd（没有 id），所以先按 id 过滤掉它再比顺序。
  const slots = root.children.map((c) => c.id).filter(Boolean);
  assert.equal(slots[0], 'card-search', `搜索槽必须是第一个卡片槽，实际顺序 ${slots.join(' / ')}`);
  assert.equal(slot.hidden, true, '默认收起时不许占版面');
});

test('★端到端：点开 → 输入 → 出结果，次行显示 admin1 · country（消歧）', async () => {
  fetchMock.setFallback({
    status: 200,
    json: {
      results: [
        {
          name: '北京',
          latitude: 39.9075,
          longitude: 116.39723,
          country: '中国',
          admin1: '北京市',
          timezone: 'Asia/Shanghai',
        },
      ],
    },
  });

  const { root, btn } = renderNowScreen();
  btn.click(); // 展开面板

  const slot = root.querySelector('#card-search');
  assert.equal(slot.hidden, false, '点开后面板必须可见');
  const input = root.querySelector('.search-input');
  assert.ok(input, '面板里必须有输入框');
  assert.equal(btn.getAttribute('aria-expanded'), 'true', 'aria-expanded 要跟着开合走');

  input.value = '北京消歧用例';
  await input.fire('input', {});
  await wait(ps.SEARCH_DEBOUNCE_MS + 150);

  const items = root.querySelectorAll('.search-item');
  assert.equal(items.length, 1, `应渲染 1 条结果，实际 ${items.length}`);
  const t = text(items[0]);
  assert.match(t, /北京/, '主行必须是地名');
  // ★次行的消歧信息不变，只是分隔符经 fmt.placeTitle() 加固：间隔号前是 NBSP
  //（普通空格 + 间隔号」的组合已被 placeTitle 替换掉，钉住这个形态等于钉住修复本身）。
  assert.match(t, /北京市\u00A0· 中国/, '★次行必须是 admin1 · country —— 同名多地全靠它分开');
  assert.ok(!/ · /.test(t), '次行不得再出现「普通空格 + 间隔号」（会折到行首）');
});

test('端到端：admin1 / country 全为 null 时不渲染 "null"，也不留孤立的 " · "', async () => {
  fetchMock.setFallback({
    status: 200,
    json: { results: [{ name: '无属地信息', latitude: 1.5, longitude: 2.5, timezone: 'UTC' }] },
  });

  const { root, btn } = renderNowScreen();
  btn.click();
  const input = root.querySelector('.search-input');
  input.value = '无属地用例';
  await input.fire('input', {});
  await wait(ps.SEARCH_DEBOUNCE_MS + 150);

  const items = root.querySelectorAll('.search-item');
  assert.equal(items.length, 1);
  const t = text(items[0]);
  assert.equal(t, '无属地信息', `次行该整行不渲染，实际渲染成「${t}」`);
  assert.doesNotMatch(t, /null/);
  assert.doesNotMatch(t, /·/);
});

test('端到端：空结果走 empty 文案（不是「搜索失败」）', async () => {
  fetchMock.setFallback({ status: 200, json: { results: [] } });

  const { root, btn } = renderNowScreen();
  btn.click();
  const input = root.querySelector('.search-input');
  input.value = '查无此地用例';
  await input.fire('input', {});
  await wait(ps.SEARCH_DEBOUNCE_MS + 150);

  const status = root.querySelector('.search-status');
  assert.ok(status, '必须有一条状态文案');
  assert.equal(text(status), zh.t('search.empty'));
  assert.equal(root.querySelectorAll('.search-item').length, 0);
});

test('端到端：请求失败走 failed 文案，与 empty 明确区分', async () => {
  fetchMock.setFallback({ status: 500, body: 'boom' });

  const { root, btn } = renderNowScreen();
  btn.click();
  const input = root.querySelector('.search-input');
  input.value = '失败用例';
  await input.fire('input', {});
  await wait(ps.SEARCH_DEBOUNCE_MS + 400);

  const status = root.querySelector('.search-status');
  assert.ok(status, '必须有一条状态文案');
  assert.equal(text(status), zh.t('search.failed'), '失败必须说「搜索失败」');
  assert.notEqual(text(status), zh.t('search.empty'), '★失败绝不能说成「没有这个地方」');
});

test('开合往返：点一次展开，再点一次收起', () => {
  const { root, btn } = renderNowScreen();
  const slot = root.querySelector('#card-search');
  assert.equal(slot.hidden, true);

  btn.click();
  assert.equal(root.querySelector('#card-search').hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(btn.getAttribute('aria-label'), zh.t('search.close'));

  btn.click();
  assert.equal(root.querySelector('#card-search').hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-label'), zh.t('search.open'));
});

test('★状态住在控制器里：标题区整槽重建后，输入过的关键词还在', async () => {
  fetchMock.setFallback({ status: 200, json: { results: [] } });
  const { root, btn } = renderNowScreen();
  btn.click();

  const input = root.querySelector('.search-input');
  input.value = '重建用例';
  await input.fire('input', {});
  await wait(ps.SEARCH_DEBOUNCE_MS + 150);

  // 模拟 reverse 回来导致的整槽重建（一次 boot 至少三次）
  now.renderHeader(root, {
    atMs: null,
    coord: { lat: 22.5431, lon: 114.0579, source: 'gps' },
    placeName: '深圳',
    provenance: [],
  });
  const input2 = root.querySelector('.search-input');
  assert.ok(input2, '重建后面板必须还在（状态不在 DOM 里，所以能照着 state 重画回来）');
  assert.equal(input2.value, '重建用例', '★打过的字不许被整槽重建抹掉');
});

/* ------------------------------------------------------------------ */
/* 5. 中文地名补「市」重试（2026-10 真机：泉州 / 厦门 / 温州 搜不到）    */
/*                                                                      */
/* ★根因是**上游数据缺口**，不是解析错：geocoding-api.open-meteo.com    */
/*   （= GeoNames）的中文别名索引只登记了一部分城市的带「市」写法。      */
/*   所以空结果时补一次「市」再问一次 —— 补一次就停，不许循环。          */
/* ------------------------------------------------------------------ */

/**
 * 造一个「按 keyword 分流」的假取数函数，并记账每一次调用。
 *
 * @param {Object<string, Array<Object>>} table keyword → 结果列表。
 * @param {Object} [opts] `throwOn`：这些 keyword 一律抛异常。
 * @returns {{calls:Array<string>, fetch:Function}} 调用记录与取数函数。
 */
function keywordFetch(table, opts = {}) {
  const calls = [];
  const boom = opts.throwOn || [];
  return {
    calls,
    fetch: async (id, ctx) => {
      calls.push(ctx.keyword);
      if (boom.includes(ctx.keyword)) throw new Error('network down');
      return { ok: true, data: table[ctx.keyword] || [] };
    },
  };
}

/** 泉州（带「市」才有）—— 真机实测：泉州 0 条、泉州市 1 条。 */
const QUANZHOU = { name: '泉州市', lat: 24.91389, lon: 118.58583, country: '中国', admin1: '福建省' };

/** 纽约（繁体 + 「市」才有真·纽约市）—— 真机实测：
 *  `纽约` 0 条、`纽约市` 0 条、`紐約` → 肯塔基州小镇、`紐約市` → 纽约市（880 万人）。 */
const NEW_YORK_CITY = {
  name: '紐約市', lat: 40.71427, lon: -74.00597, country: '美国', admin1: '纽约州', population: 8804190,
};
const NEW_YORK_TOWN = {
  name: '紐約', lat: 36.98894, lon: -88.95256, country: '美国', admin1: '肯塔基州', population: null,
};

test('★中文搜国外城市：「纽约」转繁后带/不带「市」都问，按人口取纽约市而不是同名小镇', async () => {
  const { calls, fetch } = keywordFetch({
    纽约: [], 纽约市: [], 紐約: [NEW_YORK_TOWN], 紐約市: [NEW_YORK_CITY],
  });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('纽约');

  assert.equal(ctl.status, 'ok', `★纽约必须搜得到，实际 ${ctl.status}`);
  // ★变异验证：只问 `紐約`、或按返回先后取，这条会变成肯塔基小镇而红
  assert.equal(ctl.results[0].name, '紐約市', `必须命中纽约市，实际 ${ctl.results[0].name}`);
  assert.equal(ctl.results[0].population, 8804190);
  assert.deepEqual(
    calls,
    ['纽约', 'New York City', '纽约市', '紐約市', '紐約'],
    `实际：${calls.join(' → ')}`,
  );
  ctl.dispose();
});

test('★已经是繁体、或转繁后与原词相同：不许多发请求', async () => {
  const { calls, fetch } = keywordFetch({ 北京: [BJ] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('北京');

  assert.equal(ctl.status, 'ok');
  assert.deepEqual(calls, ['北京'], `无转换可做时只许发一次，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★转繁后仍 0 条：状态仍是 empty，不许说成网络错误', async () => {
  const { calls, fetch } = keywordFetch({ 卢森堡: [], 卢森堡市: [], 盧森堡: [], 盧森堡市: [] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('卢森堡');

  assert.equal(ctl.status, 'empty');
  assert.equal(ctl.results.length, 0);
  assert.deepEqual(calls, ['卢森堡', '卢森堡市', '盧森堡', '盧森堡市'], '补一次就停');
  ctl.dispose();
});

test('★英文缩写「LA」：上游命中加纳的 La 村，也必须并行查别名并改按人口取洛杉矶', async () => {
  const LA_US = {
    name: 'Los Angeles', lat: 34.05223, lon: -118.24368, country: '美国', admin1: '加州', population: 3971883,
  };
  const LA_GH = {
    name: 'La', lat: 8.2, lon: -0.85, country: '加纳', admin1: 'Greater Accra', population: null,
  };
  const { calls, fetch } = keywordFetch({ LA: [LA_GH], 'Los Angeles': [LA_US] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('LA');

  assert.equal(ctl.status, 'ok');
  // ★变异验证：若只在空结果时才兜底，这里会停留在加纳的 La 而红
  assert.equal(ctl.results[0].name, 'Los Angeles', `首条必须是洛杉矶，实际 ${ctl.results[0].name}`);
  assert.deepEqual(
    calls,
    ['LA', 'Los Angeles', '洛杉矶', '洛杉磯'],
    `缩写必须总走别名并行，实际：${calls.join(' → ')}`,
  );
  ctl.dispose();
});

test('★英文缩写「SF」：上游 0 条 → 兜底并行查 San Francisco/旧金山/舊金山并命中', async () => {
  const SF = {
    name: 'San Francisco', lat: 37.77493, lon: -122.41942, country: '美国', admin1: '加州', population: 827526,
  };
  const { calls, fetch } = keywordFetch({ SF: [], 'San Francisco': [SF] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('SF');

  assert.equal(ctl.status, 'ok', `SF 必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, 'San Francisco');
  assert.equal(ctl.results[0].population, 827526);
  assert.deepEqual(calls, ['SF', 'San Francisco', '旧金山', '舊金山'], `实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★中文「温哥华」：简体 0 条 → 繁体命中（加拿大 66 万人 + 美国小城），按人口加拿大在前', async () => {
  const VAN_CA = {
    name: '溫哥華', lat: 49.28273, lon: -123.12074, country: '加拿大', admin1: '不列颠哥伦比亚', population: 662248,
  };
  const VAN_US = {
    name: '溫哥華', lat: 45.63873, lon: -122.66149, country: '美国', admin1: '华盛顿州', population: 196442,
  };
  const { calls, fetch } = keywordFetch({ 温哥华: [], 温哥华市: [], 温哥華: [VAN_CA, VAN_US] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('温哥华');

  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.results.length, 2, '两个同名温哥华都要在');
  assert.equal(ctl.results[0].country, '加拿大', `人口多的加拿大温哥华必须排第一，实际第一=${ctl.results[0].country}`);
  // ★「哥」的繁简同形，Unihan 无映射，所以兜底词是「温哥華」而非「溫哥華」；
  //   但「温哥華」上游也是 0 条，真正命中靠别名表里的英文全名 Vancouver
  assert.deepEqual(
    calls,
    ['温哥华', 'Vancouver', '温哥华市', '温哥華', '温哥華市'],
    `实际：${calls.join(' → ')}`,
  );
  ctl.dispose();
});

test('★县/镇/村去后缀：「乌镇镇」上游 0 条 → 去「镇」问「乌镇」并命中', async () => {
  const WUZHEN = {
    name: '乌镇', lat: 30.7456, lon: 120.4908, country: '中国', admin1: '浙江', population: 60000,
  };
  const { calls, fetch } = keywordFetch({ 乌镇镇: [], 乌镇: [WUZHEN] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('乌镇镇');

  assert.equal(ctl.status, 'ok', `乌镇镇必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, '乌镇');
  // ★去后缀得「乌镇」→ 繁体「烏鎮」；再补一轮拼音兜底「wuzhen」（去后缀后在拼音表里查得到）
  assert.deepEqual(calls, ['乌镇镇', '乌镇', '烏鎮', 'wuzhen'], `实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★县/镇/村去后缀：「华西村」上游直接命中，不再多发请求', async () => {
  const HUAXI = {
    name: '华西村', lat: 31.826, lon: 120.36, country: '中国', admin1: '江苏', population: null,
  };
  const { calls, fetch } = keywordFetch({ 华西村: [HUAXI] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('华西村');

  assert.equal(ctl.status, 'ok');
  assert.deepEqual(calls, ['华西村'], `命中后不许补查，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★中文地名补「市」：「泉州」上游 0 条 → 自动再问一次「泉州市」并命中', async () => {
  const { calls, fetch } = keywordFetch({ 泉州: [], 泉州市: [QUANZHOU] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('泉州');

  assert.equal(ctl.status, 'ok', `★泉州必须搜得到（靠补「市」那一次），实际 ${ctl.status}`);
  assert.equal(ctl.results.length, 1);
  assert.equal(ctl.results[0].name, '泉州市');
  assert.equal(ctl.results[0].admin1, '福建省');
  // ★变异验证：去掉补「市」这一步，这条会红（1 次 + 状态变 empty）
  assert.deepEqual(calls, ['泉州', '泉州市'], `必须恰好发两次，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★补了也还是 0 条（晋江这类真没有的）：状态仍是 empty，且只补一次不许循环', async () => {
  const { calls, fetch } = keywordFetch({ 晋江: [], 晋江市: [] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('晋江');

  assert.equal(ctl.status, 'empty', '★补了「市」仍然 0 条 = 真没有，不许说成「搜索失败」');
  assert.equal(ctl.results.length, 0);
  assert.deepEqual(calls, ['晋江', '晋江市'], '补一次就停（不许「市市」「市市市」地循环）');
  ctl.dispose();
});

test('★第一次就有结果时绝不许多发一次请求（一次多余的请求比一次多余的等待贵）', async () => {
  const { calls, fetch } = keywordFetch({ 北京: [BJ], 北京市: [BJ] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('北京');

  assert.equal(ctl.status, 'ok');
  // ★变异验证：把补「市」的条件写成「不管有没有结果都补」，这条会红
  assert.deepEqual(calls, ['北京'], `★命中了就只许发一次，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★补请求失败：保留第一次的真实结果（空），不许把「没找到」改写成「网络错误」', async () => {
  // ★这是本组最要紧的一条：补请求是锦上添花，它的失败不能污染第一次的真实结论。
  //   变异验证：把补请求的失败分支写成 ERROR，这条会红。
  const calls = [];
  const ctl = ps.createPlaceSearch({
    fetch: async (id, ctx) => {
      calls.push(ctx.keyword);
      if (ctx.keyword === '泉州市') throw new Error('network down');
      return { ok: true, data: [] };
    },
  });

  await ctl.run('泉州');

  assert.equal(ctl.status, 'empty', '★补请求失败时必须仍是「没有这个地方」，不是「搜索失败」');
  assert.equal(ctl.errorMessage, '', '补请求的失败原因不许写进状态');
  assert.deepEqual(calls, ['泉州', '泉州市'], '补请求确实发出去了（发了两次就是两次，诚实记账）');
  ctl.dispose();
});

test('★不该补的场景：拼音 / 已带行政区划后缀 —— 一次都不许多问', async () => {
  const { calls, fetch } = keywordFetch({ Quanzhou: [], 泉州市: [QUANZHOU], 思明区: [] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('Quanzhou'); // 非纯汉字
  assert.deepEqual(calls, ['Quanzhou'], '拼音不补「市」');

  await ctl.run('泉州市'); // 已带后缀
  assert.deepEqual(calls, ['Quanzhou', '泉州市'], '已经带「市」就不许再加成「泉州市市」');
  assert.equal(ctl.status, 'ok');

  await ctl.run('思明区'); // 已带区 → 补「思明」（去后缀），上游 0 条则 empty
  assert.deepEqual(calls, ['Quanzhou', '泉州市', '思明区', '思明'], '已带「区」补去后缀');
  assert.equal(ctl.status, 'empty', '补了也 0 条，就该如实说没找到');
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 8. 拼音搜索（2026-11 真机：wuzhen 这类拼音输入上游 0 条）              */
/*                                                                      */
/* 两条路都要钉：                                                        */
/*   ① 用户打拼音 → 映射回中文再问（wuzhen → 乌镇）；                    */
/*   ② 用户打中文、上游 0 条 → 补发拼音版本再问（乌镇 → wuzhen）。        */
/* ------------------------------------------------------------------ */

test('★拼音输入：「wuzhen」上游 0 条 → 映射回「乌镇」并命中', async () => {
  const WUZHEN = {
    name: '乌镇', lat: 30.7456, lon: 120.4908, country: '中国', admin1: '浙江', population: 60000,
  };
  const { calls, fetch } = keywordFetch({ wuzhen: [], 乌镇: [WUZHEN] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('wuzhen');

  assert.equal(ctl.status, 'ok', `拼音必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, '乌镇');
  assert.deepEqual(calls, ['wuzhen', '乌镇'], `拼音只映射回一个中文词，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★中文上游 0 条：补发拼音版本（「乌镇」0 条 → 「wuzhen」命中）', async () => {
  const WUZHEN = {
    name: '乌镇', lat: 30.7456, lon: 120.4908, country: '中国', admin1: '浙江', population: 60000,
  };
  // ★「乌镇」本身就以「镇」字结尾 → 被当作已带后缀：去后缀得「乌」（单字不放行），
  //   补「市」/繁体分支都不进入 —— 拼音映射是这类地名唯一的兜底路。变异验证：去掉 ②d 这条会红
  const { calls, fetch } = keywordFetch({ 乌镇: [], wuzhen: [WUZHEN] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('乌镇');

  assert.equal(ctl.status, 'ok', `中文补拼音必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, '乌镇');
  assert.deepEqual(
    calls,
    ['乌镇', 'wuzhen'],
    `「镇」字结尾不许补市（「乌」单字也不许放行），只发拼音，实际：${calls.join(' → ')}`,
  );
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 9. 混合输入拆解（含空格/逗号：拆词并行搜，拆出的词也走别名表）          */
/* ------------------------------------------------------------------ */

test('★混合输入「纽约， New York」：按逗号拆段，「New York」整段保留不许拆成 New/York', async () => {
  const { calls, fetch } = keywordFetch({
    '纽约， New York': [], 纽约: [], 'New York City': [NEW_YORK_CITY], 纽约市: [], 紐約市: [], 'New York': [],
  });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('纽约， New York');

  assert.equal(ctl.status, 'ok', `混合输入必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, '紐約市');
  // ★变异验证：退回「无脑按空格拆」，这里会出现 `New` 与 `York` 两个全废的请求
  assert.deepEqual(
    calls,
    ['纽约， New York', '纽约', 'New York City', '纽约市', '紐約市', 'New York'],
    `实际：${calls.join(' → ')}`,
  );
  ctl.dispose();
});

test('★纯英文含空格不拆：「New York」整词只查一次（拆成 New/York 全是废请求）', async () => {
  const NYC = {
    name: 'New York City', lat: 40.71427, lon: -74.00597, country: '美国', admin1: '纽约州', population: 8804190,
  };
  const { calls, fetch } = keywordFetch({ 'New York': [NYC] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('New York');

  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.results[0].name, 'New York City');
  assert.deepEqual(calls, ['New York'], `★整词命中即止，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★分词拼音「heng dian」：映射回「横店」（拼音表键必须归一成无空格）', async () => {
  const HD = {
    name: '横店', lat: 29.1478, lon: 120.3164, country: '中国', admin1: '浙江', population: null,
  };
  const { calls, fetch } = keywordFetch({ 'heng dian': [], 横店: [HD] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('heng dian');

  assert.equal(ctl.status, 'ok', `分词拼音必须搜得到，实际 ${ctl.status}`);
  assert.equal(ctl.results[0].name, '横店');
  // ★变异验证：拼音表里写成 `'heng dian'` 这种带空格的键时，这条会红（永远查不到）
  assert.deepEqual(calls, ['heng dian', '横店'], `实际：${calls.join(' → ')}`);
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 10. 合并排序：行政层级分档（PPLA > PPL > ADM2），人口只定同档先后      */
/* ------------------------------------------------------------------ */

test('★层级排序：ADM2 县人口再高也不得盖过 PPLA/PPL（镇/村级别标注）', async () => {
  const LA_US = {
    name: 'Los Angeles', lat: 34.05223, lon: -118.24368, country: '美国', admin1: '加州', featureCode: 'PPLA', population: 3971883,
  };
  const LA_GH = {
    name: 'La', lat: 8.2, lon: -0.85, country: '加纳', admin1: 'Greater Accra', featureCode: 'PPL', population: null,
  };
  const LA_COUNTY = {
    name: '洛杉矶县', lat: 34.3, lon: -118.2, country: '美国', admin1: '加州', featureCode: 'ADM2', population: 10000000,
  };
  // LA 有别名 → 必走合并排序；县人口（1000 万）是市（397 万）两倍多，仍必须排最后
  const { calls, fetch } = keywordFetch({ LA: [LA_GH], 'Los Angeles': [LA_US], 洛杉矶: [LA_COUNTY], 洛杉磯: [] });
  const ctl = ps.createPlaceSearch({ fetch });

  await ctl.run('LA');

  assert.equal(ctl.status, 'ok');
  assert.deepEqual(
    ctl.results.map((p) => p.name),
    ['Los Angeles', 'La', '洛杉矶县'],
    `PPLA > PPL > ADM2，实际：${ctl.results.map((p) => `${p.name}(${p.featureCode})`).join(' / ')}`,
  );
  assert.deepEqual(calls, ['LA', 'Los Angeles', '洛杉矶', '洛杉磯'], `实际：${calls.join(' → ')}`);
  ctl.dispose();
});

/* ------------------------------------------------------------------ */
/* 11. 外置别名表（search-alias.json：新增地名免改代码）                  */
/* ------------------------------------------------------------------ */

test('★loadAliases 成功：外置别名立即生效，且与内置表合并（不丢内置）', async () => {
  const BAR = { name: 'Bar City', lat: 1, lon: 2, country: 'X国', admin1: 'Y省' };
  const { calls, fetch } = keywordFetch({ foo: [], 'Bar City': [BAR] });
  const ctl = ps.createPlaceSearch({ fetch });

  fetchMock.setFallback({ status: 200, json: { version: 1, aliases: { foo: ['Bar City'] } } });
  const loaded = await ctl.loadAliases('search-alias.json');
  assert.equal(loaded, true, '合法的 JSON 必须加载成功');

  await ctl.run('foo'); // 外置别名：foo → Bar City
  assert.equal(ctl.status, 'ok');
  assert.equal(ctl.results[0].name, 'Bar City');
  assert.deepEqual(calls, ['foo', 'Bar City'], `外置别名必须走兜底并行，实际：${calls.join(' → ')}`);
  ctl.dispose();
});

test('★loadAliases 失败（404 / 坏 JSON）：回退内置表，内置别名照常工作', async () => {
  const SF = {
    name: 'San Francisco', lat: 37.77493, lon: -122.41942, country: '美国', admin1: '加州', population: 827526,
  };

  // 404：加载失败
  const one = keywordFetch({ SF: [], 'San Francisco': [SF] });
  const ctl1 = ps.createPlaceSearch({ fetch: one.fetch });
  fetchMock.setFallback({ status: 404 });
  assert.equal(await ctl1.loadAliases('missing.json'), false, '404 必须如实返回失败');

  // 坏 JSON：解析失败与网络失败同一条回退路径
  fetchMock.setFallback({ status: 200, body: 'not-json{' });
  assert.equal(await ctl1.loadAliases('broken.json'), false, '坏 JSON 也必须回退而不是炸掉');

  // 内置表没丢：SF 仍走内置别名命中
  await ctl1.run('SF');
  assert.equal(ctl1.status, 'ok');
  assert.equal(ctl1.results[0].name, 'San Francisco');
  assert.deepEqual(one.calls, ['SF', 'San Francisco', '旧金山', '舊金山'], `实际：${one.calls.join(' → ')}`);
  ctl1.dispose();
});

test('★loadAliases 离线短路：onLine=false 时零请求直接回退内置表（与 http.js 同口径）', async () => {
  const ctl = ps.createPlaceSearch({ fetch: async () => ({ ok: true, data: [] }) });
  globalThis.navigator.onLine = false;

  assert.equal(await ctl.loadAliases(), false, '离线必须如实回退');
  assert.equal(fetchMock.count, 0, '★离线一个请求都不许发');

  globalThis.navigator.onLine = true;
  ctl.dispose();
});
