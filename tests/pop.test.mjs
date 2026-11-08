/**
 * 降水概率上屏（任务 B）验证
 *
 * 背景：降水概率（precipitation_probability）早就随 weather 一路取回来了（存进
 * `hourlyPopPct`），但界面从不显示；界面上那个「降水」其实是**降水量 mm**。
 * 两者是两回事，上屏时标签必须能区分。
 *
 * 这一组用例钉死四件事：
 *   1) 逐时序列里「此刻」那一个小时能被正确对位（不是永远取下标 0）；
 *   2) 对位失败 / 数据源没给 → 值是 null，界面显示占位符「—」，**绝不显示 0%**；
 *   3) 界面上「降水量」与「降水概率」是两项、标签互不相同；
 *   4) 图例里两项各自有释义，且那条曾经写着「界面上没有降水概率这一项」的文案已改。
 *
 * 环境：装好假 DOM / 假 localStorage 后再 import 被测模块（now.js 会被 compare /
 * app 等拉起，且渲染函数要 document.createElement）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installFetch, installNavigator, installStorage, FakeStorage, text } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: null });
installFetch();

const dom = createFakeDom([{ id: 'app' }]);
dom.document.readyState = 'loading';

const now = await import('../src/ui/now.js');
const fmt = await import('../src/core/format.js');
const om = await import('../src/data/openmeteo.js');
const { t, hasKey } = await import('../src/i18n/index.js');
const legend = await import('../src/ui/legend.js');

/**
 * 构造一份 weather 响应（逐时 24 小时，概率只在第 14 小时有值）。
 *
 * @param {{tempC?:number, pop?:number|null, withHourlyTime?:boolean}} [opts] 选项。
 * @returns {Object} 响应 JSON。
 */
function weatherJson(opts = {}) {
  const tempC = opts.tempC === undefined ? 26.4 : opts.tempC;
  const pop = opts.pop === undefined ? 37 : opts.pop;
  const withTime = opts.withHourlyTime !== false;
  const hours = Array.from({ length: 24 }, (unused, i) => `2025-06-21T${String(i).padStart(2, '0')}:00`);
  return {
    utc_offset_seconds: 28800,
    current: {
      time: '2025-06-21T14:00',
      temperature_2m: tempC,
      relative_humidity_2m: 55,
      apparent_temperature: tempC + 2,
      precipitation: 0.4,
      weather_code: 3,
      wind_speed_10m: 2.1,
      wind_direction_10m: 90,
      surface_pressure: 1004,
      visibility: 12000,
    },
    daily: {
      time: ['2025-06-21'],
      weather_code: [3],
      temperature_2m_max: [tempC + 4],
      temperature_2m_min: [tempC - 4],
      sunrise: ['2025-06-21T05:00'],
      sunset: ['2025-06-21T19:30'],
      uv_index_max: [6],
      precipitation_sum: [0.4],
    },
    hourly: {
      time: withTime ? hours : undefined,
      temperature_2m: Array.from({ length: 24 }, () => tempC),
      // 除第 14 小时外全填 0：这样「取错下标」会拿到 0 而不是 37，一眼能看出来
      precipitation_probability: Array.from({ length: 24 }, (unused, i) => (i === 14 ? pop : 0)),
      weather_code: Array.from({ length: 24 }, () => 3),
    },
  };
}

/**
 * 构造一份 NowSnapshot（只填天气卡要用的字段）。
 *
 * @param {Object|null} w WeatherNow。
 * @returns {Object} NowSnapshot。
 */
function snap(w) {
  return {
    atMs: Date.UTC(2025, 5, 21, 6, 0),
    coord: { lat: 39.9087, lon: 116.3975 },
    placeName: null,
    elevationM: null,
    weather: w,
    air: null,
    provenance: [],
  };
}

