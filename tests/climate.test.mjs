/**
 * 气候常态（ERA5 1991–2020 自算月平均）
 *
 * 背景：用户提问「只有『此刻』，年/月平均数据在哪里？」—— 此刻页原本只有实时天气。
 * 本文件钉死 `src/data/climate.js` 的**请求构造**与**按月聚合**两件事，以及
 * `src/ui/now.js` 的气候常态卡渲染。
 *
 * ★诚实底线（改断言之前先读）：
 *   - `tests/fixtures/climate-bj-1991-2020.json` 是 **2026-10-16 沙箱直连 curl 抓回来的
 *     真实响应**（HTTP 200 / 303294 B / 10958 天），数值一个字节都没改（只加了 `_meta`）。
 *     **不许**用手编的 JSON 顶替它 —— 那等于拿自己编的数证明自己的算法对。
 *   - 下面那些「期望值」是用**另一份独立脚本**（不 import parseClimate）照着夹具重算
 *     出来的，不是「跑一遍 parseClimate 把输出抄下来」—— 后者是同义反复，红了也白红。
 *   - 常识校验对不上的地方（北京 7 月 32.4℃，比 30–32℃ 的常识区间高 0.4℃）
 *     **照实写在断言旁边**，不放宽区间去迁就。
 *
 * 覆盖：
 *   1) buildClimateRequest 的 url / 参数形状（起止日期、daily 变量、models=era5、单位）；
 *   2) parseClimate 对真实响应产出 12 个月（1→12 有序、1 位小数、逐项对拍 + 常识校验）；
 *   3) 手算可验证的小样本聚合（2 年 × 12 月，月降水 = 总和 ÷ 年数）；
 *   4) null 跳过：null 日既不进分子也不进分母，`days` 计数诚实；
 *   5) 退化输入返回 null 且不抛；
 *   6) getSource('climate') 可解析；SOURCE_LIST 仍是六路、未被污染；
 *   7) climateCacheKey 同坐标同键、异坐标异键；
 *   8) renderClimateCard 四态（idle 有按钮 / ready 有 12 行 / error 有重试 / 回调非函数不绑不崩）；
 *   9) now.js 的闭包红线（不许发请求、不许 import data 层）+ 红线上屏文案。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createFakeDom, installStorage, FakeStorage, installNavigator, text } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  CLIMATE_HOST,
  CLIMATE_START,
  CLIMATE_END,
  CLIMATE_YEARS,
  buildClimateRequest,
  parseClimate,
  climateCacheKey,
  CLIMATE_SOURCES,
} = await import('../src/data/climate.js');
const { SOURCE_LIST, SOURCE_TABLE, getSource } = await import('../src/data/sources.js');
const { t } = await import('../src/i18n/index.js');
const { ZH } = await import('../src/i18n/zh.js');
const { EN } = await import('../src/i18n/en.js');

createFakeDom();
const { renderClimateCard } = await import('../src/ui/now.js');

/** 真实响应夹具（北京 39.9087,116.3975，1991-01-01 ~ 2020-12-31）。 */
const REAL_BJ = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/climate-bj-1991-2020.json'), 'utf8'));

/**
 * 独立重算的期望值（单位：℃ / mm）。
 *
 * 出处：2026-10-16 用一份**不 import parseClimate** 的独立脚本（按 `daily.time` 的
 * YYYY-MM 分桶、各自求和再除）跑同一份夹具得出。列序：月份 / 平均最高 / 平均最低 /
 * 月降水 / 有效天数 / 年数。
 */
const EXPECT_BJ = [
  [1, 1.9, -8.3, 2.8, 930, 30],
  [2, 6.0, -5.2, 5.1, 848, 30],
  [3, 13.3, 0.2, 8.9, 930, 30],
  [4, 21.9, 8.1, 19.1, 900, 30],
  [5, 28.7, 14.7, 35.0, 930, 30],
  [6, 32.3, 20.0, 74.4, 900, 30],
  [7, 32.4, 22.7, 159.9, 930, 30],
  [8, 31.1, 21.3, 119.2, 930, 30],
  [9, 27.1, 15.5, 56.5, 900, 30],
  [10, 19.8, 7.7, 33.0, 930, 30],
  [11, 10.3, -1.1, 14.4, 900, 30],
  [12, 3.2, -6.4, 3.4, 930, 30],
];

