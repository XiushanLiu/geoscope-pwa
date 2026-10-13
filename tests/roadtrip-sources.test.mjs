/**
 * 自驾模块两路新源 + 坐标算法的契约守卫
 *
 * 钉死这五件事（任何一条破了都是「看起来正常但错了」）：
 *   ① 自检仍是**恰好六路**，全量表是八路（别把新源塞进 SOURCE_LIST）；
 *   ② 两路源的契约数值与缓存键格式（架构 §4.8）；
 *   ③ OSRM 的 URL 是 **lon,lat** 顺序，且 parse 必须把「HTTP 200 但没有路线 /
 *      距离为 0」翻译成具体文案键（不许当成功）；
 *   ④ 高德的 `status:"0"` 必须翻译成**具体的桶**，坐标必须转成 WGS84 且保留 raw；
 *   ⑤ GCJ-02 ↔ WGS84：境内往返残差 < 1 m，境外（东京）原样返回。
 *
 * ⚠️ 口径：本文件里的体积 / 时延 / 偏移数字均为**沙箱实测**（架构 §0），不是真机结论；
 *    断言只钉「算法自洽」这一层（往返残差、方向、边界），不钉真机数值。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sources = await import(pathToFileURL(path.join(ROOT, 'src/data/sources.js')).href);
const roadsources = await import(pathToFileURL(path.join(ROOT, 'src/data/roadsources.js')).href);
const osrm = await import(pathToFileURL(path.join(ROOT, 'src/data/osrm.js')).href);
const amap = await import(pathToFileURL(path.join(ROOT, 'src/data/amap.js')).href);
const geo = await import(pathToFileURL(path.join(ROOT, 'src/core/geo.js')).href);
const apikeys = await import(pathToFileURL(path.join(ROOT, 'src/core/apikeys.js')).href);

/* ------------------------------------------------------------------ */
/* ① 源表拆分                                                          */
/* ------------------------------------------------------------------ */

test('① SOURCE_LIST 仍恰好六路；SOURCE_TABLE 是八路，getSource 能取到自驾两路', () => {
  assert.equal(sources.SOURCE_LIST.length, 6, '自检六路的断言被 tests/sources.test.mjs 钉着，不能动');
  assert.equal(Object.keys(sources.SOURCE_TABLE).length, 8);
  assert.deepEqual(
    sources.SOURCE_LIST.map((s) => s.id),
    ['weather', 'air', 'geocode', 'elevation', 'reverse', 'tile']
  );
  for (const id of ['osrmRoute', 'amapPoi']) {
    assert.ok(sources.getSource(id), `getSource 必须能解析 ${id}`);
    assert.equal(sources.getSource(id).id, id);
    // 新源**不得**进自检列表
    assert.ok(!sources.SOURCE_LIST.some((s) => s.id === id), `${id} 不该进 SOURCE_LIST`);
  }
  assert.equal(sources.getSource('nope'), null);
});

test('① 两路源的契约数值照架构 §4.8 固化', () => {
  const osrmSpec = sources.getSource('osrmRoute');
  assert.equal(osrmSpec.timeoutMs, 9000, 'full+annotations 实测 362 KB，6 s 偏紧');
  assert.equal(osrmSpec.retry, 1);
  assert.equal(osrmSpec.cacheable, false, '★几何禁止落盘');
  assert.equal(osrmSpec.ttlMs, 0);
  assert.equal(osrmSpec.host, 'https://router.project-osrm.org');
  assert.equal(osrmSpec.attributionKey, 'attr.osrm');

  const amapSpec = sources.getSource('amapPoi');
  assert.equal(amapSpec.timeoutMs, 6000);
  assert.equal(amapSpec.retry, 1);
  assert.equal(amapSpec.cacheable, true);
  assert.equal(amapSpec.ttlMs, 21600000, '6 小时，省 5000 次/月配额');
  assert.equal(amapSpec.host, 'https://restapi.amap.com');
  assert.equal(amapSpec.attributionKey, 'attr.amap');
});

/* ------------------------------------------------------------------ */
/* ② URL 与缓存键                                                      */
/* ------------------------------------------------------------------ */

