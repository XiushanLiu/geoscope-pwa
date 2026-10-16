/**
 * 气候常态（ERA5 月平均 / 年平均）—— 请求构造 + 按月聚合
 *
 * 职责：只做两件事 —— 构造 archive-api 的 30 年逐日请求（RequestSpec），以及把
 * 逐日响应**就地聚合成 12 个月的月平均**（只留聚合结果）。不发请求（统一由
 * `core/http.js` 出口）、不读缓存（统一由 `core/cache.js` 管理）、不渲染。
 * 分工与 `data/roadsources.js` 一致：本模块只提供 build/parse。
 *
 * ★为什么是「ERA5 再分析自算月平均」而不是官方气候常态（改这里之前先读）：
 *   提问是「只有『此刻』，年/月平均数据在哪里？」，而三条看起来更「官方」的路都已被
 *   **实测否决**，不要再去试，也不要把它们写进注释当备选：
 *     1) Open-Meteo Climate API（CMIP6）给的是**未来情景**投影，不是 1991–2020 常态；
 *     2) NOAA 官方 normals **不覆盖中国**（北京台站 CHM00054511 实测返回 `[]`）；
 *     3) NASA POWER 的 `T2M_MAX` / `T2M_MIN` 是**极端值**不是平均（实测与平均差约 8℃）。
 *   唯一走通的路是 `archive-api.open-meteo.com` 的 ERA5 逐日再分析 1991-01-01 ~
 *   2020-12-31，一次请求、本地按月聚合。
 *
 * ★★上屏红线（不可简写）：本模块产出的数字是**自算的 ERA5 再分析月平均**，不是任何
 *   官方气候常态值。界面必须显示完整一句
 *   `ERA5 再分析 1991–2020 自算月平均 · 非官方气候常态`（英文走 `climate.entryNote`
 *   的英文版）。简写成「气候常态」「官方常态」就是**说谎**：ERA5 是约 31 km 网格的
 *   再分析格点值，与气象台站的实测常态存在真实偏差（这个偏差要写进界面说明，
 *   不是 bug）。
 *
 * ★★只存聚合结果，绝不落盘 30 年原始逐日数组：一次响应 gzip 前 303 KB（实测），
 *   聚合结果只有几百字节。缓存 TTL 30 天（ERA5 历史数据是静态的，30 年窗口不随时间变化）。
 */

import { makeKey } from '../core/cache.js';
import { round4 } from '../core/geo.js';
import { t } from '../i18n/index.js';
import { OPENMETEO_ATTRIBUTION_KEY } from './openmeteo.js';

/** 归档（再分析）服务基址（仅 https）。 */
export const CLIMATE_HOST = 'https://archive-api.open-meteo.com';

/** 气候窗口起止（**含两端**：1991-01-01 ~ 2020-12-31）。 */
export const CLIMATE_START = '1991-01-01';
export const CLIMATE_END = '2020-12-31';

/**
 * 名义年数（30）。
 *
 * ★只是**名义值**，聚合结果里的 `years` / `monthYears` 用的是**数据里实际出现的
 * 年份数**，不是这个常量 —— 万一某个月因数据缺失只覆盖 29 年，除数就必须是 29，
 * 用 30 除会把「缺了一年」悄悄摊进其余年份，得出一个看起来很合理的假数。
 */
export const CLIMATE_YEARS = 30;

/** 逐日变量（日最高 / 日最低 / 日降水合计）。 */
export const CLIMATE_DAILY_FIELDS = 'temperature_2m_max,temperature_2m_min,precipitation_sum';

/**
 * 构造气候常态请求（30 年逐日 ERA5，一次取全）。
 *
 * 单位参数为什么**显式写**：`buildWeatherRequest`（data/openmeteo.js）一个 `*_unit`
 * 参数都没发（全仓 `grep -rn "_unit" src/` 零命中），也就是说全 App 的温度与降水口径
 * 一直吃的是 Open-Meteo 的**默认值**（摄氏度 / 毫米）。这里把默认值显式钉成
 * `temperature_unit=celsius` / `precipitation_unit=mm`，数值与天气源完全一致，
 * 但不再依赖「上游哪天改默认」—— 30 年聚合一旦单位漂移，是**所有月份一起错**且
 * 看不出来（数值都在合理区间）。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildClimateRequest(ctx) {
  return {
    url: `${CLIMATE_HOST}/v1/archive`,
    params: {
      latitude: round4(ctx.lat).toFixed(4),
      longitude: round4(ctx.lon).toFixed(4),
      start_date: CLIMATE_START,
      end_date: CLIMATE_END,
      daily: CLIMATE_DAILY_FIELDS,
      // ★显式钉住再分析数据集：archive-api 默认是 best_match（会随上游数据集增删漂移），
      //   而 1991–2020 这 30 年必须始终是同一套 ERA5，否则「常态」会随请求日期变。
      models: 'era5',
      timezone: 'auto',
      temperature_unit: 'celsius',
      precipitation_unit: 'mm',
    },
    responseType: 'json',
  };
}

/**
 * 取有限数字，缺失一律 null。
 *
 * ★三连判定 `null / undefined / !Number.isFinite(Number(v))` 是硬规矩：本仓已在 4 处
 *   踩过 `Number(null) === 0` 的坑 —— 把「没算出来」当成 0 ℃ 显示一个看起来很有道理
 *   的假结果。这里再补一条 boolean 拦截（`Number(true) === 1`），同源。
 *
 * @param {*} v 任意值。
 * @returns {number|null} 有限数字或 null。
 */
