/**
 * i18n 入口：当前 locale + 文案表 + t()
 *
 * 为什么 t() 不能继续住在 zh.js 里：翻译函数是**运行时**（要读「当前是哪一国的界面」），
 * 而 zh.js 只是一份**静态表**。两者混在一个文件时，新增英文包只能「再建一个 en.js 并
 * 另写一份 t()」，于是「当前 locale」这个概念无家可归 —— 谁切换、存在哪、什么时候生效
 * 全都得靠口头约定。本模块就是那个家。
 *
 * 三件事：
 *   1) 持有当前 locale（默认 'zh'：本项目中文界面为主）与 setLocale() / getLocale()；
 *   2) t(key, params) 按当前 locale 取表、替换占位符；
 *   3) tr(spec) 把 core 层吐出的**结构化文案量** `{ key, params }` 翻成字符串
 *      —— core 不许 import 本模块（core ← data ← ui ← html 单向依赖），它只能返回 key。
 *
 * ★缺键策略（与旧实现一致，别改成抛异常或返回空串）：返回 key 本身。
 *   「界面上显示 wmo.61」比「显示空白 / 白屏」好排查一万倍，而且它是**可见的**失败。
 *   真正的兜底是 tools/check.mjs 第 14 节：zh.js 与 en.js 的 key 集合双向校验，
 *   少一个 key 直接报红 —— 让缺键死在提交前，而不是死在用户屏幕上。
 *
 * 非浏览器安全：本模块不碰 DOM（写 <html lang> 是 ui/locale.js 的事），
 * 因此 tools/check.mjs 在 Node 侧动态 import 全部 src 模块时是安全的。
 */

import { ZH } from './zh.js';
import { EN } from './en.js';

/** 应用元信息（导出 JSON 与页面标题共用）。 */
export const APP_NAME = 'WayScope';
export const APP_VERSION = '1.0.0';

/** 默认 locale：中文界面为主（用户拍板）。 */
export const DEFAULT_LOCALE = 'zh';

/** 受支持的 locale（顺序即「我的」页切换器的界面顺序）。 */
export const LOCALES = ['zh', 'en'];

/** locale → 文案表。 */
const TABLES = { zh: ZH, en: EN };

/** locale → <html lang> 该写的 BCP-47 标签（与 ui/locale.js 共用这一处真相）。 */
const LANG_ATTR = { zh: 'zh-CN', en: 'en' };

/** @type {string} 当前 locale（模块级：一次切换，全站生效）。 */
let _locale = DEFAULT_LOCALE;

/**
 * 白名单钳位：只认 LOCALES 里的值。
 *
 * 为什么读侧也要钳（不直接返回 _locale）：内存态可能来自一份被外力改坏的缓存，
 * 一旦出去一个 'jp' 这样的值，TABLES['jp'] 是 undefined，t() 会全站返回原始 key。
 * 宁可回落默认语言，也不让整个界面变成一串键名。
 *
 * @param {*} v 任意值。
 * @returns {string} 'zh' 或 'en'。
 */
function _norm(v) {
  return v === 'en' ? 'en' : DEFAULT_LOCALE;
}

/**
 * 取当前 locale。
 *
 * @returns {string} 'zh' 或 'en'。
 */
export function getLocale() {
  return _norm(_locale);
}

/**
 * 切换当前 locale。
 *
 * 只改内存态，**不碰 store**：写盘是 ui/settings.js 的事（与 setThemeMode / setFontScale
 * 同形状 —— store 负责持久化，本模块负责「此刻显示哪国话」）。这样 core 层不需要知道
 * i18n 的存在，i18n 也不需要 import store，两边都不破坏单向依赖。
 *
 * @param {*} v 目标 locale；非法值回落 DEFAULT_LOCALE。
 * @returns {string} 实际生效的 locale。
 */
export function setLocale(v) {
  _locale = _norm(v);
  return _locale;
}

/**
 * 取某个 locale 的文案表（供守卫脚本与单测比对两张表）。
 *
 * @param {string} [locale] locale；缺省为当前 locale。
 * @returns {Object<string,string>} 文案表（**引用**，只读用途，勿改）。
 */
export function tableOf(locale) {
  return TABLES[_norm(locale === undefined ? _locale : locale)] || ZH;
}

/**
 * 取文案。
 *
 * @param {string} key 文案键，如 'status.ok'。
 * @param {Object<string, string|number>} [params] 占位符替换表，如 { ms: 123 }。
 * @returns {string} 替换后的文案；键缺失时返回 key 本身（可见的失败，便于排查）。
 */
export function t(key, params = {}) {
  const table = tableOf();
  const tpl = table[key];
  if (tpl === undefined) {
    // 缺失键：静默返回 key；不抛、不打日志 —— 打日志会引 store，而 store 属于 core 层，
    // 那会让 i18n 反向依赖 core。缺键由 tools/check.mjs 第 14 节在提交前拦下。
    return String(key);
  }
  return String(tpl).replace(/\{(\w+)\}/g, (m, name) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * 把 core 层吐出的**结构化文案量**翻成字符串。
 *
 * core/format.js 的 duration() / relativeTime() / staleFor() 返回的是
 * `{ key: 'fmt.duration.hm', params: { h: 10, m: 32 } }` —— 因为 core 不许 import 本模块。
 * 本函数就是那座桥。
 *
 * 顺带兼容「已经是字符串」的情况：那几个函数在**数值缺失**时返回 core/format.js 的
 * DASH 占位符（'—'），它不是 key，必须原样透传，不能被当成键名去查表。
 *
 * @param {string|{key:string, params?:Object}|null} spec 结构化文案量或已成文本。
 * @param {Object<string, string|number>} [extra] 额外占位符（覆盖 spec.params 的同名项）。
 * @returns {string} 文本；null / undefined 返回空串。
 */
export function tr(spec, extra = {}) {
  if (spec === null || spec === undefined) return '';
  if (typeof spec !== 'object') return String(spec);
  const key = spec.key === undefined || spec.key === null ? '' : String(spec.key);
  if (!key) return '';
  return t(key, { ...(spec.params && typeof spec.params === 'object' ? spec.params : {}), ...extra });
}

/**
 * 判断文案键是否存在（debug 自检与单测用）。
 *
 * @param {string} key 文案键。
 * @returns {boolean} 是否存在于当前表。
 */
export function hasKey(key) {
  return Object.prototype.hasOwnProperty.call(tableOf(), key);
}

/**
 * 导出当前表的全部键（供冒烟脚本与守卫检查完整性）。
 *
 * @returns {string[]} 键数组。
 */
export function allKeys() {
  return Object.keys(tableOf());
}

/**
 * 取某个 locale 该写在 <html lang> 上的 BCP-47 标签。
 *
 * 放在这里而不写进 ui/locale.js：语言标签是语言的一部分，跟着表走，
 * 免得将来加了第三国语言时漏改某个写死 'zh-CN' 的地方。
 *
 * @param {string} [locale] locale；缺省为当前 locale。
 * @returns {string} 形如 'zh-CN' / 'en'。
 */
export function langAttrOf(locale) {
  return LANG_ATTR[_norm(locale === undefined ? _locale : locale)] || LANG_ATTR[DEFAULT_LOCALE];
}

/** 重新导出两张表（供守卫脚本与单测做同构比对，UI 层请勿直接用 —— 一律走 t()）。 */
export { ZH, EN };