const POINTS = [
  { lat: 39.9087, lon: 116.3975 },
  { lat: 34.3416, lon: 108.9398 },
];

test('② OSRM 的 URL 是 lon,lat 顺序（写反会绕到地球另一侧）', () => {
  const req = osrm.buildRouteRequest({ points: POINTS, overview: 'full' });
  assert.equal(
    req.url,
    'https://router.project-osrm.org/route/v1/driving/116.397500,39.908700;108.939800,34.341600'
  );
  assert.equal(req.params.overview, 'full');
  assert.equal(req.params.geometries, 'geojson');
  assert.equal(req.params.steps, false, 'steps 实测 318 KB，不用它');
  assert.equal(req.params.annotations, 'true', '切段要逐边时长');
  assert.equal(req.responseType, 'json');
});

test('② simplified 不请求 annotations（几何点太少，累积曲线无意义）', () => {
  const req = osrm.buildRouteRequest({ points: POINTS, overview: 'simplified' });
  assert.equal(req.params.overview, 'simplified');
  assert.equal(req.params.annotations, undefined);
});

test('② 点数不足 2 当场失败（OSRM 对单点返回 HTTP 400）', () => {
  assert.throws(
    () => osrm.buildRouteRequest({ points: [{ lat: 39.9, lon: 116.4 }] }),
    (err) => err.messageKey === 'rt.err.needMorePoints'
  );
});

test('② 缓存键格式：osrmRoute 带点列指纹与 overview，amapPoi 六段', () => {
  const osrmSpec = sources.getSource('osrmRoute');
  assert.equal(
    osrmSpec.cacheKey({ points: POINTS, overview: 'full' }),
    'gs:v1:osrmRoute:39.9087,116.3975;34.3416,108.9398:full'
  );
  // 缺 overview 时默认 full（与 build 的默认值一致，否则同一次请求会有两个键）
  assert.equal(osrmSpec.cacheKey({ points: POINTS }), 'gs:v1:osrmRoute:39.9087,116.3975;34.3416,108.9398:full');

  const amapSpec = sources.getSource('amapPoi');
  assert.equal(
    amapSpec.cacheKey({ typecode: '100000', keyword: '如家', lat: 33.0728, lon: 107.0234, radius: 5000 }),
    'gs:v1:amapPoi:100000:%E5%A6%82%E5%AE%B6:33.0728:107.0234:5000'
  );
  // 缺字段不崩
  assert.equal(amapSpec.cacheKey({}), 'gs:v1:amapPoi:::0.0000:0.0000:0');
});

/* ------------------------------------------------------------------ */
/* ③ OSRM parse：业务态必须看得见                                       */
/* ------------------------------------------------------------------ */

/** 造一条两点的 OSRM 响应（geometry 点数 = 边数 + 1）。 */
function fakeRoute(edgeDurations, distance = 25705.4, duration = 1374) {
  const coords = edgeDurations.map((d, i) => [116.3 + i * 0.01, 39.9 + i * 0.01]);
  coords.push([116.3 + edgeDurations.length * 0.01, 39.9 + edgeDurations.length * 0.01]);
  return {
    code: 'Ok',
    routes: [
      {
        distance,
        duration,
        geometry: { type: 'LineString', coordinates: coords },
        legs: [
          {
            distance,
            duration,
            annotation: { duration: edgeDurations },
          },
        ],
      },
    ],
    waypoints: [
      { name: '起点', location: [116.3975, 39.9087], distance: 3.2 },
      { name: '京加路', location: [108.9398, 34.3416], distance: 1580.0 },
    ],
  };
}

test('③ 正常响应：累积曲线长度 = 几何点数，吸附距离与最大吸附都算出来', () => {
  const route = osrm.parseRoute(fakeRoute([100, 200, 300]), { overview: 'full' });
  assert.equal(route.ok, true);
  assert.equal(route.durationKind, 'osrm-freeflow', '★界面必须照此标注「非实时路况」');
  assert.equal(route.geometryPoints, 4);
  assert.deepEqual(route.cumulativeS, [0, 100, 300, 600]);
  assert.equal(route.cumulativeTotalS, 600);
  assert.equal(route.cumulativeKind, 'annotations');
  assert.equal(route.waypoints.length, 2);
  assert.equal(route.waypoints[1].snapDistanceM, 1580);
  assert.equal(route.snapMaxM, 1580, '★吸附距离必须暴露：实测可达 3363 m');
  assert.equal(route.waypoints[1].inputIndex, 1);
  assert.equal(route.legs.length, 1);
  assert.deepEqual(route.legs[0], { fromIndex: 0, toIndex: 1, distanceM: 25705.4, durationS: 1374 });
  assert.equal(route.shape, null);
});

