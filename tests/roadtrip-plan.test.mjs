/**
 * 切段（`core/roadtrip.js::splitStopovers`）的回归 —— 架构 §4.4.1 Stage 2
 *
 * ★夹具性质（先说清楚，不许含糊）：
 *   **本文件绝大多数用例跑在 `tests/fixtures/*.json` 上，那是三条真实 OSRM 响应**，
 *   经 `src/data/osrm.js::parseRoute()` 解析后原样持久化（不是手搓、不是 mock）。
 *   只有「去重」与「起终点不入选」两组用到**合成夹具**，它们的测试名一律带
 *   【合成夹具，非真实响应】前缀，且**不**声称复现了任何真实锚点 ——
 *   真实响应在高速公路上「空间上离必经点 2 km」必然同时「时间上离必经点 < 900 s」，
 *   于是去重必然先被必经点吸附吃掉，合成不出来。
 *
 * ★文档 §4.4.1 那张锚点表与本实现的对照（实测结论，不是猜测）：
 *   初版文档的三个锚点**自身用了两套下标约定**，任何一种实现最多只能对齐其中两条：
 *     · 4h 那条：旧文档 `[106.17855, 32.77479]` = geometry[2443]；本实现取 geometry[2444]
 *     · 3h 第一条：旧文档 `[105.566, 32.30835]` = geometry[1700]；本实现取 geometry[1701]
 *     · 3h 第二条：旧文档 `[107.77626, 33.26337]` = geometry[4432]；本实现**正是** geometry[4432] ✓
 *   本实现按 §4.4.1 第 1–2 条的字面执行：累积曲线直接用 `route.cumulativeS`
 *   （`acc[i]` = 进入第 i 条边之前的累积，长度 = 几何点数），锚点 = 第一个
 *   `cumulativeS[k] >= want` 的 `geometry[k]`。一致地执行这个规则，得到的是上面
 *   第三列；旧表的前两条相当于「取 geometry[k−1]」。**差一条边**（约 135 m / 几秒），
 *   不影响天数与形态。
 *
 *   2026-10-15 team-lead 拍板：**保持 `geometry[k]`，改文档表格，不改算法**
 *   （§4.4.1 第 2 条明文写的是 `geometry[k]`，且语义自洽：第一个跨过门槛的 k 就是
 *   「开满当天目标的那一刻到达的点」）。文档表已按本实现的输出订正，并在表下留了
 *   带日期的订正说明。
 *
 *   ★于是本文件现在钉**两**件事，缺一不可：
 *     (a) 「旧文档值 = 本实现下标 − 1」这一组（⑥）**刻意保留**：它是那份订正的证据链，
 *         删了后人就无从知道这里曾经不自洽；
 *     (b) 「订正后的文档数值 == 本实现在同一夹具上的输出」（⑥b）：防止文档将来又漂走。
 *   谁改约定，(a) 与 (b) 至少会红一条，不会静默漂移。
 *
 * 环境：零第三方依赖（node:test + node:assert）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

const rt = await import('../src/core/roadtrip.js');
const geo = await import('../src/core/geo.js');
// 只为了核对「core 吐出的键，两张表都有」。core 自己不许 import i18n（单向依赖），
// 但**测试**站在最外层，可以两边都看 —— 这正是它该盯的那条缝。
const { ZH, EN } = await import('../src/i18n/index.js');

/**
 * 读一份真实夹具。
 *
 * @param {string} name 文件名。
 * @returns {Object} RouteInfo。
 */
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.resolve(ROOT, 'tests/fixtures', name), 'utf8'));
}

/** 成都 → 西安。 */
const CD_XIAN = fixture('osrm-cd-xian.json');
/** 成都 → 汉中 → 西安（含一个真实必经点）。 */
const CD_HZ_XIAN = fixture('osrm-cd-hanzhong-xian.json');
/** 西安 → 洛阳（总时长刚过 4 h，用来验收尾规则）。 */
const XIAN_LUOYANG = fixture('osrm-xian-luoyang.json');

/** 断言用的时刻（固定 → id 可复现）。 */
const NOW = 1700000000000;

/* ------------------------------------------------------------------ */
/* 合成夹具构造器（★只给【合成夹具，非真实响应】那两组用）              */
/* ------------------------------------------------------------------ */

/**
 * 造一条最小 RouteInfo（**合成**，形状与 parseRoute 的产出保持一致）。
 *
 * @param {Array<Array<number>>} points 几何（[lon, lat]）。
 * @param {Array<number>} durations 逐边秒数（长度 = 点数 − 1）。
 * @param {Array<number>} distances 逐边米数（同上）。
 * @param {Array<number>} waypointIdx 必经点在 points 里的下标（含首末）。
 * @returns {Object} RouteInfo。
 */
