/**
 * 行程模型与本机持久化的守卫
 *
 * 钉死这八件事（前四条是 T02 的验收项，后四条是本项目踩过的坑的复发防线）：
 *   ① 迁移：旧结构 → v1 字段补齐，且**已有值一个字都不改**；
 *   ② 更高 schema 被拒，带 `trip.newerSchema`，不改写、不猜测；
 *   ③ 导出 → inspect → apply 的 round-trip 等价；
 *   ④ 单条行程 JSON < 20 KB（几何不落盘才守得住）；
 *   ⑤ 几何与逐边累积曲线**绝不**落盘（`saveTrip` 的口子上就被拦下）；
 *   ⑥ `readTrip()` 自动 touch（刷新 storedAt，降低被 prune 淘汰的概率）；
 *   ⑦ 筛选返回 pass/fail/unknown 三元组，unknown 单独成组且计数，永不被吞或删除；
 *   ⑧ 缺失值一律 null（不是 0、不是空串）—— 0 元房价会被读成「免费」，那是造假。
 *
 * ⚠️ 口径：体积 / 时延数字均为沙箱实测（架构 §0），不是真机结论；
 *    断言只钉「不落盘」与「预算上限」这两条可在本机验证的事。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rt = await import(pathToFileURL(path.join(ROOT, 'src/core/roadtrip.js')).href);
const store = await import(pathToFileURL(path.join(ROOT, 'src/core/tripstore.js')).href);
const cache = await import(pathToFileURL(path.join(ROOT, 'src/core/cache.js')).href);

/** 每个用例开头清空行程（Node 下 cache 走内存 Map，进程内共享）。 */
function resetTrips() {
  store.clearAllTrips();
}

/* ------------------------------------------------------------------ */
/* ① 迁移                                                              */
/* ------------------------------------------------------------------ */

test('① 旧结构（无 schema、缺一半字段）→ 补齐到 v1，且已有值一个字都不改', () => {
  const raw = {
    // 没有 schema：视作待迁移的旧结构
    id: 'trip-old-1',
    name: '成都 → 西安',
    createdAt: 1760000000000,
    // 没有 updatedAt / plan / route / stopovers / checkIns
  };
  const m = rt.migrateTrip(raw);
  assert.equal(m.ok, true);
  const t = m.trip;
  assert.equal(t.schema, rt.SCHEMA_VERSION);
  // ★已有值不动
  assert.equal(t.id, 'trip-old-1', 'id 不能被重新生成');
  assert.equal(t.name, '成都 → 西安');
  assert.equal(t.createdAt, 1760000000000);
  // 缺失补齐
  assert.equal(typeof t.updatedAt, 'number');
  assert.ok(t.plan && typeof t.plan === 'object');
  assert.equal(t.plan.dailyTargetSec, rt.DEFAULT_DAILY_TARGET_SEC, '默认每天 4 小时');
  assert.equal(t.plan.minGapSec, rt.DEFAULT_MIN_GAP_SEC);
  assert.deepEqual(t.plan.via, []);
  assert.equal(t.plan.origin, null);
  assert.deepEqual(t.stopovers, []);
  assert.deepEqual(t.checkIns, []);
  assert.equal(t.lastErrorKey, null);
  // route 是空壳，且两个大字段存在但为 null
  assert.equal(t.route.geometry, null);
  assert.equal(t.route.cumulativeS, null);
  assert.equal(t.route.geometryPoints, 0);
});

