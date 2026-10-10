/**
 * 瓦片缓存与地图三态降级（2026-10-11 四轮真机实测后新增）
 *
 * 依据 docs/bench/2026-10-11-summary.md：
 *   - 全瓦片 31 个采样点中位 693 ms、范围 247–3198 ms（波动 13 倍，已占 6 s 超时的 53%）；
 *   - 同一 z/x/y 的字节数与指纹跨四轮完全一致 → 瓦片内容确定不变，缓存不会拿到脏数据；
 *   - 故新增「按 URL 的内存 LRU 缓存（96 条 / TTL 7 天）」，并把「失败一次即无地图」改为三态降级。
 *
 * 覆盖：
 *   1) 未授信样式 → 成功也不写缓存；
 *   2) 授信后 → 写缓存；第二次命中缓存（latencyMs 0 / fromCache true / 零网络请求）；
 *   3) useCache:false 强制走真实网络（自检页必须用）；
 *   4) LRU 上限 96 生效（淘汰 lastUsed 最久的）；
 *   5) TTL 过期不命中；
 *   6) 撤销授信 → 清空该样式缓存；
 *   7) degradeMapMode 三态（全成 map / 全败 no-map / 部分 grid / 空批不动）；
 *   8) isNoMapMode() 与 setNoMapMode() 兼容语义（回归）；
 *   9) probeTile 非法坐标零请求（回归）；
 *  10) clearTileCache() 清空。
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { installFetch, installNavigator, installStorage, FakeStorage, installClock, setNow, advance } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });
const fetchMock = installFetch();
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
// TTL 用例必须精确打点，不能靠真实 sleep
const restoreClock = installClock();

const tiles = await import('../src/data/tiles.js');

/** 虚拟时钟基准（固定值，保证每次运行可复现）。 */
const BASE_NOW = 1760000000000;

/** 第 i 块瓦片坐标（彼此不同，保证 URL 与指纹各异）。 */
const T = (i) => ({ z: 12, x: 1000 + i, y: 2000 });

/**
 * 让每块瓦片返回随 z/y/x 变化的字节（否则指纹全同会被判成占位图）。
 *
 * @param {string} url 请求 URL。
 * @returns {Object} mock 响应。
 */
function byteHandler(url) {
  const m = String(url).match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
  const z = m ? Number(m[1]) : 0;
  const y = m ? Number(m[2]) : 0;
  const x = m ? Number(m[3]) : 0;
  return { arrayBuffer: new Uint8Array([z & 255, y & 255, x & 255, (z + y + x) & 255]) };
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  tiles.clearTileCache();
  ['street', 'imagery', 'dark'].forEach((id) => tiles.markStyleTrusted(id, false));
  tiles.setMapMode(tiles.MAP_MODE.MAP);
  setNow(BASE_NOW);
});

after(() => {
  restoreClock();
  tiles.clearTileCache();
});

test('未授信样式：探测成功也不写缓存（占位图不得进缓存）', async () => {
  fetchMock.setHandler(byteHandler);
  const p1 = await tiles.probeTile('street', T(0));
  assert.equal(p1.ok, true, '探测应成功');
  assert.equal(p1.fromCache, false);
  assert.equal(tiles.tileCacheSize(), 0, '未授信时绝不允许写缓存');

  fetchMock.reset();
  const p2 = await tiles.probeTile('street', T(0));
  assert.equal(fetchMock.count, 1, '未授信 → 第二次仍必须走网络');
  assert.equal(p2.fromCache, false);
  assert.equal(tiles.tileCacheSize(), 0);
});

test('授信后：写入缓存，第二次命中且零网络请求', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);

  const first = await tiles.probeTile('street', T(0));
  assert.equal(first.ok, true);
  assert.equal(first.fromCache, false);
  assert.equal(tiles.tileCacheSize(), 1, '授信后必须写入缓存');

  fetchMock.reset();
  const second = await tiles.probeTile('street', T(0));
  assert.equal(fetchMock.count, 0, '命中缓存时一次网络请求都不许发');
  assert.equal(second.fromCache, true);
  assert.equal(second.latencyMs, 0, '命中缓存的时延必须是 0');
  assert.equal(second.fp, first.fp, '指纹必须照实回填');
  assert.equal(second.bytes, first.bytes, '字节数必须照实回填');
  assert.equal(second.httpStatus, first.httpStatus, 'HTTP 状态必须照实回填');
  assert.equal(second.error, null);
});