test('③ 多段 legs：累积曲线跨段连续累加（切段的唯一依据）', () => {
  const json = fakeRoute([100, 200]);
  json.routes[0].legs.push({ distance: 500, duration: 60, annotation: { duration: [50, 70] } });
  json.routes[0].geometry.coordinates = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
  json.waypoints.push({ name: '', location: [2, 2], distance: 1 });
  const route = osrm.parseRoute(json, {});
  assert.deepEqual(route.cumulativeS, [0, 100, 300, 350, 420]);
  assert.equal(route.legs.length, 2);
  assert.equal(route.legs[1].fromIndex, 1);
});

test('③ ★两个累计口径分开返回：cumulativeTotalS ≠ durationS，不许拿一个冒充另一个', () => {
  // 用 726 km 那一档的**真实量级**造夹具：Σ annotation = 29860 s，OSRM duration = 29898 s
  //（实测差 38 s / 0.13 %，沙箱口径）。两个值都必须带着，让 UI 能照实写注脚。
  const json = fakeRoute([10000, 10000, 9860]);
  json.routes[0].duration = 29898;
  json.routes[0].distance = 726004.8;
  const route = osrm.parseRoute(json, { overview: 'full' });
  assert.equal(route.cumulativeTotalS, 29860, 'Σ annotation.duration');
  assert.equal(route.durationS, 29898, 'OSRM 自己的总时长（界面展示值）');
  assert.notEqual(route.cumulativeTotalS, route.durationS, '★两者不许被悄悄统一成一个数');
  assert.equal(route.cumulativeS[route.cumulativeS.length - 1], 29860, '累积曲线末值 = Σ annotation');
  // 差值是「小差异」而不是算错：钉住量级，防止哪天差出一个数量级却没人发现
  const diffRatio = (route.durationS - route.cumulativeTotalS) / route.durationS;
  assert.ok(diffRatio >= 0 && diffRatio < 0.02, `差值比例 ${diffRatio} 超出「<1% 量级」的预期`);
});

test('③ annotations 缺失时给 null + kind=none，绝不按距离比例编一条', () => {
  const json = fakeRoute([100, 200]);
  delete json.routes[0].legs[0].annotation;
  const route = osrm.parseRoute(json, {});
  assert.equal(route.cumulativeS, null, '宁可没有依据，也不许编');
  assert.equal(route.cumulativeKind, 'none');
});

test('③ HTTP 200 但 code 不是 Ok → rt.err.noRoute（不许当成功）', () => {
  assert.throws(
    () => osrm.parseRoute({ code: 'InvalidOptions' }, {}),
    (err) => err.messageKey === 'rt.err.noRoute' && err.code === 'BUSINESS'
  );
});

test('③ HTTP 200 但距离为 0 → rt.err.zeroDistance（海上坐标实测如此）', () => {
  assert.throws(
    () => osrm.parseRoute(fakeRoute([0], 0, 0), {}),
    (err) => err.messageKey === 'rt.err.zeroDistance'
  );
});

test('③ 无几何 → rt.err.noGeometry', () => {
  const json = fakeRoute([1]);
  json.routes[0].geometry.coordinates = [];
  assert.throws(() => osrm.parseRoute(json, {}), (err) => err.messageKey === 'rt.err.noGeometry');
});

/* ------------------------------------------------------------------ */
/* ④ 高德：status:"0" 分桶 + 坐标转换                                   */
/* ------------------------------------------------------------------ */

