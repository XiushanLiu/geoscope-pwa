/**
 * 自驾路线图 / 搬家（架构 §7 T05）
 *
 * 为什么单独一个文件：`roadtrip-model.test.mjs` 测行程数据模型、`roadtrip-plan.test.mjs`
 * 测切段算法、`roadtrip-ui.test.mjs` 测规划主流程，都不碰**投影**。而 T05 最容易烂、
 * 又最难靠肉眼发现的三处全在投影与降级上：
 *
 *   1) **fitBounds 的层级选择**。自己再写一份墨卡托，底图按 A 投影铺、路线按 B 投影画，
 *      表现是「路画在河上」—— 而且**没有任何报错**。这里用「越大跨度 → 越低层级」的
 *      单调性与边界（降到 MIN_ZOOM 时 covers 必须为 false）把它钉住。
 *   2) **投影正确性**。中心点必须落在视口正中；东移一整块瓦片必须恰好是 +256 px。
 *      差一点就会整体偏移，而偏移是静默的。
 *   3) **无几何降级与 coord:null**。没有几何时必须画**虚线 + 标注**（实线会被当成真实
 *      路径）；没有坐标的打卡**不许**变成图上的一个点（那等于给「没记录」编了个位置）。
 *
 * 另外一条：导出 → 在另一台机器导入必须出**等价行程**（round-trip）。
 *
 * 还有一条**零回归**断言：本轮为了装下整程给路线图放宽了缩放下界（`ROADMAP_MIN_ZOOM`），
 *   而放宽的手段是动 `src/ui/map.js`。★「动 map.js 不许影响此刻屏」必须有证据，不能只
 *   靠「我觉得没影响」—— 见文末那条用例（DEFAULT_ZOOM 值钉死 + app.js 不传 zoom +
 *   不传下界时钳位仍按 MIN_ZOOM）。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage（零第三方依赖）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeDom, installNavigator, installStorage, installFetch, FakeStorage } from './harness.mjs';

// store.js / cache.js 在**模块加载期**就决定走内存还是 localStorage，必须先装全局。
installStorage(new FakeStorage());
installNavigator({ online: true });
// renderMapCard() 铺瓦片时不发 fetch（只建 <img src>），但装上以防将来改成取数
installFetch();

const dom = createFakeDom([{ id: 'app' }]);

const { fitBoundsZoom, projectRoute, renderRouteCard } = await import('../src/ui/roadmap.js');
const { lonLatToTile, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM, TILE_SIZE, tileAttribution } = await import('../src/data/tiles.js');
const { VIEW_W, VIEW_H, ROADMAP_MIN_ZOOM, mapView, setMapView } = await import('../src/ui/map.js');
const { t } = await import('../src/i18n/index.js');
const { newTrip, exportTrips, inspectTripFile, applyTripFile, slimTrip } = await import('../src/core/roadtrip.js');

/** ★视口尺寸直接从 src/ui/map.js 取，不抄一份：抄了就会和底图的视口错位（静默）。 */
assert.equal(VIEW_W, 350, '视口宽与 map.js 一致（改动前先读 map.js 的 VIEW_W 注释）');
assert.equal(VIEW_H, 260, '视口高与 map.js 一致');

/** 成都 → 西安（真实夹具 `fixtures/osrm-cd-xian.json` 的两端）。 */
const CD = { lat: 30.572795, lon: 104.066298 };
const XA = { lat: 34.222612, lon: 108.948 };

/* ------------------------------------------------------------------ */
/* fitBounds                                                           */
/* ------------------------------------------------------------------ */