test('useCache:false 强制走真实网络（自检页测的必须是链路质量）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  await tiles.probeTile('street', T(0));
  assert.equal(tiles.tileCacheSize(), 1);

  fetchMock.reset();
  const forced = await tiles.probeTile('street', T(0), { useCache: false });
  assert.equal(fetchMock.count, 1, 'useCache:false 必须绕过缓存重新请求');
  assert.equal(forced.fromCache, false);
  assert.equal(forced.latencyMs, 0, '虚拟时钟下时延为 0（本用例只关心是否走网络）');
  // 强制刷新拿到的是同一份字节 → 指纹与缓存里的一致
  const cached = await tiles.probeTile('street', T(0));
  assert.equal(cached.fromCache, true);
  assert.equal(cached.fp, forced.fp);
});

test('LRU 上限 96 生效：超限时淘汰 lastUsed 最久的条目', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);

  for (let i = 0; i < tiles.TILE_CACHE_MAX; i += 1) {
    advance(1); // lastUsed 必须有先后之分，否则 LRU 无从区分
    await tiles.probeTile('street', T(i));
  }
  assert.equal(tiles.tileCacheSize(), tiles.TILE_CACHE_MAX, '灌满后 size 等于上限');
  assert.equal(tiles.TILE_CACHE_MAX, 96);

  // 先用一次第 0 条，把它变成「最近用过」
  fetchMock.reset();
  const warm = await tiles.probeTile('street', T(0));
  assert.equal(warm.fromCache, true, '第 0 条此刻仍在缓存里');
  assert.equal(fetchMock.count, 0);

  // 再插一条新的 → 触发淘汰，被淘汰的应是第 1 条（第 0 条刚被用过）
  await tiles.probeTile('street', T(999));
  assert.equal(tiles.tileCacheSize(), tiles.TILE_CACHE_MAX, '超限后 size 仍等于上限');

  fetchMock.reset();
  const evicted = await tiles.probeTile('street', T(1));
  assert.equal(evicted.fromCache, false, '最久未用的第 1 条应已被淘汰');
  assert.equal(fetchMock.count, 1);

  fetchMock.reset();
  const kept = await tiles.probeTile('street', T(0));
  assert.equal(kept.fromCache, true, '近期用过的第 0 条不得被淘汰');
  assert.equal(fetchMock.count, 0);
});

test('TTL 过期后不命中缓存（7 天）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  await tiles.probeTile('street', T(0));

  advance(tiles.TILE_CACHE_TTL_MS - 1000);
  fetchMock.reset();
  const fresh = await tiles.probeTile('street', T(0));
  assert.equal(fresh.fromCache, true, 'TTL 未到 → 仍应命中');
  assert.equal(fetchMock.count, 0);

  advance(2000);
  fetchMock.reset();
  const expired = await tiles.probeTile('street', T(0));
  assert.equal(expired.fromCache, false, 'TTL 过期 → 不得命中');
  assert.equal(fetchMock.count, 1, '过期后必须重新走网络');
  assert.equal(tiles.TILE_CACHE_TTL_MS, 604800000, 'TTL 必须是 7 天');
});

test('撤销授信：立即清空该样式的缓存（占位图一旦确诊，缓存不得留）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  tiles.markStyleTrusted('dark', true);
  await tiles.probeTile('street', T(0));
  await tiles.probeTile('dark', T(1));
  assert.equal(tiles.tileCacheSize(), 2);

  tiles.markStyleTrusted('dark', false);
  assert.equal(tiles.tileCacheSize(), 1, '只清 dark，street 那条要留着');
  assert.equal(tiles.isStyleTrusted('dark'), false);
  assert.equal(tiles.isStyleTrusted('street'), true);

  fetchMock.reset();
  const again = await tiles.probeTile('dark', T(1));
  assert.equal(again.fromCache, false, '撤销授信后该样式不再命中缓存');
  assert.equal(fetchMock.count, 1);
});

