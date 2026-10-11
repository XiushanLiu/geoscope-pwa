/**
 * 气象映射表（WMO / 欧洲 AQI / UV / 风向 / 蒲福风级）
 *
 * 职责：把数值编码翻译为中文语义与色彩令牌，供展示层直接消费。纯数据 + 纯函数，零网络。
 *
 * 口径：
 *   - WMO 天气码：Open-Meteo 使用的 weather_code（0..99）；
 *   - 欧洲 AQI：0–20 优 / 21–40 良 / 41–60 中 / 61–80 差 / 81–100 很差 / >100 极差；
 *   - UV：0–2 低 / 3–5 中 / 6–7 高 / 8–10 很高 / 11+ 极高；
 *   - 风向：16 方位中文；蒲福风级：0–12 级。
 *
 * 文案：advice 文案取自 i18n（t(adviceKey)），故本模块依赖 i18n/zh.js（叶子模块，无循环）。
 */

import { t } from '../i18n/zh.js';

/**
 * WMO 天气码表（Open-Meteo 口径）。
 * zh 完整描述 / short 短描述 / icon 单字符符号（内联字符，非外链图标）。
 */
const WMO_TABLE = {
  0: { zh: '晴', short: '晴', icon: '☀' },
  1: { zh: '大部晴朗', short: '晴间少云', icon: '🌤' },
  2: { zh: '局部多云', short: '多云', icon: '⛅' },
  3: { zh: '阴', short: '阴', icon: '☁' },
  45: { zh: '雾', short: '雾', icon: '🌫' },
  48: { zh: '沉积雾凇雾', short: '雾凇', icon: '🌫' },
  51: { zh: '小毛毛雨', short: '毛毛雨', icon: '🌦' },
  53: { zh: '中毛毛雨', short: '毛毛雨', icon: '🌦' },
  55: { zh: '大毛毛雨', short: '毛毛雨', icon: '🌦' },
  56: { zh: '冻毛毛雨（弱）', short: '冻毛毛雨', icon: '🌧' },
  57: { zh: '冻毛毛雨（强）', short: '冻毛毛雨', icon: '🌧' },
  61: { zh: '小雨', short: '小雨', icon: '🌧' },
  63: { zh: '中雨', short: '中雨', icon: '🌧' },
  65: { zh: '大雨', short: '大雨', icon: '🌧' },
  66: { zh: '冻雨（弱）', short: '冻雨', icon: '🌨' },
  67: { zh: '冻雨（强）', short: '冻雨', icon: '🌨' },
  71: { zh: '小雪', short: '小雪', icon: '🌨' },
  73: { zh: '中雪', short: '中雪', icon: '🌨' },
  75: { zh: '大雪', short: '大雪', icon: '❄' },
  77: { zh: '米雪', short: '米雪', icon: '❄' },
  80: { zh: '小阵雨', short: '阵雨', icon: '🌦' },
  81: { zh: '中阵雨', short: '阵雨', icon: '🌧' },
  82: { zh: '强阵雨', short: '暴雨', icon: '⛈' },
  85: { zh: '小阵雪', short: '阵雪', icon: '🌨' },
  86: { zh: '大阵雪', short: '阵雪', icon: '❄' },
  95: { zh: '雷阵雨', short: '雷阵雨', icon: '⛈' },
  96: { zh: '雷阵雨伴小冰雹', short: '雷暴冰雹', icon: '⛈' },
  99: { zh: '雷阵雨伴大冰雹', short: '强雷暴冰雹', icon: '⛈' },
};

/** 未知天气码兜底。 */
const WMO_UNKNOWN = { zh: '未知天气', short: '未知', icon: '·' };

/**
 * WMO 天气码 → 中文描述。
 *
 * @param {number} code WMO 天气码。
 * @param {boolean} [isDay=true] 是否白昼（预留昼夜图标切换，本阶段文案一致）。
 * @returns {{code:number, zh:string, short:string, icon:string, day:boolean}} 描述对象。
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
      zh: WMO_UNKNOWN.zh,
      short: WMO_UNKNOWN.short,
      icon: WMO_UNKNOWN.icon,
      day: !!isDay,
    };
  }
  const c = Math.trunc(n);
  const base = WMO_TABLE[c] || WMO_UNKNOWN;
  return { code: c, zh: base.zh, short: base.short, icon: base.icon, day: !!isDay };
}

/** 欧洲 AQI 六档定义。 */
const AQI_LEVELS = [
  { max: 20, level: 'good', zh: '优', token: '--c-ok', adviceKey: 'aqi.good.advice' },
  { max: 40, level: 'fair', zh: '良', token: '--c-ok', adviceKey: 'aqi.fair.advice' },
  { max: 60, level: 'moderate', zh: '中', token: '--c-warn', adviceKey: 'aqi.moderate.advice' },
  { max: 80, level: 'poor', zh: '差', token: '--c-warn', adviceKey: 'aqi.poor.advice' },
  { max: 100, level: 'very-poor', zh: '很差', token: '--c-alert', adviceKey: 'aqi.very-poor.advice' },
  { max: Infinity, level: 'extreme', zh: '极差', token: '--c-alert', adviceKey: 'aqi.extreme.advice' },
];

/**
 * 欧洲 AQI 分级。
 *
 * 说明：`value` 保留原始测量值（含负值，便于排查上游异常）；`displayValue` 是钳制到 [0, +∞)
 * 之后的展示值，界面一律用 displayValue，避免出现「优 · AQI -10」这种自相矛盾的文案。
 * 非有限入参（undefined / null / 'x' / NaN / {}）一律兜底为 0 / good。
 *
 * @param {number} europeanAqi 欧洲 AQI 值。
 * @returns {{value:number, displayValue:number, level:string, zh:string, colorToken:string,
 *            advice:string, adviceKey:string}} 分级结果。
 */