test('fitBounds：跨度越大层级越低（单调性）', () => {
  const near = fitBoundsZoom({ minLat: 30.57, maxLat: 30.60, minLon: 104.06, maxLon: 104.09 });
  const city = fitBoundsZoom({ minLat: 30.40, maxLat: 30.80, minLon: 103.80, maxLon: 104.40 });
  const trip = fitBoundsZoom({ minLat: CD.lat, maxLat: XA.lat, minLon: CD.lon, maxLon: XA.lon });

  assert.ok(near.z >= city.z, `近景层级 ${near.z} 不应低于城区 ${city.z}`);
  assert.ok(city.z >= trip.z, `城区层级 ${city.z} 不应低于整程 ${trip.z}`);
  assert.ok(near.z > MIN_ZOOM, '几百米的跨度不该降到底层');
  assert.equal(near.covers, true, '几公里的跨度应当装得下');
  // ★成都→西安（约 716 km）**装得下**：这是本轮放宽下界之后的事实。
  //   不放宽时 z10 一屏只约 48 km（= 360° × 350 / (256 × 2^10)），716 km 需要 z≈6，
  //   而 tiles.js 的 MIN_ZOOM = 10 —— 那时 covers 只能是 false，「路线图」装不下整程。
  //   现在路线图用 ROADMAP_MIN_ZOOM = 3 作下界（实测 z3–z6 Esri 均有真瓦片，
  //   数据见 src/ui/map.js 的 ROADMAP_MIN_ZOOM 注释），整程落到 **z6**。
  // ★这条断言是变异点：把 ROADMAP_MIN_ZOOM 改回 10，它必须红（见文末注释）。
  assert.equal(trip.covers, true, '716 km 必须真的装得下（放宽下界就是为了这个）');
  assert.equal(trip.z, 6, `716 km 实测落在 z6，实际 z${trip.z}`);
  assert.ok(trip.z < MIN_ZOOM, '整程层级必须低于街道级下界 —— 否则等于没放宽');
});

test('★716 km 真的装得下：一屏宽度必须 ≥ 716 km（不许靠 covers=true 自欺）', () => {
  const trip = fitBoundsZoom({ minLat: CD.lat, maxLat: XA.lat, minLon: CD.lon, maxLon: XA.lon });
  // 赤道处一屏的东西向公里数（视口宽 VIEW_W，世界宽 TILE_SIZE × 2^z）
  const spanKmAt = (z) => ((360 * VIEW_W) / (TILE_SIZE * 2 ** z)) * 111;
  assert.ok(
    spanKmAt(trip.z) >= 716,
    `z${trip.z} 一屏约 ${spanKmAt(trip.z).toFixed(0)} km（赤道处），装不下 716 km —— covers 不许是 true`
  );
  assert.equal(trip.covers, true);
});

test('★放宽的下界必须真的传到 setMapView：否则路线按 z6 投影、底图仍按 z10 铺', () => {
  // ★这是本轮唯一的跨模块隐式契约：fitBounds 算得出 z6 不算数，**底图**也得按 z6 铺。
  //   两者不一致时路线会画在错的地方，而且没有任何报错 —— 只能靠这条断言发现。
  const box = renderRouteCard(dom.byId.app, { points: [CD, XA], styleId: 'street' });
  assert.ok(box, '渲染应成功');
  assert.equal(mapView().zoom, 6, `底图视图必须是 fitBounds 算出的 z6，实际 z${mapView().zoom}`);
});

test('fitBounds：极端跨度仍装不下 —— 退到下界并把 covers 置 false，不许硬抬层级裁掉路线', () => {
  // 横跨欧亚（约 130°）：连 z3 都装不进 350×260
  const huge = fitBoundsZoom({ minLat: 10, maxLat: 60, minLon: -10, maxLon: 120 });
  assert.equal(huge.z, ROADMAP_MIN_ZOOM, '装不下时必须退到路线图的层级下界');
  assert.equal(huge.covers, false, '★covers=false 是给用户的说明：可能看不全');
  assert.notEqual(huge.z, MAX_ZOOM, '绝不许为了「装得下」而硬抬层级');
});

test('fitBounds：中心取墨卡托中点（高纬度不偏北）', () => {
  const b = { minLat: 60, maxLat: 70, minLon: 100, maxLon: 110 };
  const fit = fitBoundsZoom(b);
  // 高纬度段：纬度算术中点 65° 在墨卡托上明显偏北，正确中心应低于 65°
  assert.ok(
    fit.center.lat > 65,
    `高纬度段的中心必须取墨卡托中点（等像素间距的中点比算术中点 65° 更靠北），实际 ${fit.center.lat}`
  );
  assert.ok(fit.center.lat > 60, `中心不能跑出包围盒，实际 ${fit.center.lat}`);
  assert.ok(Math.abs(fit.center.lon - 105) < 1e-6, `经度中点应为 105，实际 ${fit.center.lon}`);
});

/* ------------------------------------------------------------------ */
/* 投影                                                                */
/* ------------------------------------------------------------------ */

test('投影正确性：中心点落在视口正中', () => {
  const fit = fitBoundsZoom({ minLat: CD.lat, maxLat: XA.lat, minLon: CD.lon, maxLon: XA.lon });
  const [p] = projectRoute([fit.center], fit.center, fit.z);
  assert.ok(Math.abs(p.x - VIEW_W / 2) < 1e-6, `中心 x 应为 ${VIEW_W / 2}，实际 ${p.x}`);
  assert.ok(Math.abs(p.y - VIEW_H / 2) < 1e-6, `中心 y 应为 ${VIEW_H / 2}，实际 ${p.y}`);
});