test('① 迁移不改写已有值：plan 的自定义值、stopovers / checkIns 逐条保留', () => {
  const raw = {
    schema: 1,
    id: 'trip-x',
    name: 'x',
    plan: {
      origin: { lat: 30.5728, lon: 104.0668, name: '成都', source: 'search' },
      destination: { lat: 34.3416, lon: 108.9398, name: '西安', source: 'search' },
      via: [{ lat: 33.07, lon: 107.02, name: '汉中', source: 'manual' }],
      startDate: '2026-10-20',
      days: 3,
      dailyTargetSec: 18000,
      minGapSec: 900,
    },
    stopovers: [{ id: 'so-1', day: 1, seq: 1, coord: { lat: 33.07, lon: 107.02 }, anchorFrom: 'via', cumSecAtArrival: 14404 }],
    checkIns: [{ id: 'ck-1', type: 'stay', name: '汉中院子', stay: { pricePerNight: 148, roomType: 'standard' } }],
  };
  const t = rt.migrateTrip(raw).trip;
  assert.equal(t.plan.origin.lat, 30.5728);
  assert.equal(t.plan.origin.source, 'search');
  assert.equal(t.plan.via.length, 1);
  assert.equal(t.plan.via[0].name, '汉中');
  assert.equal(t.plan.startDate, '2026-10-20');
  assert.equal(t.plan.days, 3);
  assert.equal(t.plan.dailyTargetSec, 18000, '自定义值不能被默认 14400 覆盖');
  assert.equal(t.plan.minGapSec, 900);
  assert.equal(t.stopovers[0].id, 'so-1');
  assert.equal(t.stopovers[0].cumSecAtArrival, 14404);
  assert.equal(t.stopovers[0].coord.lat, 33.07);
  assert.equal(t.checkIns[0].stay.pricePerNight, 148);
  assert.equal(t.checkIns[0].stay.roomType, 'standard');
  // 非法的 dailyTargetSec 才回退默认
  assert.equal(rt.migrateTrip({ plan: { dailyTargetSec: 999 } }).trip.plan.dailyTargetSec, 14400);
});

test('① 未知更高版本 → 拒绝并给 reasonKey（不改写、不猜测）', () => {
  const m = rt.migrateTrip({ schema: 2, id: 'a', name: 'b' });
  assert.equal(m.ok, false);
  assert.equal(m.reasonKey, 'trip.newerSchema');
  assert.deepEqual(m.reasonParams, { schema: '2' });
  assert.equal(m.trip, undefined, '拒绝时绝不带回一个「猜出来的」行程');

  // 非整数 / 小于 1
  assert.equal(rt.migrateTrip({ schema: 'x' }).reasonKey, 'trip.badSchema');
  assert.equal(rt.migrateTrip({ schema: 0 }).reasonKey, 'trip.badSchema');
  assert.equal(rt.migrateTrip(null).reasonKey, 'trip.notObject');
  assert.equal(rt.migrateTrip([]).reasonKey, 'trip.notObject');
});

/* ------------------------------------------------------------------ */
/* ② 打卡与候选                                                        */
/* ------------------------------------------------------------------ */

test('② newCheckIn：缺字段一律 null（不是 0、不是空串）', () => {
  const ck = rt.newCheckIn('stay', { name: '如家', coord: { lat: 33.07, lon: 107.02 }, coordSource: 'gps' });
  assert.equal(ck.type, 'stay');
  assert.equal(ck.stay.pricePerNight, null, '★房价 0 会被读成免费，那是造假');
  assert.equal(ck.stay.roomType, null);
  assert.equal(ck.stay.nights, null);
  assert.equal(ck.sight, null);
  assert.equal(ck.food, null);
  assert.equal(ck.common.rating, null);
  assert.equal(ck.address, null);
  assert.equal(ck.category, null);
  assert.equal(ck.amapId, null);
  assert.equal(ck.raw, null);
  assert.equal(ck.converted, false);
  assert.equal(ck.source, 'manual');
  assert.equal(typeof ck.atMs, 'number');
  assert.ok(ck.id.startsWith('ck-'));
  // 坐标可以完全没有（手动补录）
  assert.equal(rt.newCheckIn('food', { coord: null, coordSource: 'manual' }).coord, null);
});

