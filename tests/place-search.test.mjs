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
      return { ok: true, data: [] };
    },
    debounceMs: 40,
  });

  ctl.input('北');
  ctl.input('北京');
  ctl.input('北京市');
  await wait(40 + 90);

  assert.equal(calls.length, 1, `防抖后只应发 1 次请求，实际发了 ${calls.length} 次`);
  assert.equal(calls[0].id, 'geocode', '必须走已注册的 geocode 源');
  assert.equal(calls[0].kw, '北京市', '必须是最后一次输入的完整关键词');
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
  assert.match(t, /北京市 · 中国/, '★次行必须是 admin1 · country —— 同名多地全靠它分开');
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