function synthRoute(points, durations, distances, waypointIdx) {
  const cumS = [0];
  const cumM = [0];
  let s = 0;
  let m = 0;
  for (let i = 0; i < durations.length; i += 1) {
    s += durations[i];
    m += distances[i];
    cumS.push(s);
    cumM.push(m);
  }
  const waypoints = waypointIdx.map((i) => ({
    inputIndex: i,
    snapped: { lat: points[i][1], lon: points[i][0] },
    name: '',
    snapDistanceM: 0,
  }));
  return {
    ok: true,
    errorKey: null,
    fetchedAt: 0,
    distanceM: m,
    durationS: s,
    durationKind: 'osrm',
    waypoints,
    snapMaxM: 0,
    legs: [{ fromIndex: 0, toIndex: 1, distanceM: m, durationS: s }],
    cumulativeS: cumS,
    cumulativeTotalS: s,
    cumulativeM: cumM,
    cumulativeTotalM: m,
    cumulativeKind: 'annotations',
    geometry: points,
    geometryPoints: points.length,
    shape: null,
    requestedOverview: 'full',
  };
}

/* ------------------------------------------------------------------ */
/* ① 夹具自身：真实响应 + 真实解析器，坐标顺序必须是 lon,lat            */
/* ------------------------------------------------------------------ */

test('① 三条夹具都是真实响应经 parseRoute 产出（cumS/cumM 长度 = 几何点数）', () => {
  for (const [name, f] of [
    ['osrm-cd-xian.json', CD_XIAN],
    ['osrm-cd-hanzhong-xian.json', CD_HZ_XIAN],
    ['osrm-xian-luoyang.json', XIAN_LUOYANG],
  ]) {
    assert.equal(f.ok, true, `${name} 必须是成功响应`);
    assert.ok(Array.isArray(f.geometry) && f.geometry.length > 1, `${name} 要有几何`);
    assert.equal(f.cumulativeKind, 'annotations', `${name} 必须带逐边时长（否则没有切段依据）`);
    // ★第 1 条的不变量：累积曲线长度 = 几何点数
    assert.equal(f.cumulativeS.length, f.geometry.length, `${name} cumS 长度应等于点数`);
    assert.equal(f.cumulativeM.length, f.geometry.length, `${name} cumM 长度应等于点数`);
    assert.ok(f._meta && typeof f._meta.source === 'string', `${name} 必须带出处（_meta.source）`);
    assert.match(f._meta.source, /^https:\/\/router\.project-osrm\.org\//, `${name} 出处应是 OSRM 公共实例`);
  }
});

test('② ★lon,lat 顺序钉死：写反不报错，必须靠断言拦住', () => {
  // 成都 [104.0665, 30.5728]（WGS84）→ 若按 lat,lon 读，会落在东经 30°/北纬 104°（非法）
  // 或落在「纬度 104」这种根本不存在的点。**写反 OSRM 不报错**，只给一条完全不同的路线。
  const first = CD_XIAN.geometry[0];
  assert.ok(Math.abs(first[0] - 104.0665) < 0.01, `首点经度应≈104.0665，实际 ${first[0]}`);
  assert.ok(Math.abs(first[1] - 30.5728) < 0.01, `首点纬度应≈30.5728，实际 ${first[1]}`);
  const last = CD_XIAN.geometry[CD_XIAN.geometry.length - 1];
  assert.ok(Math.abs(last[0] - 108.9480) < 0.01, `末点经度应≈108.9480，实际 ${last[0]}`);
  assert.ok(Math.abs(last[1] - 34.2227) < 0.01, `末点纬度应≈34.2227，实际 ${last[1]}`);
  // 反过来验一次：把经纬度对调后，这点离成都应该是**上万公里**，绝不能被当成同一处
  const swapped = { lat: first[0], lon: first[1] };
  const chengdu = { lat: 30.5728, lon: 104.0665 };
  assert.ok(geo.distanceKm(swapped, chengdu) > 5000, '经纬度对调后应离成都极远（否则这条断言没有牙）');
});

/* ------------------------------------------------------------------ */
/* ③ 三条真实样本的形态（文档 §4.4.1 末尾那张表）                      */
/* ------------------------------------------------------------------ */

test('③ 西安→洛阳 366 km 真实样本 @4h：0 个停留点 / 1 天（末段 913 s 并入第 1 天）', () => {
  // 这正是文档里「336 km 三点路线」那一行的**形状**：总时长只比 4 h 多 15 min，
  // 不足 minGap 30 min → 不再切这一刀，余量并入同一天。
  const r = rt.splitStopovers(XIAN_LUOYANG, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.stopovers.length, 0, '不该切出停留点');
  assert.equal(r.dayCount, 1, '只有一天');
  assert.ok(r.tailMergedSec > 0, '必须如实报出被并入的余量');
  assert.ok(r.tailMergedSec < 1800, `并入的余量应 < minGap(1800)，实际 ${r.tailMergedSec}`);
  assert.equal(r.tailMergedIntoDay, 1, '并入的是第 1 天');
});

test('④ 成都→西安 真实样本 @4h：1 个停留点 / 2 天（文档表第 2 行）', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.stopovers.length, 1, '文档：1 个停留点');
  assert.equal(r.dayCount, 2, '文档：2 天');
  const s = r.stopovers[0];
  assert.equal(s.day, 1);
  assert.equal(s.seq, 1);
  // 本实现一致的取值（见文件头对照说明）：geometry[2444]
  assert.equal(s.coord.lon, 106.180014);
  assert.equal(s.coord.lat, 32.775131);
  assert.equal(s.anchorFrom, 'cumulative-4h');
  assert.ok(Math.abs(s.cumSecAtArrival - 14404.2) < 0.01, `cumSecAtArrival=${s.cumSecAtArrival}`);
  assert.ok(r.tailMergedSec > 0 && r.tailMergedSec < 1800, '末段 455 s 不足 30 min → 并入第 2 天');
  assert.equal(r.tailMergedIntoDay, 2);
});