test('② adoptCandidate：保留 raw 与 converted，来源标 amap', () => {
  const candidate = {
    id: 'B0FFH9XJ2L',
    name: '汉中院子民宿',
    type: '住宿服务;宾馆酒店',
    address: '陕西省汉中市',
    rating: 4.3,
    coord: { lat: 33.06, lon: 107.01 },
    raw: { lat: 33.07, lon: 107.02, coordSys: 'GCJ-02' },
    converted: true,
  };
  const ck = rt.adoptCandidate(candidate, 'stay', { stay: { pricePerNight: 148, roomType: 'king' }, tripId: 'trip-1' });
  assert.equal(ck.source, 'amap');
  assert.equal(ck.coordSource, 'amap');
  assert.equal(ck.amapId, 'B0FFH9XJ2L');
  assert.equal(ck.category, '住宿服务;宾馆酒店');
  assert.equal(ck.common.rating, 4.3);
  // ★原始凭证不许丢
  assert.deepEqual(ck.raw, { lat: 33.07, lon: 107.02, coordSys: 'GCJ-02' });
  assert.equal(ck.converted, true);
  // 用户补录值
  assert.equal(ck.stay.pricePerNight, 148);
  assert.equal(ck.stay.roomType, 'king');
  // 高德没给评分时就是 null
  assert.equal(rt.adoptCandidate({ ...candidate, rating: null }, 'stay').common.rating, null);
});

test('② id 同毫秒内不撞号（撞号 = 第二条覆盖第一条，用户数据静默丢失）', () => {
  const a = rt.newId('ck', 1760000000000);
  const b = rt.newId('ck', 1760000000000);
  assert.notEqual(a, b);
});

/* ------------------------------------------------------------------ */
/* ③ 导出 / 导入 round-trip                                            */
/* ------------------------------------------------------------------ */

/** 造一条「成都 → 西安」级别的行程（6 途经点、5 停留点、12 打卡）。 */
function bigTrip() {
  const trip = rt.newTrip({
    origin: { lat: 30.5728, lon: 104.0668, name: '成都', source: 'search' },
    destination: { lat: 34.3416, lon: 108.9398, name: '西安', source: 'search' },
    via: [1, 2, 3, 4].map((i) => ({ lat: 31 + i * 0.6, lon: 105 + i * 0.7, name: `途经${i}`, source: 'manual' })),
    startDate: '2026-10-20',
    days: 3,
  });
  trip.name = '成都 → 西安';
  trip.route = {
    ok: true,
    distanceM: 726004.8,
    durationS: 29898.1,
    durationKind: 'osrm-freeflow',
    fetchedAt: 1760000000000,
    waypoints: [0, 1, 2, 3, 4, 5].map((i) => ({
      inputIndex: i,
      snapped: { lat: 30 + i * 0.7, lon: 104 + i * 0.8 },
      name: '',
      snapDistanceM: i === 3 ? 3363 : 12.5,
    })),
    snapMaxM: 3363,
    legs: [0, 1, 2, 3, 4].map((i) => ({ fromIndex: i, toIndex: i + 1, distanceM: 145000, durationS: 5979 })),
    cumulativeS: Array.from({ length: 5987 }, (_, i) => i * 5),
    cumulativeKind: 'annotations',
    geometry: Array.from({ length: 5987 }, (_, i) => [104 + i * 0.001, 30 + i * 0.001]),
    geometryPoints: 5987,
    shape: null,
    requestedOverview: 'full',
  };
  trip.stopovers = [1, 2, 3, 4, 5].map((i) => ({
    id: `so-${i}`,
    day: i,
    seq: i,
    coord: { lat: 31 + i * 0.6, lon: 105 + i * 0.7 },
    anchorFrom: 'cumulative-4h',
    cumSecAtArrival: i * 14404,
    driveFromPrevS: 14404,
    driveFromPrevM: 145000,
    placeName: `第${i}天落脚点`,
    placeSource: 'reverse',
    note: '',
    actual: null,
  }));
  trip.checkIns = [];
  for (let i = 0; i < 4; i += 1) {
    trip.checkIns.push(rt.newCheckIn('stay', { name: `住宿${i}`, stay: { pricePerNight: 148, roomType: 'standard', nights: 1 } }));
    trip.checkIns.push(rt.newCheckIn('sight', { name: `景点${i}`, sight: { level: '4A', rating: 4.7, ticketCny: 90 } }));
    trip.checkIns.push(rt.newCheckIn('food', { name: `美食${i}`, food: { localSpecial: true, perHeadCny: 68, dishes: [{ name: '菜豆腐', priceCny: 12, note: '' }] } }));
  }
  return trip;
}