test('① currentHourIndex：按「时间串对到小时」定位，不是永远取下标 0', () => {
  const hours = Array.from({ length: 24 }, (unused, i) => `2025-06-21T${String(i).padStart(2, '0')}:00`);
  assert.equal(om.currentHourIndex(hours, '2025-06-21T14:00'), 14, '第 14 小时应命中下标 14');
  assert.equal(om.currentHourIndex(hours, '2025-06-21T00:00'), 0, '0 点应命中下标 0');
  assert.equal(om.currentHourIndex(hours, '2025-06-21T23:00'), 23, '23 点应命中下标 23');
  // 对不上 → null（绝不退化成「取第一个」）
  assert.equal(om.currentHourIndex(hours, '2025-06-22T14:00'), null, '跨日对不上应返回 null');
  assert.equal(om.currentHourIndex(hours, ''), null, 'current.time 为空应返回 null');
  assert.equal(om.currentHourIndex(hours, null), null, 'current.time 为 null 应返回 null');
  assert.equal(om.currentHourIndex(undefined, '2025-06-21T14:00'), null, '序列缺失应返回 null');
  assert.equal(om.currentHourIndex([], '2025-06-21T14:00'), null, '空序列应返回 null');
});

test('② parseWeather：popNowPct 取的是「观测时刻那一小时」的概率', () => {
  const parsed = om.parseWeather(weatherJson({ pop: 37 }), { lat: 39.9087, lon: 116.3975 });
  assert.equal(parsed.popNowPct, 37, '当前时次（14 点）的概率应为 37');
  assert.equal(parsed.precipMm, 0.4, '降水量是另一个字段，不受影响');
  // 逐时原样序列仍在（阶段二图表要用），新字段是**追加**的，没动既有形状
  assert.equal(parsed.hourlyPopPct.length, 24, 'hourlyPopPct 仍应是 24 项');
  assert.equal(parsed.hourlyPopPct[14], 37, 'hourlyPopPct[14] 应为 37');
});

test('③ 缺 hourly.time 时退到「本地小时数」兜底，仍然取到同一个值', () => {
  const parsed = om.parseWeather(weatherJson({ pop: 41, withHourlyTime: false }), { lat: 39.9087, lon: 116.3975 });
  assert.equal(parsed.popNowPct, 41, '兜底路径（本地 14 点）也应取到 41');
});

test('④ 数据源没给概率 → popNowPct 为 null（★不是 0）', () => {
  const json = weatherJson({ pop: null });
  json.hourly.precipitation_probability = undefined;
  const parsed = om.parseWeather(json, { lat: 39.9087, lon: 116.3975 });
  assert.equal(parsed.popNowPct, null, '没有序列时必须是 null，绝不能是 0');
});

test('④b 序列存在、但当前时次那个点是 null → popNowPct 为 null（★不是 0）', () => {
  // 只把第 14 小时（观测时刻）挖成 null，其余保留 0：
  //  这是「源数据有洞」和「没给序列」不同的真实场景，此前 _n(null)===0 会把洞读成 0%。
  const json = weatherJson({ pop: null });
  assert.equal(json.hourly.precipitation_probability[14], null, '第 14 小时必须真是 null');
  assert.equal(json.hourly.precipitation_probability[0], 0, '其余小时仍是真实的 0%');
  const parsed = om.parseWeather(json, { lat: 39.9087, lon: 116.3975 });
  assert.equal(parsed.popNowPct, null, '源数据在该点是 null，绝不能读成 0%');
  assert.equal(parsed.hourlyPopPct[14], null, '逐时序列里该点也必须是 null');
  assert.equal(parsed.hourlyPopPct[0], 0, '其余点的真实 0% 不许被抹成 null');
});

test('④c 温/湿/风等标量字段为 null → 对应字段是 null（★不是 0）', () => {
  const json = weatherJson({});
  json.current.visibility = null;      // 能见度缺测
  json.current.surface_pressure = null; // 气压缺测
  json.daily.uv_index_max = [null];     // 当日紫外线极值缺测
  const parsed = om.parseWeather(json, { lat: 39.9087, lon: 116.3975 });
  assert.equal(parsed.visibilityM, null, '能见度缺测必须是 null，不能读成 0 m');
  assert.equal(parsed.pressureHpa, null, '气压缺测必须是 null，不能读成 0 hPa');
  assert.equal(parsed.uvMax, null, '紫外线极值缺测必须是 null，不能读成 0');
});

test('⑤ format.percent：有值出百分比，缺失出占位符', () => {
  assert.equal(fmt.percent(37), '37%');
  assert.equal(fmt.percent(0), '0%', '真实取到的 0% 就该显示 0%（那是「确定不下」，不是缺失）');
  assert.equal(fmt.percent(37.6), '38%', '默认取整');
  assert.equal(fmt.percent(37.24, 1), '37.2%', '可指定小数位');
  assert.equal(fmt.percent(null), '—', '缺失必须是占位符');
  assert.equal(fmt.percent(undefined), '—');
  assert.equal(fmt.percent(''), '—', '空串不得显示成 0%');
  assert.equal(fmt.percent(NaN), '—');
});

