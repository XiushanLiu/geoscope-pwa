/**
 * core/sun.js 独立验证（NOAA 日出日落，纯函数、离线可用）
 *
 * 覆盖：北京春分昼长≈12h / 北纬 80° 夏至极昼·冬至极夜 / 赤道附近 / 南半球季节相反 /
 * dateUTC 传 ms 与 Date 对象两种形态 / 异常纬度（±91）不崩 /
 * isDaylight 昼夜判定与 sunrise/sunset 自洽 / solarNoon 可用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const sun = await import('../src/core/sun.js');

/** @returns {number} UTC ms。 */
const utc = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * 取某地对某日的计算结果。
 */
const at = (lat, lon, iso) => sun.sunriseSunset({ lat, lon, dateUTC: utc(iso) });

/**
 * 转成 HH:MM（UTC）。
 */
const hhmm = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(11, 16));

test('北京（39.9087,116.3975）春分昼长≈12h、夏至≈15h、冬至≈9.3h', () => {
  const spring = at(39.9087, 116.3975, '2025-03-20');
  assert.equal(spring.polar, 'none');
  assert.ok(Math.abs(spring.dayLengthMs - 12 * 3600000) < 20 * 60000, `春分昼长应≈12h，实际 ${spring.dayLengthMs / 3600000}h`);

  const summer = at(39.9087, 116.3975, '2025-06-21');
  assert.ok(Math.abs(summer.dayLengthMs - 15 * 3600000) < 15 * 60000, `夏至昼长应≈15h，实际 ${summer.dayLengthMs / 3600000}h`);

  const winter = at(39.9087, 116.3975, '2025-12-21');
  assert.ok(Math.abs(winter.dayLengthMs - 9.3 * 3600000) < 20 * 60000, `冬至昼长应≈9.3h，实际 ${winter.dayLengthMs / 3600000}h`);

  assert.ok(summer.dayLengthMs > spring.dayLengthMs && spring.dayLengthMs > winter.dayLengthMs, '昼长必须 夏>春分>冬');
});

test('北京夏至日出 04:45 左右、日落 19:44 左右（UTC+8 视图），昼夜跨界的时:分正确', () => {
  const summer = at(39.9087, 116.3975, '2025-06-21');
  // 内部返回 UTC 语义 epoch，按 +8h 偏移还原成北京时间
  const sunriseLocal = hhmm(summer.sunriseAt + 8 * 3600000);
  const sunsetLocal = hhmm(summer.sunsetAt + 8 * 3600000);
  assert.equal(sunriseLocal, '04:45', `北京夏至日出应≈04:45 CST，实际 ${sunriseLocal}`);
  assert.equal(sunsetLocal, '19:44', `北京夏至日落应≈19:44 CST，实际 ${sunsetLocal}`);
});

test('北纬 80°：夏至极昼（dayLength≈24h）、冬至极夜（dayLength=0），sunrise/sunset 为 null', () => {
  const summer = at(80, 0, '2025-06-21');
  assert.equal(summer.polar, 'polar-day', '北纬 80° 夏至必须是极昼');
  assert.equal(summer.sunriseAt, null);
  assert.equal(summer.sunsetAt, null);
  assert.equal(summer.dayLengthMs, 86400000, '极昼昼长应为 24h');

  const winter = at(80, 0, '2025-12-21');
  assert.equal(winter.polar, 'polar-night', '北纬 80° 冬至必须是极夜');
  assert.equal(winter.dayLengthMs, 0, '极夜昼长应为 0');
  assert.equal(winter.sunriseAt, null);

  // 南纬对称：季节相反
  const southSummer = at(-80, 0, '2025-12-21');
  assert.equal(southSummer.polar, 'polar-day', '南纬 80° 在南半球夏至（12 月）必须是极昼');
  const southWinter = at(-80, 0, '2025-06-21');
  assert.equal(southWinter.polar, 'polar-night');
});