test('⑤ 成都→西安 真实样本 @3h：2 个停留点 / 3 天（文档表第 3 行）', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.stopovers.length, 2, '文档：2 个停留点');
  assert.equal(r.dayCount, 3, '文档：3 天');
  assert.equal(r.stopovers[0].coord.lon, 105.567632);
  assert.equal(r.stopovers[0].coord.lat, 32.309538);
  assert.equal(r.stopovers[1].coord.lon, 107.776263);
  assert.equal(r.stopovers[1].coord.lat, 33.263369);
  // day/seq 递增
  assert.deepEqual(r.stopovers.map((s) => s.day), [1, 2]);
  assert.deepEqual(r.stopovers.map((s) => s.seq), [1, 2]);
  // ★「同一个 legs 输入、不同的每日目标 → 不同天数」—— legs 之上这一层存在的意义
  const at4h = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.notEqual(at4h.dayCount, r.dayCount, '4h 与 3h 必须给出不同天数');
});

test('⑥ ★【订正前的旧文档值】逐位对照：三条里对上一条，另两条差正好一条边', () => {
  const r3 = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  // 旧文档第 3 条锚点：文档只写到 5 位小数，按同一精度对齐后逐位一致 ✓
  // （实测值 107.776263 / 33.263369 → round 到 5 位 = 107.77626 / 33.26337）
  assert.equal(r3.stopovers[1].coord.lon.toFixed(5), '107.77626');
  assert.equal(r3.stopovers[1].coord.lat.toFixed(5), '33.26337');

  // 旧文档第 1 条（4h）与第 2 条（3h 首刀）：旧文档写的是「本实现下标 − 1」那一个点。
  // 这里不猜，直接把「文档值等于前一个点」这件事用机器钉死 —— 将来若有人改了约定，
  // 这两条会立刻红，而不是悄悄漂到别处。
  const g = CD_XIAN.geometry;
  const docVals = [
    { lon: 106.17855, lat: 32.77479, cut: rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW }).stopovers[0] },
    { lon: 105.566, lat: 32.30835, cut: r3.stopovers[0] },
  ];
  for (const d of docVals) {
    const idx = g.findIndex((p) => p[0] === d.cut.coord.lon && p[1] === d.cut.coord.lat);
    assert.ok(idx > 0, '本实现的锚点必须能在几何里精确找到');
    const prev = g[idx - 1];
    assert.ok(
      Math.abs(prev[0] - d.lon) < 1e-5 && Math.abs(prev[1] - d.lat) < 1e-5,
      `文档值 [${d.lon}, ${d.lat}] 应正好是本实现锚点的前一条边（前一点 = [${prev[0]}, ${prev[1]}]）`
    );
  }
});

test('⑥b ★订正后的文档表格必须与本实现在同一真实夹具上的输出逐位一致（防文档再漂）', () => {
  const doc = fs.readFileSync(path.resolve(ROOT, 'docs/roadtrip-architecture.md'), 'utf8');
  const start = doc.indexOf('### 4.4.1');
  assert.ok(start >= 0, '文档必须有 §4.4.1 这一节');
  const end = doc.indexOf('### 4.5', start);
  // 只取这一节：否则文档别处凑巧出现同一串数字时，这条断言就失去意义了。
  const sec = doc.slice(start, end > 0 ? end : doc.length);
  const noteAt = sec.indexOf('★订正说明');
  assert.ok(noteAt > 0, '§4.4.1 必须留着那段带日期的订正说明（它是这次改表的出处）');
  const tablePart = sec.slice(0, noteAt);

  const r4 = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  const r3 = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  const pairs = [
    [r4.stopovers[0], '4h 那一刀'],
    [r3.stopovers[0], '3h 第一刀'],
    [r3.stopovers[1], '3h 第二刀'],
  ];
  for (const [s, label] of pairs) {
    const want = `${String(s.coord.lon)}, ${String(s.coord.lat)}`;
    assert.ok(
      tablePart.indexOf(want) !== -1,
      `${label}：订正后的表格里必须原样写着 [${want}]，实际表格里没有 —— 文档又漂了`
    );
  }

  // ★反向也钉一条：订正前的旧值只允许出现在订正说明里，不许还留在表格上当「当前结论」。
  for (const old of ['106.17855, 32.77479', '105.566, 32.30835']) {
    assert.ok(
      tablePart.indexOf(old) === -1,
      `旧值 [${old}] 已从表格订正掉，只许留在订正说明里作为证据，不许继续当结论`
    );
  }

  // 西安→洛阳 那一行（替代样本）的三个数也一并钉住，形状与旧「336 km」结论一致
  assert.ok(tablePart.indexOf('366.5 km / 4.28 h') !== -1, '替代样本的里程 / 时长要写准');
  assert.ok(tablePart.indexOf('913 s') !== -1, '替代样本被并入的末段余量要写准');
});

