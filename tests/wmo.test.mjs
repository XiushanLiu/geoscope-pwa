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
// core/wmo.js 现在只产出**文案键**（core 不许 import i18n），翻成人话由这里做。
const i18nMod = await import('../src/i18n/index.js');
const { t } = i18nMod;
const { ZH } = await import('../src/i18n/zh.js');
const { EN } = await import('../src/i18n/en.js');

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
    assert.equal(t(r.key), expected[c], `WMO ${c} 文案不符`);
    assert.equal(r.code, c);
    assert.ok(typeof r.shortKey === 'string' && r.shortKey.length > 0, `WMO ${c} 必须有短描述键`);
    assert.ok(t(r.shortKey).length > 0, `WMO ${c} 的短描述键必须能翻出非空文案`);
    assert.ok(typeof r.icon === 'string' && r.icon.length > 0, `WMO ${c} 必须有图标字符`);
    assert.equal(r.day, true, 'isDay 默认 true');
  }
  // 关键的雾 / 雪 / 雷暴三类必须不为「未知」
  for (const c of [45, 48, 71, 73, 75, 77, 95, 96, 99]) {
    assert.notEqual(t(wmo.wmo(c).shortKey), '未知', `WMO ${c} 不得落到未知兜底`);
    assert.notEqual(t(wmo.wmo(c).key), '未知天气', `WMO ${c} 不得落到未知兜底`);
  }
  assert.ok(wmo.wmo(45).icon.includes('🌫'), '雾必须用雾图标');
  assert.ok(wmo.wmo(96).icon.includes('⛈'), '雷暴冰雹必须用雷暴图标');
});

test('WMO 昼夜参数与未知码兜底；非数值入参不抛异常', () => {
  assert.equal(wmo.wmo(0, false).day, false, 'isDay=false 必须透传');
  assert.equal(t(wmo.wmo(0, false).key), '晴');

  const unknown = wmo.wmo(999);
  assert.equal(t(unknown.key), '未知天气');
  assert.equal(t(unknown.shortKey), '未知');
  assert.equal(unknown.icon, '·');

  for (const bad of [undefined, NaN, 'abc', {}, []]) {
    const r = wmo.wmo(bad);
    assert.equal(t(r.key), '未知天气', `异常入参 ${String(bad)} 必须落到未知兜底`);
    assert.equal(r.code, -1, '非数值码归一为 -1');
  }
  // 【缺陷固化为断言】null / 空串代表「天气码缺失」，必须显示未知，绝不能被 Number() 转成 0 后显示成「晴」
  for (const missing of [null, '']) {
    const r = wmo.wmo(missing);
    assert.equal(t(r.key), '未知天气', `天气码缺失(${String(missing)}) 必须显示「未知天气」，实际显示「${t(r.key)}」`);
  }
  // 负数码不崩
  assert.equal(t(wmo.wmo(-5).key), '未知天气');
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
    assert.equal(t(r.levelKey), zh, `AQI ${v} 中文应为 ${zh}`);
    const advice = t(r.adviceKey);
    assert.ok(advice && typeof advice === 'string' && advice.length > 0, `AQI ${v} 必须有非空建议文案`);
    assert.ok(!advice.includes('{'), '建议文案不得残留占位符');
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
    assert.equal(t(r.levelKey), zh);
    assert.ok(t(r.adviceKey).length > 0);
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
    assert.equal(t('w.windFrom', { dir: t(wmo.windDir16(deg).abbrKey) }), zh, `风向 ${deg}° 应为 ${zh}`);
  }
  // 归一化后的 deg 必须在 [0,360)
  for (const deg of [-30, -400, 1000, 359.9]) {
    const d = wmo.windDir16(deg).deg;
    assert.ok(d >= 0 && d < 360, `归一化后必须在 [0,360)，实际 ${d}`);
  }
  // 非数值不崩
  assert.equal(t('w.windFrom', { dir: t(wmo.windDir16('abc').abbrKey) }), '北风');
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
    assert.equal(t(r.key), zh, `${ms} m/s 应为 ${zh}`);
  }
  // 异常入参兜底为 0 级，不抛
  for (const bad of [-5, undefined, null, 'x', NaN, {}]) {
    assert.equal(wmo.beaufort(bad).level, 0, `异常入参 ${String(bad)} 应兜底为 0 级`);
    assert.equal(t(wmo.beaufort(bad).key), '无风');
  }
  assert.equal(t(wmo.beaufort(0).key), '无风');
});

test('★core 产出的每一个文案键，中英两张表都必须有（漏翻即失败）', () => {
  const keys = [];
  for (let c = 0; c <= 99; c += 1) {
    const d = wmo.wmo(c);
    keys.push(d.key, d.shortKey);
  }
  keys.push(wmo.wmo(null).key, wmo.wmo(null).shortKey);
  for (const r of wmo.beaufortScale()) keys.push(r.key);
  for (const r of wmo.aqiScale()) keys.push(r.levelKey, r.adviceKey);
  for (const r of wmo.uvScale()) keys.push(r.levelKey, r.adviceKey);
  for (const k of wmo.windRose16()) keys.push(k, `${k}.abbr`);
  keys.push('w.windFrom');

  const missZh = [...new Set(keys)].filter((k) => !Object.prototype.hasOwnProperty.call(ZH, k));
  const missEn = [...new Set(keys)].filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepEqual(missZh, [], `中文表缺：${missZh.join(', ')}`);
  assert.deepEqual(missEn, [], `英文表缺：${missEn.join(', ')}`);
});

test('切到英文后，core 产的键确实翻成英文（不是照抄中文）', () => {
  const saved = i18nMod.getLocale();
  // t() 读的是模块级「当前 locale」，所以两句话必须在各自的 locale 下分别求值
  i18nMod.setLocale('zh');
  const zhForm = i18nMod.t('w.windFrom', { dir: i18nMod.t('dir.14.abbr') });
  i18nMod.setLocale('en');
  const enForm = i18nMod.t('w.windFrom', { dir: i18nMod.t('dir.14.abbr') });
  const enForce = i18nMod.t('bf.5');
  i18nMod.setLocale(saved);
  // 风向这句是「语序不同」的典型：中文后缀「风」、英文介词 from
  assert.equal(zhForm, '西北风');
  assert.equal(enForm, 'wind from NW');
  assert.equal(enForce, 'Fresh breeze');
});