test('clearTileCache 清空全部条目', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  await tiles.probeTile('street', T(0));
  await tiles.probeTile('street', T(1));
  assert.equal(tiles.tileCacheSize(), 2);

  tiles.clearTileCache();
  assert.equal(tiles.tileCacheSize(), 0);

  fetchMock.reset();
  const after = await tiles.probeTile('street', T(0));
  assert.equal(after.fromCache, false);
  assert.equal(fetchMock.count, 1);
});

test('degradeMapMode：全成 → map / 全败 → no-map / 部分失败 → grid / 空批不动', () => {
  const ok = { ok: true, fp: 'a' };
  const bad = { ok: false, fp: null };

  assert.equal(tiles.degradeMapMode([ok, ok, ok]), tiles.MAP_MODE.MAP);
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.MAP);

  assert.equal(tiles.degradeMapMode([bad, bad, bad]), tiles.MAP_MODE.NO_MAP);
  assert.equal(tiles.isNoMapMode(), true, '全败 → 纯坐标模式');

  assert.equal(tiles.degradeMapMode([ok, ok, bad]), tiles.MAP_MODE.GRID, '9 块里坏 2 块不代表底图全废');
  assert.equal(tiles.isNoMapMode(), false, 'grid 状态下 isNoMapMode() 必须为 false');

  // 空批：没有证据时不猜，保持当前模式不动
  const before = tiles.mapMode();
  assert.equal(tiles.degradeMapMode([]), before);
  assert.equal(tiles.degradeMapMode(null), before);
  assert.equal(tiles.degradeMapMode(undefined), before);
  assert.equal(tiles.mapMode(), before);

  // 部分失败后又全成 → 必须能回到 map（不可 sticky）
  assert.equal(tiles.degradeMapMode([ok, ok]), tiles.MAP_MODE.MAP);
});

test('probeTile 单块失败不再置位（交由整批裁决）', async () => {
  fetchMock.setFallback({ status: 404, json: {} });
  const p = await tiles.probeTile('street', T(0));
  assert.equal(p.ok, false);
  assert.equal(p.fromCache, false);
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.MAP, '单块失败不得立刻宣布无地图');
  assert.equal(tiles.isNoMapMode(), false);
  assert.equal(fetchMock.count, 1, 'retry 必须为 0');

  assert.equal(tiles.degradeMapMode([p]), tiles.MAP_MODE.NO_MAP, '整批只有这一块且失败 → 才判 no-map');
});

test('兼容回归：setNoMapMode / isNoMapMode 的两态语义不变', () => {
  tiles.setNoMapMode(true);
  assert.equal(tiles.isNoMapMode(), true);
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.NO_MAP);

  tiles.setNoMapMode(false);
  assert.equal(tiles.isNoMapMode(), false);
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.MAP);

  // 非法模式值不得把全局状态打歪
  tiles.setMapMode('nonsense');
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.MAP, '非法模式值必须被忽略');
});

test('兼容回归：probeTile 非法坐标仍然零请求、错误码 PARSE', async () => {
  fetchMock.setHandler(byteHandler);
  const bad = await tiles.probeTile('street', { z: NaN, x: undefined, y: null });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'PARSE');
  assert.equal(bad.fp, null);
  assert.equal(bad.fromCache, false);
  assert.equal(fetchMock.count, 0, '非法坐标一次请求都不许发（不污染数据源）');
  assert.equal(bad.url, null, '非法坐标必须给 url=null：拼出来的 .../tile/NaN/NaN/NaN 不对应任何真实请求，写进导出 JSON 会误导');
  assert.equal(bad.z, null, '非法 z 必须回传 null，不能把 NaN 当坐标');
  assert.ok(bad.error.message.includes('瓦片坐标非法'), '错误文案仍要说明原因，信息不能丢');
});