/* ------------------------------------------------------------------ */
/* ④ 口径（第 8 条）与「不估算」（第 7 条）                            */
/* ------------------------------------------------------------------ */

test('⑦ ★两个累计口径分开返回，不许假装相等（真实样本实测差 0.11 %–0.52 %）', () => {
  for (const [name, f] of [['cd-xian', CD_XIAN], ['xian-luoyang', XIAN_LUOYANG]]) {
    const r = rt.splitStopovers(f, { dailyTargetSec: 14400 }, { nowMs: NOW });
    assert.ok(r.totalSecAnn !== null && r.totalSecLegs !== null, `${name} 两个口径都要有`);
    assert.notEqual(r.totalSecAnn, r.totalSecLegs, `${name}：两者不许被悄悄统一成一个数`);
    assert.ok(r.driftSec > 0, `${name}：实测恒为 annotation 略小（差值应为正），实际 ${r.driftSec}`);
    assert.ok(r.driftRatio > 0 && r.driftRatio < 0.01, `${name}：差值应 < 1 %，实际 ${(r.driftRatio * 100).toFixed(3)} %`);
  }
  // 逐条核对具体数字（真实响应上的实测值）
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.ok(Math.abs(r.totalSecAnn - 29262.4) < 0.01, `Σ annotation = ${r.totalSecAnn}`);
  assert.equal(r.totalSecLegs, 29295, 'Σ legs[].duration / route.duration');
  assert.ok(Math.abs(r.driftSec - 32.6) < 0.01, `差 ${r.driftSec}`);
});

test('⑧ ★不估算：driveFromPrevS / driveFromPrevM 都是区间求和，不是直线距离 ÷ 速度', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  const s = r.stopovers[0];
  const idx = CD_XIAN.geometry.findIndex((p) => p[0] === s.coord.lon && p[1] === s.coord.lat);

  // 时长：cumulativeS 区间差
  assert.equal(s.driveFromPrevS, CD_XIAN.cumulativeS[idx] - CD_XIAN.cumulativeS[0]);
  // 里程：cumulativeM 区间差（★Stage 1 补的逐边累积里程）
  assert.equal(s.driveFromPrevM, CD_XIAN.cumulativeM[idx] - CD_XIAN.cumulativeM[0]);
  // 且与「直线距离」明显不同 —— 若哪天有人改成直线距离，这条会红
  const straightKm = geo.distanceKm(
    { lat: CD_XIAN.geometry[0][1], lon: CD_XIAN.geometry[0][0] },
    s.coord
  );
  assert.ok(
    Math.abs(s.driveFromPrevM / 1000 - straightKm) > 5,
    `沿路实测 ${(s.driveFromPrevM / 1000).toFixed(1)} km 与直线 ${straightKm.toFixed(1)} km 差应远大于 5 km`
  );
  // 第二段（3h 样本的第二刀）同样是区间差
  const r3 = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  const i0 = CD_XIAN.geometry.findIndex((p) => p[0] === r3.stopovers[0].coord.lon && p[1] === r3.stopovers[0].coord.lat);
  const i1 = CD_XIAN.geometry.findIndex((p) => p[0] === r3.stopovers[1].coord.lon && p[1] === r3.stopovers[1].coord.lat);
  assert.equal(r3.stopovers[1].driveFromPrevS, CD_XIAN.cumulativeS[i1] - CD_XIAN.cumulativeS[i0]);
  assert.equal(r3.stopovers[1].driveFromPrevM, CD_XIAN.cumulativeM[i1] - CD_XIAN.cumulativeM[i0]);
});

/* ------------------------------------------------------------------ */
/* ⑤ 第 4 / 5 / 6 条                                                   */
/* ------------------------------------------------------------------ */

