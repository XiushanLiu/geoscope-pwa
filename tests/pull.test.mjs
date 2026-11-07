/**
 * 「取数 → 记账 → 溯源」共享实现（`src/ui/pull.js`）的行为契约。
 *
 * 为什么单开一个文件：它同时被气候页（`app.js`）与地理页（`compass.js`）使用，
 * 放在任何一页的测试里都会让人以为它是那一页的私有实现。
 *
 * ★这里钉的是**行为**，不是字段集合。2026-10-17 之前 `_pull()` 在两页各有一份副本，
 * 靠一条「两处字段集合逐字一致」的用例守着 —— 那种用例钉得住字段名，钉不住
 * 「记不记健康 / stale 有没有翻成 state / 没数据时不进气泡」。副本收成一份之后，
 * 那条用例已删除，换成本文件里这些直接驱动实现的断言（并做过变异验证）。
 *
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });

const pull = await import('../src/ui/pull.js');
const health = await import('../src/data/health.js');
const sources = await import('../src/data/sources.js');

/**
 * 溯源气泡里那九项的**顺序**（渲染层按这个顺序读，改了要连带改 `now.js`）。
 *
 * ★2026-10 真机缺陷补的 `fromCache`：缓存命中那一路上屏显示「0 ms」，等于把
 *   「没测」说成「测到 0」。所以字段契约改成两条 —— `fromCache` 明说命中，
 *   `latencyMs` 在命中时是 **null**（不是 0）。**渲染侧必须读 `fromCache`**，
 *   见 tests/ui.test.mjs 的「溯源气泡：缓存命中不许显示 0 ms」，两条一处改。
 */
const PROVENANCE_KEYS = [
  'sourceId',
  'label',
  'url',
  'latencyMs',
  'fromCache',
  'fetchedAt',
  'cacheAgeMs', // v82：缓存条目年龄，页头据此显示「x 分钟前更新」
  'state',
  'attribution',
];

/**
 * 造一个假的取数函数（注入 `opts.fetch`，避开真网络与 `http.js` 的全局串行队列）。
 *
 * ★**假数据必须忠实于 SourceResult 契约**，尤其 `sourceId` 不能省：
 *   `data/health.js:169` 的 `recordResult(result)` 是**靠 `result.sourceId` 记账**的
 *   （`result.ok` 走 `recordSuccess(result.sourceId, …)`，否则 `recordFailure(…)`）。
 *   真实 `request()` 的返回值由 `core/http.js:187` 的 `_result()` 构造，永远带 sourceId；
 *   这里若漏掉它，健康台账会**静默记到 `undefined` 名下** —— 于是
 *   `getHealth('elevation').attempts` 恒为 0，而代码一行都不报错。
 *   这是个教训：注入的假数据不忠实，测试红的就不是实现，而是假数据自己。
 *
 * @param {string} sourceId 源 id（SourceResult 契约字段，不可省）。
 * @param {Object} res 其余字段（会覆盖下面的默认）。
 * @returns {() => Promise<Object>} 取数函数。
 */
const fetchOf = (sourceId, res) => async () => ({ sourceId, error: null, stale: false, ...res });

/**
 * 造一份只有 provenance 的最小快照。
 *
 * @returns {Object} 快照。
 */
const blank = () => ({ provenance: [] });

beforeEach(() => {
  health.resetHealth();
});

test('★成功一路：data 写回 + 溯源气泡记一条 fresh + 健康台账真的记了这一路', async () => {
  const snap = blank();
  const res = await pull.pullSource(
    snap,
    'elevation',
    { lat: 39.9087, lon: 116.3975 },
    (data) => {
      snap.elevationM = data.elevationM;
    },
    { fetch: fetchOf('elevation', { ok: true, data: { elevationM: 44 }, meta: { requestUrl: 'https://example.test/elev', latencyMs: 12, finishedAt: 1700000000000 }, stale: false }) }
  );

  assert.equal(res.ok, true);
  assert.equal(snap.elevationM, 44, 'data 必须真的写回快照');
  assert.equal(snap.provenance.length, 1, '拿到 data 就该记一条溯源');
  assert.deepEqual(Object.keys(snap.provenance[0]), PROVENANCE_KEYS, '溯源字段与顺序都不许变');
  assert.equal(snap.provenance[0].sourceId, 'elevation');
  assert.equal(snap.provenance[0].label, sources.getSource('elevation').label, '源名要取登记点里的 label');
  assert.equal(snap.provenance[0].url, 'https://example.test/elev');
  assert.equal(snap.provenance[0].latencyMs, 12);
  assert.equal(snap.provenance[0].fetchedAt, 1700000000000);
  assert.equal(snap.provenance[0].state, 'fresh', '非陈旧必须记 fresh');
  // ★变异验证的落点：删掉 pullSource() 里的 recordResult(res)，这一条会红（attempts 变 0）
  assert.equal(health.getHealth('elevation').attempts, 1, '每一路都必须记账（overallMode 靠它判降级）');
});