test('投影正确性：东移一整块瓦片恰好 +256 px（与 lonLatToTile 同一份换算）', () => {
  const z = 12;
  const center = { lat: 30.5, lon: 104.0 };
  const east = { lat: 30.5, lon: 104.0 + 360 / 2 ** z };
  const [a] = projectRoute([center], center, z);
  const [b] = projectRoute([east], center, z);
  assert.ok(Math.abs(b.x - a.x - TILE_SIZE) < 1e-6, `东移一整块瓦片应是 +${TILE_SIZE}px，实际 ${b.x - a.x}`);
});

test('投影正确性：像素差与 lonLatToTile 的瓦片差逐点一致', () => {
  const z = 11;
  const center = { lat: 31.2, lon: 105.4 };
  const pts = [
    { lat: 30.9, lon: 104.8 },
    { lat: 32.1, lon: 106.7 },
    { lat: 30.2, lon: 103.9 },
  ];
  const proj = projectRoute(pts, center, z);
  assert.equal(proj.length, pts.length, '有效坐标一个都不能丢');
  const ct = lonLatToTile(center.lat, center.lon, z);
  for (let i = 0; i < pts.length; i += 1) {
    const tp = lonLatToTile(pts[i].lat, pts[i].lon, z);
    const wantX = VIEW_W / 2 + (tp.x + tp.fx - (ct.x + ct.fx)) * TILE_SIZE;
    const wantY = VIEW_H / 2 + (tp.y + tp.fy - (ct.y + ct.fy)) * TILE_SIZE;
    assert.ok(Math.abs(proj[i].x - wantX) < 1e-6, `第 ${i} 点 x 与 lonLatToTile 不一致`);
    assert.ok(Math.abs(proj[i].y - wantY) < 1e-6, `第 ${i} 点 y 与 lonLatToTile 不一致`);
  }
});

test('投影：缺坐标的点被跳过，绝不被当成 (0,0) 画上去', () => {
  const center = { lat: 30.5, lon: 104.0 };
  const out = projectRoute([{ lat: null, lon: null }, center, {}], center, 12);
  assert.equal(out.length, 1, '只有坐标齐全的点才该被投影');
  assert.ok(Math.abs(out[0].x - VIEW_W / 2) < 1e-6);
});

/* ------------------------------------------------------------------ */
/* 卡片                                                                */
/* ------------------------------------------------------------------ */

test('★Esri 署名行必须保留且随样式切换：删掉一行字就是违约', () => {
  const box = renderRouteCard(dom.byId.app, {
    points: [CD, XA],
    markers: [{ ...CD, name: '成都', kind: 'stay' }],
    styleId: 'street',
  });
  const credit = box.querySelector('.map-credit');
  assert.ok(credit, '必须有 .map-credit 署名行');
  // ★连「被隐藏」也算删：署名行看不见 = 不构成署名，条款上等同于删掉
  assert.equal(credit.hidden, false, '署名行不许被隐藏');
  assert.equal(credit.parentNode !== null, true, '署名行不许被摘掉');
  assert.ok(
    credit.textContent.indexOf(tileAttribution('street')) !== -1,
    `署名行要带 Esri 署名串，实际：${credit.textContent}`
  );
});

test('★隐藏 .map-pin / .map-zoom：路线图不需要「我在哪儿」的针和手动缩放', () => {
  const box = renderRouteCard(dom.byId.app, { points: [CD, XA], styleId: 'street' });
  for (const cls of ['map-pin', 'map-zoom']) {
    const nodes = box.querySelectorAll(`.${cls}`);
    assert.ok(nodes.length > 0, `底图卡应当有 .${cls}（我们只是隐藏它，不是删功能）`);
    for (const n of nodes) {
      assert.equal(n.hidden, true, `.${cls} 必须被隐藏（理由见 src/ui/roadmap.js 文件头）`);
    }
  }
});