test('⑨ ★必经点优先（真实样本）：切点离必经点 428 s 时吸附到必经点，anchorFrom=via', () => {
  // 成都→汉中→西安：dailyTargetSec=18500 时，跨过门槛的那个点还在汉中以南，
  // 而再开 428 s 就到汉中（< VIA_SNAP_TOL_SEC 900）→ 落到汉中，而不是汉中前的国道边。
  const r = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 18500 }, { nowMs: NOW });
  assert.equal(r.stopovers.length, 1);
  const s = r.stopovers[0];
  assert.equal(s.anchorFrom, 'via', '应吸附到必经点');
  assert.equal(s.coord.lat, CD_HZ_XIAN.waypoints[1].snapped.lat, '坐标就是吸附后的必经点');
  assert.equal(s.coord.lon, CD_HZ_XIAN.waypoints[1].snapped.lon);
  assert.ok(Math.abs(s.cumSecAtArrival - 18933.8) < 0.01, 't 推进到该 leg 结束');
  // 反证：同一条路线、更小的每日目标，切点离必经点 85 km → 不该吸附
  const far = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(far.stopovers[0].anchorFrom, 'cumulative-4h', '离必经点太远的切点不该被吸附');
});

test('⑩ 起点 / 终点永不成为 Stopover（真实样本）', () => {
  for (const f of [CD_XIAN, CD_HZ_XIAN, XIAN_LUOYANG]) {
    for (const target of [10800, 14400, 18000]) {
      const r = rt.splitStopovers(f, { dailyTargetSec: target }, { nowMs: NOW });
      const first = f.geometry[0];
      const last = f.geometry[f.geometry.length - 1];
      for (const s of r.stopovers) {
        assert.ok(
          !(s.coord.lon === first[0] && s.coord.lat === first[1]),
          '起点不许成为停留点（它属于 plan.origin）'
        );
        assert.ok(
          !(s.coord.lon === last[0] && s.coord.lat === last[1]),
          '终点不许成为停留点（它属于 plan.destination）'
        );
      }
    }
  }
});

test('⑪【合成夹具，非真实响应】去重：离必经点 556 m 的切点被丢弃；阈值改 0 则保留', () => {
  // 4 点 3 边，必经点在下标 2。每边 556 m / 3000 s（刻意做成「很慢」，
  // 好让「空间上近」与「时间上近」分开 —— 真实高速上这两件事是绑死的）。
  const points = [
    [0, 0],
    [0.005, 0],
    [0.01, 0],
    [0.015, 0],
  ];
  const route = synthRoute(points, [3000, 3000, 3000], [556, 556, 556], [0, 2, 3]);

  const dropped = rt.splitStopovers(route, { dailyTargetSec: 2500, minGapSec: 100 }, { nowMs: NOW });
  // 第一刀落在下标 1：离必经点(下标 2) 556 m < 2000 → 丢弃；时间上早 3000 s > 900 → 不吸附
  const firstCut = dropped.stopovers.find((s) => s.coord.lon === 0.005);
  assert.equal(firstCut, undefined, '离必经点 556 m 的切点应被去重丢掉');
  // 第二刀落在必经点本身 → via，保留
  assert.equal(dropped.stopovers.length, 1);
  assert.equal(dropped.stopovers[0].anchorFrom, 'via');

  // ★阈值改成 0：同一刀被保留，于是变成 2 个停留点 —— 这正是「去重阈值改成 0」的变异证明
  const kept = rt.splitStopovers(
    route,
    { dailyTargetSec: 2500, minGapSec: 100 },
    { nowMs: NOW, dedupM: 0 }
  );
  assert.equal(kept.stopovers.length, 2, '阈值改成 0 后不再去重');
  assert.equal(kept.stopovers[0].coord.lon, 0.005, '被保留的正是原来那一刀');
});

test('⑫【合成夹具，非真实响应】跨过门槛的那个点正好是终点时，不切', () => {
  // 3 点 2 边，每边 100 s：cumS = [0, 100, 200]。dailyTargetSec=150 时，
  // 第一个跨过 150 的点是下标 2 —— 那是终点，第 6 条不许它入选。
  const points = [[0, 0], [0.001, 0], [0.002, 0]];
  const route = synthRoute(points, [100, 100], [111, 111], [0, 2]);
  const r = rt.splitStopovers(route, { dailyTargetSec: 150, minGapSec: 0 }, { nowMs: NOW });
  assert.equal(r.stopovers.length, 0, '跨过门槛的点是终点 → 这一刀不能算');
  assert.equal(r.dayCount, 1);
});

/* ------------------------------------------------------------------ */
/* ⑥ Stopover 形状 / 默认值 / 失败路径                                  */
/* ------------------------------------------------------------------ */