/** 独立重算的年均（℃ / mm·年⁻¹）。 */
const EXPECT_BJ_SUMMARY = { tmaxC: 19.0, tminC: 7.5, precipMm: 531.7 };

/**
 * 造一个「手算可验证」的极小样本：2 年 × 12 月 × 2 天。
 *
 * 每天只给两个温度值 `m` 与 `m+1`（m = 月份），最低一律 0，降水一律 1 mm：
 *   月平均最高 = ((m) + (m+1)) / 2 = m + 0.5        （跨两年合并后仍成立）
 *   月平均最低 = 0
 *   月降水     = 2 天 × 1 mm × 2 年 ÷ 2 年 = 2 mm   （总和 ÷ **年数**，不是 ÷ 天数）
 *
 * @returns {Object} 形如 archive-api 响应的对象。
 */
function twoYearSample() {
  const time = [];
  const tmax = [];
  const tmin = [];
  const prcp = [];
  for (const year of [2000, 2001]) {
    for (let m = 1; m <= 12; m += 1) {
      const mm = String(m).padStart(2, '0');
      for (const day of ['01', '02']) {
        time.push(`${year}-${mm}-${day}`);
        tmax.push(day === '01' ? m : m + 1);
        tmin.push(0);
        prcp.push(1);
      }
    }
  }
  return { daily: { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: prcp } };
}

/**
 * 造一批固定月份数据（供渲染用例使用）。
 *
 * @returns {Object} parseClimate 形状的聚合结果。
 */
function fakeAggregate() {
  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    months.push({ month: m, tmaxC: m + 0.5, tminC: m - 1, precipMm: m, days: 4, monthYears: 2 });
  }
  return { years: 2, dayCount: 48, months, summary: { tmaxC: 7, tminC: 0, precipMm: 24 } };
}

/* ------------------------------------------------------------------ */
/* 1. 请求构造                                                          */
/* ------------------------------------------------------------------ */

test('① buildClimateRequest：url / 起止日期 / daily 变量 / models=era5 / 单位参数', () => {
  const spec = buildClimateRequest({ lat: 39.90873, lon: 116.39748 });
  assert.equal(spec.url, `${CLIMATE_HOST}/v1/archive`);
  assert.equal(spec.url, 'https://archive-api.open-meteo.com/v1/archive');
  assert.equal(spec.responseType, 'json');

  const p = spec.params;
  assert.equal(p.latitude, '39.9087');
  assert.equal(p.longitude, '116.3975');
  // 起止日期必须来自集中常量（不许散落在拼串里，改窗口只改一处）
  assert.equal(p.start_date, CLIMATE_START);
  assert.equal(p.end_date, CLIMATE_END);
  assert.equal(p.start_date, '1991-01-01');
  assert.equal(p.end_date, '2020-12-31');
  assert.equal(CLIMATE_YEARS, 30);

  assert.equal(p.daily, 'temperature_2m_max,temperature_2m_min,precipitation_sum');
  // ★显式钉住数据集：archive-api 默认 best_match 会随上游漂移，30 年常态不能跟着变
  assert.equal(p.models, 'era5');
  // 单位与天气源一致（天气源不发 *_unit，吃的是默认 °C / mm，这里显式钉住，数值口径相同）
  assert.equal(p.temperature_unit, 'celsius');
  assert.equal(p.precipitation_unit, 'mm');
  assert.equal(p.timezone, 'auto');
});