test('★coord:null 的打卡不上图：绝不替「没记录」编一个位置', () => {
  const box = renderRouteCard(dom.byId.app, {
    points: [CD, XA],
    markers: [
      { ...CD, name: '成都', kind: 'stay' },
      { lat: null, lon: null, name: '没定位的店', kind: 'check' },
      { ...XA, name: '西安', kind: 'check' },
    ],
    styleId: 'street',
  });
  // ★为什么按 tagName 数而不是 classList：SVG 节点的 class 是 setAttribute 写进去的，
  //   假 DOM 的 classList 只跟 className（真 DOM 里 SVG 的 className 是只读的，不能写）。
  const dots = box.descendants().filter((n) => n.tagName === 'CIRCLE');
  // ★只数**有坐标**的两条 —— 缺坐标那条若被画上去，用户会以为自己真的在那儿停过
  assert.equal(dots.length, 2, `只该画 2 个标记，实际 ${dots.length} 个`);
});

test('★无几何时降级为「示意直线」：画成虚线且必须带标注', () => {
  const box = renderRouteCard(dom.byId.app, {
    points: [], // 没拿到几何
    markers: [{ ...CD, name: '成都', kind: 'stay' }, { ...XA, name: '西安', kind: 'check' }],
    styleId: 'street',
  });
  const line = box.descendants().filter((n) => n.tagName === 'POLYLINE')[0] || null;
  assert.ok(line, '没有几何也要画出示意直线（否则分不清「没画出来」和「这一程是空的」）');
  assert.ok(
    String(line.getAttribute('class') || '').indexOf('rt-route-line--schematic') !== -1,
    '示意直线必须带 --schematic（画成虚线）'
  );
  assert.ok(line.getAttribute('stroke-dasharray'), '示意直线必须是虚线：实线会被当成真实路径');
  assert.ok(
    box.textContent.indexOf(t('rt.mapSchematic')) !== -1,
    `必须标注「这是示意直线，不是真实路径」，实际：${box.textContent}`
  );
});

test('有几何时不画虚线、也不写示意标注', () => {
  const box = renderRouteCard(dom.byId.app, {
    points: [CD, { lat: 32.4, lon: 106.5 }, XA],
    markers: [{ ...CD, name: '成都', kind: 'stay' }],
    styleId: 'street',
  });
  const line = box.descendants().filter((n) => n.tagName === 'POLYLINE')[0] || null;
  assert.ok(line, '有几何就要画折线');
  assert.equal(
    String(line.getAttribute('class') || '').indexOf('rt-route-line--schematic'),
    -1,
    '有几何时不许画成示意虚线'
  );
  assert.equal(line.getAttribute('stroke-dasharray'), null, '有几何时是实线');
  assert.equal(box.textContent.indexOf(t('rt.mapSchematic')), -1, '有几何时不许写示意标注');
});

test('装不下时卡片要明说「可能看不全」', () => {
  const box = renderRouteCard(dom.byId.app, {
    points: [
      { lat: 10, lon: -10 },
      { lat: 60, lon: 120 },
    ],
    styleId: 'street',
  });
  assert.ok(
    box.textContent.indexOf(t('rt.mapNoFit')) !== -1,
    `跨度太大必须写明看不全，实际：${box.textContent}`
  );
});

/* ------------------------------------------------------------------ */
/* 搬家：导出 → 导入 round-trip                                          */
/* ------------------------------------------------------------------ */

test('★导出 → 在新机器导入必须出等价行程（round-trip）', () => {
  const trip = newTrip({ origin: { lat: CD.lat, lon: CD.lon, name: '成都' }, destination: { lat: XA.lat, lon: XA.lon, name: '西安' }, dailyTargetSec: 14400 });
  trip.name = '成都—西安';
  trip.stopovers = [
    { id: 'so-1', day: 1, seq: 0, coord: { lat: 32.7, lon: 106.1 }, anchorFrom: 'cumulative-4h', driveFromPrevS: 14400, driveFromPrevM: 300000 },
  ];
  trip.checkIns = [
    // ★显式给 atMs：缺省时 newCheckIn() 会填 Date.now()，两侧各填一次就差几毫秒，
    //   round-trip 断言会假红（不是不等价，是时间戳本来就该由创建时刻决定）。
    { id: 'ck-1', type: 'stay', name: '锦江宾馆', coord: { lat: 32.65, lon: 106.08 }, coordSource: 'amap', atMs: 1730000000000 },
  ];

  const file = JSON.stringify(exportTrips([trip]));
  // ★导出文件里不许带几何（体积口径见 src/data/osrm.js 文件头）：slimRoute 把
  //   geometry / cumulativeS / cumulativeM 一律置 null，但**键还在**（形状要稳定），
  //   所以断言的是值不是「字符串里有没有这个词」。
  const parsed = JSON.parse(file);
  assert.equal(parsed.trips[0].route.geometry, null, '导出文件不许带几何');
  assert.equal(parsed.trips[0].route.cumulativeS, null, '导出文件不许带逐边累积时长');
  assert.equal(parsed.trips[0].route.cumulativeM, null, '导出文件不许带逐边累积里程');

  const ins = inspectTripFile(file);
  assert.equal(ins.ok, true, `导入校验应通过，实际：${ins.reasonKey}`);
  assert.equal(ins.plan.dropped, 0);

  const applied = applyTripFile(ins.plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.trips.length, 1);

  const a = JSON.stringify(slimTrip(trip));
  const b = JSON.stringify(slimTrip(applied.trips[0]));
  // updatedAt 是落盘时刻，本就不该相等；其余字段必须逐字一致
  const strip = (s) => JSON.stringify({ ...JSON.parse(s), updatedAt: 0 });
  assert.equal(strip(b), strip(a), '导入出的行程必须与导出的等价');
  assert.equal(applied.trips[0].checkIns[0].name, '锦江宾馆', '打卡要跟着一起搬过去');
});