test('⑬ Stopover 形状照 §4.4：字段齐全、缺的一律 null（不是 0 / 空串）', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  for (const s of r.stopovers) {
    assert.match(s.id, /^so-/, 'id 由 core 生成');
    assert.ok(Number.isInteger(s.day) && s.day >= 1);
    assert.ok(Number.isInteger(s.seq) && s.seq >= 1);
    assert.ok(s.coord && Number.isFinite(s.coord.lat) && Number.isFinite(s.coord.lon));
    assert.ok(rt.ANCHOR_SOURCES.includes(s.anchorFrom), `anchorFrom=${s.anchorFrom}`);
    assert.ok(Number.isFinite(s.cumSecAtArrival));
    assert.ok(Number.isFinite(s.driveFromPrevS));
    assert.ok(Number.isFinite(s.driveFromPrevM));
    // 未逆地理 → 名字缺失是 null，不是空串（空串会被渲染成一行空白）
    assert.equal(s.placeName, null);
    assert.equal(s.placeSource, 'coord');
    assert.equal(s.note, '');
    assert.equal(s.actual, null);
  }
});

test('⑭ plan 缺省时走默认 4 h / 30 min；显式给非法值 → 失败而不是悄悄改', () => {
  const dflt = rt.splitStopovers(CD_XIAN, {}, { nowMs: NOW });
  assert.equal(dflt.stopovers.length, 1, '默认 4 h（与 14400 那一档一致）');
  assert.equal(dflt.dayCount, 2);

  const bad = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 0 }, { nowMs: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonKind, 'badTarget');
  assert.equal(bad.stopovers.length, 0, '失败时 stopovers 恒为空，不许半途给一半');

  const badGap = rt.splitStopovers(CD_XIAN, { minGapSec: -1 }, { nowMs: NOW });
  assert.equal(badGap.ok, false);
  assert.equal(badGap.reasonKind, 'badTarget');
});

test('⑮ 数据不全 → 失败并给机器码；**绝不**用估算把缺的那段补上', () => {
  const noRoute = rt.splitStopovers(null, {}, { nowMs: NOW });
  assert.equal(noRoute.ok, false);
  assert.equal(noRoute.reasonKind, 'noRoute');

  const noGeo = rt.splitStopovers({ ...CD_XIAN, geometry: null }, {}, { nowMs: NOW });
  assert.equal(noGeo.ok, false);
  assert.equal(noGeo.reasonKind, 'noGeometry');

  // ★没有逐边时长就没有切段依据：不许按「总时长 ÷ 边数」或「距离 ÷ 假想速度」补
  const noAnn = rt.splitStopovers({ ...CD_XIAN, cumulativeS: null, cumulativeKind: 'none' }, {}, { nowMs: NOW });
  assert.equal(noAnn.ok, false);
  assert.equal(noAnn.reasonKind, 'noAnnotations');
  assert.equal(noAnn.stopovers.length, 0);

  // cumulativeM 缺失 → 里程给 null（时长仍然算得出来，但不能编里程）
  const noMeters = rt.splitStopovers({ ...CD_XIAN, cumulativeM: null }, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(noMeters.ok, true);
  assert.equal(noMeters.stopovers[0].driveFromPrevM, null, '缺逐边里程 → driveFromPrevM 为 null');
  assert.ok(Number.isFinite(noMeters.stopovers[0].driveFromPrevS), '时长照给');
});

test('⑯ ★失败时机器码与 i18n 键**并存**：不许把「猜文案」的活丢给 UI', () => {
  const cases = [
    rt.splitStopovers(null, {}, { nowMs: NOW }),
    rt.splitStopovers({ ...CD_XIAN, geometry: null }, {}, { nowMs: NOW }),
    rt.splitStopovers({ ...CD_XIAN, cumulativeS: null, cumulativeKind: 'none' }, {}, { nowMs: NOW }),
    rt.splitStopovers(CD_XIAN, { dailyTargetSec: 0 }, { nowMs: NOW }),
    rt.splitStopovers(CD_XIAN, { minGapSec: -1 }, { nowMs: NOW }),
  ];
  const seen = new Set();
  for (const r of cases) {
    assert.equal(r.ok, false);
    assert.ok(typeof r.reasonKind === 'string' && r.reasonKind.length > 0, '机器码必须有（程序分支用）');
    // ★核心：`reasonKey` 恒为 null 是**回退** —— 那等于断了「core 产键、UI 翻译」这条
    //   全仓约定，UI 只能拿 `reasonKind` 自己编一句说法，于是每层各有一套措辞。
    assert.ok(
      typeof r.reasonKey === 'string' && r.reasonKey.length > 0,
      `${r.reasonKind} 必须给出 i18n 键（不许恒 null），实际 ${JSON.stringify(r.reasonKey)}`
    );
    // ★必须是 `rt.err.*` 这一族：`trip.*` 那七个是**文件级**失败（不是行程文件 / 版本
    //   太新），拿来描述「这条路线缺逐边时长」就是张冠李戴 —— 界面会告诉用户一个
    //   跟实际原因无关的理由。这一条断言就是防那个的。
    assert.ok(
      r.reasonKey.indexOf('rt.err.') === 0,
      `${r.reasonKind} 的键必须落在 rt.err.* 族，实际 ${r.reasonKey}`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(ZH, r.reasonKey),
      `中文表必须有 ${r.reasonKey}（漏翻会让界面直接显示键名）`
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(EN, r.reasonKey),
      `英文表必须有 ${r.reasonKey}（两张表必须同构）`
    );
    assert.ok(r.reasonParams && typeof r.reasonParams === 'object');
    seen.add(r.reasonKind);
  }
  // 四种失败分类全部被走到 —— 少一种就说明有分支没被这条用例覆盖
  assert.deepEqual([...seen].sort(), Object.values(rt.SPLIT_FAIL).sort(), 'SPLIT_FAIL 的每一档都要被覆盖');

  // ★`noRoute` 这一档必须落在**不带占位符**的键上：它的成因是「压根没拿到一份路线数据」，
  //   没有 OSRM 错误码可填；用 `rt.err.noRoute`（带 {code}）会让占位符原样上屏，
  //   用户看到「…（OSRM 返回 {code}）」这种半成品句子。
  const noRouteKey = rt.splitStopovers(null, {}, { nowMs: NOW }).reasonKey;
  assert.ok(
    ZH[noRouteKey].indexOf('{') === -1 && EN[noRouteKey].indexOf('{') === -1,
    `noRoute 的文案不许带占位符（没有码可填），实际 zh「${ZH[noRouteKey]}」/ en「${EN[noRouteKey]}」`
  );
});

test('⑯b 成功时 reasonKind / reasonKey 都是 null（失败才给，成功不占位）', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reasonKind, null);
  assert.equal(r.reasonKey, null);
});

