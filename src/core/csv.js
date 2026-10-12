/**
 * CSV 导出（RFC 4180 + Excel 兼容）
 *
 * 职责：把「此刻」屏那一屏数据导出成一份表格文件。为什么要有它：备份 JSON 是给
 * **搬家**用的（含位置隐私、结构嵌套、给机器读），而 CSV 是给**看数**用的 —— 用户想在
 * Excel / Numbers 里排一列气温、画一条曲线，JSON 那份帮不上忙。
 *
 * 三条硬规矩（改本文件前先读）：
 *
 *   1) **列必须是界面上有的数**。本模块是 core 层，但绝不「顺手多给几个字段」：
 *      每一列都能在 src/ui/now.js 渲染的卡片上找到对应数字。界面上根本没有的量
 *      （例如已取回但尚未上屏的逐小时降水概率）一律**不进表** —— 导出去一个用户
 *      在界面上找不到出处的数字，等于替数据源背书。
 *   2) **缺失留空，不填 0、也不写「—」**。项目界面上缺失一律显示占位符「—」
 *      （core/format.js 的 DASH），但 CSV 里写「—」会让 Excel 把整列判成文本列，
 *      数字列就废了；留空才是表格里「这一格没有数据」的标准语义。
 *   3) **磁偏角由调用方传入**。它是 data/wmm2025.js 算的，而四层单向依赖规定
 *      `core` 不得 import `data`（tools/check.mjs 静态断言）。所以本模块只接收
 *      `opts.declinationDeg` 这个数字，谁调用谁算 —— 分层线不能为了少传一个参数而破。
 *
 *   4) **文案由调用方注入，本模块不 import i18n**。列名与分档名（天气现象 / 风向 /
 *      UV 档位 / AQI 档位）都是人类语言，而 core 不许读 locale 表（core 读「当前界面
 *      是哪国话」= 最底层反向依赖上层）。所以 `snapshotToCsv()` 收一个 `opts.tr`
 *      翻译回调 `(key, params) => string`，由 UI 层把 `t` 传进来 —— 本模块仍然只做
 *      序列化，一个词都不自己造。
 *
 * 分层：core ← 只依赖同层的 core/format.js、core/wmo.js、core/sun.js。**不依赖 i18n**
 * （i18n 的 locale 状态住在 src/i18n/index.js，属于上层；core/wmo.js 与 core/http.js
 * 原先 import i18n/zh.js 的那几处已随中英文改造一并移除）。
 */

import { stamp as exportFilenameStamp, pad2 } from './format.js';
import { wmo, aqi, uv, windDir16, beaufort } from './wmo.js';
import { isDaylight } from './sun.js';

/** UTF-8 BOM：Excel（尤其中文 Windows 版）靠它认出 UTF-8，否则中文全是乱码。 */
export const BOM = '﻿';

/** RFC 4180 规定行尾是 CRLF，不是裸 LF（Excel 对 LF 的容忍度各不相同）。 */
export const CRLF = '\r\n';

/** CSV 的 MIME：charset 必须写进 type，否则部分浏览器按 Latin-1 存盘。 */
export const CSV_MIME = 'text/csv;charset=utf-8';

/** 导出文件名前缀（与 core/backup.js 的 'geoscope-backup-' 同族，便于在下载目录里排序相邻）。 */
const FILE_PREFIX = 'geoscope-now';

/** 列分隔符。 */
const DELIM = ',';

/**
 * 列定义（顺序即列序）：`[行字段, 列名文案键]`。
 *
 * ★导出在这里而不是埋在 snapshotToCsv() 内部：列名是**文案键**，本模块只负责把它们
 * 交给调用方给的 tr() 翻译。把它暴露出来，UI 层（与 tools/check.mjs 的守卫）才能
 * 核对「每一列的 key 都真实存在于两张文案表」—— 藏起来就没人查得动。
 *
 * @type {Array<[string, string]>}
 */
