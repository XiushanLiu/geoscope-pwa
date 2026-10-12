/**
 * 语言引导：把本机语言偏好（store.locale）落到 i18n 与 `<html lang>` 上
 *
 * 存在理由：与 src/ui/theme.js 的 applyThemeMode() / applyFontScale() **完全同构** ——
 * 语言是**全站属性**，不是「我的」设置页的属性。用户在设置页选了 English，切回此刻 /
 * 自检 / 方位页必须同样是英文。本仓库是零构建原生 PWA：四个独立 HTML 页，各有一份
 * 手写 `<nav>`，靠 `<a href>` 跳转，**没有 SPA 路由、没有共享的 bootstrap** ——
 * 所以每个入口模块必须各引导一次，不能指望某一页替别人写。
 *
 * 为什么单独开一个文件而不塞进 theme.js：theme.js 文件头写着「零 import，因此
 * core / data / ui 任一层都可以引它」，那是一条真实的、有文档价值的不变量。
 * 本模块必须 import core/store.js 与 i18n/index.js，塞进去就把那条不变量写成了假话。
 *
 * 调用时机：入口模块的**模块顶层**（module 求值那一刻）调 `applyLocale(getLocale())`。
 * ES module 默认 defer，此刻 `document.documentElement` 已存在；放进 boot() / init()
 * 或任何 `await` 之后，用户会先看到一帧中文再跳成英文。本函数幂等，重复调用无副作用。
 *
 * ★与字号那条「防跳档」的区别：字号在四个 HTML 的 `<head>` 里另有一段同步预置脚本，
 *   语言**没有**。原因是首帧那句「正在装载…」在 HTML 里是中文硬编码的兜底文本
 *   （无 JS 环境下的白屏防线），同步脚本换不掉它 —— 真要做，得给每个 HTML 每种语言
 *   各存一份兜底文本，那是把一份静态副本乘成 N 份，维护成本远大于那一帧的收益。
 *   这里如实记下这个取舍，不要当成遗漏去「补」。
 *
 * 依赖方向：ui → core/store.js + i18n/index.js。非浏览器环境（Node 侧静态检查 import
 * 本模块）下是安全的空操作。
 */

import { getLocale, setLocale as persistLocale } from '../core/store.js';
import { DEFAULT_PLACE_NAME } from '../core/geo.js';
import { setLocale as setI18nLocale, getLocale as getI18nLocale, langAttrOf, t } from '../i18n/index.js';

/**
 * 地点的显示名（跟着界面语言走）。
 *
 * 只有**出厂默认地点**需要这一层：它是个地名（北京 · 天安门），英文界面下必须写成
 * "Beijing · Tian'anmen"。core/geo.js 里存的是中文那一版原文（理由见那边的 JSDoc：
 * 它会被写进备份 JSON），这里负责把它换成当前语言的那一版。
 *
 * 用户自己收藏 / 定位出来的地名**原样显示**，一个字都不改 —— 那是数据源给的原文，
 * 强行翻译地名（把 "München" 翻成「慕尼黑」）只会让用户对不上自己搜的是什么。
 *
 * @param {string|null|undefined} name 存储里的地点名。
 * @returns {string} 当前语言下的显示名；空名回落「未命名地点」。
 */
export function placeDisplayName(name) {
  const raw = name === null || name === undefined ? '' : String(name);
  if (raw === '') return t('fav.unnamed');
  if (raw === DEFAULT_PLACE_NAME) return t('place.default');
  return raw;
}

/**
 * 把语言偏好写到 i18n 与 `<html lang>` 上。
 *
 * 两处都要写：
 *   - i18n 决定 `t()` 查哪张表（这是**功能**）；
 *   - `<html lang>` 决定屏幕阅读器用哪国语音念、浏览器要不要提示翻译（这是**无障碍**）。
 *   只写一处会出现「界面是英文、读屏按中文念」这种半切状态。
 *
 * 非法值（含 undefined / 拼错的字符串）一律按 'zh' 处理 —— 宁可回到中文（默认语言），
 * 也不把 i18n 切到一个没有表的 locale 上去。
 *
 * @param {'zh'|'en'} locale 语言标记。
 * @returns {'zh'|'en'} 实际应用的语言。
 */
export function applyLocale(locale) {
  const applied = locale === 'en' ? 'en' : 'zh';
  setI18nLocale(applied);
  const root = typeof document !== 'undefined' && document ? document.documentElement : null;
  if (root) root.setAttribute('lang', langAttrOf(applied));
  return applied;
}

/**
 * 读本机偏好并应用（入口模块顶层的那一行的推荐写法）。
 *
 * 顺带做一次**回写**：i18n 的内存态在每个页面都是新建的（四个 HTML 各自求值一次
 * 模块图），而 store 是持久化的唯一真相。这里以 store 为准，保证「设置页改了 →
 * 切到别的页也是英文」这条承诺成立，不依赖某个页面恰好先跑过。
 *
 * @returns {'zh'|'en'} 实际应用的语言。
 */
export function applyStoredLocale() {
  return applyLocale(getLocale());
}

/**
 * 切换语言：写本机偏好 + 立即生效（设置页那颗切换器用）。
 *
 * 与设置页的 `setThemeMode(mode); applyThemeMode(mode);` 同一手法：先落盘、再上屏。
 *
 * @param {'zh'|'en'} locale 目标语言。
 * @returns {'zh'|'en'} 实际应用的语言。
 */
export function switchLocale(locale) {
  const applied = applyLocale(locale);
  persistLocale(applied);
  return applied;
}

/** @returns {'zh'|'en'} 当前 i18n 正在用的语言（供自检与单测核对）。 */
export function currentLocale() {
  return getI18nLocale();
}