test('①b CLIMATE_SOURCES.climate 契约值（timeoutMs / retry / ttlMs / cacheable / 不进自检）', () => {
  const s = CLIMATE_SOURCES.climate;
  assert.equal(s.id, 'climate');
  assert.equal(s.labelKey, 'source.climate');
  assert.equal(s.host, CLIMATE_HOST);
  // 23428 = max(6000, ceil(11713.75 × 2))：北京三次实测最大 11.714 s（沙箱口径，待真机复测）
  assert.equal(s.timeoutMs, 23428);
  assert.equal(s.retry, 1);
  assert.equal(s.ttlMs, 2592000000); // 30 天
  assert.equal(s.cacheable, true);
  assert.equal(s.critical, false);
  assert.equal(s.kind, 'api');
  assert.equal(s.priority, 9);
  assert.equal(typeof s.build, 'function');
  assert.equal(typeof s.parse, 'function');
  // label / attribution 必须是惰性 getter（写成 `label: t('…')` 会永远中文）
  const desc = Object.getOwnPropertyDescriptor(s, 'label');
  assert.ok(desc && typeof desc.get === 'function', 'label 必须是 getter');
  assert.equal(typeof s.label, 'string');
  assert.ok(s.label.length > 0);
});

/* ------------------------------------------------------------------ */
/* 2. 真实响应聚合                                                      */
/* ------------------------------------------------------------------ */

test('② parseClimate 对真实响应（北京 10958 天）产出 12 个月，逐项对拍独立重算值', () => {
  assert.equal(REAL_BJ.daily.time.length, 10958, '夹具必须是完整的 10958 天');
  assert.equal(REAL_BJ.daily.time[0], '1991-01-01');
  assert.equal(REAL_BJ.daily.time[10957], '2020-12-31');

  const got = parseClimate(REAL_BJ, { lat: 39.9087, lon: 116.3975 });
  assert.ok(got, '真实响应必须解析出结果');
  assert.equal(got.years, 30);
  assert.equal(got.dayCount, 10958);
  assert.equal(got.months.length, 12);

  // 月份必须 1→12 有序（错月是最容易悄悄发生的一类 bug）
  assert.deepEqual(
    got.months.map((m) => m.month),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );

  for (const [month, hi, lo, pr, days, yrs] of EXPECT_BJ) {
    const m = got.months[month - 1];
    assert.equal(m.tmaxC, hi, `${month}月 平均最高`);
    assert.equal(m.tminC, lo, `${month}月 平均最低`);
    assert.equal(m.precipMm, pr, `${month}月 月降水`);
    assert.equal(m.days, days, `${month}月 有效天数`);
    assert.equal(m.monthYears, yrs, `${month}月 年数`);
    // 数值统一 1 位小数
    for (const v of [m.tmaxC, m.tminC, m.precipMm]) {
      assert.ok(Number.isFinite(Number(v)), `${month}月 数值必须是有限数字`);
      assert.equal(Math.round(Number(v) * 10) / 10, Number(v), `${month}月 必须只保留 1 位小数`);
    }
  }

  assert.equal(got.summary.tmaxC, EXPECT_BJ_SUMMARY.tmaxC, '年均最高');
  assert.equal(got.summary.tminC, EXPECT_BJ_SUMMARY.tminC, '年均最低');
  assert.equal(got.summary.precipMm, EXPECT_BJ_SUMMARY.precipMm, '年降水总量');
});

