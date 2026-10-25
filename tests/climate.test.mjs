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
 *   9) now.js 的闭包红线（不许发请求、不许 import data 层）+ 红线上屏文案；
 *   10) 格点中心 `grid`（北京 40,116.5 / 手算距离区间 / 缺字段一律 null / 整行不显示）。
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
  // 10000：分母只取 **gzip 样本**（真实使用条件，浏览器必带 Accept-Encoding: gzip）：
  //   0.993 s（广州）/ 2.585 s（北京），最大 2.585 s。
  //   ★不取未压缩那七样本的最大值 14.284 s —— `generationtime_ms` 实测 20.36 ms 证明
  //   算力不是瓶颈，那个数是 303 KB 纯传输造成的，而该条件（curl 未带 --compressed）
  //   在真实使用中**不发生**。（七样本仍留档：北京 5.062/11.714/9.417；广州 14.284/4.619/2.493/3.540。）
  //   ★10 s 是 **n=2 样本下的保守取值**（62.7 KB 在 100 kbps 慢链上约 5 s + 余量），
  //   **不是由样本严格推出的**。改这个值必须同步改上面那句「不是严格推出」的说明。
  assert.equal(s.timeoutMs, 10000);
  // ★retry 0：62.7 KB 是天气源的 20~30 倍，能超时一次说明链路很差；失败态已有手动
  //   重试按钮；且 http.js 全局并发 1，自动重试会让最坏队列占用翻倍（10 s → 20 s）
  assert.equal(s.retry, 0);
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

  // ★取整取舍（主理人 2026-10-16 裁决：不改代码，只钉住这个差）：
  //   现状 = 已取整月值求和（列能加得起来）= 531.7 mm；
  //   「未取整月值求和再取整」那条更准的路 = 531.6 mm。两者差 0.1 mm（0.02%），
  //   远低于 ERA5 格点与台站 18% 量级的噪声，属预期。**改成 531.6 会立刻红**
  //   —— 那正是「有人偷偷换了口径」时该看到的红。
  const sumUnrounded = REAL_BJ.daily.precipitation_sum.reduce(
    (acc, v, i) => acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0),
    0
  );
  const unroundedAnnual = Math.round((sumUnrounded / 30) * 10) / 10;
  assert.equal(unroundedAnnual, 531.6, '未取整月值求和再取整应为 531.6 mm');
  assert.equal(got.summary.precipMm, 531.7, '现状（已取整月值求和）应为 531.7 mm');
  assert.ok(
    Math.abs(unroundedAnnual - got.summary.precipMm) <= 0.1 + 1e-9,
    '两条路的差必须 ≤ 0.1 mm（超出说明某处取整口径变了）'
  );
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
  // ★全量表是七路：六路 + 气候常态。
  //   2026-10-17 自驾下线：原「自驾两路」（osrmRoute / amapPoi）已随 src/data/roadsources.js
  //   一并删除，九路 → 七路。★这个 7 是本次删除后唯一的「成员数」硬钉点 —— 原来钉九路的
  //   那条断言在 tests/roadtrip-sources.test.mjs 里，该测试已随自驾删除，数字由这里接管。
  //   ⚠️ 气候常态（决定 C）跟着本次一起发布，所以这 1 路不能摘；摘了就成了 6。
  assert.equal(Object.keys(SOURCE_TABLE).length, 7);
  assert.ok(SOURCE_TABLE.climate);
  // 反向钉：自驾两路不许以任何形式回来（键名也不许留残影）
  assert.equal(SOURCE_TABLE.osrmRoute, undefined, '自驾路线源已下线，全量表里不许再出现 osrmRoute');
  assert.equal(SOURCE_TABLE.amapPoi, undefined, '高德 POI 源已下线，全量表里不许再出现 amapPoi');
  assert.deepEqual(
    Object.keys(SOURCE_TABLE).sort(),
    ['air', 'climate', 'elevation', 'geocode', 'reverse', 'tile', 'weather'],
    '全量表必须恰好是「自检六路 + 气候常态」七路'
  );
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
  // ★2026-10-17 导航重构：now.js 的骨架瘦身成
  //   `search→weather→air→climate→prov→legend`（place / map / bearing 三块随「地理」
  //   主 tab 搬到 ui/compass.js 的骨架里）。所以 climate 槽的相对位置改成
  //   「在 air 之后、prov 之前」—— 判据变了，但「顺序由首次 appendChild 那一刻决定」
  //   这条硬约束没变，仍然必须机器钉住。
  const iAir = src.indexOf("_slot(root, 'air')");
  const iClimate = src.indexOf("_slot(root, 'climate')");
  const iProv = src.indexOf("_slot(root, 'prov')");
  assert.ok(iAir > 0 && iClimate > iAir && iProv > iClimate, 'climate 槽必须在 air 之后、prov 之前');

  // 反向钉：**骨架函数体里**不许再有 place / map / bearing 三槽（它们归地理页）。
  // ⚠️ 必须只扫 renderSkeleton 的函数体，不能扫整个 now.js ——
  //    `_slot(root, 'place')` 在 renderPlaceCard 里**仍然存在且必须存在**
  //    （地理页建好槽之后再调它）。扫全文件会把合法代码判成违规。
  const skStart = src.indexOf('export function renderSkeleton(root) {');
  const skEnd = src.indexOf('/* 降级横幅', skStart);
  assert.ok(skStart > 0 && skEnd > skStart, '应能定位 renderSkeleton 的函数体');
  const skeletonBody = src.slice(skStart, skEnd);
  for (const gone of ['place', 'map', 'bearing']) {
    assert.equal(
      skeletonBody.includes(`_slot(root, '${gone}')`),
      false,
      `renderSkeleton 里不许再建 ${gone} 槽（已随地理页搬走）`
    );
  }
  // 顺带钉住：renderPlaceCard 这个导出必须还在（地理页要 import）
  assert.match(src, /export function renderPlaceCard\(/, 'renderPlaceCard 必须保留导出（地理页要用）');
  // ★2026-10-26：「方位 · 磁偏角」概览卡删除（磁偏角数值一屏重复两遍），
  //   renderBearingCard 随之删除 —— 原来那条「必须保留导出（地理页要用）」的理由已消失，
  //   故删；但**不删成「没人管」**：反向钉住它不许复活（复活 = 那两遍又回来）。
  assert.doesNotMatch(
    src,
    /export function renderBearingCard\(/,
    'renderBearingCard 已随概览卡删除，不许复活（磁偏角只许在详情卡说一遍）'
  );
});

