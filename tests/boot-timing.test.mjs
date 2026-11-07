/**
 * 首屏分段耗时打点（src/ui/app.js 的 boot()）的行为测试。
 *
 * 为什么单独一个文件：本单是**测量**，不是优化 —— 首屏串行（定位 → 天气 → 空气 →
 * 海拔 → 后台）是设计上刻意的（全局并发 1，见 core/http.js 的 _chain），没有真机分段
 * 数据之前不许调超时、不许砍路数。所以这里钉的是「测出来的数字必须可信」这三件事：
 *   1) **缺段给 null，不给 0**。0 会把「本轮没跑到这一段」说成「这一段耗时 0 ms」——
 *      与溯源卡「命中缓存就显示『缓存命中』、不显示 0 ms」是同一条纪律。
 *   2) **合计是墙钟，不是各段之和**。各段之间有渲染与判定开销，相加会漏掉它们；
 *      更不许把没跑到的段当 0 加进去（那样「离线一轮」的合计会等于定位段）。
 *   3) **上屏那一行读的是上一轮**。本行在 boot 中途渲染（后台段与合计都还没跑完），
 *      拿本轮半成品上屏就是把「还没测」说成「已经测到了」。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM / 假 localStorage / 假 navigator / 假 fetch；
 * 与 favorites.test.mjs 同一套路（document.readyState = 'loading'，显式调 boot()）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installFetch, installNavigator, installStorage, FakeStorage, text } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: null });
const fetchMock = installFetch();

const DOM_IDS = [{ id: 'app' }, { id: 'banner' }];
const dom = createFakeDom(DOM_IDS);
dom.document.readyState = 'loading'; // 不让入口模块自动 boot，改为用例里显式调用

const app = await import('../src/ui/app.js');
const store = await import('../src/core/store.js');
const fmt = await import('../src/core/format.js');
const { t } = await import('../src/i18n/index.js');

/** 占位符（latency(null) 的出参）：缺段必须显示它，不许显示 0 ms。 */
const DASH = fmt.latency(null);

beforeEach(() => {
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  globalThis.navigator.onLine = true;
  dom.byId['app'].textContent = '';
  dom.byId['banner'].textContent = '';
  if (globalThis.location) delete globalThis.location;
});

/**
 * 从 #app 子树里按 id 属性找节点（假 DOM 的 getElementById 只索引预置 id）。
 *
 * @param {string} id 目标 id。
 * @returns {Object|null} 节点或 null。
 */
function nodeById(id) {
  const hits = dom.byId.app.descendants().filter((n) => n.getAttribute('id') === id);
  return hits.length ? hits[hits.length - 1] : null;
}

test('一次 boot 都没跑完过时，bootTimings() 返回 null（而不是一份全 0 的表）', () => {
  assert.equal(app.bootTimings(), null, '★没有上一轮就是没有，全 0 的表等于谎报「都测到 0 ms」');
});

test('离线那一轮：没跑到的四段是 null，geo 与 total 是真测出来的数字', async () => {
  globalThis.navigator.onLine = false; // 离线：weather / air / elevation / background 压根不会跑
  await app.boot();

  const tm = app.bootTimings();
  assert.ok(tm, '离线也是正常结束的一轮，必须发布耗时');

  // ★四段没跑到：必须是 null。给 0 就等于把「没测」说成「测到 0 ms」
  assert.equal(tm.weather, null, '离线时天气段没跑，必须是 null');
  assert.equal(tm.air, null, '离线时空气段没跑，必须是 null');
  assert.equal(tm.elevation, null, '离线时海拔段没跑，必须是 null');
  assert.equal(tm.background, null, '离线时后台段没跑，必须是 null');

  assert.equal(typeof tm.geo, 'number', '定位段跑到了，必须是数字');
  assert.equal(typeof tm.total, 'number', '合计是墙钟，跑完了就必须是数字');
  assert.ok(tm.geo >= 0);
  // ★变异（本组）：合计若按「各段之和、没跑到的当 0」算，离线这一轮的合计会**正好等于**
  //   定位段 —— 那不是首屏耗时，只是定位耗时。
  assert.ok(tm.total > tm.geo, `合计必须覆盖整轮（不止定位那一段），实际 total=${tm.total} geo=${tm.geo}`);
  globalThis.navigator.onLine = true;
});

