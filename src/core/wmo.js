/**
 * 气象映射表（WMO / 欧洲 AQI / UV / 风向 / 蒲福风级）
 *
 * 职责：把数值编码翻译成**色彩令牌 + 文案键**，供展示层直接消费。纯数据 + 纯函数，零网络。
 *
 * ★本模块不产出任何人类语言 —— 一律产出 **i18n key**（如 `{ key: 'wmo.61' }`），
 *   由 UI 层 t() 之后才变成「小雨」/ "Slight rain"。
 *
 *   为什么：本模块在 core 层。四层单向依赖 `core ← data ← ui ← html` 规定 core 不得
 *   反向 import 上层（tools/check.mjs 第 8 节与 tests/static.test.mjs 都有硬断言），
 *   而 i18n 的 **locale 状态**（当前是哪一国界面）住在 src/i18n/index.js —— core 一旦
 *   import 它，就等于让最底层去读一个全局可变的「现在该说哪国话」，分层倒置且不可测。
 *   所以这里只给键，UI 层负责翻。
 *
 *   为什么不用「core 自己 import 文案表、按 locale 选」：那仍要 import i18n，同样破分层；
 *   为什么不用「core 接受一个翻译回调、默认走中文」：默认中文会让「英文表少一个 key」
 *   这种错误**静默降级成中文**，正好是 tools/check.mjs 第 14 节那道同构守卫要抓的东西 ——
 *   有默认兜底，守卫就被架空了。返回 key 则没有兜底：少一个 key 界面就显示 `wmo.61`，
 *   而提交前守卫必定报红。
 *
 * 口径：
 *   - WMO 天气码：Open-Meteo 使用的 weather_code（0..99）；
 *   - 欧洲 AQI：0–20 优 / 21–40 良 / 41–60 中 / 61–80 差 / 81–100 很差 / >100 极差；
 *   - UV：0–2 低 / 3–5 中 / 6–7 高 / 8–10 很高 / 11+ 极高；
 *   - 风向：16 方位；蒲福风级：0–12 级。
 *
 * 依赖：零 import（纯常量 + 纯函数）。
 */

/**
 * WMO 天气码表（Open-Meteo 口径）。
 *
 * key 完整描述键 / shortKey 短描述键 / icon 单字符符号（内联字符，非外链图标）。
 * 键名前缀 `wmo.`，未知码落到 `wmo.unknown`。
 */
const WMO_TABLE = {
  0: { key: 'wmo.0', shortKey: 'wmo.0.short', icon: '☀' },
  1: { key: 'wmo.1', shortKey: 'wmo.1.short', icon: '🌤' },
  2: { key: 'wmo.2', shortKey: 'wmo.2.short', icon: '⛅' },
  3: { key: 'wmo.3', shortKey: 'wmo.3.short', icon: '☁' },
  45: { key: 'wmo.45', shortKey: 'wmo.45.short', icon: '🌫' },
  48: { key: 'wmo.48', shortKey: 'wmo.48.short', icon: '🌫' },
  51: { key: 'wmo.51', shortKey: 'wmo.51.short', icon: '🌦' },
  53: { key: 'wmo.53', shortKey: 'wmo.53.short', icon: '🌦' },
  55: { key: 'wmo.55', shortKey: 'wmo.55.short', icon: '🌦' },
  56: { key: 'wmo.56', shortKey: 'wmo.56.short', icon: '🌧' },
  57: { key: 'wmo.57', shortKey: 'wmo.57.short', icon: '🌧' },
  61: { key: 'wmo.61', shortKey: 'wmo.61.short', icon: '🌧' },
  63: { key: 'wmo.63', shortKey: 'wmo.63.short', icon: '🌧' },
  65: { key: 'wmo.65', shortKey: 'wmo.65.short', icon: '🌧' },
  66: { key: 'wmo.66', shortKey: 'wmo.66.short', icon: '🌨' },
  67: { key: 'wmo.67', shortKey: 'wmo.67.short', icon: '🌨' },
  71: { key: 'wmo.71', shortKey: 'wmo.71.short', icon: '🌨' },
  73: { key: 'wmo.73', shortKey: 'wmo.73.short', icon: '🌨' },
  75: { key: 'wmo.75', shortKey: 'wmo.75.short', icon: '❄' },
  77: { key: 'wmo.77', shortKey: 'wmo.77.short', icon: '❄' },
  80: { key: 'wmo.80', shortKey: 'wmo.80.short', icon: '🌦' },
  81: { key: 'wmo.81', shortKey: 'wmo.81.short', icon: '🌧' },
  82: { key: 'wmo.82', shortKey: 'wmo.82.short', icon: '⛈' },
  85: { key: 'wmo.85', shortKey: 'wmo.85.short', icon: '🌨' },
  86: { key: 'wmo.86', shortKey: 'wmo.86.short', icon: '❄' },
  95: { key: 'wmo.95', shortKey: 'wmo.95.short', icon: '⛈' },
  96: { key: 'wmo.96', shortKey: 'wmo.96.short', icon: '⛈' },
  99: { key: 'wmo.99', shortKey: 'wmo.99.short', icon: '⛈' },
};

