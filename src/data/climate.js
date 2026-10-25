/**
 * 气候常态（ERA5 月平均 / 年平均）—— 请求构造 + 按月聚合
 *
 * 职责：只做两件事 —— 构造 archive-api 的 30 年逐日请求（RequestSpec），以及把
 * 逐日响应**就地聚合成 12 个月的月平均**（只留聚合结果）。不发请求（统一由
 * `core/http.js` 出口）、不读缓存（统一由 `core/cache.js` 管理）、不渲染。
 * 分工与其它 data 层源模块一致：本模块只提供 build/parse
 * （★2026-10-17：这里原本写的是「与 data/roadsources.js 一致」，那个模块已随
 *   自驾下线删除，改成泛指其它源模块）。
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
 * ★★只存聚合结果，绝不落盘 30 年原始逐日数组：一次响应 **gzip 前 303294 B / gzip 后
 *   62686 B**（2026-10-16 实测：北京 `curl --compressed` 的 `size_download`，后者才是
 *   真机真要下的字节；广州同口径 66068 B）。聚合结果只有几百字节（实测落盘 1106 B）。
 *   缓存 TTL 30 天（ERA5 历史数据是静态的，30 年窗口不随时间变化）。
 */

import { makeKey } from '../core/cache.js';
// ★大圆距离直接复用 core/geo.js 的 distanceKm()，不在本模块抄第二份实现
//   （本仓有过「抄一份然后两边漂移」的教训）。它不做 null 兜底，所以调用方必须先把
//   四个坐标都判成有限数字 —— 见 _gridOf()。
import { round4, distanceKm } from '../core/geo.js';
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
 * 取响应里的 **ERA5 格点中心** 与它到查询点的距离。
 *
 * 为什么要有它：archive-api 返回的 `latitude` / `longitude` **不是**我们请求的那两个值，
 *   而是上游把请求点吸附到的 **0.25° 网格中心**（北京请求 39.9087,116.3975 → 返回
 *   40,116.5；广州 23.1291,113.2644 → 返回 23.25,113.25）。这一步就把「为什么这些
 *   月平均跟我印象里的官方常态不一样」讲清楚了 —— 数据不是台站的，是**十几公里外
 *   一个格点的**。这个数必须上屏（见 climate.gridNote），不该只躺在注释里。
 *
 * ★四个「没算出来」的坑照旧：`json.latitude` / `json.longitude` / `ctx.lat` / `ctx.lon`
 *   任何一个缺失或非有限数 → 对应字段是 **null**，绝不出 `0,0` 或 `0 km`
 *   （`Number(null) === 0` 是本仓踩过四次的坑，会显示一个看起来很有道理的假结果）。
 *   格点中心本身与 ctx 无关：ctx 缺失时 lat/lon 照常给，只有 distanceKm 是 null。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} [ctx] 查询点上下文。
 * @returns {{lat:number, lon:number, distanceKm:number|null}|null} 格点；缺格点字段时 null。
 */
