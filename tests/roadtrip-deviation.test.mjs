/**
 * 偏离重规划判定（需求 8.4，2026-10-16）
 *
 * 阈值：默认 **50 km**（用户最初提 100 km，同轮改为 50 km），且**可设置**
 * （`DEVIATION_PRESETS_M` 四档），不许在代码里写死成一个字面量。
 *
 * 这一组钉的是三条诚实性红线：
 *   1. 「判不了」≠「没偏离」—— 没定位 / 没规划停留点时必须返回 unknown，
 *      压成 false 等于在任何时候都宣称「一切正常」；
 *   2. 定位失败拿到的**默认地点不许当真** —— `getCurrentPosition()` 会回退到
 *      DEFAULT_PLACE，拿它算距离会得出一个看起来很有道理的假偏离；
 *   3. 显示的是**直线距离**，不是「沿路还要开多远」—— 两者是不同量，不许混说。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as rt from '../src/core/roadtrip.js';

/** 三个规划停留点（近似：成都 / 汉中 / 西安）。 */
const STOPS = [
  { id: 'so1', coord: { lat: 30.5728, lon: 104.0668 } },
  { id: 'so2', coord: { lat: 33.0677, lon: 107.0231 } },
  { id: 'so3', coord: { lat: 34.3416, lon: 108.9398 } },
];

test('★阈值默认 50 km，且必须是可设置的（不是写死的字面量）', () => {
  assert.equal(rt.DEFAULT_DEVIATION_REPLAN_M, 50000, '默认阈值必须是 50 km');
  assert.ok(Array.isArray(rt.DEVIATION_PRESETS_M), '必须给出可选档位');
  assert.ok(rt.DEVIATION_PRESETS_M.includes(50000), '档位里必须含 50 km');
  // 同一个位置、同一个停留点，只改阈值就能翻转结论 —— 证明阈值真的接进判定里了
  const far = { lat: 30.5728, lon: 105.2 }; // 离成都约 110 km
  assert.equal(rt.findDeviation(far, STOPS, 50000).state, rt.DEVIATION_STATE.OVER);
  assert.equal(rt.findDeviation(far, STOPS, 200000).state, rt.DEVIATION_STATE.OK);
});

test('★在阈值内 → ok；超出 → over（50 km 档实测）', () => {
  // 成都东偏一点，约 30 km
  const near = { lat: 30.60, lon: 104.40 };
  const a = rt.findDeviation(near, STOPS, 50000);
  assert.equal(a.state, rt.DEVIATION_STATE.OK, `约 30 km 应在 50 km 阈值内，实际 ${a.nearestKm}`);
  assert.ok(a.nearestKm < 50, '返回的距离也要真的是 km');
  assert.equal(a.nearestIndex, 0, '最近的应是第一个停留点（成都）');

  // 明显跑偏
  const away = { lat: 28.0, lon: 112.9 }; // 长沙方向
  const b = rt.findDeviation(away, STOPS, 50000);
  assert.equal(b.state, rt.DEVIATION_STATE.OVER);
});

test('★「判不了」必须是 unknown，不许压成「没偏离」', () => {
  // 没有当前位置
  const noPos = rt.findDeviation(null, STOPS, 50000);
  assert.equal(noPos.state, rt.DEVIATION_STATE.UNKNOWN, '没定位时必须判不了');
  assert.notEqual(noPos.state, rt.DEVIATION_STATE.OK, '★没定位绝不能等于「在阈值内」');

  // 没有规划停留点
  const noStop = rt.findDeviation({ lat: 30.5, lon: 104.0 }, [], 50000);
  assert.equal(noStop.state, rt.DEVIATION_STATE.UNKNOWN, '没停留点时必须判不了');

  // 停留点全都没坐标
  const noCoord = rt.findDeviation({ lat: 30.5, lon: 104.0 }, [{ id: 'x', coord: null }], 50000);
  assert.equal(noCoord.state, rt.DEVIATION_STATE.UNKNOWN, '停留点没坐标时必须判不了');
  assert.equal(noCoord.locatedCount, 0, '没坐标的不许被当成「距离为 0 的最近点」');

  // 坐标非法
  assert.equal(rt.findDeviation({ lat: NaN, lon: NaN }, STOPS, 50000).state, rt.DEVIATION_STATE.UNKNOWN);
  assert.equal(rt.findDeviation({ lat: 'x', lon: 'y' }, STOPS, 50000).state, rt.DEVIATION_STATE.UNKNOWN);
});