test('⑨b climate.* / source.climate 中英成对且非空（不许简写红线文案）', () => {
  const keys = [
    'source.climate',
    'climate.title',
    'climate.entryNote',
    'climate.gridNote',
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

/* ------------------------------------------------------------------ */
/* 10. 格点中心（grid）—— 解释「为什么不是台站数」的物证                  */
/* ------------------------------------------------------------------ */

/**
 * 手算的北京格点距离（写死在注释里，别把浮点写进断言）。
 *
 * 独立算法（不 import 本仓任何模块）：Haversine，R = 6371 km（与 core/geo.js 同）
 *   39.9087,116.3975 → 40,116.5  =  13.3939 km
 * 交叉验证两路：
 *   - 平面近似（1° 纬度 ≈ 111.32 km，1° 经度 ≈ 111.32 × cos(39.95°)）= 13.4090 km
 *     —— 与球面解差 0.015 km（0.1%），量级对得上。
 *   - 换 WGS84 长半轴 R = 6378.137 → 13.4089 km（球半径不同带来 0.015 km 差异，属正常）。
 * 所以断言取区间 13.0 ~ 13.8，不写死 13.3939 / 13.4。
 */
const HAND_BJ_GRID_KM = 13.3939;

test('⑩ 北京夹具 → grid 是格点中心 40,116.5，distanceKm 落在手算区间内', () => {
  // 响应自己的 latitude/longitude 就是物证：请求 39.9087,116.3975，回来的是 40,116.5
  assert.equal(REAL_BJ.latitude, 40, '夹具的 latitude 必须是格点中心 40');
  assert.equal(REAL_BJ.longitude, 116.5, '夹具的 longitude 必须是格点中心 116.5');

  const got = parseClimate(REAL_BJ, { lat: 39.9087, lon: 116.3975 });
  assert.ok(got, '真实响应必须解析出结果');
  assert.ok(got.grid, 'grid 必须有值');
  assert.equal(got.grid.lat, 40, 'grid.lat 必须取自响应的 latitude');
  assert.equal(got.grid.lon, 116.5, 'grid.lon 必须取自响应的 longitude');

  // 手算 13.3939 km（见 HAND_BJ_GRID_KM 注释）—— 区间断言，不锁浮点
  assert.ok(
    got.grid.distanceKm > 13.0 && got.grid.distanceKm < 13.8,
    `distanceKm 应落在 13.0~13.8（手算 ${HAND_BJ_GRID_KM}），实际 ${got.grid.distanceKm}`
  );
  // 1 位小数
  assert.equal(got.grid.distanceKm, 13.4, 'distanceKm 保留 1 位小数后应等于 13.4');
  // ★绝不退化成 0：0 km 等于谎称格点就在脚下
  assert.notEqual(got.grid.distanceKm, 0);
});

test('⑩b 缺 json.latitude / longitude → grid === null 且不抛（不是 0,0）', () => {
  // 浅拷贝即可：parseClimate 只读 daily 与 latitude/longitude，不碰别的
  const noLat = Object.assign({}, REAL_BJ);
  delete noLat.latitude;
  const noLon = Object.assign({}, REAL_BJ);
  delete noLon.longitude;

  let r1 = null;
  let r2 = null;
  assert.doesNotThrow(() => {
    r1 = parseClimate(noLat, { lat: 39.9087, lon: 116.3975 });
    r2 = parseClimate(noLon, { lat: 39.9087, lon: 116.3975 });
  }, '缺格点字段不许抛');

  assert.ok(r1, '少了 latitude 也该照常聚合（聚合不依赖它）');
  assert.equal(r1.grid, null, '缺 latitude → grid 必须是 null');
  assert.ok(r2);
  assert.equal(r2.grid, null, '缺 longitude → grid 必须是 null');

  // 非有限数（null / NaN / 字符串）同罪 —— `Number(null) === 0` 是本仓踩过四次的坑
  for (const bad of [null, undefined, NaN, 'abcd', {}]) {
    const j = Object.assign({}, REAL_BJ, { latitude: bad });
    const got = parseClimate(j, { lat: 39.9087, lon: 116.3975 });
    assert.equal(got.grid, null, `latitude=${String(bad)} 时 grid 必须是 null`);
  }
});

test('⑩c ctx 缺失 → lat/lon 照给，distanceKm === null（不是 0）', () => {
  const a = parseClimate(REAL_BJ, {});
  assert.ok(a && a.grid);
  assert.equal(a.grid.lat, 40, '格点中心与 ctx 无关，ctx 缺也照给');
  assert.equal(a.grid.lon, 116.5);
  assert.equal(a.grid.distanceKm, null, 'ctx 空 → distanceKm 必须是 null');
  assert.notEqual(a.grid.distanceKm, 0, '★绝不能是 0 —— 0 km 是假结果');

  // 不传 ctx（老调用点）、ctx 里坐标是 null / NaN，同一条规则
  const b = parseClimate(REAL_BJ);
  assert.equal(b.grid.distanceKm, null, '不传 ctx 也必须是 null');
  for (const bad of [null, NaN, undefined, 'x']) {
    const c = parseClimate(REAL_BJ, { lat: bad, lon: 116.3975 });
    assert.equal(c.grid.distanceKm, null, `ctx.lat=${String(bad)} 时必须是 null`);
    const d = parseClimate(REAL_BJ, { lat: 39.9087, lon: bad });
    assert.equal(d.grid.distanceKm, null, `ctx.lon=${String(bad)} 时必须是 null`);
  }
});

test('⑩d 渲染：有 grid 出格点那一行；grid 为 null / 距离缺失 → 整行不出现', () => {
  // 有值：整句模板只插值数字，且排在如实标注那一行之后
  const root = mount();
  const data = Object.assign(fakeAggregate(), { grid: { lat: 40, lon: 116.5, distanceKm: 13.4 } });
  renderClimateCard(root, { status: 'ready', data, text: '' }, null);
  const body = text(root);
  const line = t('climate.gridNote', { lat: 40, lon: 116.5, km: 13.4 });
  assert.ok(body.indexOf(line) !== -1, '必须出格点那一行');
  assert.ok(body.indexOf(line) > body.indexOf(t('climate.entryNote')), '格点行必须排在如实标注之后');
  // 不许出现「0 km」这种退化
  assert.ok(body.indexOf('0 km') === -1, '不许出现 0 km');

  // grid === null：整行消失，其余照旧
  const root2 = mount();
  const data2 = Object.assign(fakeAggregate(), { grid: null });
  renderClimateCard(root2, { status: 'ready', data: data2, text: '' }, null);
  const body2 = text(root2);
  assert.ok(body2.indexOf(t('climate.gridNote', { lat: 40, lon: 116.5, km: 13.4 })) === -1, 'grid 为 null 时整行不显示');
  assert.ok(body2.indexOf('格点') === -1, 'grid 为 null 时不许留「格点」字样');
  assert.equal(root2.querySelectorAll('.clim-c').length, 36, '其余内容不受影响');
  assert.ok(body2.indexOf(t('climate.entryNote')) !== -1, '如实标注照旧在');

  // grid 有值但 distanceKm === null（算不出距离）→ 同样整行不显示
  const root3 = mount();
  const data3 = Object.assign(fakeAggregate(), { grid: { lat: 40, lon: 116.5, distanceKm: null } });
  renderClimateCard(root3, { status: 'ready', data: data3, text: '' }, null);
  assert.ok(
    text(root3).indexOf(t('climate.gridNote', { lat: 40, lon: 116.5, km: 0 })) === -1,
    'distanceKm 为 null 时整行不显示'
  );
  assert.ok(text(root3).indexOf('格点') === -1, 'distanceKm 缺失时不许显示「格点 —」或「约 0 km」');
});