function _finite(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'symbol') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 保留 1 位小数。
 *
 * @param {number} v 数值。
 * @returns {number} 一位小数。
 */
function _r1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * 从 'YYYY-MM-DD' 取年份与月份。
 *
 * 只认这一种形态的首段（`daily.time` 就是它）；解析不出返回 null，由调用方**整日跳过**
 * —— 不能因为日期串怪就把它塞进 1 月。
 *
 * @param {*} s 日期串。
 * @returns {{year:number, month:number}|null} 年月；解析不出 null。
 */
function _yearMonth(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * 把 30 年逐日响应聚合成 12 个月的月平均（**只留聚合结果**）。
 *
 * 口径（界面上的每一个数字都按这几条算，改一条就要改注释与测试）：
 *   - `months[i].tmaxC` / `tminC`：该日历月内**所有有效日**的日最高 / 日最低的
 *     **算术平均** —— 是「跨 30 年把同一日历月的每一天合在一起求平均」（一次除法），
 *     不是「先算每年月平均再平均」（那在闰年与缺测年份下是另一个数）。
 *     分母 `days` = 该月内日最高与日最低**都有效**的天数；只有一半有效的那天
 *     **两边都不计**（不进分子也不进分母），绝不当成 0 ℃。
 *   - `months[i].precipMm`：**多年平均月降水量** = 该月 30 年降水总和 ÷ **年数**。
 *     年数取该月**实际出现的年份数**（`monthYears`），不是常量 30：缺测年份就按
 *     实际年份除，宁可除数小一点，也不用 30 把缺口摊平。
 *   - `months[i].days`：见上（温度平均的分母）。`monthYears`：降水除数的年份数。
 *   - `summary.precipMm`：**年平均降水总量**（mm/年）= 12 个月平均值之和。
 *     ★用**已取整的月值**相加再取整一次，保证界面上「12 行相加 == 年均」；
 *     与「先加原始值再取整」最多差 0.6 mm（≤ 0.1%），换来表格自洽。
 *   - `summary.tmaxC` / `tminC`：全年所有有效日的平均最高 / 平均最低（一次除法）。
 *   - `years`：响应里**实际出现的年份数**；`dayCount`：全年有效日数。
 *   - 数值统一保留 1 位小数；该月一个有效日都没有时值是 **null**（不是 0）。
 *
 * 退化输入（不是数组 / 缺 `daily` / `daily.time` 长度为 0 / 抛异常）一律返回 **null** ——
 * 不是返回一堆 0，也不是抛异常让整条链路炸掉。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} [ctx] 上下文（本聚合不用它，签名与其它 parse 对齐）。
 * @returns {{years:number, dayCount:number,
 *            months:Array<{month:number, tmaxC:number|null, tminC:number|null,
 *                          precipMm:number|null, days:number, monthYears:number}>,
 *            summary:{tmaxC:number|null, tminC:number|null, precipMm:number|null}}|null}
 *   聚合结果；输入不可用时 null。
 */
export function parseClimate(json, ctx) {
  try {
    const daily = json && typeof json === 'object' ? json.daily : null;
    if (!daily || typeof daily !== 'object') return null;
    const times = daily.time;
    if (!Array.isArray(times) || times.length === 0) return null;

    const tmaxArr = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const tminArr = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    const prcpArr = Array.isArray(daily.precipitation_sum) ? daily.precipitation_sum : [];

    const buckets = [];
    for (let i = 0; i < 12; i += 1) {
      buckets.push({ tmaxSum: 0, tminSum: 0, days: 0, prcpSum: 0, years: new Set() });
    }

    let dayCount = 0;
    let allTmaxSum = 0;
    let allTminSum = 0;
    const allYears = new Set();

    for (let i = 0; i < times.length; i += 1) {
      const ym = _yearMonth(times[i]);
      if (!ym) continue; // 日期串认不出来 → 整天跳过，绝不塞进 1 月
      const b = buckets[ym.month - 1];

      const hi = _finite(tmaxArr[i]);
      const lo = _finite(tminArr[i]);
      const pr = _finite(prcpArr[i]);

      if (ym.year) allYears.add(ym.year);

      // 温度：两个都有效才算「有效日」；缺一半的那天两边都不计（不当 0 ℃）
      if (hi !== null && lo !== null) {
        b.tmaxSum += hi;
        b.tminSum += lo;
        b.days += 1;
        dayCount += 1;
        allTmaxSum += hi;
        allTminSum += lo;
      }
      // 降水：只在有效日累加，并记下这一年确实为该月贡献了降水
      if (pr !== null && ym.year) {
        b.prcpSum += pr;
        b.years.add(ym.year);
      }
    }

    const months = buckets.map((b, i) => {
      const monthYears = b.years.size;
      return {
        month: i + 1,
        tmaxC: b.days > 0 ? _r1(b.tmaxSum / b.days) : null,
        tminC: b.days > 0 ? _r1(b.tminSum / b.days) : null,
        // 除数必须是**实际年份数**：用 30 除会把缺测年份摊进其余年份
        precipMm: monthYears > 0 ? _r1(b.prcpSum / monthYears) : null,
        days: b.days,
        monthYears,
      };
    });

    // 年降水总量 = 12 个月平均值之和（用已取整的月值相加，见 JSDoc）
    let annualPrecip = 0;
    let hasPrecip = false;
    for (const m of months) {
      if (m.precipMm !== null) {
        annualPrecip += m.precipMm;
        hasPrecip = true;
      }
    }

    return {
      years: allYears.size,
      dayCount,
      months,
      summary: {
        tmaxC: dayCount > 0 ? _r1(allTmaxSum / dayCount) : null,
        tminC: dayCount > 0 ? _r1(allTminSum / dayCount) : null,
        precipMm: hasPrecip ? _r1(annualPrecip) : null,
      },
    };
  } catch (err) {
    // parse 抛异常会让 http.js 整路失败；这里宁可返回 null（界面显示「没取到」），
    // 也不抛 —— 但绝不返回一堆 0 冒充结果。
    return null;
  }
}