test('★缓存命中：fromCache=true 且 latencyMs 必须是 null（不许把「没发请求」记成「测到 0 ms」）', async () => {
  const snap = blank();
  // 假数据忠实复刻 `core/http.js` 的 fresh 命中分支：fromCache=true、latencyMs=0。
  // ★不许把这里的 latencyMs 直接写成 null —— 那就是替实现把活干了，断言会永远绿。
  await pull.pullSource(
    snap,
    'elevation',
    { lat: 1, lon: 2 },
    (data) => {
      snap.elevationM = data.elevationM;
    },
    {
      fetch: fetchOf('elevation', {
        ok: true,
        data: { elevationM: 44 },
        meta: { requestUrl: 'u', latencyMs: 0, finishedAt: 4, fromCache: true },
      }),
    }
  );

  assert.deepEqual(Object.keys(snap.provenance[0]), PROVENANCE_KEYS, '命中这路的字段集合与顺序同样不许变');
  assert.equal(snap.provenance[0].fromCache, true, '★命中必须显式记 true，渲染层靠它决定说什么');
  // ★变异验证的落点：把 pull.js 里的 `fromCache ? null : …` 改回 `res.meta.latencyMs`，
  //   这一条立刻红（拿到 0），而「字段集合」那条仍是绿的 —— 正是它单独存在的理由。
  assert.equal(snap.provenance[0].latencyMs, null, '★命中时 latencyMs 必须是 null（null 出「—」= 没测）');
});

test('★未命中（真发请求）时 fromCache=false 且 latencyMs 保留实测值（不许一律置 null）', async () => {
  const snap = blank();
  await pull.pullSource(
    snap,
    'elevation',
    { lat: 1, lon: 2 },
    (data) => {
      snap.elevationM = data.elevationM;
    },
    {
      // 没有 fromCache 字段（真实 `http.js` 未命中时就是这样），也不能被当成命中
      fetch: fetchOf('elevation', {
        ok: true,
        data: { elevationM: 44 },
        meta: { requestUrl: 'u', latencyMs: 137, finishedAt: 5 },
      }),
    }
  );

  assert.equal(snap.provenance[0].fromCache, false, '未命中必须是 false');
  assert.equal(snap.provenance[0].latencyMs, 137, '真发了请求就该保留实测时延');
});

test('★陈旧兜底：ok=false 但 stale=true 时 data 照常写回，state 必须是 stale（不许冒充 fresh）', async () => {
  const snap = blank();
  await pull.pullSource(
    snap,
    'elevation',
    { lat: 1, lon: 2 },
    (data) => {
      snap.elevationM = data.elevationM;
    },
    { fetch: fetchOf('elevation', { ok: false, stale: true, data: { elevationM: 40 }, meta: { requestUrl: 'u', latencyMs: 3, finishedAt: 1 } }) }
  );

  assert.equal(snap.elevationM, 40, '陈旧兜底值也是数据，照常上屏');
  assert.equal(snap.provenance.length, 1);
  assert.equal(snap.provenance[0].state, 'stale', '★stale 必须翻成 state，一律写 fresh 就是说谎');
});