test('导入坏文件：必须给出可读原因，不许静默当成功', () => {
  const bad = inspectTripFile('{ not json');
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonKey, 'trip.badJson');

  const wrongApp = inspectTripFile(JSON.stringify({ schema: 1, app: 'something-else', trips: [] }));
  assert.equal(wrongApp.ok, false);
  assert.equal(wrongApp.reasonKey, 'trip.notRoadtrip');

  // ★applyTripFile 不许把「没有 trips」宽容成空数组 —— 那是 ok:true + 行程被清空
  const noTrips = applyTripFile({});
  assert.equal(noTrips.ok, false);
  assert.equal(noTrips.reasonKey, 'trip.planNoTrips');
});

/* ------------------------------------------------------------------ */
/* 零回归：动 map.js 不许影响此刻屏                                        */
/* ------------------------------------------------------------------ */

test('★零回归证明：放宽下界只作用于路线图，此刻屏一个字都没变', () => {
  // ★为什么要有这条：本轮为了装下整程，改了 `src/ui/map.js`（新增 ROADMAP_MIN_ZOOM +
  //   setMapView 的可选下界参数）。「我觉得没影响」不算证据，这里逐条钉死：
  //
  // ① 此刻屏的层级常量值没变（写死实测到的数，改了就红）
  assert.equal(DEFAULT_ZOOM, 12, '此刻屏默认层级必须仍是 12');
  assert.equal(MIN_ZOOM, 10, '底图层级下界必须仍是 10（街道级）');
  assert.equal(MAX_ZOOM, 16, '底图层级上界必须仍是 16');
  assert.equal(ROADMAP_MIN_ZOOM, 3, '路线图下界必须是 3，且**不等于** MIN_ZOOM');

  // ② 不传下界时，钳位行为与改动前**逐字一致**（这是「可选参数」的立身之本）
  assert.equal(setMapView({ zoom: -5 }).zoom, MIN_ZOOM, '不传下界 → 仍钳到 MIN_ZOOM（此刻屏行为不变）');
  assert.equal(setMapView({ zoom: 99 }).zoom, MAX_ZOOM, '上界不变');
  assert.equal(setMapView({ zoom: 6 }).zoom, MIN_ZOOM, '★此刻屏传 z6 也要被钳回 z10 —— 街道级下界仍然生效');
  assert.equal(setMapView({ zoom: 6 }, ROADMAP_MIN_ZOOM).zoom, 6, '只有显式传下界时才允许低层级');
  assert.equal(setMapView({ zoom: 6 }, undefined).zoom, MIN_ZOOM, '传 undefined 等于不传');

  // ③ 编排层（此刻屏）根本不传 zoom，更不会传 minZoom —— 它连碰都碰不到新参数
  const appSrc = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const calls = appSrc.split(/\r?\n/).filter((line) => line.indexOf('renderMapCard(') !== -1);
  assert.ok(calls.length > 0, '此刻屏应当有 renderMapCard 调用（找不到说明断言本身失效了）');
  for (const line of calls) {
    assert.equal(line.indexOf('zoom'), -1, `此刻屏不许传 zoom / minZoom，实际：${line.trim()}`);
    assert.equal(line.indexOf('minZoom'), -1, `此刻屏不许传 minZoom，实际：${line.trim()}`);
  }

  // ④ 收尾：把视图恢复成此刻屏的默认值，避免本用例的副作用影响同进程内的后来者
  setMapView({ zoom: DEFAULT_ZOOM });
  assert.equal(mapView().zoom, DEFAULT_ZOOM);
});