function _gridOf(json, ctx) {
  const gLat = _finite(json && json.latitude);
  const gLon = _finite(json && json.longitude);
  if (gLat === null || gLon === null) return null;

  const cLat = _finite(ctx && ctx.lat);
  const cLon = _finite(ctx && ctx.lon);
  let km = null;
  if (cLat !== null && cLon !== null) {
    const d = distanceKm({ lat: cLat, lon: cLon }, { lat: gLat, lon: gLon });
    // distanceKm 不兜底（core 层按约定只算数），NaN / Infinity 一律收敛成 null
    km = Number.isFinite(d) ? _r1(d) : null;
  }
  return { lat: gLat, lon: gLon, distanceKm: km };
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
 *     ★★这里的取整取舍必须知道（2026-10-16 主理人裁决，**代码不改，只记录**）：
 *       实现是「把**已取整**的月值（即界面上显示的那一列）相加，再取整一次」，
 *       于是**界面上 12 行相加正好等于年均**（北京 2.8+5.1+…+3.4 = 531.7 mm，
 *       与 summary.precipMm 的 531.7 一致）。
 *       另一条路是「先用未取整的月值求和再取整」—— 那个数在数学上更准，北京实测
 *       **531.6 mm**，与上面的 531.7 差 **0.1 mm（0.02%）**。
 *       裁决：保持现状（列能加得起来），因为 0.1 mm 远低于这份数据本身的噪声
 *       —— ERA5 格点与台站的差异是 18% 量级（广州年降水实测 2041.7 mm vs 常识
 *       1600~1900 mm），为 0.02% 去牺牲「表格自洽」不划算。
 *       ⚠️所以：**年降水总量与逐月列的和可能差 ±0.1 mm 属预期**，不是 bug；
 *       真要切成「未取整最准」版本，改的是下面 annualPrecip 那一行累加的对象。
 *   - `summary.tmaxC` / `tminC`：全年所有有效日的平均最高 / 平均最低（一次除法）。
 *   - `years`：响应里**实际出现的年份数**；`dayCount`：全年有效日数。
 *   - 数值统一保留 1 位小数；该月一个有效日都没有时值是 **null**（不是 0）。
 *
 * 退化输入（不是数组 / 缺 `daily` / `daily.time` 长度为 0 / 抛异常）一律返回 **null** ——
 * 不是返回一堆 0，也不是抛异常让整条链路炸掉。
 *
 *   - `grid`：响应里的**格点中心**（`json.latitude` / `json.longitude`）+ 它到查询点
 *     `ctx` 的大圆距离（km，1 位小数）。聚合本身与 ctx 无关，ctx 只用于算这个距离；
 *     缺任一坐标 → 对应字段 null（见 `_gridOf`）。界面靠它解释「为什么不是台站数」。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} [ctx] 查询点上下文（只用于算 `grid.distanceKm`）。
 * @returns {{years:number, dayCount:number,
 *            months:Array<{month:number, tmaxC:number|null, tminC:number|null,
 *                          precipMm:number|null, days:number, monthYears:number}>,
 *            summary:{tmaxC:number|null, tminC:number|null, precipMm:number|null},
 *            grid:{lat:number, lon:number, distanceKm:number|null}|null}|null}
 *   聚合结果；输入不可用时 null（`grid` 单独判空，与整体 null 无关）。
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
      // 格点中心与查询点的距离。缺 json.latitude/longitude 时整个 grid 是 null，
      // 缺 ctx.lat/lon 时 lat/lon 照给、只有 distanceKm 是 null —— 两种「没算出来」
      // 都不能退化成 0,0 或 0 km（界面据此整行不显示，见 climate.gridNote）。
      grid: _gridOf(json, ctx),
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
    //   （★2026-10-17：这里原本写「照抄 data/roadsources.js 的写法」，那个模块已随
    //    自驾下线删除；惰性 getter 这条规矩本身不变，见 data/sources.js 文件头。）
    get label() { return t(this.labelKey); },
    host: CLIMATE_HOST,
    // ★★timeoutMs 10000：怎么来的必须写清，因为它**不是**由样本严格推出的（见 ②）。
    //
    //   先说清楚一件事：响应里的 `generationtime_ms` 是 **20.36 ms**（北京，实测；
    //   广州 21.94 ms）。也就是说服务端把 10958 天 × 3 变量整段算完只要 20 ms ——
    //   **算力根本不是瓶颈，耗时几乎全是传输**。
    //
    //   ① 分母只取 **gzip 样本**（真实使用条件）：0.993 s（广州）/ 2.585 s（北京），
    //      最大 **2.585 s**。浏览器发请求必带 `Accept-Encoding: gzip`（不用我们做任何事），
    //      真机上走的就是 62.7 KB 这一档，不是 303 KB。
    //
    //   ② 为什么是 10 s 而不是 2× = 5.2 s：**gzip 样本只有 2 个（n=2，太薄）**，
    //      且真机蜂窝通常比沙箱直连慢；62.7 KB 在 100 kbps 量级的慢链上约 5 s
    //      （62700 B × 8 ÷ 100000 ≈ 5.0 s），10 s 既覆盖它又留了余量。
    //      ★明写：**10 s 是 n=2 样本下的保守取值，不是由样本严格推出的结论**，
    //      不许把它包装成实测结论。★沙箱口径，【待真机复测】。
    //
    //   ③ 为什么不拿未压缩的 14.284 s 当分母：`generationtime_ms = 20.36 ms` 证明
    //      那个数是 **303 KB 纯传输**造成的（curl 未带 `--compressed`），而浏览器
    //      必带 gzip，该条件在真实使用中**不发生**。七个未压缩样本**逐条留档**：
    //        北京 39.9087,116.3975：5.062 / 11.714 / 9.417 s
    //        广州 23.1291,113.2644：14.284 / 4.619 / 2.493 / 3.540 s
    //      （测量条件：curl 未带 --compressed，非真实使用条件，**不作为分母**。）
    //      另注：响应里的 latitude/longitude 是**格点中心**（北京请求 39.9087,116.3975
    //      → 返回 40,116.5），与「ERA5 约 31 km 网格、不是台站」是同一件事，
    //      也是界面必须写「非官方气候常态」的物证。
    timeoutMs: 10000,
    // ★retry 0（不是既有源的 1）：
    //     ① 这条请求 gzip 后 **62.7 KB**，是天气源的 20~30 倍；能超时一次说明链路
    //        已经很差，立刻再来一次大概率还是超时 —— 重试的期望收益低于它的代价；
    //     ② 失败态卡片**已经有手动「重试」按钮**（now.js 的 error 分支 →
    //        _emptyCard(text, onLoad)），重试交给用户手势更合适：用户看得见自己在等什么，
    //        也能自己决定要不要再来一次；
    //     ③ `core/http.js:24` 的 `_chain` 是**全局并发 1**，自动重试会让最坏队列占用
    //        翻倍（10 s → 20 s），把天气刷新 / 空气 / 地名 / 瓦片全堵在它后面。
    retry: 0,
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