test('②b 常识校验：北京 1 月 / 7 月 与年降水总量（对不上的照实写，不放宽区间）', () => {
  const got = parseClimate(REAL_BJ, { lat: 39.9087, lon: 116.3975 });
  const jan = got.months[0];
  const jul = got.months[6];

  // 常识：北京 1 月平均最高 1~3℃ —— 实测 1.9℃，落在区间内
  assert.ok(jan.tmaxC >= 1 && jan.tmaxC <= 3, `1月平均最高应在 1~3℃，实测 ${jan.tmaxC}`);
  // 常识：北京 7 月平均最高 30~32℃ —— 实测 **32.4℃**，比区间上沿高 0.4℃。
  // ★这里**不放宽区间**：ERA5 是约 31 km 网格的再分析格点值，与台站实测常态存在
  //   真实偏差（格点落点、城市下垫面都不是台站那一套）。这 0.4℃ 是要写进界面说明的
  //   真实偏差，不是聚合 bug。断言钉的是「实测就是这个数」。
  assert.equal(jul.tmaxC, 32.4);
  assert.ok(jul.tmaxC > 32, `7月平均最高 32.4℃ 高于常识区间 30~32℃ 上沿 0.4℃（ERA5 格点偏差，属实）`);
  // 常识：北京年降水 500~650 mm —— 实测 531.7 mm，落在区间内
  assert.ok(
    got.summary.precipMm >= 500 && got.summary.precipMm <= 650,
    `年降水应在 500~650 mm，实测 ${got.summary.precipMm}`
  );
  // 12 个月的月降水之和必须等于年降水总量（界面上「12 行相加 == 年均」）
  const sum = got.months.reduce((a, m) => a + (m.precipMm || 0), 0);
  assert.equal(Math.round(sum * 10) / 10, got.summary.precipMm);
});

/* ------------------------------------------------------------------ */
/* 3. 手算可验证的小样本                                                 */
/* ------------------------------------------------------------------ */

test('③ 手算样本（2 年 × 12 月 × 2 天）：月平均最高 = m+0.5、月降水 = 总和 ÷ 年数', () => {
  const got = parseClimate(twoYearSample(), { lat: 0, lon: 0 });
  assert.ok(got);
  assert.equal(got.years, 2);
  assert.equal(got.dayCount, 48);
  assert.equal(got.months.length, 12);

  for (let m = 1; m <= 12; m += 1) {
    const row = got.months[m - 1];
    assert.equal(row.month, m);
    assert.equal(row.tmaxC, m + 0.5, `${m}月 平均最高（(m + m+1)/2）`);
    assert.equal(row.tminC, 0, `${m}月 平均最低`);
    // 降水：2 天 × 1 mm × 2 年 = 4 mm，除以**年数 2** = 2 mm（除以天数会得到 1）
    assert.equal(row.precipMm, 2, `${m}月 月降水（总和 ÷ 年数）`);
    assert.equal(row.days, 4, `${m}月 有效天数`);
    assert.equal(row.monthYears, 2, `${m}月 年数`);
  }

  // 全年：48 天的算术平均 = 7℃；年降水 = 12 × 2 = 24 mm
  assert.equal(got.summary.tmaxC, 7);
  assert.equal(got.summary.tminC, 0);
  assert.equal(got.summary.precipMm, 24);
});

/* ------------------------------------------------------------------ */
/* 4. null 跳过                                                        */
/* ------------------------------------------------------------------ */

test('④ null / NaN 的日子既不进分子也不进分母（不当成 0）', () => {
  const json = {
    daily: {
      time: ['2000-01-01', '2000-01-02', '2000-01-03', '2000-01-04'],
      temperature_2m_max: [10, null, 20, null],
      temperature_2m_min: [0, 0, 10, null],
      precipitation_sum: [2, null, null, 6],
    },
  };
  const got = parseClimate(json, { lat: 0, lon: 0 });
  assert.ok(got);
  const jan = got.months[0];

  // 只有「最高与最低都有效」的两天（1 日、3 日）计入温度
  assert.equal(jan.days, 2, '有效日数必须是 2，不是 4');
  assert.equal(jan.tmaxC, 15, '(10+20)/2');
  assert.equal(jan.tminC, 5, '(0+10)/2');
  // ★若把 null 当 0：(10+0+20+0)/4 = 7.5 —— 那是个「看起来很有道理」的假结果
  assert.notEqual(jan.tmaxC, 7.5, 'null 绝不能被当成 0 ℃');

  // 降水：只有 1 日（2 mm）与 4 日（6 mm）有效，年数 1 → 8 mm
  assert.equal(jan.precipMm, 8);
  assert.equal(jan.monthYears, 1);

  assert.equal(got.dayCount, 2);
  assert.equal(got.years, 1);
  assert.equal(got.summary.tmaxC, 15);
  assert.equal(got.summary.tminC, 5);
  assert.equal(got.summary.precipMm, 8);

  // 其余月份一个有效日都没有 → 必须是 null，不是 0
  for (let m = 2; m <= 12; m += 1) {
    assert.equal(got.months[m - 1].tmaxC, null, `${m}月无有效日，必须是 null`);
    assert.equal(got.months[m - 1].precipMm, null, `${m}月无降水，必须是 null`);
    assert.equal(got.months[m - 1].days, 0);
  }

  // NaN / undefined / 非数字串同样跳过
  const dirty = {
    daily: {
      time: ['2000-02-01', '2000-02-02', '2000-02-03'],
      temperature_2m_max: [Number.NaN, 5, 'abc'],
      temperature_2m_min: [undefined, 1, 2],
      precipitation_sum: [1, 3, null],
    },
  };
  const got2 = parseClimate(dirty, { lat: 0, lon: 0 });
  assert.equal(got2.months[1].days, 1, 'NaN/undefined/非数字串全部跳过');
  assert.equal(got2.months[1].tmaxC, 5);
  assert.equal(got2.months[1].tminC, 1);
  assert.equal(got2.months[1].precipMm, 4, '(1+3)/1 年');
});

