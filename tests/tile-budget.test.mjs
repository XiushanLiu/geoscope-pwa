/**
 * 瓦片后台探测的**整批时间预算**。
 *
 * 背景：三块逐块串行、每块超时 6 s，且全部走 `http.js` 的全局串行队列（并发恒为 1），
 * 最坏情况 3 × 6 s = **18 s 占用队列**。真机实测瓦片中位 693 ms、峰值 3198 ms，弱网下会碰到。
 *
 * 改法不是开旁路队列（那会拆掉「全局并发 1」），也不是做队列让步点（`http.js` 不用改 ——
 * 见本文件最后一条：探测是逐块入队的，而 refresh 会自增 epoch，循环每块后据此让位，
 * 「刷新时作废还没发出去的块」这件事故已经在 app 层免费做到了）。改法是给整批一个总预算，
 * 并把**每一块的超时按剩余预算收紧**：队列被这批探测占住的时间有了硬上限（18 s → 8 s）。
 *
 * 本文件压住两条：预算真的生效（慢场景下砍得动），以及预算不误杀（快场景下三块照跑）。
 *
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createFakeDom, installFetch, installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });
const fetchMock = installFetch();

const dom = createFakeDom([{ id: 'app' }, { id: 'banner' }]);
dom.document.readyState = 'loading';

const app = await import('../src/ui/app.js');
const {
  probeTileBatch,
  TILE_PROBE_COUNT,
  TILE_PROBE_BUDGET_MS,
} = app;
const {
  sampleTiles,
  tileUrl,
  clearTileCache,
  setMapMode,
  mapMode,
  degradeMapMode,
  MAP_MODE,
  TILE_TIMEOUT_MS,
} = await import('../src/data/tiles.js');

const ctx = { lat: 39.9087, lon: 116.3975 };

/** 瓦片要么立刻返回字节，要么挂到超时（用于构造「每块都很慢」）。 */
function routeTiles(mode) {
  fetchMock.setHandler((url) => {
    if (url.includes('arcgisonline.com')) {
      if (mode === 'hang') return { hang: true }; // 只有 abort 才 reject
      return { arrayBuffer: new Uint8Array([1, 2, 3, 4]) };
    }
    return { status: 200, json: {} };
  });
}

const tileCalls = () => fetchMock.calls.filter((u) => u.includes('arcgisonline.com'));

beforeEach(() => {
  clearTileCache();
  setMapMode(MAP_MODE.MAP);
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
});

test('预算生效：每块都慢时，整批耗时被压到预算量级（远小于 3 × 6 s）', async () => {
  routeTiles('hang');
  const tiles = sampleTiles(ctx);
  const budgetMs = 500;

  const t0 = Date.now();
  const probes = await probeTileBatch('street', tiles, { count: 3, budgetMs });
  const elapsed = Date.now() - t0;

  // 直接证据：第一块的超时被收紧到预算（500 ms），而不是给满 TILE_TIMEOUT_MS（6000 ms）。
  // 若没收紧，这一块就会挂满 6 s，elapsed 会是 6000 量级。
  assert.ok(elapsed >= 400, `第一块应该真的等到收紧后的超时，实测只用了 ${elapsed} ms`);
  assert.ok(
    elapsed < 1200,
    `整批必须被预算压住：实测 ${elapsed} ms（预算 500 ms）。未收紧时这里是 6000 ms 量级`
  );
  assert.ok(
    elapsed <= budgetMs + 400,
    `整批耗时应 ≤ 预算 + 一点余量，实测 ${elapsed} ms / 预算 ${budgetMs} ms`
  );
  // 3 × 6000 = 18000 是加预算前的理论最坏值，这里必须明显小于它
  assert.ok(elapsed < TILE_PROBE_COUNT * TILE_TIMEOUT_MS, '必须明显小于 18 s 的老最坏值');

  // 预算耗尽后不再发起新块
  assert.ok(probes.length < 3, `预算耗尽后不该再探新块，实际探了 ${probes.length} 块`);
  assert.equal(tileCalls().length, probes.length, '发出去的请求数应与收集到的结果数一致');
  assert.equal(probes[0].ok, false, '挂到超时的块应记为失败');
});

test('预算不误杀：三块都快时全部被探测，整批裁决仍为 map', async () => {
  routeTiles('fast');
  const tiles = sampleTiles(ctx);
  // 直接用生产默认预算值，顺带证明默认值不会误伤正常情况
  assert.equal(TILE_PROBE_BUDGET_MS, 8000, '默认预算应为 8 s（真机峰值 3198 ms）');

  const probes = await probeTileBatch('street', tiles, {
    count: TILE_PROBE_COUNT,
    budgetMs: TILE_PROBE_BUDGET_MS,
  });

  assert.equal(probes.length, 3, `正常情况下三块必须全探，实际 ${probes.length} 块`);
  assert.equal(tileCalls().length, 3, '三块都应真实发出请求');
  assert.ok(probes.every((p) => p.ok), '三块都快时应全部成功');

  // 且裁决不受影响：全成 → map
  assert.equal(degradeMapMode(probes), MAP_MODE.MAP, '三块全成必须判 map');
  assert.equal(mapMode(), MAP_MODE.MAP);
});