test('④ status:"0" 按 infocode 分成具体桶（用户该做的动作各不相同）', () => {
  const cases = [
    ['10001', 'rt.amap.invalidKey'],
    ['10003', 'rt.amap.quota'],
    ['10004', 'rt.amap.busy'],
    ['10008', 'rt.amap.sig'],
    ['19999', 'rt.amap.other'],
    ['', 'rt.amap.other'],
  ];
  for (const [infocode, key] of cases) {
    assert.equal(amap.bucketOf(infocode), key, `infocode=${infocode}`);
    assert.throws(
      () => amap.parsePoi({ status: '0', info: 'INVALID_USER_KEY', infocode }, {}),
      (err) => err.messageKey === key && err.messageParams.code === infocode
    );
  }
});

test('④ 高德 POI：GCJ-02 必须转成 WGS84，且 raw 与 converted 都留着', () => {
  // 天安门 GCJ-02（= WGS84 加偏后的值）
  const gcj = geo.wgs84ToGcj02(39.9087, 116.3975);
  const json = {
    status: '1',
    count: '1',
    pois: [
      {
        id: 'B0FFH9XJ2L',
        name: '如家酒店·汉中中心广场店',
        type: '住宿服务;宾馆酒店',
        typecode: '100100',
        address: '陕西省汉中市汉台区',
        location: `${gcj.lon},${gcj.lat}`,
        biz_ext: { rating: '4.3', cost: '180' },
      },
    ],
  };
  const out = amap.parsePoi(json, { lat: 39.9087, lon: 116.3975 });
  assert.equal(out.count, 1, '高德的 count 是字符串 "1"，归一成数字');
  assert.equal(out.items.length, 1);
  const item = out.items[0];
  // 转回来必须≈原 WGS84（残差 < 1 m）
  assert.ok(geo.distanceKm(item.coord, { lat: 39.9087, lon: 116.3975 }) * 1000 < 1);
  // ★原文留着：任何时候都能重算
  assert.equal(item.raw.coordSys, 'GCJ-02');
  assert.ok(Math.abs(item.raw.lat - gcj.lat) < 1e-9);
  assert.equal(item.converted, true);
  // 评分与人均：拿到才有值
  assert.equal(item.rating, 4.3);
  assert.equal(item.cost, 180);
  // 直线距离，且标明不是路网距离
  assert.equal(item.distanceKind, 'straight');
  assert.ok(item.distanceM !== null && item.distanceM < 1000);
});

test('④ 高德没给评分/人均 → 就是 null（不许用默认值占位）', () => {
  const json = {
    status: '1',
    count: '1',
    pois: [{ id: 'X', name: '无名店', location: '116.4,39.9' }],
  };
  const item = amap.parsePoi(json, {}).items[0];
  assert.equal(item.rating, null);
  assert.equal(item.cost, null);
  assert.equal(item.typecode, null);
  assert.equal(item.address, null);
  assert.equal(item.distanceM, null, '没有锚点就不算距离，而不是算成 0');
});

test('④ 境外 POI 原样返回且 converted=false', () => {
  const json = {
    status: '1',
    pois: [{ id: 'T', name: 'Tokyo Hotel', location: '139.6503,35.6762' }],
  };
  const item = amap.parsePoi(json, {}).items[0];
  assert.equal(item.coord.lat, 35.6762);
  assert.equal(item.coord.lon, 139.6503);
  assert.equal(item.converted, false, '境外不纠偏，标记必须如实');
});

test('④ 没填 Key：build 当场失败，且 requestRoadSource 把它收敛成 SourceResult', async () => {
  apikeys.clearAmapKey();
  assert.throws(
    () => amap.buildPoiRequest({ lat: 33.07, lon: 107.02, typecode: '100000' }),
    (err) => err.messageKey === 'rt.amap.noKey'
  );

  // ★关键：失败必须是**看得见的**，而且要是一个标准 SourceResult ——
  //   不能变成裸异常冒到 UI 层（那正是「按钮点了没反应」的静默断线）。
  const res = await roadsources.requestRoadSource('amapPoi', { lat: 33.07, lon: 107.02, typecode: '100000' });
  assert.equal(res.ok, false);
  assert.equal(res.sourceId, 'amapPoi');
  assert.equal(res.error.messageKey, 'rt.amap.noKey');
  assert.equal(res.stale, false);
  assert.equal(typeof res.meta.finishedAt, 'number');
});