/* ------------------------------------------------------------------ */
/* 5. 退化输入                                                          */
/* ------------------------------------------------------------------ */

test('⑤ 退化输入返回 null 且不抛（不是一堆 0）', () => {
  const cases = [
    null,
    undefined,
    {},
    { daily: {} },
    { daily: { time: [] } },
    { daily: { time: null } },
    { daily: { time: 'not-an-array' } },
    [],
    'x',
  ];
  for (const c of cases) {
    assert.equal(parseClimate(c, { lat: 0, lon: 0 }), null, `输入 ${JSON.stringify(c)} 必须返回 null`);
  }
  // 有 time 但没有逐日数组：也算退化（不能返回 12 个 0）
  assert.equal(parseClimate({ daily: { time: ['2000-01-01'] } }, { lat: 0, lon: 0 }).months[0].tmaxC, null);
  // 日期串认不出来 → 整天跳过，不能塞进 1 月
  const weird = parseClimate(
    { daily: { time: ['not-a-date', '2000-03-01'], temperature_2m_max: [1, 2], temperature_2m_min: [1, 1], precipitation_sum: [1, 1] } },
    { lat: 0, lon: 0 }
  );
  assert.equal(weird.months[0].days, 0, '怪日期串不能落进 1 月');
  assert.equal(weird.months[2].days, 1);
});

/* ------------------------------------------------------------------ */
/* 6. 源表                                                             */
/* ------------------------------------------------------------------ */

test('⑥ getSource("climate") 可解析；SOURCE_LIST 仍是六路且未被污染', () => {
  const s = getSource('climate');
  assert.ok(s, '全量表必须能解析到 climate');
  assert.equal(s.id, 'climate');
  assert.equal(s.build, buildClimateRequest);
  assert.equal(s.parse, parseClimate);

  assert.equal(SOURCE_LIST.length, 6, '自检六路不许被新源污染');
  assert.deepEqual(
    SOURCE_LIST.map((x) => x.id),
    ['weather', 'air', 'geocode', 'elevation', 'reverse', 'tile']
  );
  // 全量表是九路：六路 + 自驾两路 + 气候常态
  assert.equal(Object.keys(SOURCE_TABLE).length, 9);
  assert.ok(SOURCE_TABLE.climate);
  assert.ok(SOURCE_TABLE.osrmRoute);
  assert.ok(SOURCE_TABLE.amapPoi);
});

/* ------------------------------------------------------------------ */
/* 7. 缓存键                                                           */
/* ------------------------------------------------------------------ */