test('⑥ 天气卡同时出现「降水量」与「降水概率」两项，且标签互不相同', () => {
  const root = dom.document.createElement('div');
  now.renderSkeleton(root);
  now.renderWeatherCard(root, snap({
    atMs: Date.UTC(2025, 5, 21, 6, 0),
    tzOffsetSec: 28800,
    tempC: 26.4, feelsC: 28.4, humidityPct: 55,
    precipMm: 0.4, popNowPct: 37,
    windMs: 2.1, windDeg: 90, pressureHpa: 1004, visibilityM: 12000,
    wmoCode: 3, sunriseAt: Date.UTC(2025, 5, 20, 21, 0), sunsetAt: Date.UTC(2025, 5, 21, 11, 30),
    uvMax: 6, todayMaxC: 30, todayMinC: 22,
    hourlyTempC: [], hourlyPopPct: [],
  }));
  const card = text(root.querySelector('#card-weather'));
  assert.ok(card.includes(t('w.precip')), `天气卡应有「${t('w.precip')}」，实际：${card}`);
  assert.ok(card.includes(t('w.pop')), `天气卡应有「${t('w.pop')}」，实际：${card}`);
  assert.notEqual(t('w.precip'), t('w.pop'), '两个标签必须不同，否则用户会当成同一个量');
  assert.ok(t('w.precip').includes('降水量'), `「降水量」标签必须点明是「量」，实际：${t('w.precip')}`);
  assert.ok(t('w.pop').includes('概率'), `「降水概率」标签必须点明是「概率」，实际：${t('w.pop')}`);
  assert.ok(card.includes('0.4 mm'), `降水量应显示 0.4 mm，实际：${card}`);
  assert.ok(card.includes('37%'), `降水概率应显示 37%，实际：${card}`);
});

test('⑦ 概率缺失时显示占位符「—」，★绝不显示 0%', () => {
  const root = dom.document.createElement('div');
  now.renderSkeleton(root);
  now.renderWeatherCard(root, snap({
    atMs: Date.UTC(2025, 5, 21, 6, 0),
    tzOffsetSec: 28800,
    tempC: 26.4, feelsC: 28.4, humidityPct: 55,
    precipMm: null, popNowPct: null,
    windMs: null, windDeg: null, pressureHpa: null, visibilityM: null,
    wmoCode: null, sunriseAt: null, sunsetAt: null,
    uvMax: null, todayMaxC: null, todayMinC: null,
    hourlyTempC: [], hourlyPopPct: [],
  }));
  const card = text(root.querySelector('#card-weather'));
  // 抽出「降水概率」标签后面紧跟的那个值
  const idx = card.indexOf(t('w.pop'));
  assert.ok(idx >= 0, `天气卡应出现「${t('w.pop')}」标签`);
  const value = card.slice(idx + t('w.pop').length).trim().slice(0, 4);
  assert.ok(value.startsWith('—'), `降水概率缺失必须显示「—」，实际片段：'${value}'（整卡：${card}）`);
  assert.ok(!/0%/.test(card), `概率缺失绝不能显示 0%：${card}`);
});

test('⑧ 图例：两项各自有释义，且旧文案里那句「界面上没有降水概率这一项」已不成立', () => {
  const model = legend.legendModel();
  const flat = {};
  for (const g of model) for (const it of g.items) flat[it.id] = it;
  assert.ok(flat.precip, '图例应有降水量条目');
  assert.ok(flat.pop, '图例应有降水概率条目');
  assert.ok(!/没有降水概率/.test(flat.precip.body), `降水量释义不该再写「没有降水概率」：${flat.precip.body}`);
  assert.ok(flat.pop.body.includes('概率'), '降水概率释义应讲清它是概率');
  assert.equal(flat.pop.rows.length, 0, '本应用没有给降水概率设分档，不该出现档位行');
  assert.ok(hasKey('legend.pop.title') && hasKey('legend.pop.body'), 'legend.pop.* 键应在文案表里');
});
