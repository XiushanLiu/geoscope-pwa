/**
 * 底图渲染（S57 街道样式 / S58 GRID 降级）回归
 *
 * 这一组用例盯的是「渲染侧特有的、探测侧抓不到」的五类错：
 *   1) `lonLatToTile` 与 `sampleTiles` 结果一致 —— 防两份换算实现漂移
 *      （瓦片号算错不报错，只会静默错位几百公里）；
 *   2) 瓦片 URL 顺序必须是 `{z}/{y}/{x}` —— 防写反（写反同样不报错，只会拉到别的半球）；
 *   3) 缓存命中走 Blob URL 且**被 revoke** —— 防在 96 块 LRU 之外再漏一份内存；
 *   4) GRID 态失败块留白 + × —— 防「半残被渲染成全好」；
 *   5) 署名非空且随样式切换 —— Esri 条款硬要求，漏了就是违约。
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  installFetch,
  installNavigator,
  installStorage,
  FakeStorage,
  createFakeDom,
} from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });
const fetchMock = installFetch();
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });

/* ---------- Blob URL 桩：Node 没有 createObjectURL，自己记账以便断言 revoke ---------- */
const _created = [];
const _revoked = [];
URL.createObjectURL = (blob) => {
  const u = `blob:qa/${_created.length}`;
  _created.push(u);
  return u;
};
URL.revokeObjectURL = (u) => {
  _revoked.push(u);
};

const dom = createFakeDom([{ id: 'app' }]);
const root = dom.byId.app;

const tiles = await import('../src/data/tiles.js');
const map = await import('../src/ui/map.js');

/** 北京天安门（WGS84），与 geo.js 的 DEFAULT_PLACE 一致。 */
const ctx = { lat: 39.9087, lon: 116.3975 };

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

/**
 * 取渲染结果里所有 img 节点。
 *
 * @param {Object} box 卡片槽位。
 * @returns {Array<Object>} img 节点。
 */
function imgs(box) {
  // FakeNode.tagName 是**大写**（与真实 DOM 一致）
  return box.descendants().filter((n) => n.tagName === 'IMG');
}

beforeEach(() => {
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  tiles.clearTileCache();
  ['street', 'imagery', 'dark'].forEach((id) => tiles.markStyleTrusted(id, false));
  tiles.setMapMode(tiles.MAP_MODE.MAP);
  map.setMapView({ styleId: 'street', zoom: tiles.DEFAULT_ZOOM, coord: ctx });
  _created.length = 0;
  _revoked.length = 0;
});

after(() => {
  tiles.clearTileCache();
});

/* ------------------------------------------------------------------ */
/* 1. 换算一致性                                                        */
/* ------------------------------------------------------------------ */

test('lonLatToTile 与 sampleTiles 完全一致（防两份换算实现漂移）', () => {
  const samples = tiles.sampleTiles(ctx);
  const offsets = [
    { lat: ctx.lat, lon: ctx.lon },
    { lat: ctx.lat + 0.15, lon: ctx.lon + 0.15 },
    { lat: ctx.lat - 0.15, lon: ctx.lon - 0.15 },
  ];
  assert.equal(samples.length, offsets.length);
  offsets.forEach((c, i) => {
    const one = tiles.lonLatToTile(c.lat, c.lon, tiles.DEFAULT_ZOOM);
    assert.deepEqual(
      { z: samples[i].z, x: samples[i].x, y: samples[i].y },
      { z: one.z, x: one.x, y: one.y },
      `第 ${i} 个取样点：sampleTiles 必须走 lonLatToTile，不能另算一份`
    );
  });
});

test('lonLatToTile 在极区与非法入参下仍返回合法瓦片号（不产生 NaN）', () => {
  for (const c of [{ lat: 90, lon: 180 }, { lat: -90, lon: -180 }, { lat: NaN, lon: undefined }, {}]) {
    const t = tiles.lonLatToTile(c.lat, c.lon, 12);
    assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), `${JSON.stringify(c)} → x/y 必须有限`);
    assert.ok(t.x >= 0 && t.x < 2 ** 12 && t.y >= 0 && t.y < 2 ** 12, '必须钳在 [0, 2^z)');
  }
});

/* ------------------------------------------------------------------ */
/* 2. URL 顺序                                                          */
/* ------------------------------------------------------------------ */

