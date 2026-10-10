/**
 * core/wmo.js 独立验证
 *
 * 覆盖：WMO 全表（含 45/48 雾、71/73/75/77 雪、95/96/99 雷暴）/ 未知码兜底 /
 * 欧洲 AQI 六档全部边界值 / UV 五档全部边界值 / 16 方位边界（含跨档与负值）/
 * 蒲福风级边界 / 非数值入参不得抛异常。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const wmo = await import('../src/core/wmo.js');

test('WMO 全表可见与 extremeauit 口径一致：所有受支持码都能给出中文、短描述与图标', () => {
  const expected = {
    0: '晴', 1: '大部晴朗', 2: '局部多云', 3: '阴',
    45: '雾', 48: '沉积雾凇雾',
    51: '小毛毛雨', 53: '中毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨（弱）', 57: '冻毛毛雨（强）',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨（弱）', 67: '冻雨（强）',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '小阵雨', 81: '中阵雨', 82: '强阵雨', 85: '小阵雪', 86: '大阵雪',
    95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴大冰雹',
  };
  const codes = Object.keys(expected).map(Number);
  for (const c of codes) {
    const r = wmo.wmo(c);
    assert.equal(r.zh, expected[c], `WMO ${c} 文案不符`);
    assert.equal(r.code, c);
    assert.ok(typeof r.short === 'string' && r.short.length > 0, `WMO ${c} 必须有短描述`);
    assert.ok(typeof r.icon === 'string' && r.icon.length > 0, `WMO ${c} 必须有图标字符`);
    assert.equal(r.day, true, 'isDay 默认 true');
  }
  // 关键的雾 / 雪 / 雷暴三类必须不为「未知」
  for (const c of [45, 48, 71, 73, 75, 77, 95, 96, 99]) {
    assert.notEqual(wmo.wmo(c).short, '未知', `WMO ${c} 不得落到未知兜底`);
    assert.notEqual(wmo.wmo(c).zh, '未知天气', `WMO ${c} 不得落到未知兜底`);
  }
  assert.ok(wmo.wmo(45).icon.includes('🌫'), '雾必须用雾图标');
  assert.ok(wmo.wmo(96).icon.includes('⛈'), '雷暴冰雹必须用雷暴图标');
});

test('WMO 昼夜参数与未知码兜底；非数值入参不抛异常', () => {
  assert.equal(wmo.wmo(0, false).day, false, 'isDay=false 必须透传');
  assert.equal(wmo.wmo(0, false).zh, '晴');

  const unknown = wmo.wmo(999);
  assert.equal(unknown.zh, '未知天气');
  assert.equal(unknown.short, '未知');
  assert.equal(unknown.icon, '·');

  for (const bad of [undefined, NaN, 'abc', {}, []]) {
    const r = wmo.wmo(bad);
    assert.equal(r.zh, '未知天气', `异常入参 ${String(bad)} 必须落到未知兜底`);
    assert.equal(r.code, -1, '非数值码归一为 -1');
  }
  // 【缺陷固化为断言】null / 空串代表「天气码缺失」，必须显示未知，绝不能被 Number() 转成 0 后显示成「晴」
  for (const missing of [null, '']) {
    const r = wmo.wmo(missing);
    assert.equal(r.zh, '未知天气', `天气码缺失(${String(missing)}) 必须显示「未知天气」，实际显示「${r.zh}」`);
  }
  // 负数码不崩
  assert.equal(wmo.wmo(-5).zh, '未知天气');
});

test('欧洲 AQI 六档全部边界值（含负数与非数值兜底为 0/优）', () => {
  const cases = [
    [0, 'good', '优'], [20, 'good', '优'],
    [21, 'fair', '良'], [40, 'fair', '良'],
    [41, 'moderate', '中'], [60, 'moderate', '中'],
    [61, 'poor', '差'], [80, 'poor', '差'],
    [81, 'very-poor', '很差'], [100, 'very-poor', '很差'],
    [101, 'extreme', '极差'], [5000, 'extreme', '极差'],
  ];
  for (const [v, level, zh] of cases) {
    const r = wmo.aqi(v);
    assert.equal(r.level, level, `AQI ${v} 应为 ${level}`);
    assert.equal(r.zh, zh, `AQI ${v} 中文应为 ${zh}`);
    assert.ok(r.advice && typeof r.advice === 'string' && r.advice.length > 0, `AQI ${v} 必须有非空建议文案`);
    assert.ok(!r.advice.includes('{'), '建议文案不得残留占位符');
  }
  // 越界/异常入参：不得抛，且要有合法档位
  for (const bad of [undefined, null, 'x', NaN, {}]) {
    const r = wmo.aqi(bad);
    assert.equal(r.level, 'good', `异常入参 ${String(bad)} 应兜底为 good`);
    assert.equal(r.value, 0);
  }
  // 已知行为（建议项）：负值会原样保留成 value=-10，界面会显示「优 · AQI -10」，建议钳制到 0
  assert.equal(wmo.aqi(-10).value, -10, '负值未钳制 → 见报告建议项');
  // 小数四舍五入
  assert.equal(wmo.aqi(20.6).value, 21);
  assert.equal(wmo.aqi(20.6).level, 'fair', '四舍五入后按 21 判定');
});

test('UV 五档全部边界值', () => {
  const cases = [
    [0, 'low', '低'], [2, 'low', '低'],
    [3, 'moderate', '中'], [5, 'moderate', '中'],
    [6, 'high', '高'], [7, 'high', '高'],
    [8, 'very-high', '很高'], [10, 'very-high', '很高'],
    [11, 'extreme', '极高'], [25, 'extreme', '极高'],
  ];
  for (const [v, level, zh] of cases) {
    const r = wmo.uv(v);
    assert.equal(r.level, level, `UV ${v} 应为 ${level}`);
    assert.equal(r.zh, zh);
    assert.ok(r.advice.length > 0);
  }
  for (const bad of [-3, undefined, null, 'y', NaN]) {
    assert.equal(wmo.uv(bad).level, 'low', `UV 异常入参 ${String(bad)} 兜底为 low`);
  }
  assert.equal(wmo.uv(2.6).level, 'moderate', 'UV 四舍五入后跨界');
  assert.equal(wmo.uv(10.6).level, 'extreme');
});

test('16 方位：0°/90°/180°/270°/359°/360°/-1° 与刚好跨档的两点', () => {
  const cases = [
    [0, '北风'], [11, '北风'], [12, '东北偏北风'], [22, '东北偏北风'], [23, '东北偏北风'],
    [34, '东北风'], [45, '东北风'], [90, '东风'], [135, '东南风'], [180, '南风'],
    [225, '西南风'], [270, '西风'], [315, '西北风'],
    [303, '西北偏西风'], [326, '西北风'], [327, '西北偏北风'], [337, '西北偏北风'], [348, '西北偏北风'],
    [349, '北风'], [359, '北风'], [360, '北风'], [-1, '北风'], [720, '北风'],
  ];
  for (const [deg, zh] of cases) {
    assert.equal(wmo.windDir16(deg).zh, zh, `风向 ${deg}° 应为 ${zh}`);
  }
  // 归一化后的 deg 必须在 [0,360)
  for (const deg of [-30, -400, 1000, 359.9]) {
    const d = wmo.windDir16(deg).deg;
    assert.ok(d >= 0 && d < 360, `归一化后必须在 [0,360)，实际 ${d}`);
  }
  // 非数值不崩
  assert.equal(wmo.windDir16('abc').zh, '北风');
  assert.equal(wmo.windDir16(undefined).deg, 0);
});

test('蒲福风级 0–12 级全部边界值', () => {
  const cases = [
    [0, 0, '无风'], [0.29, 0, '无风'], [0.3, 1, '软风'], [1.5, 1, '软风'],
    [1.6, 2, '轻风'], [3.3, 2, '轻风'], [3.4, 3, '微风'], [5.4, 3, '微风'],
    [5.5, 4, '和风'], [7.9, 4, '和风'], [8.0, 5, '清风'], [10.7, 5, '清风'],
    [10.8, 6, '强风'], [13.8, 6, '强风'], [13.9, 7, '疾风'], [17.1, 7, '疾风'],
    [17.2, 8, '大风'], [20.7, 8, '大风'], [20.8, 9, '烈风'], [24.4, 9, '烈风'],
    [24.5, 10, '狂风'], [28.4, 10, '狂风'], [28.5, 11, '暴风'], [32.6, 11, '暴风'],
    [32.7, 12, '飓风'], [100, 12, '飓风'],
  ];
  for (const [ms, level, zh] of cases) {
    const r = wmo.beaufort(ms);
    assert.equal(r.level, level, `${ms} m/s 应为 ${level} 级`);
    assert.equal(r.zh, zh, `${ms} m/s 应为 ${zh}`);
  }
  // 异常入参兜底为 0 级，不抛
  for (const bad of [-5, undefined, null, 'x', NaN, {}]) {
    assert.equal(wmo.beaufort(bad).level, 0, `异常入参 ${String(bad)} 应兜底为 0 级`);
    assert.equal(wmo.beaufort(bad).zh, '无风');
  }
  assert.equal(wmo.beaufort(0).zh, '无风');
});