test('上屏那一行读的是上一轮：缺段显示「—」，且整句是模板插值出来的', async () => {
  // 先跑一轮离线（四段为 null）作为「上一轮」
  globalThis.navigator.onLine = false;
  await app.boot();
  const prev = app.bootTimings();
  assert.ok(prev, '前置：上一轮必须已经发布');
  assert.equal(prev.weather, null, '前置：上一轮的天气段是没跑到的');
  globalThis.navigator.onLine = true;

  // 用上一轮的数字拼出**期望整句**（缺段出占位符，不许出 0 ms）
  const expected = t('settings.bootTiming', {
    geo: fmt.latency(prev.geo),
    weather: fmt.latency(prev.weather),
    air: fmt.latency(prev.air),
    elevation: fmt.latency(prev.elevation),
    background: fmt.latency(prev.background),
    total: fmt.latency(prev.total),
  });
  // ★变异（本组）：缺段若显示 0，这四个就会变成 '0 ms'，下面整句比对随即失败
  for (const k of ['weather', 'air', 'elevation', 'background']) {
    assert.equal(fmt.latency(prev[k]), DASH, `缺段 ${k} 必须显示「${DASH}」，实际 ${fmt.latency(prev[k])}`);
  }
  assert.ok(expected.indexOf(DASH) !== -1, `前置：期望整句里必须有缺段占位符「${DASH}」`);

  // 再跑一轮在线的：这一轮会在溯源卡后面追加打点行，读的是上一轮
  await app.boot();
  const line = nodeById('boot-timing');
  assert.ok(line, '气候屏必须在溯源卡后面追加一行 #boot-timing');
  assert.equal(line.textContent, expected, '打点行必须是「整句模板 + 插值数字」，且读的是上一轮');
  assert.ok(line.className.indexOf('card-note') !== -1, `复用现成的 card-note，实际 class='${line.className}'`);

  // 位置：必须紧跟溯源卡（在 #card-prov 里面、且在溯源内容之后）
  const prov = nodeById('card-prov');
  assert.ok(prov, '溯源卡容器 #card-prov 必须存在');
  assert.ok(prov.descendants().indexOf(line) !== -1, '打点行必须挂在溯源卡里（在溯源内容之后）');
  assert.ok(text(prov).indexOf(expected) !== -1, '打点行必须在溯源卡的内容之后');
});

test('bootTimings() 给的是副本：改返回值不许改到模块状态', async () => {
  await app.boot();
  const a = app.bootTimings();
  assert.ok(a, '前置：这一轮已经跑完并发布了耗时');
  a.geo = 999999;
  assert.notEqual(app.bootTimings().geo, 999999, '★交出去的是副本，改它不许污染模块级状态');
});

test('在线那一轮：五段全都跑到了，就都必须是数字（不许留 null）', async () => {
  await app.boot();
  const tm = app.bootTimings();
  assert.ok(tm, '在线一轮跑完必须发布耗时');
  for (const k of ['geo', 'weather', 'air', 'elevation', 'background', 'total']) {
    assert.equal(typeof tm[k], 'number', `在线一轮里 ${k} 跑到了，必须是数字，实际 ${tm[k]}`);
  }
  assert.ok(tm.total >= tm.geo + tm.weather + tm.air + tm.elevation, '合计必须覆盖各段（不是各段之外的某个片段）');
  globalThis.navigator.onLine = true;
});

test('★跑完整轮会落盘（自检页是另一个页面，不落盘就拿不到读数）', async () => {
  globalThis.navigator.onLine = false; // 离线一轮：weather/air/elevation/background 没跑到
  await app.boot();
  globalThis.navigator.onLine = true;

  const rec = store.getBootTimings();
  assert.ok(rec, '★跑完整轮必须落盘，否则自检页导出的 read 永远是 null');
  assert.equal(typeof rec.atMs, 'number', '落盘要带采样时间，否则读数无法对应到哪一版哪一次');
  assert.equal(typeof rec.timings.total, 'number', '合计是墙钟，必须是数字');
  assert.equal(typeof rec.timings.geo, 'number', '定位段跑到了，必须是数字');
  // ★缺段仍是 null：落盘时把「没跑」写成 0，导出的 JSON 就会谎报「这一段 0 ms」
  for (const k of ['weather', 'air', 'elevation', 'background']) {
    assert.equal(rec.timings[k], null, `离线一轮的 ${k} 没跑到，落盘必须是 null`);
  }
});

test('★残缺轮次不落盘：total 不是有限数就整条丢弃，不覆盖上一次的有效读数', () => {
  const ok = store.setBootTimings({ geo: 10, weather: 20, air: 30, elevation: 40, background: 50, total: 120 });
  assert.equal(ok, true, '前置：完整一轮可落盘');
  const before = store.getBootTimings();
  assert.equal(before.timings.total, 120);

  assert.equal(store.setBootTimings({ geo: 999 }), false, '★没有 total 的残缺表必须拒收');
  assert.equal(store.setBootTimings(null), false, '非对象必须拒收');
  const after = store.getBootTimings();
  assert.equal(after.timings.total, 120, '★拒收后不许覆盖上一次的有效读数');
  assert.equal(after.atMs, before.atMs, '拒收的轮次不该刷新采样时间');
});

test('getBootTimings() 给的是副本：改返回值不许改到持久化记录', () => {
  store.setBootTimings({ geo: 1, weather: 2, air: 3, elevation: 4, background: 5, total: 6 });
  const a = store.getBootTimings();
  a.timings.total = 999999;
  a.atMs = 0;
  const b = store.getBootTimings();
  assert.equal(b.timings.total, 6, '★交出去的是副本，改它不许污染落盘记录');
  assert.notEqual(b.atMs, 0, '★时间戳也必须是副本');
});