test('⑰ 天数语义：dayCount = 停留点数 + 1，且每个 Stopover 是「第 N 天的落脚点」', () => {
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  assert.equal(r.dayCount, r.stopovers.length + 1);
  r.stopovers.forEach((s, i) => assert.equal(s.day, i + 1));
  // 每日时长之和 + **末段** = Σ annotation（不许有对不上的零头）
  // ★末段用 tailSec，不是 tailMergedSec：后者只是「收尾规则触发时多出来的那一截」，
  //   前者才是「最后一个停留点 → 终点」的完整一段。少了 tailSec 这个字段，
  //   UI 就画不出最后一天开多久 —— 最后一天没有落脚点可挂。
  const sumDays = r.stopovers.reduce((a, s) => a + s.driveFromPrevS, 0);
  assert.ok(
    Math.abs(sumDays + r.tailSec - r.totalSecAnn) < 0.01,
    `每日之和 ${sumDays} + 末段 ${r.tailSec} 应等于 Σ annotation ${r.totalSecAnn}`
  );
  assert.ok(r.tailSec > 0, '末段必须大于 0（终点总在最后一个停留点之后）');
  assert.ok(Number.isFinite(r.tailM), '末段里程也要给（cumulativeM 有就有）');
});

test('⑱ ★收尾触发时，tailMergedSec 是末段里「多出来」的那一截，不是末段全长', () => {
  // 成都→西安 @4h：第二刀被收尾规则作废 → 它后面那 455 s 并进第 2 天；
  // 而第 2 天全长 = 14404 s（第一刀 → 被作废那刀）+ 455 s = 14858 s。
  const r = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.ok(r.tailMergedSec > 0, '这条样本应触发收尾规则');
  assert.ok(
    r.tailMergedSec < r.tailSec,
    `被并入的 ${r.tailMergedSec}s 应只是末段 ${r.tailSec}s 的一部分`
  );
  assert.equal(r.tailMergedIntoDay, r.dayCount, '并入的是最后一天');
  // 3h 那条没触发收尾：末段就是一个完整的第 3 天
  const r3 = rt.splitStopovers(CD_XIAN, { dailyTargetSec: 10800 }, { nowMs: NOW });
  assert.equal(r3.tailMergedSec, 0, '没触发收尾时不应报并入量');
  assert.equal(r3.tailMergedIntoDay, null);
  assert.ok(Math.abs(r3.tailSec - 7643.7) < 0.01, `第 3 天开 ${r3.tailSec}s`);
});

/* ------------------------------------------------------------------ */
/* ⑫ 必经点「必须经过 / 仅供参考」（需求 8.2，2026-10-16）              */
/* ------------------------------------------------------------------ */