/**
 * 测试用的假 Key。
 *
 * ★刻意**不是** 32 位纯字母数字：架构 §9 new 增了一条约定「源码里不得出现疑似密钥常量
 *   （32 位字母数字）」，而高德真实 Key 恰好就是 32 位十六进制。留一个 32 位假串在这里，
 *   将来那条扫描上线就会被误判成硬编码密钥 —— 测试自己反倒成了反例。
 */
const FAKE_KEY = 'testkey-4f2a9c7e1b83';

test('④ 填了 Key：URL 带 key，且不带任何凭据头（由 http.js 保证 credentials:omit）', () => {
  assert.equal(apikeys.setAmapKey(`  ${FAKE_KEY}  `), true);
  const req = amap.buildPoiRequest({ lat: 33.0728, lon: 107.0234, typecode: '100000', keyword: '民宿' });
  assert.equal(req.url, 'https://restapi.amap.com/v5/place/text');
  assert.equal(req.params.key, FAKE_KEY, '写入时已 trim');
  assert.equal(req.params.types, '100000');
  assert.equal(req.params.location, '107.0234,33.0728');
  assert.equal(req.params.radius, '5000');
  assert.equal(req.params.extensions, 'all');
  apikeys.clearAmapKey();
  assert.equal(apikeys.hasAmapKey(), false);
});

/* ------------------------------------------------------------------ */
/* ⑤ Key 的存取纪律                                                    */
/* ------------------------------------------------------------------ */

test('⑤ apikeys：非法值一律拒绝（不静默接受），掩码不回显整串', () => {
  assert.equal(apikeys.setAmapKey(''), false, '空串不是「配置成功」');
  assert.equal(apikeys.setAmapKey('   '), false);
  assert.equal(apikeys.setAmapKey('ab cd'), false, '含空白');
  assert.equal(apikeys.setAmapKey('x'.repeat(apikeys.KEY_MAX_LEN + 1)), false);
  assert.equal(apikeys.setAmapKey(null), false);
  assert.equal(apikeys.setAmapKey(12345), false);

  assert.equal(apikeys.setAmapKey(FAKE_KEY), true);
  assert.equal(apikeys.getAmapKey(), FAKE_KEY);
  assert.equal(apikeys.hasAmapKey(), true);
  // 20 位：首 4 + 12 个星 + 末 4
  assert.equal(apikeys.maskKey(FAKE_KEY), 'test************1b83');
  assert.equal(apikeys.maskKey('short'), '*****', '短串整串打星，避免首尾各留 4 位等于全露');
  assert.equal(apikeys.maskKey(''), '');

  assert.equal(apikeys.clearAmapKey(), true);
  assert.equal(apikeys.clearAmapKey(), false, '本来就没配，不假称成功');
});

/* ------------------------------------------------------------------ */
/* ⑥ GCJ-02 ↔ WGS84 坐标算法                                           */
/* ------------------------------------------------------------------ */

/** 六个境内样本（覆盖华东 / 西南 / 西北 / 华南 / 东北）。 */
const CN_SAMPLES = [
  ['北京天安门', 39.9087, 116.3975],
  ['上海人民广场', 31.2304, 121.4737],
  ['成都天府广场', 30.5728, 104.0668],
  ['西安钟楼', 34.3416, 108.9398],
  ['广州', 23.1291, 113.2644],
  ['哈尔滨', 45.8038, 126.535],
];

test('⑥ 境内六样本：加偏方向正确（几百米量级）+ 往返残差 < 1 m', () => {
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

test('⑥ 境外一律原样返回（东京 = 原值，一次都不许挪）', () => {
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

test('⑥ isInOffsetZone 的边界与非数字', () => {
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

test('⑥ 非数字入参不炸（返回原值，由上层决定怎么显示）', () => {
  assert.deepEqual(geo.gcj02ToWgs84(null, null), { lat: null, lon: null });
  assert.deepEqual(geo.wgs84ToGcj02(undefined, undefined), { lat: undefined, lon: undefined });
});