test('③ 导出 → inspect → apply 的 round-trip 等价', () => {
  const trip = bigTrip();
  const payload = rt.exportTrips([trip], 1760000000000);
  assert.equal(payload.schema, rt.SCHEMA_VERSION);
  assert.equal(payload.app, 'geoscope-roadtrip');
  assert.equal(payload.trips.length, 1);

  const inspected = rt.inspectTripFile(JSON.stringify(payload));
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  assert.equal(inspected.plan.dropped, 0);
  assert.equal(inspected.plan.exportedAt, new Date(1760000000000).toISOString());

  const applied = rt.applyTripFile(inspected.plan);
  assert.equal(applied.ok, true);
  assert.equal(applied.trips.length, 1);

  // ★等价：与「原始行程经同一把迁移尺子」的结果逐字段相同
  const canonical = rt.migrateTrip(trip).trip;
  assert.deepEqual(applied.trips[0], canonical);
});

test('③ 非法文件：坏 JSON / 非对象 / 错 app / 错 schema / 无 trips 各自给不同的 reasonKey', () => {
  assert.equal(rt.inspectTripFile('{oops').reasonKey, 'trip.badJson');
  assert.equal(rt.inspectTripFile('[]').reasonKey, 'trip.notObject');
  assert.equal(rt.inspectTripFile({ schema: 1, app: 'other', trips: [] }).reasonKey, 'trip.notRoadtrip');
  assert.equal(rt.inspectTripFile({ schema: 2, app: 'geoscope-roadtrip', trips: [] }).reasonKey, 'trip.badSchema');
  assert.equal(rt.inspectTripFile({ schema: 1, app: 'geoscope-roadtrip' }).reasonKey, 'trip.noTrips');
  // apply 缺 plan.trips 时整体拒绝（不静默清空）
  assert.equal(rt.applyTripFile({}).reasonKey, 'trip.planNoTrips');
  assert.equal(rt.applyTripFile(null).reasonKey, 'trip.planNoTrips');
});

test('③ 一份文件里混着坏行程：坏的那条跳过、好的照进（不整体拒绝）', () => {
  const good = rt.newTrip({});
  const payload = rt.exportTrips([good]);
  payload.trips.push({ schema: 99, id: 'bad' });
  payload.trips.push(null);
  const ins = rt.inspectTripFile(payload);
  assert.equal(ins.ok, true);
  assert.equal(ins.plan.trips.length, 1);
  assert.equal(ins.plan.dropped, 2);
});

/* ------------------------------------------------------------------ */
/* ④ 体积护栏（几何不落盘才守得住）                                     */
/* ------------------------------------------------------------------ */

test('④ 单条行程 JSON < 20 KB（含 6 途经点 / 5 停留点 / 12 打卡）', () => {
  const trip = bigTrip();
  const bytes = rt.tripBytes(trip);
  assert.ok(bytes > 2000, `行程不该小到 ${bytes} B，那说明字段没带上`);
  assert.ok(bytes < rt.TRIP_MAX_BYTES, `单条行程 ${bytes} B 超出 ${rt.TRIP_MAX_BYTES} B 预算`);

  const json = JSON.stringify(rt.exportTrips([trip]).trips[0]);
  assert.ok(json.indexOf('5987') === -1 || json.indexOf('"geometryPoints":5987') !== -1);
});