export const CSV_COLUMNS = [
  ['exportedAt', 'csv.h.exportedAt'],
  ['observedAt', 'csv.h.observedAt'],
  ['place', 'csv.h.place'],
  ['lat', 'csv.h.lat'],
  ['lon', 'csv.h.lon'],
  ['elevationM', 'csv.h.elevation'],
  ['tempC', 'csv.h.temp'],
  ['feelsC', 'csv.h.feels'],
  ['humidityPct', 'csv.h.humidity'],
  ['precipMm', 'csv.h.precip'],
  ['windMs', 'csv.h.windSpeed'],
  ['windDir', 'csv.h.windDir'],
  ['beaufort', 'csv.h.beaufort'],
  ['pressureHpa', 'csv.h.pressure'],
  ['visibilityM', 'csv.h.visibility'],
  ['weather', 'csv.h.weather'],
  ['wmoCode', 'csv.h.wmoCode'],
  ['sunrise', 'csv.h.sunrise'],
  ['sunset', 'csv.h.sunset'],
  ['dayLengthMin', 'csv.h.dayLength'],
  ['uvIndex', 'csv.h.uv'],
  ['uvLevel', 'csv.h.uvLevel'],
  ['todayMaxC', 'csv.h.todayMax'],
  ['todayMinC', 'csv.h.todayMin'],
  ['aqi', 'csv.h.aqi'],
  ['aqiLevel', 'csv.h.aqiLevel'],
  ['pm10', 'csv.h.pm10'],
  ['pm25', 'csv.h.pm25'],
  ['ozone', 'csv.h.ozone'],
  ['no2', 'csv.h.no2'],
  ['declinationDeg', 'csv.h.declination'],
  ['sources', 'csv.h.sources'],
];

/**
 * 需要**转义**才安全的字符：分隔符、双引号、CR、LF。
 * 只在这四种字符出现时才加引号包裹 —— 多余的引号会让部分解析器把纯数字当文本。
 */
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * 公式注入触发器：以 `=` / `+` / `@` 开头的单元格会被 Excel / LibreOffice 当公式求值。
 * ★刻意**不含 `-`**：气温、磁偏角这些字段本来就是负数（'-12'），把 '-' 也算进去
 *   会把所有负数变成文本，那才是真的把数据毁了。
 * 唯一的真实来源是「地点」—— 它来自逆地理 / 地名搜索接口，理论上可以是任意字符串。
 */
const FORMULA_TRIGGER = /^[=+@]/;

/**
 * 归一列定义。
 *
 * 接受两种写法，为了调用方不必为了「表头就是键名」这种简单情况多写一层对象：
 *   - 字符串：当作 { key, header } 同值；
 *   - 对象：{ key, header }，缺 header 时回落 key。
 *
 * @param {Array<string|{key:string, header?:string}>} columns 列定义。
 * @returns {Array<{key:string, header:string}>} 归一后的列。
 */
function _normColumns(columns) {
  const list = Array.isArray(columns) ? columns : [];
  return list
    .map((c) => {
      if (c === null || c === undefined) return null;
      if (typeof c === 'string') return { key: c, header: c };
      if (typeof c !== 'object') return null;
      const key = c.key === undefined || c.key === null ? '' : String(c.key);
      if (!key) return null;
      return { key, header: c.header === undefined || c.header === null ? key : String(c.header) };
    })
    .filter(Boolean);
}

/**
 * 按 key 取值（支持 'a.b' 路径，取不到返回 undefined）。
 *
 * @param {Object} row 数据行。
 * @param {string} key 键或点号路径。
 * @returns {*} 值或 undefined。
 */