test('⑦ climateCacheKey：同坐标同键、异坐标异键（4 位小数）', () => {
  const a = climateCacheKey({ lat: 39.90873, lon: 116.39748 });
  const b = climateCacheKey({ lat: 39.9087, lon: 116.3975 });
  assert.equal(a, b, '4 位小数内的抖动必须归一到同一个键');
  assert.equal(a, 'gs:v1:climate:39.9087:116.3975');

  // 坐标差 > 1e-4 → 不同键
  const c = climateCacheKey({ lat: 39.9088, lon: 116.3975 });
  const d = climateCacheKey({ lat: 39.9087, lon: 116.3976 });
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.notEqual(c, d);

  // 与别的源不撞键
  assert.notEqual(a, 'gs:v1:weather:39.9087:116.3975');
  // 缺坐标不崩
  assert.equal(climateCacheKey({}), 'gs:v1:climate:0.0000:0.0000');
  assert.equal(climateCacheKey(null), 'gs:v1:climate:0.0000:0.0000');
});

/* ------------------------------------------------------------------ */
/* 8. 渲染                                                             */
/* ------------------------------------------------------------------ */

/**
 * 建一棵假 DOM 并挂一个根容器。
 *
 * @returns {Object} 根容器。
 */
function mount() {
  createFakeDom();
  return document.createElement('main');
}

test('⑧ renderClimateCard：idle 有按钮、点了才回调、回调非函数时不绑不崩', () => {
  const root = mount();
  renderClimateCard(root, { status: 'idle', data: null, text: '' }, () => {});
  const btn = root.querySelector('.btn');
  assert.ok(btn, 'idle 必须有「查看月平均」按钮');
  assert.equal(btn.textContent, t('climate.loadBtn'));

  let called = 0;
  renderClimateCard(root, { status: 'idle', data: null, text: '' }, () => {
    called += 1;
  });
  root.querySelector('.btn').click();
  assert.equal(called, 1, '点击必须真的调到回调');

  // onLoad 非函数：不许绑、不许崩（本仓规矩：绝不退化成空函数，那是静默断线）
  assert.doesNotThrow(() => renderClimateCard(root, { status: 'idle', data: null, text: '' }, null));
  assert.doesNotThrow(() => {
    const b = root.querySelector('.btn');
    if (b) b.click(); // 非函数回调下按钮不该带监听；即使点到也不许抛
  });
  assert.doesNotThrow(() => renderClimateCard(root, { status: 'idle', data: null, text: '' }, 'not-a-function'));

  // ★红线文案必须整句上屏（不许简写成「气候常态」）
  assert.ok(text(root).indexOf(t('climate.entryNote')) !== -1, 'idle 必须显示如实标注');
  assert.equal(t('climate.entryNote'), 'ERA5 再分析 1991–2020 自算月平均 · 非官方气候常态');
});

test('⑧b renderClimateCard：loading 出骨架 + 提示，不出表', () => {
  const root = mount();
  renderClimateCard(root, { status: 'loading', data: null, text: '' }, () => {});
  assert.ok(root.querySelector('.sk'), 'loading 必须有骨架');
  assert.ok(text(root).indexOf(t('climate.loading')) !== -1);
  assert.equal(root.querySelectorAll('.clim-c').length, 0, 'loading 不该出现月度数值');
});

test('⑧c renderClimateCard：ready 出 12 行表 + 年均摘要 + 如实标注', () => {
  const root = mount();
  renderClimateCard(root, { status: 'ready', data: fakeAggregate(), text: '' }, null);

  // 4 列：月份 / 平均最高 / 平均最低 / 月降水 → 12 × 3 个数值单元 + 4 个表头
  assert.equal(root.querySelectorAll('.clim-h').length, 4, '表头 4 列');
  assert.equal(root.querySelectorAll('.clim-c').length, 36, '12 行 × 3 个数值列');
  assert.equal(root.querySelectorAll('.clim').length, 1);

  const body = text(root);
  for (let m = 1; m <= 12; m += 1) {
    assert.ok(body.indexOf(t(`climate.m${m}`)) !== -1, `必须出现 ${m} 月的本地化月份名`);
  }
  assert.ok(body.indexOf(t('climate.annual')) !== -1, '必须有年均摘要');
  assert.ok(body.indexOf(t('climate.entryNote')) !== -1, '必须有如实标注（红线）');
  // 样本量（天 / 年）如实给
  assert.ok(body.indexOf(t('climate.sample', { n: 48, years: 2 })) !== -1);
});

