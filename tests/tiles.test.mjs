/**
 * data/tiles.js 独立验证
 *
 * 覆盖：三种样式 URL 拼装（重点验暗色那条路径层级）/ 未知样式回落 /
 * 指纹 SHA-256 前 16 位 hex 与 size-head 降级 / dedupeTiles 的 real·fake·unknown 判定 /
 * probeTile 成功取到 fp 与字节、失败不抛异常并置无地图模式 / sampleTiles 三位置互不重复。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { installFetch, installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });
const fetchMock = installFetch();
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });

const tiles = await import('../src/data/tiles.js');

const BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

beforeEach(() => {
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  tiles.setNoMapMode(false);
});

test('三种样式 URL 逐一断言（ArcGIS 为 {z}/{y}/{x} 顺序，暗色路径层级不同）', () => {
  assert.equal(
    tiles.tileUrl('street', 12, 3371, 1550),
    `${BASE}World_Street_Map/MapServer/tile/12/1550/3371`,
    'street：World_Street_Map/MapServer/tile/{z}/{y}/{x}'
  );
  assert.equal(
    tiles.tileUrl('imagery', 12, 3371, 1550),
    `${BASE}World_Imagery/MapServer/tile/12/1550/3371`,
    'imagery：World_Imagery/MapServer/tile/{z}/{y}/{x}'
  );
  assert.equal(
    tiles.tileUrl('dark', 12, 3371, 1550),
    `${BASE}Canvas/World_Dark_Gray_Base/MapServer/tile/12/1550/3371`,
    'dark：必须多一层 Canvas/（这是最容易照抄错的一条）'
  );
  // 三种样式的 fmt 声明
  assert.equal(tiles.TILE_STYLES.street.fmt, 'jpeg');
  assert.equal(tiles.TILE_STYLES.imagery.fmt, 'jpeg');
  assert.equal(tiles.TILE_STYLES.dark.fmt, 'png', '暗色底图必须是 png');
  // x/y 不得被调换
  const flip = tiles.tileUrl('street', 3, 7, 5);
  assert.ok(flip.endsWith('/tile/3/5/7'), `必须是 {z}/{y}/{x}，实际 ${flip}`);
});

test('未知样式 id 回落到 street（不返回 undefined URL）', () => {
  assert.equal(tiles.tileUrl('nope', 1, 1, 1), tiles.tileUrl('street', 1, 1, 1));
  assert.equal(tiles.styleLabel('street'), '街道图');
  assert.equal(tiles.styleLabel('imagery'), '影像图');
  assert.equal(tiles.styleLabel('dark'), '暗色图');
  assert.equal(tiles.styleLabel('unknown-style'), 'unknown-style');
});

test('tileUrl 对非法 z/x/y（NaN、字符串）不会抛且不残留未替换占位符', () => {
  const u = tiles.tileUrl('street', NaN, undefined, null);
  assert.ok(!u.includes('{'), `不得残留占位符：${u}`);
  assert.ok(u.startsWith(BASE));
});

test('fingerprint：crypto.subtle 可用时返回 SHA-256 前 16 位 hex', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const r = await tiles.fingerprint(bytes.buffer);
  assert.equal(r.algo, 'sha256-16');
  assert.equal(r.fp.length, 16, '指纹必须是 16 个 hex 字符');
  assert.ok(/^[0-9a-f]{16}$/.test(r.fp), `必须是小写十六进制：${r.fp}`);

  // 与 Node 端独立计算的 SHA-256 前 16 位比对（交叉验证实现正确性）
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(r.fp, hex.slice(0, 16), '必须与标准 SHA-256 截短结果一致');

  // 相同字节 → 相同指纹；不同字节 → 不同指纹
  const again = await tiles.fingerprint(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  assert.equal(again.fp, r.fp);
  const other = await tiles.fingerprint(new Uint8Array([9, 9, 9]).buffer);
  assert.notEqual(other.fp, r.fp);
});

test('fingerprint：crypto.subtle 缺失时降级为 size-head 且不抛', async () => {
  const real = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    const r = await tiles.fingerprint(new Uint8Array([0x41, 0x42, 0x43]).buffer);
    assert.equal(r.algo, 'size-head');
    assert.equal(r.fp, '3:414243', '降级指纹必须是 字节长度:首字节hex');
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: real, configurable: true, writable: true });
  }
});

test('fingerprint：入参为空 / 非 ArrayBuffer 时不抛（UI 层不能因为脏数据白屏）', async () => {
  const empty = await tiles.fingerprint(new Uint8Array(0).buffer);
  assert.ok(typeof empty.fp === 'string');
  const bad = await tiles.fingerprint(undefined);
  assert.ok(/^[0-9a-f]{16}$/.test(bad.fp), `空入参也必须给出合法指纹，实际 ${bad.fp}`);
  const u8 = await tiles.fingerprint(new Uint8Array([1, 2]));
  assert.ok(u8.fp.length > 0);
});

test('dedupeTiles：同一样式三位置指纹各异 → real', () => {
  const probes = [
    { ok: true, fp: 'aaaaaaaaaaaaaaaa' },
    { ok: true, fp: 'bbbbbbbbbbbbbbbb' },
    { ok: true, fp: 'cccccccccccccccc' },
  ];
  const v = tiles.dedupeTiles(probes);
  assert.equal(v.total, 3);
  assert.equal(v.unique, 3);
  assert.equal(v.verdict, 'real', '3 个样本指纹各异必须判定为真实瓦片');
  assert.deepEqual(v.fps, ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
});

test('dedupeTiles：指纹全同 → fake（识破「200 但占位图」的假成功源）', () => {
  const v = tiles.dedupeTiles([
    { ok: true, fp: 'same' },
    { ok: true, fp: 'same' },
    { ok: true, fp: 'same' },
  ]);
  assert.equal(v.total, 3);
  assert.equal(v.unique, 1);
  assert.equal(v.verdict, 'fake');
});

test('dedupeTiles：样本不足（<3）→ unknown；部分重复也 → unknown', () => {
  assert.equal(tiles.dedupeTiles([]).verdict, 'unknown');
  assert.equal(tiles.dedupeTiles([{ ok: true, fp: 'a' }, { ok: true, fp: 'b' }]).verdict, 'unknown', '2 个样本不足以判定');
  // 3 个样本里 2 同 1 异：既非全异也非全同
  const mixed = tiles.dedupeTiles([{ ok: true, fp: 'x' }, { ok: true, fp: 'x' }, { ok: true, fp: 'y' }]);
  assert.equal(mixed.verdict, 'unknown', '部分重复应保守判 unknown');
  // 失败样本不计入
  const withFails = tiles.dedupeTiles([
    { ok: false, fp: null },
    { ok: true, fp: 'a' },
    { ok: true, fp: 'b' },
    { ok: true, fp: 'c' },
  ]);
  assert.equal(withFails.total, 3, '失败的 probe 不得计入样本数');
  assert.equal(withFails.verdict, 'real');
  // 脏输入
  assert.equal(tiles.dedupeTiles(null).total, 0);
  assert.equal(tiles.dedupeTiles([null, undefined, {}]).verdict, 'unknown');
});

test('probeTile 成功：返回 z/x/y/bytes/fp/fpAlgo，且不切换无地图模式', async () => {
  fetchMock.setFallback({ arrayBuffer: new Uint8Array([1, 2, 3, 4]), headers: { 'content-type': 'image/jpeg' } });
  const p = await tiles.probeTile('dark', { z: 12, x: 3371, y: 1550 });
  assert.equal(p.ok, true);
  assert.equal(p.styleId, 'dark');
  assert.equal(p.label, '暗色图');
  assert.equal(p.z, 12);
  assert.equal(p.x, 3371);
  assert.equal(p.y, 1550);
  assert.equal(p.bytes, 4);
  assert.equal(p.httpStatus, 200);
  assert.ok(typeof p.latencyMs === 'number');
  assert.ok(/^[0-9a-f]{16}$/.test(p.fp), `必须给出 16 位 hex 指纹，实际 ${p.fp}`);
  assert.equal(p.fpAlgo, 'sha256-16');
  assert.equal(p.error, null);
  assert.equal(tiles.isNoMapMode(), false, '成功时不得切换无地图模式');
});

test('probeTile 失败：不抛异常、置无可用的 fp、不重试；单块失败不再置位，交由 degradeMapMode 整批裁决', async () => {
  // ★2026-10-11 真机实测后改契约：瓦片时延波动 13 倍（247–3198 ms），
  //   一次慢/失败就把整张地图打没代价太大，故「失败一次即切无地图」退场，
  //   改成整批探测结束后由 degradeMapMode() 三态裁决（全败才 no-map）。
  fetchMock.setFallback({ status: 404, json: {} });
  const p = await tiles.probeTile('street', { z: 12, x: 1, y: 1 });
  assert.equal(p.ok, false);
  assert.equal(p.fp, null);
  assert.equal(p.fpAlgo, null);
  assert.equal(p.error.code, 'HTTP');
  assert.equal(p.httpStatus, 404);
  assert.equal(tiles.isNoMapMode(), false, '单块失败不得立刻宣布无地图（要等整批裁决）');
  assert.equal(tiles.mapMode(), 'map', '单块失败时模式保持不动');
  assert.equal(fetchMock.count, 1, 'retry 必须为 0：只允许一次尝试');

  // 整批只有这一块且它失败了 → 才判 no-map
  assert.equal(tiles.degradeMapMode([p]), 'no-map');
  assert.equal(tiles.isNoMapMode(), true);

  const health = await import('../src/data/health.js');
  assert.equal(health.isMapDisabled(), true, 'health 的口径必须与 tiles 单一状态源一致');
});

test('probeTile 网络异常/超时也不抛；单块失败不置位，整批裁决才切 no-map', async () => {
  fetchMock.setFallback({ throwNet: true });
  const p = await tiles.probeTile('imagery', { z: 5, x: 1, y: 1 });
  assert.equal(p.ok, false);
  assert.equal(p.error.code, 'NETWORK');
  assert.equal(p.fp, null);
  assert.equal(tiles.isNoMapMode(), false, '单块失败先不宣布无地图');
  assert.equal(tiles.degradeMapMode([p]), 'no-map');
  assert.equal(tiles.isNoMapMode(), true);
});

test('sampleTiles：同一层级生成 3 个互不相同的坐标，且落在 [0, 2^z-1] 内', () => {
  const list = tiles.sampleTiles({ lat: 39.9087, lon: 116.3975 });
  assert.equal(list.length, 3);
  for (const t of list) {
    assert.equal(t.z, 12);
    assert.ok(t.x >= 0 && t.x < 4096, `x 越界：${t.x}`);
    assert.ok(t.y >= 0 && t.y < 4096, `y 越界：${t.y}`);
  }
  const key = (t) => `${t.z}/${t.x}/${t.y}`;
  assert.equal(new Set(list.map(key)).size, 3, '三个取样位置必须互不相同（否则无法识破占位图）');
  // 默认坐标（不传参）也必须可用
  const def = tiles.sampleTiles();
  assert.equal(def.length, 3);
  assert.equal(new Set(def.map(key)).size, 3);
  // 极端坐标（极区 / ±180）不得产生越界或 NaN：
  // 当 lat±0.15 越过 ±90° 时 Math.log 得到 NaN，现有实现未做有限性钳制（见报告缺陷项）
  for (const coord of [{ lat: 89.9, lon: -179.9 }, { lat: 90, lon: 0 }, { lat: -89.9, lon: 0 }, { lat: 0, lon: 180 }]) {
    for (const t of tiles.sampleTiles(coord)) {
      assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), `坐标 ${JSON.stringify(coord)} 生成了非法瓦片 ${JSON.stringify(t)}`);
      assert.ok(t.x >= 0 && t.x < 4096 && t.y >= 0 && t.y < 4096);
    }
  }
});

test('setNoMapMode 可被显式复位（供新一轮探测使用）', () => {
  tiles.setNoMapMode(true);
  assert.equal(tiles.isNoMapMode(), true);
  tiles.setNoMapMode(false);
  assert.equal(tiles.isNoMapMode(), false);
});