/** 未知天气码兜底。 */
const WMO_UNKNOWN = { key: 'wmo.unknown', shortKey: 'wmo.unknown.short', icon: '·' };

/**
 * WMO 天气码 → 描述（**文案键**，不是文字）。
 *
 * @param {number} code WMO 天气码。
 * @param {boolean} [isDay=true] 是否白昼（预留昼夜图标切换，本阶段文案一致）。
 * @returns {{code:number, key:string, shortKey:string, icon:string, day:boolean}} 描述对象。
 */
export function wmo(code, isDay = true) {
  // 【致命兜底】天气码缺失（null / '' / undefined）或非法（NaN / 'abc' / {} / []）一律落到「未知天气」。
  // 原因：Number(null)===0、Number('')===0、Number([])===0 —— 若直接 Number() 会把「没数据」
  // 误判成 WMO 0「晴」，界面显示「☀ 晴」。这是**误导性天气显示**，比显示「未知」更糟。
  // 因此这里只对「number」和「非空字符串」做数值化，其余全部归一为 code = -1 的未知档。
  let n = NaN;
  if (typeof code === 'number') {
    n = code;
  } else if (typeof code === 'string' && code.trim() !== '') {
    n = Number(code);
  }
  if (!Number.isFinite(n)) {
    return {
      code: -1,
      key: WMO_UNKNOWN.key,
      shortKey: WMO_UNKNOWN.shortKey,
      icon: WMO_UNKNOWN.icon,
      day: !!isDay,
    };
  }
  const c = Math.trunc(n);
  const base = WMO_TABLE[c] || WMO_UNKNOWN;
  return { code: c, key: base.key, shortKey: base.shortKey, icon: base.icon, day: !!isDay };
}

/** 欧洲 AQI 六档定义（zh 字段已换成 levelKey，文案由 UI 翻译）。 */
const AQI_LEVELS = [
  { max: 20, level: 'good', levelKey: 'level.aqi.good', token: '--c-ok', adviceKey: 'aqi.good.advice' },
  { max: 40, level: 'fair', levelKey: 'level.aqi.fair', token: '--c-ok', adviceKey: 'aqi.fair.advice' },
  { max: 60, level: 'moderate', levelKey: 'level.aqi.moderate', token: '--c-warn', adviceKey: 'aqi.moderate.advice' },
  { max: 80, level: 'poor', levelKey: 'level.aqi.poor', token: '--c-warn', adviceKey: 'aqi.poor.advice' },
  { max: 100, level: 'very-poor', levelKey: 'level.aqi.very-poor', token: '--c-alert', adviceKey: 'aqi.very-poor.advice' },
  { max: Infinity, level: 'extreme', levelKey: 'level.aqi.extreme', token: '--c-alert', adviceKey: 'aqi.extreme.advice' },
];