test('★阈值非法时回落默认 50 km，绝不许落成 0（0 = 一动就报偏离）', () => {
  const cur = { lat: 30.5728, lon: 104.0668 }; // 就在成都上
  for (const bad of [null, undefined, 0, -1, NaN, 'abc']) {
    const d = rt.findDeviation(cur, STOPS, bad);
    assert.equal(d.thresholdM, 50000, `阈值 ${String(bad)} 必须回落 50 km`);
    assert.equal(d.state, rt.DEVIATION_STATE.OK, `阈值 ${String(bad)} 时不该把「原地」判成偏离`);
  }
});

test('★plan 归一：deviationReplanM 缺失 / 非法一律回落默认，不许是 0', () => {
  // `_plan()` 未导出，走公开路径 `newTrip()`（它内部过 `_plan()`）
  for (const bad of [undefined, null, 0, -5, NaN, 'xx']) {
    const trip = rt.newTrip({ deviationReplanM: bad });
    assert.equal(
      trip.plan.deviationReplanM,
      50000,
      `deviationReplanM=${String(bad)} 必须回落 50 km，不许落成 0（一动就报偏离）`
    );
  }
  const ok = rt.newTrip({ deviationReplanM: 200000 });
  assert.equal(ok.plan.deviationReplanM, 200000, '合法的自定义阈值必须被保留');
});

test('★距离是「直线距离」，且取的是**最近**的那个停留点', () => {
  // 放在西安附近：最近的应是 so3（西安），不是 so1（成都）
  const d = rt.findDeviation({ lat: 34.35, lon: 108.95 }, STOPS, 50000);
  assert.equal(d.nearestIndex, 2, '最近的是第三个停留点（西安）');
  assert.ok(d.nearestKm < 5, `就在西安边上，距离应很小，实际 ${d.nearestKm}`);
  // 直线距离 <= 沿路距离，不会反过来 —— 这里只钉它是个正数且量级合理
  assert.ok(d.nearestKm >= 0);
});

/* ------------------------------------------------------------------ */
/* UI 层：定位失败时**不许**拿默认地点算出一个假偏离                     */
/* ------------------------------------------------------------------ */

/**
 * 定位失败 → `getCurrentPosition()` 回退默认地点（`source:'default'`），坐标是**真的
 * 经纬度**，拿去算距离会得出一个看起来很有道理的「偏离 N 公里」。
 *
 * ★判定收在 core 的 `isRealGps()`，UI 调它而不是自己写 `pos.source === 'gps'` ——
 *   所以这里测的是**被调用的那个函数本身**。
 *   ⚠️ 第一版我在测试里重抄了一遍 `pos.source === 'gps'`，那是**假绿**：改 UI 不改
 *   测试照样绿（测试与实现是同构复制品，谁改都不影响对方）。收进 core 才有得测。
 */
test('★定位失败回退的默认地点，不许被当成真实定位去算偏离', async () => {
  const { installNavigator, installStorage, installFetch, FakeStorage } = await import('./harness.mjs');
  installStorage(new FakeStorage());
  installNavigator({ online: true });
  installFetch();

  // 定位失败（拒绝 / 超时 / 无 geolocation 都走这条路）
  globalThis.navigator.geolocation = {
    getCurrentPosition: (_ok, fail) => {
      if (fail) fail(new Error('denied'));
    },
  };
  const geo = await import('../src/core/geo.js');
  const pos = await geo.getCurrentPosition({ timeoutMs: 50 });

  assert.equal(pos.source, 'default', '前置：定位失败时确实回退到默认地点');
  assert.equal(rt.isRealGps(pos), false, '★回退的默认地点绝不能算真实定位');

  // 反证：这个假坐标**确实**能算出一个距离 —— 说明必须拦在来源上，光看数字看不出来
  const fake = rt.findDeviation({ lat: pos.lat, lon: pos.lon }, STOPS, 50000);
  assert.ok(fake.nearestKm !== null, '前置：假坐标能算出距离（所以才必须靠 isRealGps 拦）');

  // 真实 GPS 必须放行
  assert.equal(rt.isRealGps({ source: 'gps', lat: 30.5, lon: 104.0 }), true, '真实 GPS 必须放行');
  // 边界：坐标非法 / 缺字段，一律不算
  assert.equal(rt.isRealGps({ source: 'gps', lat: NaN, lon: 104.0 }), false);
  assert.equal(rt.isRealGps({ source: 'gps' }), false);
  assert.equal(rt.isRealGps(null), false);
  assert.equal(rt.isRealGps(undefined), false);
});