test('授信持久化：落 localStorage 键 gs:v1:tile-trust:<styleId>，值含 trusted 与 at', () => {
  tiles.markStyleTrusted('street', true);
  const raw = localStorage.getItem('gs:v1:tile-trust:street');
  assert.ok(raw, '授信必须落盘，否则关掉 App 再打开就不授信了（等于缓存永不生效）');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v.trusted, true);
  assert.ok(Number.isFinite(parsed.v.at), '必须记录授信时刻，才能判有效期');
  assert.equal(parsed.ttl, tiles.TILE_TRUST_TTL_MS, 'TTL 必须是 30 天');
  assert.equal(tiles.TILE_TRUST_TTL_MS, 2592000000);
});

test('授信持久化：冷启动（内存无记录）时能从 localStorage 读回授信', () => {
  // 用一个内存里没有记录的 styleId 模拟冷启动路径：
  // beforeEach 已把 street/imagery/dark 三个都写进内存镜像，磁盘读取分支只能靠新 id 触发。
  const coldId = 'cold-boot-style';
  const at = 1760000000000;
  localStorage.setItem(
    `gs:v1:tile-trust:${coldId}`,
    JSON.stringify({ v: { trusted: true, at }, t: at, ttl: tiles.TILE_TRUST_TTL_MS, stale: false })
  );
  assert.equal(tiles.isStyleTrusted(coldId), true, '冷启动必须能读回上一轮自检留下的授信');
  localStorage.removeItem(`gs:v1:tile-trust:${coldId}`);
});

test('授信 30 天过期：视为未授信，且不再写缓存', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  assert.equal(tiles.isStyleTrusted('street'), true);

  advance(tiles.TILE_TRUST_TTL_MS + 1);
  assert.equal(tiles.isStyleTrusted('street'), false, '超过 30 天必须回到未授信');

  const p = await tiles.probeTile('street', T(0));
  assert.equal(p.ok, true, '授信过期只影响缓存，不得影响探测本身');
  assert.equal(tiles.tileCacheSize(), 0, '过期后不得再写缓存');
});

test('授信撤销：清缓存的同时也抹掉持久化记录', () => {
  tiles.markStyleTrusted('street', true);
  assert.ok(localStorage.getItem('gs:v1:tile-trust:street'), '授信后有记录');

  tiles.markStyleTrusted('street', false);
  assert.equal(localStorage.getItem('gs:v1:tile-trust:street'), null, '撤销后记录必须一并抹掉');
  assert.equal(tiles.isStyleTrusted('street'), false);
});

test('localStorage 不可用：授信静默降级为纯内存，瓦片请求不受影响', async () => {
  // 只让「授信那一个键」写失败，模拟配额满 / 隐私模式
  const fragile = new FakeStorage({
    failOn: (key) => String(key).indexOf('gs:v1:tile-trust:') === 0,
  });
  installStorage(fragile);

  fetchMock.setHandler(byteHandler);
  let threw = false;
  try {
    tiles.markStyleTrusted('street', true);
  } catch (err) {
    threw = true;
  }
  assert.equal(threw, false, '存不下授信绝不能抛到调用方');
  assert.equal(tiles.isStyleTrusted('street'), true, '写盘失败时本次会话仍按内存态授信');

  const p = await tiles.probeTile('street', T(0));
  assert.equal(p.ok, true, '授信存不下也必须能正常探测瓦片');
  assert.equal(tiles.tileCacheSize(), 1, '内存授信仍然允许写缓存');

  installStorage(new FakeStorage()); // 归还一个干净的 store，避免影响后续
});

test('缓存命中时也能复位地图模式（网络恢复后不得 sticky）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  await tiles.probeTile('street', T(0));

  tiles.setNoMapMode(true); // 模拟上一轮探测失败进入纯坐标
  assert.equal(tiles.isNoMapMode(), true);

  fetchMock.reset();
  const hit = await tiles.probeTile('street', T(0));
  assert.equal(hit.fromCache, true);
  assert.equal(tiles.isNoMapMode(), false, '命中缓存同样算成功，必须退出无地图模式');
  assert.equal(tiles.mapMode(), tiles.MAP_MODE.MAP);
});