test('★没拿到 data 时不进溯源气泡，但健康台账仍要记账（失败也要被降级判定看见）', async () => {
  const snap = blank();
  const applied = [];
  await pull.pullSource(
    snap,
    'reverse',
    { lat: 1, lon: 2 },
    (data) => applied.push(data),
    { fetch: fetchOf('reverse', { ok: false, data: null, meta: { requestUrl: 'u', latencyMs: 5, finishedAt: 2 } }) }
  );

  assert.equal(applied.length, 0, '没有 data 就不许调 apply');
  assert.equal(snap.provenance.length, 0, '★没有数据的溯源条目等于谎报「这一路在线」');
  assert.equal(health.getHealth('reverse').attempts, 1, '失败也要记账，否则 overallMode 永远说正常');
  // ★这里必须是 'degraded' 而不是 'failed'：reverse 在注册表里是 critical:false，
  //   而 `data/health.js:156-159` 的状态机只给**关键源**失败判 'failed'，
  //   非关键源失败且无陈旧兜底一律 'degraded'。两者在 overallMode() 里都要被
  //   看见（第 221 行对 'failed' 与 'degraded' 一并判 partial），所以本条钉的是
  //   「记账发生了」，不是「必须判成最重的那一档」。
  assert.equal(health.getHealth('reverse').status, 'degraded', '非关键源失败 → degraded（health.js 状态机）');
});

test('★关键源彻底失败（无陈旧兜底）才判 failed —— 与非关键源的 degraded 是两条分支', async () => {
  const snap = blank();
  await pull.pullSource(
    snap,
    'weather',
    { lat: 1, lon: 2 },
    () => {},
    { fetch: fetchOf('weather', { ok: false, data: null, meta: { requestUrl: 'u', latencyMs: 5, finishedAt: 2 }, error: { code: 'HTTP_500' } }) }
  );

  assert.equal(health.getHealth('weather').attempts, 1);
  // weather 是 critical:true（注册表），无陈旧兜底 → 'failed'；
  // 上面那条 reverse（critical:false）才是 'degraded'。两档不许合并成一档。
  assert.equal(health.getHealth('weather').status, 'failed', '关键源彻底失败 → failed');
  assert.equal(snap.provenance.length, 0, '失败不该留下任何溯源条目');
});

test('★safePull：取数抛异常只废自己这一路，render 仍被调用一次（传 null）', async () => {
  const snap = blank();
  const calls = [];
  const res = await pull.safePull(
    snap,
    'elevation',
    { lat: 1, lon: 2 },
    () => {},
    (r) => calls.push(r),
    { fetch: async () => {
      throw new Error('boom');
    } }
  );

  assert.equal(res, null);
  assert.equal(calls.length, 1, '失败也必须调一次 render，否则那张卡永远停在骨架');
  assert.equal(calls[0], null, '失败时 render 收到 null');
});

test('★safePull：成功时 render 收到完整的 SourceResult（不是布尔值）', async () => {
  const snap = blank();
  const calls = [];
  await pull.safePull(
    snap,
    'elevation',
    { lat: 1, lon: 2 },
    () => {},
    (r) => calls.push(r),
    { fetch: fetchOf('elevation', { ok: true, data: { elevationM: 7 }, meta: { requestUrl: 'u', latencyMs: 1, finishedAt: 3 } }) }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true, 'render 拿到的是 SourceResult 本身，调用方才能自己判 ok / stale');
});

test('★副本不许复活：两页都 import 共享实现，且都不许再各自定义一份', () => {
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const compass = readFileSync(new URL('../src/ui/compass.js', import.meta.url), 'utf8');
  const now = readFileSync(new URL('../src/ui/now.js', import.meta.url), 'utf8');

  for (const [name, src] of [['app.js', app], ['compass.js', compass]]) {
    assert.ok(/from\s+['"]\.\/pull\.js['"]/.test(src), `${name} 必须 import 共享实现`);
    assert.ok(!/async function _pull\s*\(/.test(src), `${name} 不许再自己定义 _pull（副本已收成一份）`);
    assert.ok(!/async function _safePull\s*\(/.test(src), `${name} 不许再自己定义 _safePull`);
  }
  // ★闭包护栏：now.js 在自检单文件产物的闭包内，一 import 就把 pull.js 拖进产物
  assert.ok(!/from\s+['"]\.\/pull\.js['"]/.test(now), 'now.js 不许 import pull.js（会把这个模块拖进产物闭包）');
});