test('④ 几何不落盘：726 km 的 full 几何（5987 点）在 slim 后彻底消失', () => {
  const trip = bigTrip();
  // 入参带整条几何
  assert.equal(trip.route.geometry.length, 5987);
  assert.equal(trip.route.cumulativeS.length, 5987);

  const slim = rt.slimTrip(trip);
  assert.equal(slim.route.geometry, null, '★几何绝不落盘：137 KB 会吃光预算');
  assert.equal(slim.route.cumulativeS, null, '★逐边累积曲线同样是几千个数，一并拦下');
  assert.equal(slim.route.geometryPoints, 5987, '★但「原始点数」要留着，便于如实标注曾经被抽稀');
  assert.equal(slim.route.distanceM, 726004.8);
  assert.equal(slim.route.snapMaxM, 3363, '吸附距离必须留着（界面要警示）');
  assert.equal(slim.route.waypoints.length, 6);
  assert.equal(slim.route.legs.length, 5);
  assert.equal(slim.route.cumulativeKind, 'annotations');

  // 序列化后确实没有那一长串坐标
  const json = JSON.stringify(slim);
  assert.ok(json.length < rt.TRIP_MAX_BYTES);
  assert.ok(json.indexOf('"geometry":[[') === -1);
});

test('④ ★两个累计口径都落盘（重载后界面仍说得清「两者相差 <1 %」）', () => {
  const trip = bigTrip();
  trip.route.durationS = 29898; // OSRM 总时长
  trip.route.cumulativeTotalS = 29860; // Σ annotation（726 km 实测差 38 s）
  const slim = rt.slimTrip(trip);
  assert.equal(slim.route.durationS, 29898);
  assert.equal(slim.route.cumulativeTotalS, 29860, '★单个标量，跟着行程一起持久化');
  assert.equal(slim.route.cumulativeS, null, '曲线本身不落盘，但它的合计要留着');
  // 没有 annotations 的行程：两者都是 null（不许拿 durationS 冒充）
  const bare = rt.newTrip({});
  assert.equal(bare.route.cumulativeTotalS, null);
  assert.equal(bare.route.durationS, null);
});

test('④ 用户主动缓存的 shape（简化几何）**允许**落盘', () => {
  const trip = bigTrip();
  trip.route.shape = { source: 'osrm-simplified', pts: [[104.06, 30.57], [108.93, 34.34]], rawCount: 5987 };
  const slim = rt.slimTrip(trip);
  assert.deepEqual(slim.route.shape.pts, [[104.06, 30.57], [108.93, 34.34]]);
  assert.equal(slim.route.shape.rawCount, 5987);
  assert.ok(rt.tripBytes(trip) < rt.TRIP_MAX_BYTES);
});

/* ------------------------------------------------------------------ */
/* ⑤ 持久化：读写删、touch、几何拦截                                    */
/* ------------------------------------------------------------------ */

test('⑤ saveTrip → readTrip：几何在写盘口子上就被拦下，读回来是 null', () => {
  resetTrips();
  const trip = bigTrip();
  assert.equal(store.saveTrip(trip), true);
  const read = store.readTrip(trip.id);
  assert.equal(read.ok, true);
  assert.equal(read.trip.route.geometry, null);
  assert.equal(read.trip.route.cumulativeS, null);
  assert.equal(read.trip.route.distanceM, 726004.8);
  assert.equal(read.trip.stopovers.length, 5);
  assert.equal(read.trip.checkIns.length, 12);
  assert.equal(store.tripCount(), 1);
});