export function aqi(europeanAqi) {
  const v = Number(europeanAqi);
  const value = Number.isFinite(v) ? Math.round(v) : 0;
  const hit = AQI_LEVELS.find((l) => value <= l.max) || AQI_LEVELS[AQI_LEVELS.length - 1];
  return {
    value,
    displayValue: Math.max(0, value),
    level: hit.level,
    zh: hit.zh,
    colorToken: hit.token,
    advice: t(hit.adviceKey),
    adviceKey: hit.adviceKey,
  };
}

/** UV 五档定义。 */
const UV_LEVELS = [
  { max: 2, level: 'low', zh: '低', token: '--c-ok', adviceKey: 'uv.low.advice' },
  { max: 5, level: 'moderate', zh: '中', token: '--c-warn', adviceKey: 'uv.moderate.advice' },
  { max: 7, level: 'high', zh: '高', token: '--c-warn', adviceKey: 'uv.high.advice' },
  { max: 10, level: 'very-high', zh: '很高', token: '--c-alert', adviceKey: 'uv.very-high.advice' },
  { max: Infinity, level: 'extreme', zh: '极高', token: '--c-alert', adviceKey: 'uv.extreme.advice' },
];

/**
 * 紫外线指数分级。
 *
 * 说明：同 aqi() —— `value` 保留原始值，`displayValue` 钳制到 [0, +∞) 供界面使用。
 * 非有限入参与负值一律兜底为 low 档。
 *
 * @param {number} index UV 指数。
 * @returns {{value:number, displayValue:number, level:string, zh:string, colorToken:string,
 *            advice:string, adviceKey:string}} 分级结果。
 */
export function uv(index) {
  const v = Number(index);
  const value = Number.isFinite(v) ? Math.round(v) : 0;
  const hit = UV_LEVELS.find((l) => value <= l.max) || UV_LEVELS[UV_LEVELS.length - 1];
  return {
    value,
    displayValue: Math.max(0, value),
    level: hit.level,
    zh: hit.zh,
    colorToken: hit.token,
    advice: t(hit.adviceKey),
    adviceKey: hit.adviceKey,
  };
}

/** 16 方位中文（顺时针，0 = 北）。 */
const DIR16 = [
  '北', '东北偏北', '东北', '东北偏东',
  '东', '东南偏东', '东南', '东南偏南',
  '南', '西南偏南', '西南', '西南偏西',
  '西', '西北偏西', '西北', '西北偏北',
];

/**
 * 风向 16 方位。
 *
 * @param {number} deg 风向角度（0 = 北，顺时针）。
 * @returns {{deg:number, zh:string}} 方位对象，zh 形如 '西北偏北风'。
 */
export function windDir16(deg) {
  const d = Number(deg);
  const normalized = Number.isFinite(d) ? ((d % 360) + 360) % 360 : 0;
  const idx = Math.round(normalized / 22.5) % 16;
  return { deg: normalized, zh: `${DIR16[idx]}风` };
}

/** 蒲福风级上限（m/s）。 */
const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, Infinity];
/** 蒲福风级中文名。 */
const BEAUFORT_ZH = ['无风', '软风', '轻风', '微风', '和风', '清风', '强风', '疾风', '大风', '烈风', '狂风', '暴风', '飓风'];

/**
 * 蒲福风级。
 *
 * @param {number} ms 风速（m/s）。
 * @returns {{level:number, zh:string}} 风级对象。
 */
export function beaufort(ms) {
  const v = Number(ms);
  const speed = Number.isFinite(v) && v > 0 ? v : 0;
  let level = 0;
  while (level < BEAUFORT.length - 1 && speed >= BEAUFORT[level]) level += 1;
  return { level, zh: BEAUFORT_ZH[level] };
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
 */

/**
 * 蒲福风级全表（0–12 级）。
 *
 * `maxMs` 是该级的**上限（不含）**：`speed < maxMs` 且 `speed >= 上一级的 maxMs` 即本级。
 * 最高级（12 级）的 maxMs 为 Infinity。
 *
 * @returns {Array<{level:number, zh:string, maxMs:number}>} 13 级全表副本。
 */
export function beaufortScale() {
  return BEAUFORT.map((maxMs, level) => ({ level, zh: BEAUFORT_ZH[level], maxMs }));
}

/**
 * 欧洲 AQI 六档全表。
 *
 * @returns {Array<{level:string, zh:string, max:number, advice:string}>} 六档副本。
 */
export function aqiScale() {
  return AQI_LEVELS.map((l) => ({
    level: l.level,
    zh: l.zh,
    max: l.max,
    advice: t(l.adviceKey),
  }));
}

/**
 * UV 五档全表。
 *
 * @returns {Array<{level:string, zh:string, max:number, advice:string}>} 五档副本。
 */
export function uvScale() {
  return UV_LEVELS.map((l) => ({
    level: l.level,
    zh: l.zh,
    max: l.max,
    advice: t(l.adviceKey),
  }));
}

/**
 * 风向 16 方位名（顺时针，0 = 北）。
 *
 * 后缀「风」与 windDir16() 保持一致（界面显示的是「西北偏北风」）。
 *
 * @returns {string[]} 16 个方位名副本。
 */
export function windRose16() {
  return DIR16.map((zh) => `${zh}风`);
}