test('⑫-1 ★「必须经过」无视吸附容差：离必经点很远的切点也要落到必经点', () => {
  // 反证基线：dailyTargetSec=14400 时，切点离汉中 85 km（远超 VIA_SNAP_TOL_SEC 900 s）
  // → 不传 via（=「没说」）时不吸附，anchorFrom='cumulative-4h'（既有行为）。
  const loose = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(loose.stopovers[0].anchorFrom, 'cumulative-4h', '没说 required 时必须沿用原有容差行为');

  // 同一个夹具、把必经点显式设成「必须经过」→ **无视容差**，落到汉中
  const must = rt.splitStopovers(
    CD_HZ_XIAN,
    { dailyTargetSec: 14400, via: [{ required: true }] },
    { nowMs: NOW }
  );
  assert.equal(must.stopovers[0].anchorFrom, 'via', '「必须经过」必须无视容差，落到必经点');
  assert.equal(must.stopovers[0].coord.lat, CD_HZ_XIAN.waypoints[1].snapped.lat, '坐标就是那个必经点');
});

test('⑫-2 ★「仅供参考」与「没说」行为一致：都只在容差内吸附', () => {
  const opt = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400, via: [{ required: false }] }, { nowMs: NOW });
  const unsaid = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  assert.equal(opt.stopovers[0].anchorFrom, 'cumulative-4h', '「仅供参考」超容差不吸附');
  assert.equal(
    opt.stopovers[0].anchorFrom,
    unsaid.stopovers[0].anchorFrom,
    '「仅供参考」与「没说」必须同行为 —— 「没说」不能被放大成「必须」'
  );
});

test('⑫-3 ★缺省不许放大语义：plan.via 缺失 / 元素没 required 字段，一律沿用原行为', () => {
  // 这条是 2026-10-16 真事故的回归锁：当时把「没说」归并进「必须经过」，
  // 于是老行程的分天被静默改写（必经点全部强制停留），两条既有单测当场见红。
  const noVia = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW });
  const emptyField = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400, via: [{}] }, { nowMs: NOW });
  const junkVia = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400, via: [null, 'x'] }, { nowMs: NOW });
  for (const [name, r] of [['没传 via', noVia], ['via 元素空对象', emptyField], ['via 元素非法', junkVia]]) {
    assert.equal(r.stopovers[0].anchorFrom, 'cumulative-4h', `${name} 时必须沿用原有容差行为`);
  }
  assert.equal(noVia.stopovers.length, emptyField.stopovers.length, '天数也不许变');
});

test('⑫-4 newPlaceRef：required 默认 true，只有显式 false 才是「仅供参考」', () => {
  assert.equal(rt.newPlaceRef({}).required, true, '默认是「必须经过」—— 加必经点就是要停');
  assert.equal(rt.newPlaceRef({ required: false }).required, false, '显式 false 才是仅供参考');
  assert.equal(rt.newPlaceRef({ required: true }).required, true);
  // ★不许被 Number(null)===0 那类陷阱带偏：非布尔一律按默认，不静默变 false
  assert.equal(rt.newPlaceRef({ required: 0 }).required, true, '只认真正的布尔，其余按默认');
  assert.equal(rt.newPlaceRef({ required: 'false' }).required, true, '字符串 false 不是布尔 false');
  assert.equal(rt.newPlaceRef({ required: null }).required, true);
});

test('⑫-5 ★「必须经过」的必经点不会被「余段不足 minGapSec」悄悄吞掉', () => {
  // ★构造要真的走到那条分支（第一版测试没做到，变异验证才暴露出来）：
  //   `minGapSec` 设成远超总时长 → 按第 3 条，任何一刀都「余段不足」而作废。
  //   汉中在路线中段，光靠它触发不了余段不足，必须把 minGapSec 拉大。
  const HUGE_GAP = 999999;

  // 反证基线：「没说 required」时，余段不足 → 一刀都不切
  const none = rt.splitStopovers(CD_HZ_XIAN, { dailyTargetSec: 14400 }, { nowMs: NOW, minGapSec: HUGE_GAP });
  assert.equal(none.stopovers.length, 0, '余段不足时按第 3 条不应切出任何停留点');

  // 「仅供参考」同样可以让它作废 —— 建议不是承诺
  const opt = rt.splitStopovers(
    CD_HZ_XIAN,
    { dailyTargetSec: 14400, via: [{ required: false }] },
    { nowMs: NOW, minGapSec: HUGE_GAP }
  );
  assert.equal(opt.stopovers.length, 0, '「仅供参考」不承诺停，余段不足时可以整段作废');

  // ★「必须经过」：第 3 条必须为它让路，否则这个点会**静默消失**（界面不报错，
  //   只是没人告诉你「你说必须停的那个点其实没停」）—— 那是假的「必须经过」。
  const must = rt.splitStopovers(
    CD_HZ_XIAN,
    { dailyTargetSec: 14400, via: [{ required: true }] },
    { nowMs: NOW, minGapSec: HUGE_GAP }
  );
  assert.ok(must.ok, '切段必须成功');
  const hasVia = must.stopovers.some((s) => s.anchorFrom === 'via');
  assert.ok(
    hasVia,
    `设为「必须经过」的必经点必须出现在停留点里，实际：${JSON.stringify(must.stopovers.map((s) => s.anchorFrom))}`
  );
});