/**
 * 欧洲 AQI 分级。
 *
 * 说明：`value` 保留原始测量值（含负值，便于排查上游异常）；`displayValue` 是钳制到 [0, +∞)
 * 之后的展示值，界面一律用 displayValue，避免出现「优 · AQI -10」这种自相矛盾的文案。
 * 非有限入参（undefined / null / 'x' / NaN / {}）一律兜底为 0 / good。
 *
 * ★`levelKey` / `adviceKey` 是**键**，不是文字（理由见文件头）。UI 层要显示就用
 * `t(info.levelKey)` / `t(info.adviceKey)`；本模块的旧字段 `zh` / `advice` 已移除 ——
 * 留着它们等于留一条「不切语言也能显示」的捷径，那条捷径正是英文包漏翻的温床。
 *
 * @param {number} europeanAqi 欧洲 AQI 值。
 * @returns {{value:number, displayValue:number, level:string, levelKey:string,
 *            colorToken:string, adviceKey:string}} 分级结果。
 */
export function aqi(europeanAqi) {
  const v = Number(europeanAqi);
  const value = Number.isFinite(v) ? Math.round(v) : 0;
  const hit = AQI_LEVELS.find((l) => value <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
  return {
    value,
    displayValue: Math.max(0, value),
    level: hit.level,
    levelKey: hit.levelKey,
    colorToken: hit.token,
    adviceKey: hit.adviceKey,
  };
}

/** UV 五档定义。 */
const UV_LEVELS = [
  { max: 2, level: 'low', levelKey: 'level.uv.low', token: '--c-ok', adviceKey: 'uv.low.advice' },
  { max: 5, level: 'moderate', levelKey: 'level.uv.moderate', token: '--c-warn', adviceKey: 'uv.moderate.advice' },
  { max: 7, level: 'high', levelKey: 'level.uv.high', token: '--c-warn', adviceKey: 'uv.high.advice' },
  { max: 10, level: 'very-high', levelKey: 'level.uv.very-high', token: '--c-alert', adviceKey: 'uv.very-high.advice' },
  { max: Infinity, level: 'extreme', levelKey: 'level.uv.extreme', token: '--c-alert', adviceKey: 'uv.extreme.advice' },
];

/**
 * 紫外线指数分级。
 *
 * 说明：同 aqi() —— `value` 保留原始值，`displayValue` 钳制到 [0, +∞) 供界面使用。
 * 非有限入参与负值一律兜底为 low 档。
 *
 * @param {number} index UV 指数。
 * @returns {{value:number, displayValue:number, level:string, levelKey:string,
 *            colorToken:string, adviceKey:string}} 分级结果。
 */
export function uv(index) {
  const v = Number(index);
  const value = Number.isFinite(v) ? Math.round(v) : 0;
  const hit = UV_LEVELS.find((l) => value <= l.max) || UV_LEVELS[UV_LEVELS.length - 1];
  return {
    value,
    displayValue: Math.max(0, value),
    level: hit.level,
    levelKey: hit.levelKey,
    colorToken: hit.token,
    adviceKey: hit.adviceKey,
  };
}

/**
 * 16 方位的**文案键**（顺时针，0 = 北）。
 *
 * `dir.N` 是全名（图例用），`dir.N.abbr` 是缩写（此刻页那个数字后面用）。
 * 中文两档同值，英文缩写更短（'North-northeast' → 'NNE'）—— 所以必须分两档存。
 */
const DIR16_KEYS = [
  'dir.0', 'dir.1', 'dir.2', 'dir.3',
  'dir.4', 'dir.5', 'dir.6', 'dir.7',
  'dir.8', 'dir.9', 'dir.10', 'dir.11',
  'dir.12', 'dir.13', 'dir.14', 'dir.15',
];

/**
 * 风向 16 方位。
 *
 * ★只返回**键**。方位名带「风」后缀那个动作（中文「西北偏北风」/ 英文 "wind from NNW"）
 * 由 UI 层用 `t('w.windFrom', { dir: t(dir.abbrKey) })` 完成 —— 中英文那句话的**语序不同**
 * （后缀 vs 介词），core 拼不出两种语言都对的字符串。
 *
 * @param {number} deg 风向角度（0 = 北，顺时针）。
 * @returns {{deg:number, key:string, abbrKey:string}} 方位对象。
 */
export function windDir16(deg) {
  const d = Number(deg);
  const normalized = Number.isFinite(d) ? ((d % 360) + 360) % 360 : 0;
  const idx = Math.round(normalized / 22.5) % 16;
  return { deg: normalized, key: DIR16_KEYS[idx], abbrKey: `${DIR16_KEYS[idx]}.abbr` };
}

/** 蒲福风级上限（m/s）。 */
const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, Infinity];
/** 蒲福风级的文案键（0–12 级 → 'bf.0' … 'bf.12'）。 */
const BEAUFORT_KEYS = BEAUFORT.map((_, level) => `bf.${level}`);