test('不传预算时走默认值，行为与显式传 TILE_PROBE_BUDGET_MS 一致', async () => {
  routeTiles('fast');
  const probes = await probeTileBatch('street', sampleTiles(ctx), { count: 3 });
  assert.equal(probes.length, 3, '默认预算下三块也必须全探');
});

test('shouldStop 仍留在循环内：每块之后都会检查（epoch 竞态守卫不许回退）', async () => {
  routeTiles('fast');
  // 永远「已被新一轮覆盖」→ 探完第一块就停，而不是跑完三块才检查一次
  const probes = await probeTileBatch('street', sampleTiles(ctx), {
    count: 3,
    budgetMs: TILE_PROBE_BUDGET_MS,
    shouldStop: () => true,
  });
  assert.equal(probes.length, 1, `shouldStop 必须在每块之后生效，实际探了 ${probes.length} 块`);
  assert.equal(tileCalls().length, 1, '第二块不该再发起请求');
});

test('单块抛异常仍只记该块失败，不中断整批', async () => {
  // 让第一块直接抛（网络异常），后两块正常 → 整批必须继续跑完，拿到 3 条结果。
  // ★按 URL 判别而不是「第几次调用」：harness 的 fetchMock 会对 handler 求值两次
  //   （三元判断里一次、取值一次），带计数副作用的 handler 会被重复触发、把结论带偏。
  const tiles = sampleTiles(ctx);
  const deadUrl = tileUrl('street', tiles[0].z, tiles[0].x, tiles[0].y);
  fetchMock.setHandler((url) => {
    if (url === deadUrl) return { throwNet: true };
    if (url.includes('arcgisonline.com')) return { arrayBuffer: new Uint8Array([5, 6, 7, 8]) };
    return { status: 200, json: {} };
  });

  const probes = await probeTileBatch('street', tiles, { count: 3 });
  assert.equal(probes.length, 3, '一块抛异常不得中断整批');
  assert.equal(probes[0].ok, false, '抛异常的块记为失败');
  assert.equal(probes[1].ok, true);
  assert.equal(probes[2].ok, true);
  // 部分失败 → grid（这条同时压住「三态裁决仍按整批成功率走」）
  assert.equal(degradeMapMode(probes), MAP_MODE.GRID);
});

test('契约：预算确实小于「块数 × 单块超时」，即最坏占用真的被压下来了', () => {
  assert.ok(
    TILE_PROBE_BUDGET_MS < TILE_PROBE_COUNT * TILE_TIMEOUT_MS,
    `预算 ${TILE_PROBE_BUDGET_MS} ms 必须小于 ${TILE_PROBE_COUNT} × ${TILE_TIMEOUT_MS} ms`
  );
  assert.equal(TILE_PROBE_COUNT, 3, '块数不得为省时间降到 2（3 才是区分一块慢与普遍慢的下限）');
});

test('队列让步点：app 层已免费实现，http.js 无需改动（源码级锁定）', () => {
  // 结论：不用给 http.js 的队列加「作废排队中任务」的能力。理由 ——
  //   ① 探测是**逐块入队**的（等上一块返回才入下一块），同一时刻队列里最多 1 个瓦片任务；
  //   ② refresh() → boot() 会在**第一个 await 之前**同步自增 _epoch；
  //   ③ 循环每块之后检查 shouldStop()，于是刷新一发生，第 2/3 块根本不会入队。
  // 剩下唯一「抢不掉」的是已在飞的那块：它已经在 fetch 中，且强杀它会丢样本（可能跌破
  // 2 块门槛 → 本轮不裁决）或逼我们伪造 ok:false（谎报一次没发生过的请求）。所以不做。
  const src = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');

  assert.match(src, /export function refresh\(\)\s*\{\s*return boot\(\);/, 'refresh 必须落到 boot');

  const bootAt = src.indexOf('export async function boot()');
  assert.ok(bootAt > 0, '应能定位 boot()');
  const epochAt = src.indexOf('const epoch = ++_epoch;', bootAt);
  const firstAwaitAt = src.indexOf('await ', bootAt);
  assert.ok(epochAt > 0, 'boot 内应自增 epoch');
  assert.ok(
    epochAt < firstAwaitAt,
    'epoch 自增必须在 boot 的第一个 await 之前（同步生效，刷新当轮就让位）'
  );

  assert.match(
    src,
    /shouldStop: \(\) => epoch !== _epoch/,
    '整批探测必须把 epoch 守卫传进循环（每块之后可让位）'
  );
  // 让位的运行时行为由上面第 4 条（shouldStop 探完一块就停）压住，这里只锁接线。
});
