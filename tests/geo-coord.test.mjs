/**
 * core/geo.js 的 GCJ-02 ↔ WGS84 双向纠偏：**迁回来的回归锁**
 *
 * ★为什么单独开一个文件（不说清楚就会有人以为是新写的测试）：
 *   这 6 个境内样本（往返残差 < 1 m）原本住在 `tests/roadtrip-sources.test.mjs` 里，
 *   2026-10-17 自驾下线时随那个文件一起被删掉了 —— 那是**删除动作造成的回归**，
 *   不是本来就没有断言。本文件把它们**一字不改地迁回**，并补上当年同批的境外 /
 *   边界 / 非数字三組用例，让 core/geo.js 的这两个导出重新有机器守着。
 *
 * ★诚实声明（关于「真实调用路径」，别把本文件当成有活调用方的证据）：
 *   截至 2026-10-17，**这两个函数目前没有活调用方**。历史上唯一的调用方是已删除的
 *   自驾 POI 模块（它拿国内服务返回的 GCJ-02 点位转回 WGS84，好与 Esri 底图同框）。
 *   `src/data/tiles.js` 里虽然出现过这两个函数名，但**只在注释里**（说明「将来若发现
 *   落点与路网错开数百米，再启用 wgs84ToGcj02()」），不是真调用 —— 本文件第 5 组
 *   用例把这条也钉住了，防止有人拿那句注释当成「有人在用」的证据。
 *
 *   所以本文件守的是 **core/geo.js 对外承诺的算法契约**，不是某条线上路径。
 *   它该不该留，取决于「这两个导出还要不要留」，与调用方数量无关。
 *
 * 断言内容（迁移自 tests/roadtrip-sources.test.mjs ⑥，一字未改）：
 *   - 境内六样本：加偏量在 100–1000 m（几百米量级），往返残差 < 1 m；
 *   - 境外一律原样返回（含东京、悉尼、巴黎、纽约）；
 *   - isInOffsetZone 的闭区间边界与非数字入参；
 *   - 非数字入参不炸（返回原值）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const geo = await import('../src/core/geo.js');

/** 六个境内样本（覆盖华东 / 西南 / 西北 / 华南 / 东北）。 */
const CN_SAMPLES = [
  ['北京天安门', 39.9087, 116.3975],
  ['上海人民广场', 31.2304, 121.4737],
  ['成都天府广场', 30.5728, 104.0668],
  ['西安钟楼', 34.3416, 108.9398],
  ['广州', 23.1291, 113.2644],
  ['哈尔滨', 45.8038, 126.535],
];

test('① 境内六样本：加偏方向正确（几百米量级）+ 往返残差 < 1 m', () => {
  for (const [name, lat, lon] of CN_SAMPLES) {
    const gcj = geo.wgs84ToGcj02(lat, lon);
    // 偏移量必须是「几百米」量级：太小说明没加偏（恒等占位），太大说明算错了
    const offsetM = geo.distanceKm({ lat, lon }, gcj) * 1000;
    assert.ok(offsetM > 100 && offsetM < 1000, `${name} 偏移量 ${offsetM.toFixed(1)} m 不在合理区间`);

    const back = geo.gcj02ToWgs84(gcj.lat, gcj.lon);
    const residual = geo.distanceKm({ lat, lon }, back) * 1000;
    assert.ok(residual < 1, `${name} 往返残差 ${residual.toFixed(6)} m 应 < 1 m`);
  }
});

test('② 境外一律原样返回（东京 = 原值，一次都不许挪）', () => {
  const tokyo = { lat: 35.6762, lon: 139.6503 };
  assert.equal(geo.isInOffsetZone(tokyo.lat, tokyo.lon), false);
  const gcj = geo.wgs84ToGcj02(tokyo.lat, tokyo.lon);
  assert.deepEqual(gcj, tokyo);
  const back = geo.gcj02ToWgs84(tokyo.lat, tokyo.lon);
  assert.deepEqual(back, tokyo);
  // 其它境外样本
  for (const [lat, lon] of [[35.6895, 139.6917], [-33.8688, 151.2093], [48.8566, 2.3522], [40.7128, -74.006]]) {
    assert.equal(geo.isInOffsetZone(lat, lon), false);
    assert.deepEqual(geo.gcj02ToWgs84(lat, lon), { lat, lon });
  }
  // ★已知边界（如实记录，不是缺陷掩盖）：判定用的是中国大陆的**粗略外包框**，
  //   新加坡（1.35N, 103.8E）落在框内，会被当成境内加偏。真机上若出现东南亚行程，
  //   正确的修法是用精确国界判定替换 isInOffsetZone —— 改动只在这一处。
  assert.equal(geo.isInOffsetZone(1.3521, 103.8198), true);
});

test('③ isInOffsetZone 的边界与非数字', () => {
  assert.equal(geo.isInOffsetZone(0.8293, 100), true, '纬度下边界（闭区间）');
  assert.equal(geo.isInOffsetZone(0.8292, 100), false);
  assert.equal(geo.isInOffsetZone(55.8271, 100), true, '纬度上边界（闭区间）');
  assert.equal(geo.isInOffsetZone(55.8272, 100), false);
  assert.equal(geo.isInOffsetZone(35, 72.004), true);
  assert.equal(geo.isInOffsetZone(35, 72.003), false);
  assert.equal(geo.isInOffsetZone(35, 137.8347), true);
  assert.equal(geo.isInOffsetZone(35, 137.8348), false);
  // 非数字：宁可不纠偏，也不制造假偏移
  assert.equal(geo.isInOffsetZone(null, 116), false);
  assert.equal(geo.isInOffsetZone(39, undefined), false);
  assert.equal(geo.isInOffsetZone('39.9', '116.4'), true, '数字字符串可解析');
});

test('④ 非数字入参不炸（返回原值，由上层决定怎么显示）', () => {
  assert.deepEqual(geo.gcj02ToWgs84(null, null), { lat: null, lon: null });
  assert.deepEqual(geo.wgs84ToGcj02(undefined, undefined), { lat: undefined, lon: undefined });
});

test('⑤ 反向钉：这两个导出今天没有活调用方（tiles.js 里那句只在注释里）', () => {
  // 为什么要有这条：诚实不是「把缺口写进注释就完事」，而是要让人一眼看出
  // 「有断言」≠「有线上调用方」。万一将来 tiles.js 真的启用了纠偏，
  // 这条会变红 —— 那时应该把它改成正向断言（「tiles.js 确实在调用」），
  // 而不是删掉它。
  const tilesSrc = readFileSync(new URL('../src/data/tiles.js', import.meta.url), 'utf8');
  const codeLines = tilesSrc
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !/^\s*(\/\/|\*|\/\*)/.test(l));
  const realCall = codeLines.some((l) => /gcj02ToWgs84\s*\(|wgs84ToGcj02\s*\(/.test(l));
  assert.equal(
    realCall,
    false,
    'data/tiles.js 目前不应真调用纠偏函数；若本条变红，说明有人启用了瓦片纠偏，' +
      '请把它改成正向断言并同步更新 core/geo.js 文件头那句「今天没有活调用方」'
  );
});