function _pick(row, key) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const parts = String(key).split('.');
  let cur = row;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * 转义单个字段（RFC 4180）。
 *
 * 规则：
 *   - null / undefined → 空串；
 *   - 含 `,` `"` CR LF 之一 → 用双引号包裹，内部的 `"` 翻倍成 `""`；
 *   - 首字母落在公式注入触发器上 → 前置一个单引号（Excel 把它当「本格是文本」的标记，
 *     显示时不会把那个引号露出来）；
 *   - 其余原样输出（数字保持数字，Excel 才能拿它做计算）。
 *
 * @param {*} value 任意值。
 * @returns {string} 转义后的字段文本。
 */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_TRIGGER.test(s)) s = `'${s}`;
  if (NEEDS_QUOTING.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 把一组行渲染成 CSV 文本（含 BOM、CRLF 行尾、表头行）。
 *
 * 纯函数：不读时钟、不碰 DOM、不写文件，同样的入参永远得到同样的字符串
 * —— 这样转义与行尾这两件最容易出错的事可以被单测直接钉死。
 *
 * 空数据（rows 为空数组）时**只输出表头**：那是一份「有列但没有行」的合法 CSV，
 * 比返回空字符串有用（导入方能拿到列名），也比编一行假数据诚实。
 *
 * @param {Array<Object>} rows 数据行。
 * @param {Array<string|{key:string, header?:string}>} columns 列定义（顺序即列序）。
 * @returns {string} 带 BOM 的 CSV 文本（末行也以 CRLF 结束）。
 */
export function toCsv(rows, columns = []) {
  const cols = _normColumns(columns);
  const list = Array.isArray(rows) ? rows : [];
  const lines = [cols.map((c) => escapeCsvField(c.header)).join(DELIM)];
  for (const row of list) {
    lines.push(cols.map((c) => escapeCsvField(_pick(row, c.key))).join(DELIM));
  }
  return BOM + lines.join(CRLF) + CRLF;
}

/**
 * 数值归一（口径与 core/format.js 的 _num 完全一致）。
 *
 * 必须显式拦掉的「看起来有值其实是空」：null / undefined / 布尔 / 数组 / 纯空白串。
 * `Number(null)` 与 `Number('')` 都是 0 —— 不拦就是「没数据」被写成 0°，那是硬伤。
 *
 * @param {*} v 任意值。
 * @returns {number|null} 有限数字或 null。
 */
function _num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (Array.isArray(v)) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 数值 → 固定小数位的**数字文本**；缺失返回空串（不返回「—」，理由见文件头第 2 条）。
 *
 * @param {*} v 数值。
 * @param {number} [digits=0] 小数位。
 * @returns {string} 形如 '18.2'；缺失时 ''。
 */
function _fixed(v, digits = 0) {
  const n = _num(v);
  return n === null ? '' : n.toFixed(digits);
}

/**
 * ms epoch → 指定时区偏移下的 'YYYY-MM-DD HH:MM'。
 *
 * 为什么不用 core/format.js 的 mdHm()：那份只给到月日（'01-05 07:12'），跨年的旧数据
 * 会显示得像「今年」，正是「误以为这份是刚刚导出的」的诱因 —— 与 settings.js 里
 * 备份导出时间必须带年份是同一个道理。
 *
 * @param {*} atMs ms epoch。
 * @param {number} [offsetSec=0] 时区偏移秒数。
 * @returns {string} 形如 '2025-01-05 07:12'；无法解析时 ''。
 */
function _ymdHm(atMs, offsetSec = 0) {
  const n = _num(atMs);
  if (n === null) return '';
  const off = _num(offsetSec) || 0;
  const d = new Date(n + off * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 设备本地时区相对 UTC 的偏移秒数（东为正）。
 *
 * 为什么需要它：文件名走 core/format.js 的 `stamp()`，那一份用的是**本地时间**取数
 * （getFullYear/getDate/getHours）。如果「导出时间」这一列按 UTC 写，就会出现
 * 「文件名 1405、表里 06:05」这种自相矛盾 —— 同一次导出的两个时间戳必须同源。
 * `Date.prototype.getTimezoneOffset()` 返回的是「UTC − 本地」的分钟数（东八区为 −480），
 * 所以要取反再换算成秒。
 *
 * @param {number} atMs ms epoch（用于取该时刻的偏移，跨夏令时的地区才准）。
 * @returns {number} 偏移秒数。
 */
function _deviceOffsetSec(atMs) {
  return -new Date(atMs).getTimezoneOffset() * 60;
}

/**
 * ms epoch → 指定时区偏移下的 'HH:MM'（日出日落用，界面上也是这个口径）。
 *
 * @param {*} atMs ms epoch。
 * @param {number} [offsetSec=0] 时区偏移秒数。
 * @returns {string} 'HH:MM' 或 ''。
 */
function _hhmm(atMs, offsetSec = 0) {
  const n = _num(atMs);
  if (n === null) return '';
  const off = _num(offsetSec) || 0;
  const d = new Date(n + off * 1000);
  if (!Number.isFinite(d.getTime())) return '';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 生成 CSV 文件名（带本地时间戳，同分钟导两次不会被后一次覆盖）。
 *
 * 时间戳格式复用 core/format.js 的 `stamp()`（'YYYYMMDD-HHmm'），与备份文件名同源。
 *
 * @param {number} [atMs=Date.now()] 导出时刻。
 * @returns {string} 形如 'geoscope-now-20250105-1423.csv'。
 */
export function csvFilename(atMs = Date.now()) {
  return `${FILE_PREFIX}-${exportFilenameStamp(atMs)}.csv`;
}

/**
 * 「此刻」快照 → 一行 CSV 记录（宽表：一列一个指标）。
 *
 * 为什么是**一行**而不是长表：同一时刻的 28 个指标本来就是一条记录，宽表才能让
 * 用户在 Excel 里按列排序 / 画图（长表要每次手动透视）。用户多次导出后往下追加，
 * 自然就成了一张时间序列。
 *
 * 列的取舍（对应文件头第 1 条）：全部取自此刻屏实际渲染的那几张卡片 ——
 * 天气卡（气温 / 体感 / 湿度 / 降水 / 风速 / 风向 / 蒲福 / 气压 / 能见度 / 天气现象 /
 * 日出 / 日落 / 昼长 / 紫外线 / 今日最高最低）、空气卡（欧洲 AQI + 四项污染物）、
 * 位置卡（海拔 / 经纬度 / 地名）、溯源气泡（数据来源）、以及方位屏那个磁偏角。
 * **逐小时序列不进表**：界面上根本没有逐小时那一行，等它上屏了再另开一张表更诚实。
 *
 * @param {Object} snapshot NowSnapshot（store.getLastSnapshot() 的形状）。
 * @param {{atMs?:number, declinationDeg?:number|null,
 *          tr?:(key:string, params?:Object)=>string}} [opts] 导出时刻、磁偏角（度，东偏为正）
 *   与翻译回调（UI 层把 i18n 的 t 传进来；不传则列名与分档名落成原始 key —— 那是**可见的**
 *   失败，由 tests/csv.test.mjs 与 tools/check.mjs 钉死「调用方必须传」）。
 * @returns {{name:string, text:string, rows:number, columns:number}} 文件名、CSV 文本与规模。
 */
export function snapshotToCsv(snapshot, opts = {}) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  // 翻译回调：core 不许 import i18n，只能由调用方注入。
  // 缺省时回落到「返回 key 本身」—— 与 i18n 的 t() 缺键策略一致：**可见的失败**好过
  // 静默掉一列，也不给「用中文兜底」这种会架空英文漏翻守卫的捷径。
  const tr = typeof o.tr === 'function' ? o.tr : (key) => String(key);
  const exportedAt = _num(o.atMs) === null ? Date.now() : _num(o.atMs);

  const w = snap.weather && typeof snap.weather === 'object' ? snap.weather : {};
  const a = snap.air && typeof snap.air === 'object' ? snap.air : {};
  const coord = snap.coord && typeof snap.coord === 'object' ? snap.coord : {};
  const tzOffset = _num(w.tzOffsetSec) || 0;

  // 天气现象的昼夜口径与 now.js 的 renderWeatherCard 完全一致：拿快照时刻 + 该点坐标判定。
  // 缺省也照抄 now.js 的兜底（无时刻 → 按白昼；无坐标 → 0,0），两边不许算出两种昼夜。
  const atMs = _num(snap.atMs);
  const day = atMs === null
    ? true
    : isDaylight(atMs, {
        lat: _num(coord.lat) === null ? 0 : coord.lat,
        lon: _num(coord.lon) === null ? 0 : coord.lon,
      });
  const desc = wmo(w.wmoCode, day);
  const wind = windDir16(w.windDeg);
  const bf = beaufort(w.windMs);
  const uvInfo = uv(w.uvMax);
  const aqiInfo = aqi(a.europeanAqi);

  // 昼长：界面显示「10 小时 32 分」，表里给分钟数（整数列才能算）
  const dayLenMs = _num(w.sunsetAt) !== null && _num(w.sunriseAt) !== null ? w.sunsetAt - w.sunriseAt : null;

  // 数据来源：界面上每条溯源气泡是「源名 + 时延」，表里按同一口径拼（分号分隔）
  const sources = Array.isArray(snap.provenance)
    ? snap.provenance
        .map((p) => {
          const label = p && p.label ? String(p.label) : '';
          const ms = _num(p && p.latencyMs);
          if (!label) return '';
          return ms === null ? label : `${label} ${Math.round(ms)} ms`;
        })
        .filter(Boolean)
        .join('; ')
    : '';

  const row = {
    // 两个时间列**不同时区，这是有意的**：导出时间按设备本地（与文件名同源），
    // 观测时刻按被查询地点的时区（否则「看别的地方」导出的表会记成家里的时间）。
    exportedAt: _ymdHm(exportedAt, _deviceOffsetSec(exportedAt)),
    observedAt: _ymdHm(_num(w.atMs) === null ? snap.atMs : w.atMs, tzOffset),
    place: snap.placeName ? String(snap.placeName) : '',
    lat: _fixed(coord.lat, 4),
    lon: _fixed(coord.lon, 4),
    elevationM: _fixed(snap.elevationM, 0),
    tempC: _fixed(w.tempC, 1),
    feelsC: _fixed(w.feelsC, 1),
    humidityPct: _fixed(w.humidityPct, 0),
    precipMm: _fixed(w.precipMm, 1),
    windMs: _fixed(w.windMs, 1),
    // 风向：'西北偏北风' / 'wind from NNW' —— 中英文语序不同（后缀 vs 介词），
    // 所以整句走 w.windFrom 一条模板，只插方位名。
    windDir: _num(w.windDeg) === null ? '' : tr('w.windFrom', { dir: tr(wind.abbrKey) }),
    beaufort: _num(w.windMs) === null ? '' : String(bf.level),
    pressureHpa: _fixed(w.pressureHpa, 1),
    visibilityM: _fixed(w.visibilityM, 0),
    weather: _num(w.wmoCode) === null ? '' : tr(desc.key),
    wmoCode: _num(w.wmoCode) === null ? '' : String(desc.code),
    sunrise: _hhmm(w.sunriseAt, tzOffset),
    sunset: _hhmm(w.sunsetAt, tzOffset),
    dayLengthMin: dayLenMs === null ? '' : String(Math.round(dayLenMs / 60000)),
    uvIndex: _num(w.uvMax) === null ? '' : String(uvInfo.displayValue),
    uvLevel: _num(w.uvMax) === null ? '' : tr(uvInfo.levelKey),
    todayMaxC: _fixed(w.todayMaxC, 1),
    todayMinC: _fixed(w.todayMinC, 1),
    aqi: _num(a.europeanAqi) === null ? '' : String(aqiInfo.displayValue),
    aqiLevel: _num(a.europeanAqi) === null ? '' : tr(aqiInfo.levelKey),
    pm10: _fixed(a.pm10, 1),
    pm25: _fixed(a.pm25, 1),
    ozone: _fixed(a.ozone, 1),
    no2: _fixed(a.no2, 1),
    declinationDeg: _fixed(o.declinationDeg, 2),
    sources,
  };

  const columns = CSV_COLUMNS.map(([key, headerKey]) => ({ key, header: tr(headerKey) }));

  return {
    name: csvFilename(exportedAt),
    text: toCsv([row], columns),
    rows: 1,
    columns: columns.length,
  };
}