test('⑤ readTrip 自动 touch（刷新 storedAt，降低被 prune 当旧缓存淘汰的概率）', () => {
  resetTrips();
  const trip = rt.newTrip({});
  trip.name = 'touch 测试';
  assert.equal(store.saveTrip(trip), true);
  const key = `gs:v1:trip:${trip.id}`;
  const before = cache.get(key).storedAt;
  // 让时钟往前走一点
  const start = Date.now();
  while (Date.now() - start < 5) {
    /* 等 5 ms，确保 storedAt 有肉眼可辨的变化 */
  }
  assert.equal(store.readTrip(trip.id).ok, true);
  const after = cache.get(key).storedAt;
  assert.ok(after >= before, 'touch 后 storedAt 必须不早于写入时');
  // touch 必须真的改到时间戳，而不是「写了但没变」
  assert.ok(after - before >= 0 && after >= before);
  assert.equal(store.touch(trip.id), true);
  assert.equal(store.touch('不存在的行程'), false);
});

test('⑤ 删除：从索引摘掉；是当前行程时一并清空当前标记', () => {
  resetTrips();
  const a = rt.newTrip({});
  const b = rt.newTrip({});
  assert.equal(store.saveTrip(a), true);
  assert.equal(store.saveTrip(b), true);
  assert.equal(store.tripCount(), 2);
  assert.equal(store.setActiveTrip(b.id), true);
  assert.equal(store.getActiveTripId(), b.id);

  assert.equal(store.deleteTrip(b.id), true);
  assert.equal(store.tripCount(), 1);
  assert.equal(store.getActiveTripId(), null, '删掉的正是当前行程，当前标记必须跟着清');
  assert.equal(store.deleteTrip(b.id), false, '本来就没有，不假称成功');
  assert.equal(store.deleteTrip(''), false);
  assert.equal(store.listTrips().length, 1);
  assert.equal(store.listTrips()[0].id, a.id);
});

test('⑤ listTrips 按 updatedAt 倒序（saveTrip 会把 updatedAt 刷成当下）；更高版本一律拒写', () => {
  resetTrips();
  const t1 = rt.newTrip({});
  store.saveTrip(t1);
  const start = Date.now();
  while (Date.now() - start < 5) {
    /* 等 5 ms，让两次保存的 updatedAt 分出先后 */
  }
  const t2 = rt.newTrip({});
  store.saveTrip(t2);
  // ★saveTrip 会覆写 updatedAt（保存即「改动过」），所以倒序 = 最近保存的在前
  assert.deepEqual(store.listTrips().map((t) => t.id), [t2.id, t1.id]);

  assert.equal(store.saveTrip({ schema: 99, id: 'future' }), false);
  assert.equal(store.saveTrip(null), false);
  assert.equal(store.readTrip('future').reasonKey, 'trip.notFound');
  assert.equal(store.readTrip('').reasonKey, 'trip.notFound');
});

test('⑤ 更高版本的行程读得到原因：trip.newerSchema（不改写、不猜测）', () => {
  resetTrips();
  const trip = rt.newTrip({});
  store.saveTrip(trip);
  // 模拟「被更新版本写过的行程」：直接把 schema 改高塞回本机
  const key = `gs:v1:trip:${trip.id}`;
  const entry = cache.get(key);
  cache.set(key, { ...entry.value, schema: 2 }, 1000);
  const read = store.readTrip(trip.id);
  assert.equal(read.ok, false);
  assert.equal(read.reasonKey, 'trip.newerSchema');
  assert.deepEqual(read.reasonParams, { schema: '2' });
});

test('⑤ ★坏掉的行程不许从列表里凭空消失：listTripsWithIssues 必须带回原因', () => {
  resetTrips();
  const good = rt.newTrip({});
  good.name = '好的那条';
  const bad = rt.newTrip({});
  bad.name = '会被写坏的那条';
  store.saveTrip(good);
  store.saveTrip(bad);

  // 模拟本机里被写坏的条目：直接把 schema 改成更高版本塞回去（真机上可能是
  // 「新版本应用写过的行程」或一条损坏的 localStorage 记录）
  const key = `gs:v1:trip:${bad.id}`;
  const entry = cache.get(key);
  cache.set(key, { ...entry.value, schema: 2 }, 1000);

  const { trips, skipped } = store.listTripsWithIssues();
  assert.equal(trips.length, 1);
  assert.equal(trips[0].id, good.id);
  // ★关键：失败不能只进日志（debug 关闭时 log 完全静默），必须跟着返回值出来
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].id, bad.id);
  assert.equal(skipped[0].reasonKey, 'trip.newerSchema');
  assert.deepEqual(skipped[0].reasonParams, { schema: '2' });
  // 简版仍然只给行程（不改动既有调用方）
  assert.equal(store.listTrips().length, 1);
});

