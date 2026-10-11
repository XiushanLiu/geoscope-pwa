/**
 * 主题引导：把本机主题模式（store.themeMode）落到 `<html data-theme>` 上
 *
 * 存在理由：主题是**全站属性**，不是「我的」设置页的属性。`applyThemeMode()` 原本只活
 * 在 src/ui/settings.js 里，且只有那一页在模块顶层调用过 —— 于是用户手动指定「浅色」
 * 之后，index / selfcheck / compass 三页的 `<html>` 上没有 `data-theme`，CSS 侧只能跟着
 * 系统偏好走，「手动指定后会一直保持」这条承诺（src/i18n/zh.js 的 settings.themeHint）
 * 在那三页上是假的。本仓库是零构建原生 PWA：四个独立 HTML 页，各有一份手写 `<nav>`，
 * 靠 `<a href>` 跳转，**没有 SPA 路由、没有共享的 bootstrap** —— 所以每个入口模块必须
 * 各引导一次，不能指望某一页替别人写。
 *
 * 四组合语义（改本文件前先重读 styles/tokens.css 的注释；**色值一律不动**）：
 *
 *   | themeMode | <html data-theme> | 命中哪条 CSS 规则                                     |
 *   |-----------|-------------------|--------------------------------------------------------|
 *   | 'system'  | 属性不存在        | `@media (prefers-color-scheme: …)` 媒体块（跟随系统）   |
 *   | 'light'   | "light"           | `:root[data-theme='light']` 属性块                      |
 *   | 'dark'    | "dark"            | 没有 `[data-theme='dark']` 规则块 → 回落 `:root` 默认值 |
 *
 * ⚠️ 两条极易写错的地方（写错不报错、只会静默显示错的主题）：
 *   1) **CSS 里没有 `[data-theme='dark']` 规则块**。深色就是 `:root` 的默认值，写 "dark"
 *      的唯一作用是**挡掉**媒体块的守卫 `:root:not([data-theme='dark'])`，让深色在系统
 *      偏好为浅色时也生效。别为了「对称」去补一个 dark 规则块 —— tokens.css 里两块浅色
 *      规则是手工重复的（注释写着「改一处必须改两处」），动色值必然漏一处。
 *   2) `'system'` 必须是**移除**属性（removeAttribute），不是写成 `"system"`。写成
 *      "system" 同样会命中那个 `:not([data-theme='dark'])` 守卫，于是「跟随系统」退化成
 *      「永远是深色」。
 *
 * 调用时机：入口模块的**模块顶层**（module 求值那一刻）调
 * `applyThemeMode(getThemeMode())`。ES module 默认 defer，此刻 `document.documentElement`
 * 已存在；放进 boot() / init() 或任何 `await` 之后，用户会先看到一帧错误主题的背景色。
 * 本函数幂等，重复调用无副作用。
 *
 * 依赖方向：本模块**零 import**（只吃参数、只碰 `document.documentElement`），因此
 * core / data / ui 任一层都可以引它，不会引入循环依赖。非浏览器环境（Node 侧静态检查
 * import 本模块）下是安全的空操作。
 */

/**
 * 把主题模式写到 `<html data-theme>` 上。
 *
 * @param {'system'|'light'|'dark'} mode 主题模式；非法值（含 undefined / 拼错的字符串）
 *   一律按 'system' 处理 —— 宁可跟随系统，也不把一个 CSS 认不出来的值写进属性。
 * @returns {'system'|'light'|'dark'} 实际应用的模式。
 */
export function applyThemeMode(mode) {
  const root = typeof document !== 'undefined' && document ? document.documentElement : null;
  const applied = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (!root) return applied;
  if (applied === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', applied);
  return applied;
}