test('tileUrl 顺序是 {z}/{y}/{x}（写反会静默拉到别的半球）', () => {
  const u = tiles.tileUrl('street', 12, 3373, 1550);
  assert.ok(u.endsWith('/tile/12/1550/3373'), `列号 3373 必须出现在最后一段，实际 ${u}`);
  assert.ok(!u.endsWith('/tile/12/3373/1550'), '不得写成 {z}/{x}/{y}');
  // 三种样式都必须同序（dark 路径多一层 Canvas，最容易抄错）
  for (const id of ['street', 'imagery', 'dark']) {
    const s = tiles.tileUrl(id, 12, 3373, 1550);
    assert.ok(/\/tile\/12\/1550\/3373$/.test(s), `${id} 的瓦片段顺序必须是 z/y/x，实际 ${s}`);
  }
});

test('渲染出来的 img src 也遵守 z/y/x（不只测 tileUrl 本身）', () => {
  map.renderMapCard(root, { coord: ctx });
  const list = imgs(root.querySelector('#card-map'));
  assert.ok(list.length > 0, '应渲染出瓦片 img');
  const center = tiles.lonLatToTile(ctx.lat, ctx.lon, tiles.DEFAULT_ZOOM);
  const centerUrl = tiles.tileUrl('street', center.z, center.x, center.y);
  assert.ok(
    list.some((n) => n.attrs.get('src') === centerUrl),
    `必须有一块指向中心瓦片 ${centerUrl}`
  );
});

/* ------------------------------------------------------------------ */
/* 3. Blob URL 与回收                                                   */
/* ------------------------------------------------------------------ */

test('缓存命中走 Blob URL，且加载完成后被 revoke（不漏内存）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);

  // 先把中心块探测进缓存（授信后才允许写缓存）
  const center = tiles.lonLatToTile(ctx.lat, ctx.lon, tiles.DEFAULT_ZOOM);
  const probe = await tiles.probeTile('street', { z: center.z, x: center.x, y: center.y });
  assert.equal(probe.ok, true, '探测应成功');
  assert.equal(tiles.tileCacheSize(), 1, '授信后应写进缓存');

  _created.length = 0;
  _revoked.length = 0;
  map.renderMapCard(root, { coord: ctx });

  assert.ok(_created.length >= 1, '命中缓存的块必须走 createObjectURL，而不是再发一次网络请求');
  const hit = imgs(root.querySelector('#card-map')).filter((n) =>
    String(n.attrs.get('src') || '').startsWith('blob:')
  );
  assert.equal(hit.length, _created.length, '每个 Blob URL 都应挂在某个 img 上');

  // 加载完成 → 必须回收
  await hit[0].fire('load');
  assert.ok(_revoked.includes(hit[0].attrs.get('src')), 'img 加载完成后必须 revoke 那个 Blob URL');
});

test('重渲染会回收上一批 Blob URL（翻样式不留残留）', async () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', true);
  const center = tiles.lonLatToTile(ctx.lat, ctx.lon, tiles.DEFAULT_ZOOM);
  await tiles.probeTile('street', { z: center.z, x: center.x, y: center.y });

  map.renderMapCard(root, { coord: ctx });
  const first = _created.slice();
  assert.ok(first.length >= 1);

  map.renderMapCard(root, { coord: ctx }); // 同参数再渲一次
  assert.ok(
    first.every((u) => _revoked.includes(u)),
    '重渲染前必须把上一批 Blob URL 全部 revoke'
  );
});

test('未授信时不写缓存，渲染侧也就拿不到 Blob URL（授信门不被绕过）', () => {
  fetchMock.setHandler(byteHandler);
  tiles.markStyleTrusted('street', false);
  map.renderMapCard(root, { coord: ctx });
  assert.equal(_created.length, 0, '未授信 → 缓存为空 → 全部走网络 URL');
});

/* ------------------------------------------------------------------ */
/* 4. GRID 降级呈现                                                     */
/* ------------------------------------------------------------------ */