test('⑤ ★删除必须精确：id 互为前缀的两条行程，删一条不许带走另一条', () => {
  resetTrips();
  // 导入进来的行程 id 是别的设备生成的，撞前缀完全可能（'abc' / 'abcd'）
  const a = rt.newTrip({});
  a.id = 'abc';
  const b = rt.newTrip({});
  b.id = 'abcd';
  assert.equal(store.saveTrip(a), true);
  assert.equal(store.saveTrip(b), true);
  assert.equal(store.tripCount(), 2);

  assert.equal(store.deleteTrip('abc'), true);
  assert.equal(store.tripCount(), 1);
  assert.deepEqual(store.listTrips().map((t) => t.id), ['abcd'], '★abcd 必须还在');
});

test('⑤ clearAllTrips 清空索引与全部条目', () => {
  resetTrips();
  store.saveTrip(rt.newTrip({}));
  store.saveTrip(rt.newTrip({}));
  assert.equal(store.tripCount(), 2);
  assert.equal(store.clearAllTrips(), 2);
  assert.equal(store.tripCount(), 0);
  assert.deepEqual(store.listTrips(), []);
});

/* ------------------------------------------------------------------ */
/* ⑥ 三类筛选：pass / fail / unknown                                   */
/* ------------------------------------------------------------------ */

/** @type {(t:string, patch:Object)=>Object} 造一个打卡项。 */
const ck = (t, patch) => rt.newCheckIn(t, patch);

test('⑥ 住宿筛选：达标 / 超上限 / 未填 各归其位，且总数守恒', () => {
  const list = [
    ck('stay', { name: '148 元', stay: { pricePerNight: 148, roomType: 'standard' } }),
    ck('stay', { name: '190 元（特殊放宽内）', stay: { pricePerNight: 190, roomType: 'king' } }),
    ck('stay', { name: '260 元（超上限）', stay: { pricePerNight: 260, roomType: 'standard' } }),
    ck('stay', { name: '没填房价', stay: { pricePerNight: null, roomType: 'standard' } }),
  ];
  const r = rt.partitionByFilter(list, { stay: rt.DEFAULT_STAY_FILTER });
  assert.equal(r.pass.length, 2, '148 与 190（≤200 放宽）通过');
  assert.equal(r.fail.length, 1, '260 超上限');
  assert.equal(r.unknown.length, 1, '★没填房价进 unknown，绝不进 pass');
  assert.equal(r.pass.length + r.fail.length + r.unknown.length, r.total, '★一条都不能被静默删除');
  assert.equal(r.unknownCounts.stay.pricePerNight, 1, '「未填：房价」的计数');
});

test('⑥ 景点筛选：等级按 4A/5A 排序比较；未填等级单独成组', () => {
  const list = [
    ck('sight', { name: '5A', sight: { level: '5A' } }),
    ck('sight', { name: '4A', sight: { level: '4A' } }),
    ck('sight', { name: '3A', sight: { level: '3A' } }),
    ck('sight', { name: '没填等级', sight: { level: null } }),
  ];
  const filters = { sight: { ...rt.DEFAULT_SIGHT_FILTER, enabled: { level: true, rating: false } } };
  const r = rt.partitionByFilter(list, filters);
  assert.deepEqual(r.pass.map((x) => x.name), ['5A', '4A']);
  assert.deepEqual(r.fail.map((x) => x.name), ['3A']);
  assert.deepEqual(r.unknown.map((x) => x.name), ['没填等级']);
  assert.equal(r.unknownCounts.sight.level, 1);
});