test('⑧d renderClimateCard：error 出空态 + 重试按钮；回调非函数时不绑', () => {
  const root = mount();
  let called = 0;
  renderClimateCard(root, { status: 'error', data: null, text: '取数失败' }, () => {
    called += 1;
  });
  const btn = root.querySelector('.btn');
  assert.ok(btn, 'error 必须有重试按钮');
  assert.equal(btn.textContent, t('climate.retry'));
  btn.click();
  assert.equal(called, 1, '重试必须真的调到回调');
  assert.ok(text(root).indexOf('取数失败') !== -1, '必须显示传入的失败文案');

  // 回调非函数：不绑不崩（按钮整个不出现，也不许抛）
  assert.doesNotThrow(() => renderClimateCard(root, { status: 'error', data: null, text: '' }, null));
  assert.equal(root.querySelector('.btn'), null, '回调非函数时不该有按钮');
  assert.ok(text(root).indexOf(t('climate.err')) !== -1, '缺文案时退回 climate.err');
});

/* ------------------------------------------------------------------ */
/* 9. 闭包红线 + 文案对拍                                                */
/* ------------------------------------------------------------------ */

test('⑨ now.js 不许发请求、不许 import data 层（自检页单文件产物闭包红线）', () => {
  const src = readFileSync(join(ROOT, 'src/ui/now.js'), 'utf8');
  assert.equal(/from\s+['"]\.\.\/data\//.test(src), false, 'now.js 不许 import src/data/ 下任何模块');
  assert.equal(/\brequest\s*\(/.test(src), false, 'now.js 不许发起请求');
  // 气候槽必须在 place 之后、map 之前建（顺序由首次 appendChild 那一刻决定）
  const iPlace = src.indexOf("_slot(root, 'place')");
  const iClimate = src.indexOf("_slot(root, 'climate')");
  const iMap = src.indexOf("_slot(root, 'map')");
  assert.ok(iPlace > 0 && iClimate > iPlace && iMap > iClimate, 'climate 槽必须在 place 之后、map 之前');
});

test('⑨b climate.* / source.climate 中英成对且非空（不许简写红线文案）', () => {
  const keys = [
    'source.climate',
    'climate.title',
    'climate.entryNote',
    'climate.loadBtn',
    'climate.loading',
    'climate.colMonth',
    'climate.colHigh',
    'climate.colLow',
    'climate.colPrecip',
    'climate.annual',
    'climate.annualHigh',
    'climate.annualLow',
    'climate.annualPrecip',
    'climate.sample',
    'climate.err',
    'climate.retry',
  ];
  for (let m = 1; m <= 12; m += 1) keys.push(`climate.m${m}`);

  for (const k of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(ZH, k), `中文表缺 ${k}`);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, k), `英文表缺 ${k}`);
    assert.ok(String(ZH[k]).trim() !== '', `中文 ${k} 为空`);
    assert.ok(String(EN[k]).trim() !== '', `英文 ${k} 为空`);
    // 占位符必须逐条对齐
    const ph = (s) => (String(s).match(/\{(\w+)\}/g) || []).join(',');
    assert.equal(ph(ZH[k]), ph(EN[k]), `${k} 中英占位符不一致`);
    // 中文有汉字而英文与中文完全同串 = 没翻译
    if (/[一-龥]/.test(String(ZH[k]))) {
      assert.notEqual(ZH[k], EN[k], `${k} 英文未翻译`);
    }
  }
  // 红线文案不许简写：必须含「非官方」
  assert.ok(String(ZH['climate.entryNote']).indexOf('非官方') !== -1);
  assert.ok(/not an official/i.test(String(EN['climate.entryNote'])));
});