test('GRID 态：失败的块留白 + ×，成功的不受影响', async () => {
  tiles.setMapMode(tiles.MAP_MODE.GRID);
  map.renderMapCard(root, { coord: ctx });

  const box = root.querySelector('#card-map');
  const list = imgs(box);
  assert.ok(list.length > 0);
  assert.equal(box.querySelectorAll('.map-cell--fail').length, 0, '还没失败时不该有空洞块');

  // 让其中一块失败
  await list[0].fire('error');
  const failed = box.querySelectorAll('.map-cell--fail');
  assert.equal(failed.length, 1, '失败块必须留白（map-cell--fail）');
  assert.equal(failed[0].querySelectorAll('.map-cell-x').length, 1, '失败块必须给 × 标记');
  assert.ok(text(box).indexOf('块') !== -1, '明细行应报出块数');
});

test('NO_MAP 态：一块都不请求，视口给纯坐标提示', () => {
  tiles.setMapMode(tiles.MAP_MODE.NO_MAP);
  map.renderMapCard(root, { coord: ctx });
  const box = root.querySelector('#card-map');
  assert.equal(imgs(box).length, 0, 'no-map 时不得发起任何瓦片请求');
  assert.ok(box.querySelectorAll('.map-viewport--nomap').length === 1, '视口应切成纯坐标态');
});

/** 取子树纯文本。 */
function text(node) {
  return node ? node.textContent : '';
}

/* ------------------------------------------------------------------ */
/* 5. 署名                                                              */
/* ------------------------------------------------------------------ */

test('署名非空、含 Powered by Esri，且随样式切换', () => {
  map.renderMapCard(root, { coord: ctx });
  const box = root.querySelector('#card-map');
  const creditOf = () => {
    const v = box.querySelector('.map-credit-v');
    return v ? v.textContent : '';
  };

  const street = creditOf();
  assert.ok(street.length > 0, '署名不得为空（Esri 条款硬要求）');
  assert.ok(street.indexOf('Powered by Esri') !== -1, '必须带 Esri 技术署名');
  assert.equal(street, tiles.tileAttribution('street'));

  // 切到影像：署名串必须变（两路底图的数据提供方不同）
  map.setMapView({ styleId: 'imagery' });
  map.renderMapCard(root, { coord: ctx });
  const imagery = creditOf();
  assert.ok(imagery.length > 0);
  assert.notEqual(imagery, street, '署名必须随样式切换，不能永远是街道那一条');
  assert.equal(imagery, tiles.tileAttribution('imagery'));
});

test('三个样式的署名互不相同且都非空（漏一路就是违约）', () => {
  for (const id of ['street', 'imagery', 'dark']) {
    const a = tiles.tileAttribution(id);
    assert.ok(a && a.trim().length > 0, `${id} 的署名不得为空`);
    assert.ok(a.indexOf('Powered by Esri') !== -1, `${id} 必须带 Powered by Esri`);
  }
  const set = new Set(['street', 'imagery', 'dark'].map((id) => tiles.tileAttribution(id)));
  assert.equal(set.size, 3, '三路署名必须各不相同');
});

/* ------------------------------------------------------------------ */
/* 6. 缩放边界                                                          */
/* ------------------------------------------------------------------ */

test('缩放被钳在 MIN_ZOOM..MAX_ZOOM，越界入参不会污染 URL', () => {
  assert.equal(map.setMapView({ zoom: 99 }).zoom, tiles.MAX_ZOOM);
  assert.equal(map.setMapView({ zoom: -5 }).zoom, tiles.MIN_ZOOM);
  map.renderMapCard(root, { coord: ctx, zoom: 99 });
  const srcs = imgs(root.querySelector('#card-map')).map((n) => String(n.attrs.get('src')));
  assert.ok(srcs.every((s) => !/NaN|undefined/.test(s)), `不得出现脏 URL：${srcs.join(' | ')}`);
  assert.ok(
    srcs.every((s) => new RegExp(`/tile/${tiles.MAX_ZOOM}/`).test(s)),
    '越界缩放必须被钳到 MAX_ZOOM'
  );
});

test('缩放控件在边界处禁用（不给出无效按钮）', () => {
  map.renderMapCard(root, { coord: ctx, zoom: tiles.MAX_ZOOM });
  const box = root.querySelector('#card-map');
  const btns = box.querySelectorAll('.map-zoom-btn');
  assert.equal(btns.length, 2, '放大 / 缩小两个按钮');
  assert.ok(btns[0].attrs.has('disabled'), '已在最大层级 → 放大按钮必须禁用');
  assert.ok(!btns[1].attrs.has('disabled'), '缩小按钮仍可用');
});