/**
 * 蒲福风级。
 *
 * @param {number} ms 风速（m/s）。
 * @returns {{level:number, key:string}} 风级对象（key 形如 'bf.4'，UI 层 t() 得「和风」/ "Moderate breeze"）。
 */
export function beaufort(ms) {
  const v = Number(ms);
  const speed = Number.isFinite(v) && v > 0 ? v : 0;
  let level = 0;
  while (level < BEAUFORT.length - 1 && speed >= BEAUFORT[level]) level += 1;
  return { level, key: BEAUFORT_KEYS[level] };
}

/* ------------------------------------------------------------------ */
/* 分级表的只读视图（供「指标释义」图例直接消费）                        */
/* ------------------------------------------------------------------ */
/*
 * 为什么要有这几个访问器：图例要把「清风（4 级）」解释成一张档位表，而阈值必须来自
 * **既有实现** —— 若在 legend.js 里另抄一份数字，就等于新造一套标准，将来改了换算表
 * 图例会静默说谎。这里只把上面那几张常量表原样吐出去（不新增、不改写任何数值），
 * legend.js 拿到的永远是界面真正用的那一份。
 *
 * 返回的是**副本**：调用方改不动模块内的常量表。
 * 返回的 `key` / `levelKey` / `adviceKey` 是文案键，由 UI 层翻译（理由见文件头）。
 */

/**
 * 蒲福风级全表（0–12 级）。
 *
 * `maxMs` 是该级的**上限（不含）**：`speed < maxMs` 且 `speed >= 上一级的 maxMs` 即本级。
 * 最高级（12 级）的 maxMs 为 Infinity。
 *
 * @returns {Array<{level:number, key:string, maxMs:number}>} 13 级全表副本。
 */
export function beaufortScale() {
  return BEAUFORT.map((maxMs, level) => ({ level, key: BEAUFORT_KEYS[level], maxMs }));
}

/**
 * 欧洲 AQI 六档全表。
 *
 * @returns {Array<{level:string, levelKey:string, max:number, adviceKey:string}>} 六档副本。
 */
export function aqiScale() {
  return AQI_LEVELS.map((l) => ({
    level: l.level,
    levelKey: l.levelKey,
    max: l.max,
    adviceKey: l.adviceKey,
  }));
}

/**
 * UV 五档全表。
 *
 * @returns {Array<{level:string, levelKey:string, max:number, adviceKey:string}>} 五档副本。
 */
export function uvScale() {
  return UV_LEVELS.map((l) => ({
    level: l.level,
    levelKey: l.levelKey,
    max: l.max,
    adviceKey: l.adviceKey,
  }));
}

/**
 * 风向 16 方位的**文案键**（顺时针，0 = 北）。
 *
 * 返回的是全名键（'dir.0' … 'dir.15'）；界面上「西北偏北风」那个「风」字由 UI 层
 * 用 `t('w.windFrom', { dir })` 补上，理由见 windDir16()。
 *
 * @returns {string[]} 16 个方位键副本。
 */
export function windRose16() {
  return [...DIR16_KEYS];
}