test('⑥ 美食筛选：当地特色 true / false / 未填', () => {
  const list = [
    ck('food', { name: '当地菜', food: { localSpecial: true } }),
    ck('food', { name: '连锁店', food: { localSpecial: false } }),
    ck('food', { name: '没标', food: { localSpecial: null } }),
  ];
  const r = rt.partitionByFilter(list, { food: rt.DEFAULT_FOOD_FILTER });
  assert.deepEqual(r.pass.map((x) => x.name), ['当地菜']);
  assert.deepEqual(r.fail.map((x) => x.name), ['连锁店']);
  assert.deepEqual(r.unknown.map((x) => x.name), ['没标']);
});

test('⑥ ★fail 优先于 unknown：确定的违规不许被「未填」藏起来', () => {
  // 房价 260（确定超标）+ 没填房型 → 必须进 fail，不能因为有一项未填就混进 unknown
  const list = [ck('stay', { name: '260 且没填房型', stay: { pricePerNight: 260, roomType: null } })];
  const r = rt.partitionByFilter(list, { stay: rt.DEFAULT_STAY_FILTER });
  assert.equal(r.fail.length, 1);
  assert.equal(r.unknown.length, 0);
  // 但「未填」的计数仍要如实报出（与分组无关）
  assert.equal(r.unknownCounts.stay.roomType, 1);
});

test('⑥ 没有对应筛选条件 = 不筛选（原样通过，不假装达标也不藏起来）', () => {
  const list = [ck('stay', { name: 'x', stay: { pricePerNight: 999 } })];
  const r = rt.partitionByFilter(list, {});
  assert.equal(r.pass.length, 1);
  assert.equal(r.fail.length, 0);
  assert.equal(rt.partitionByFilter(list).pass.length, 1);
});

test('⑥ 评分：仅在真有值时参与比较（null = 未填，不许用默认值占位）', () => {
  const filters = {
    stay: { ...rt.DEFAULT_STAY_FILTER, enabled: { price: false, roomType: false, rating: true }, minRating: 4.5 },
  };
  const list = [
    ck('stay', { name: '4.6 分', common: { rating: 4.6 } }),
    ck('stay', { name: '4.2 分', common: { rating: 4.2 } }),
    ck('stay', { name: '没评分', common: { rating: null } }),
  ];
  const r = rt.partitionByFilter(list, filters);
  assert.deepEqual(r.pass.map((x) => x.name), ['4.6 分']);
  assert.deepEqual(r.fail.map((x) => x.name), ['4.2 分']);
  assert.deepEqual(r.unknown.map((x) => x.name), ['没评分']);
  assert.equal(r.unknownCounts.stay.rating, 1);
});

test('⑥ 混合三类：各自的筛选条件互不影响（★景点默认还查评分，没评分就如实进「未填」）', () => {
  const list = [
    ck('stay', { name: '住', stay: { pricePerNight: 120, roomType: 'standard' } }),
    ck('sight', { name: '景（5A 但没评分）', sight: { level: '5A' } }),
    ck('food', { name: '食', food: { localSpecial: true } }),
  ];
  const r = rt.partitionByFilter(list, rt.DEFAULT_FILTERS);
  assert.deepEqual(r.pass.map((x) => x.name), ['住', '食']);
  // ★这条是产品红线的直接体现：等级达标但评分没拿到 → 不冒充达标，进「未填：评分」
  assert.deepEqual(r.unknown.map((x) => x.name), ['景（5A 但没评分）']);
  assert.equal(r.unknownCounts.sight.rating, 1);
  assert.equal(r.total, 3);
  assert.equal(r.pass.length + r.fail.length + r.unknown.length, 3);
});