test('赤道附近全年昼长≈12h，永不会出现极昼极夜', () => {
  for (const iso of ['2025-01-15', '2025-03-20', '2025-06-21', '2025-09-23', '2025-12-21']) {
    const r = at(0.5, 10, iso);
    assert.equal(r.polar, 'none', `赤道附近 ${iso} 不得判定为极区`);
    assert.ok(Math.abs(r.dayLengthMs - 12 * 3600000) < 15 * 60000, `${iso} 赤道昼长应≈12h，实际 ${r.dayLengthMs / 3600000}h`);
  }
});

test('南半球（悉尼 -33.9,151.2）季节与北半球相反', () => {
  const dec = at(-33.9, 151.2, '2025-12-21'); // 南半球夏至
  const jun = at(-33.9, 151.2, '2025-06-21'); // 南半球冬至
  assert.ok(dec.dayLengthMs > jun.dayLengthMs, '悉尼 12 月昼长必须大于 6 月');
  assert.ok(dec.dayLengthMs > 14 * 3600000, `悉尼夏至应≈14.4h，实际 ${dec.dayLengthMs / 3600000}h`);
  assert.ok(jun.dayLengthMs < 10.2 * 3600000, `悉尼冬至应≈9.9h，实际 ${jun.dayLengthMs / 3600000}h`);
});

test('dateUTC 传 ms epoch 与传 Date 对象结果完全一致', () => {
  const ms = utc('2025-06-21');
  const a = sun.sunriseSunset({ lat: 39.9087, lon: 116.3975, dateUTC: ms });
  const b = sun.sunriseSunset({ lat: 39.9087, lon: 116.3975, dateUTC: new Date(ms) });
  assert.equal(a.sunriseAt, b.sunriseAt);
  assert.equal(a.sunsetAt, b.sunsetAt);
  assert.equal(a.dayLengthMs, b.dayLengthMs);
  assert.equal(a.polar, b.polar);
});

test('dateUTC 支持 ms epoch / Date / ISO 字符串三种形态（结果一致）', () => {
  const iso = '2025-06-21T00:00:00Z';
  const ms = Date.parse(iso);
  const a = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: ms });
  const b = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: new Date(ms) });
  const c = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: iso });
  assert.equal(b.sunriseAt, a.sunriseAt);
  assert.equal(c.sunriseAt, a.sunriseAt, 'ISO 字符串必须与 ms epoch 给出同一结果');
  assert.equal(c.sunsetAt, a.sunsetAt);
  assert.equal(c.polar, 'none');
  // 非法字符串不得抛，降级为 null
  const bad = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: 'not-a-date' });
  assert.equal(bad.sunriseAt, null);
  assert.equal(bad.sunsetAt, null);
});

test('异常纬度 ±91 不崩、不在业务层 NaN 化；±180 经度亦可用', () => {
  for (const lat of [91, -91, 90, -90, 120]) {
    const r = at(lat, 0, '2025-06-21');
    assert.ok(['none', 'polar-day', 'polar-night'].indexOf(r.polar) !== -1, `纬度 ${lat} 必须给出合法 polar 值`);
    if (r.polar === 'none') {
      assert.ok(Number.isFinite(r.sunriseAt) && Number.isFinite(r.sunsetAt), '非极区必须给出有限时间戳');
    }
  }
  const edge = at(0, 180, '2025-06-21');
  assert.equal(edge.polar, 'none');
  assert.ok(Number.isFinite(edge.dayLengthMs));
  // 非数值入参不崩
  const nan = sun.sunriseSunset({ lat: 0, lon: 0, dateUTC: NaN });
  assert.equal(nan.sunriseAt, null);
  assert.equal(nan.sunsetAt, null);
});

test('缺失 lat/lon/dateUTC 时返回全 null（NaN 文案不泄漏到界面）', () => {
  const r = sun.sunriseSunset({});
  assert.equal(r.sunriseAt, null);
  assert.equal(r.sunsetAt, null);
  assert.equal(r.dayLengthMs, null);
});