/**
 * 气候常态的缓存键：'gs:v1:climate:<lat4>:<lon4>'。
 *
 * 与 `data/sources.js` 的 `_coordKey` 同形（经纬度 4 位小数 ≈ 11 m），只是 id 不同 ——
 * 气候常态是「地点的属性」，键里不该有时间戳。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {string} 缓存键。
 */
export function climateCacheKey(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return makeKey('climate', round4(c.lat).toFixed(4), round4(c.lon).toFixed(4));
}

/**
 * @typedef {Object} SourceSpec
 * @property {string} id
 * @property {string} labelKey
 * @property {string} label
 * @property {string} host
 * @property {number} timeoutMs
 * @property {number} retry
 * @property {number} ttlMs
 * @property {boolean} cacheable
 * @property {(ctx:Object)=>string} cacheKey
 * @property {(ctx:Object)=>Object} build
 * @property {(payload:*, ctx:Object)=>*} parse
 * @property {string} attributionKey
 * @property {string} attribution
 * @property {number} priority
 * @property {boolean} critical
 * @property {'api'|'tile'} kind
 */

/**
 * 气候常态源（键 `climate`）。
 *
 * ★只进 `SOURCE_TABLE`（全量表），**不进** `SOURCES` / `SOURCE_LIST`（自检六路）：
 *   那六路被 `tests/sources.test.mjs:57`、`tools/verify-standalone.mjs:116/121`
 *   用「恰好六路 / api 恰好五路」硬断言钉着，`tools/smoke.mjs:335` 还钉着六路顺序串。
 *   而且这一路单次响应 303 KB、耗时十几秒，放进自检页取样只会让自检永远跑不完。
 *
 * @type {Object<string, SourceSpec>}
 */
export const CLIMATE_SOURCES = {
  climate: {
    id: 'climate',
    labelKey: 'source.climate',
    // ★惰性 getter：模块级常量里若把翻译结果直接写死（在模块求值那一刻就调 t()），
    //   源名会永远中文 —— import 先于调用方 body 求值，applyLocale 来不及生效。
    //   照抄 data/roadsources.js 的写法。
    get label() { return t(this.labelKey); },
    host: CLIMATE_HOST,
    // timeoutMs 23428：**实测**推导，不是拍脑袋。
    //   口径：沙箱直连 curl（--noproxy '*'，本机 HTTP_PROXY 会拦回环），北京
    //   39.9087,116.3975 连续三次：5.062 s / 11.714 s / 9.417 s，最大 11.714 s；
    //   取 max(6000, ceil(11713.75 × 2)) = 23428。
    //   ★沙箱口径，【待真机复测】。另：广州那次单发实测 14.284 s（见提交说明），
    //   比北京三次的最大值还大 —— 真机复测时若稳定超过 23.4 s，这条超时要跟着抬。
    //   ⚠️副作用要知道：http.js 全局并发 1 + retry 1，最坏占用队列约 2 × 23.4 s ≈ 47 s。
    //   所以这条链路**只在用户点按钮时**发起，绝不进首屏（见 app.js 的 _loadClimate）。
    timeoutMs: 23428,
    retry: 1,
    // 30 天：ERA5 1991–2020 是**静态历史数据**，窗口不随时间变化，换坐标才有新值。
    // 落盘的是聚合结果（几百字节），不是 303 KB 的逐日数组。
    ttlMs: 2592000000,
    cacheable: true,
    // 不进自检六路 ⇒ critical=false（critical 是「是否触发整体降级态」）。
    // 这一路取数失败只废它自己那张卡，不影响整体降级态（app.js 里也不调 recordResult）。
    critical: false,
    kind: 'api',
    priority: 9,
    attributionKey: OPENMETEO_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: climateCacheKey,
    build: buildClimateRequest,
    parse: parseClimate,
  },
};