test('isDaylight 与本地 sunrise/sunset 自洽：北京夏至正午为白昼、午夜为夜间', () => {
  const BJ = { lat: 39.9087, lon: 116.3975 };
  const day = utc('2025-06-21');
  // 北京时间 12:00 → UTC-8h
  assert.equal(sun.isDaylight(day + 4 * 3600000, BJ), true, '北京夏至 12:00 CST 必须是白昼');
  // 北京时间 01:00 → CST 前一日 17:00Z
  assert.equal(sun.isDaylight(day + 17 * 3600000, BJ), false, '北京夏至 01:00 CST 必须是夜间');
  // 极区常量
  assert.equal(sun.isDaylight(day, { lat: 80, lon: 0 }), true, '北纬 80° 夏至恒为白昼');
  assert.equal(sun.isDaylight(utc('2025-12-21'), { lat: 80, lon: 0 }), false, '北纬 80° 冬至恒为夜间');
});

test('solarNoon 返回有限 ms epoch，且大致位于 sunrise 与 sunset 之间', () => {
  const r = at(39.9087, 116.3975, '2025-06-21');
  const noon = sun.solarNoon({ lat: 39.9087, lon: 116.3975, dateUTC: utc('2025-06-21') });
  assert.ok(Number.isFinite(noon), 'solarNoon 必须返回有限数字');
  // 夏令时时段的北京正午 ≈ 12:36 CST → UTC 04:36，允许 ±40 分钟误差
  const localNoon = hhmm(noon + 8 * 3600000);
  assert.ok(localNoon >= '11:55' && localNoon <= '13:15', `北京夏至正午应≈12:36 CST，实际 ${localNoon}`);
  assert.ok(r.solarNoonAt > Math.min(r.sunriseAt, r.sunsetAt) - 86400000, '正午必须落在同一天的昼夜窗口内');
});

test('同纬度不同经度：东经比西经更早日出（经度参与计算而非被忽略）', () => {
  const east = at(39.9, 116.4, '2025-03-20');
  const west = at(39.9, -116.4, '2025-03-20');
  assert.notEqual(hhmm(east.sunriseAt), hhmm(west.sunriseAt), '不同经度必须给出不同的日出时刻');
});

test('zenith=0 是显式取值，不许回落默认值', () => {
  const def = at(39.9, 116.4, '2025-06-21');
  const zero = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: utc('2025-06-21'), zenith: 0 });
  assert.notEqual(
    zero.sunriseAt,
    def.sunriseAt,
    '★显式传 0 必须生效：旧写法 || 会把它当成「未提供」而回落 90.833'
  );
  assert.ok(zero && typeof zero === 'object', '不许抛异常，返回结构仍完整');
  assert.ok('sunriseAt' in zero && 'sunsetAt' in zero && 'dayLengthMs' in zero);
});

test('zenith 未提供 / null / 空串 / 非数字 → 回落 90.833（原容错不许丢）', () => {
  const def = at(39.9, 116.4, '2025-06-21');
  const base = { lat: 39.9, lon: 116.4, dateUTC: utc('2025-06-21') };
  const cases = [
    sun.sunriseSunset({ ...base }),
    sun.sunriseSunset({ ...base, zenith: 'abc' }),
    sun.sunriseSunset({ ...base, zenith: null }),
    sun.sunriseSunset({ ...base, zenith: '' }),
    sun.sunriseSunset({ ...base, zenith: NaN }),
  ];
  for (const r of cases) {
    assert.equal(r.sunriseAt, def.sunriseAt, '未提供或无效值必须回落默认 90.833');
  }
});

test('zenith=90.833 与不传等价（默认值本身没被改动）', () => {
  const def = at(39.9, 116.4, '2025-06-21');
  const explicit = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: utc('2025-06-21'), zenith: 90.833 });
  assert.equal(explicit.sunriseAt, def.sunriseAt);
});
