/**
 * 对比度审计（tools/contrast-audit.mjs）
 *
 * 为什么有这个脚本：配色对比度问题在本项目被连续发现三次（状态色当文字色、告警红当文字色、
 * 降级横幅缺样式钩），共同特点是「测试全绿、肉眼才看得出」。tests/contrast.test.mjs 只能
 * 压住**写法**（状态色不得出现在 color: 上），压不住**数值**。这个脚本补的就是数值这一半。
 *
 * 它从 styles/tokens.css 与 styles/app.css 的实际取值出发独立重算 WCAG 对比度，
 * 不引用任何人手报过的数字 —— 改完配色跑一次就能知道有没有跌破门槛。
 *
 * 基底口径（数字不可比的主因，改口径必须同步改这里）：
 *   · chip / 徽标坐在**卡片表面**上：深色屏 = rgba(255,255,255,.07) 叠屏渐变；
 *     浅色屏卡片填充是**不透明的 #ffffff**，与屏渐变无关。
 *   · banner 直接叠在屏渐变上（不在卡片里），背景是 color-mix(状态色 n%, --c-card-fill)。
 *   · 屏渐变有两端（--c-screen-a / --c-screen-b），一律取**较差的那一端**。
 *
 * 用法：node tools/contrast-audit.mjs
 * 退出码：有任何一项低于 4.5:1 时为 1（可接进 CI），全部达标为 0。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const tokens = readFileSync(new URL('styles/tokens.css', ROOT), 'utf8');

// ---------- WCAG ----------
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const hx = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const over = (fg, a, bg) => fg.map((c, i) => a * c + (1 - a) * bg[i]);
const tag = (n) => (n >= 7 ? 'AAA' : n >= 4.5 ? 'AA' : n >= 3 ? 'AA大字' : '✗不达标');

// ---------- token 解析（跟随 var() 引用，区分深浅主题） ----------
function scopeOf(theme) {
  if (theme === 'light') {
    const i = tokens.indexOf("[data-theme='light']");
    return tokens.slice(i, tokens.indexOf('}', i));
  }
  // 深色：文件里有**多个**独立的 `:root {}` 块（状态色在末尾另起一块），必须全部拼接，
  // 只取第一个会漏掉 --c-state-*；且不碰 [data-theme='light'] 与 prefers-color-scheme 媒体块。
  let out = '';
  for (let i = tokens.indexOf(':root {'); i !== -1; i = tokens.indexOf(':root {', i + 1)) {
    out += tokens.slice(i, tokens.indexOf('}', i)) + ';';
  }
  return out;
}
function token(name, theme) {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  let m = scopeOf(theme).match(re);
  // 浅色块只覆盖了部分 token（状态色 --c-state-* 是深浅一致的，定义在基础 :root 里），
  // 所以浅色查不到时回落到基础块 —— 这正是浏览器变量的实际层叠行为。
  if (!m && theme === 'light') m = scopeOf('dark').match(re);
  if (!m) throw new Error(`token 未找到: --${name} (${theme})`);
  return m[1].trim();
}
function color(value, theme, depth = 0) {
  if (depth > 8) throw new Error('token 引用过深，可能循环');
  const v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return color(token(ref[1].slice(2), theme), theme, depth + 1);
  if (v.startsWith('#')) return { rgb: hx(v), a: 1 };
  const p = v.match(/rgba?\(([^)]+)\)/);
  if (p) {
    const n = p[1].split(',').map(Number);
    return { rgb: [n[0], n[1], n[2]], a: n.length > 3 ? n[3] : 1 };
  }
  throw new Error(`无法解析颜色: ${v}`);
}

const WHITE = [255, 255, 255];
const screenEnds = (theme) =>
  ['c-screen-a', 'c-screen-b'].map((k) => color(token(k, theme), theme).rgb);
/** 卡片表面：卡片填充叠在屏渐变上（浅色填充不透明，两端同值） */
const cardSurface = (theme) => {
  const fill = color(token('c-card-fill', theme), theme);
  return screenEnds(theme).map((ep) => over(fill.rgb, fill.a, ep));
};
const worst = (theme, text, top) =>
  Math.min(...cardSurface(theme).map((cs) => contrast(text, over(top.rgb, top.a, cs))));

// ---------- 审计项：与 app.css 的实际取值一一对应，改样式要同步改这里 ----------
const CHIPS = [
  ['chip--ok', 'c-state-ok', 22],
  ['chip--stale', 'c-state-stale', 22],
  ['chip--degraded', 'c-warn', 22],
  ['chip--offline', 'c-state-offline', 22],
  ['chip--failed', 'c-state-failed', 22],
  ['chip--idle', 'c-state-idle', 38], // idle 是 38%，不是同族的 22%：它要跟基础 .chip 底拉开区分度
];
const BANNERS = [
  ['banner--grid', 'c-warn', 14],
  ['banner--partial', 'c-warn', 7],
  ['banner--empty', 'c-alert', 20],
];

const rows = [];
let failed = 0;
for (const theme of ['dark', 'light']) {
  const text = color(token('c-text-1', theme), theme).rgb;
  for (const [cls, tok, pct] of CHIPS) {
    const st = color(`var(--${tok})`, theme);
    const n = worst(theme, text, { rgb: st.rgb, a: pct / 100 });
    if (n < 4.5) failed++;
    rows.push({ 类别: 'chip', 主题: theme === 'dark' ? '深色屏' : '浅色屏', 选择器: '.' + cls, 填充: pct + '%', 对比度: n.toFixed(2), 判定: tag(n) });
  }
  // banner 直接叠屏渐变，不在卡片里
  for (const [cls, tok, pct] of BANNERS) {
    const st = color(`var(--${tok})`, theme).rgb;
    const fill = color(token('c-card-fill', theme), theme);
    const a = (pct / 100) * 1 + (1 - pct / 100) * fill.a;
    const premult = st.map((c, i) => (pct / 100) * c + (1 - pct / 100) * fill.rgb[i] * fill.a);
    const rgb = premult.map((c) => c / a);
    const n = Math.min(...screenEnds(theme).map((ep) => contrast(text, over(rgb, a, ep))));
    if (n < 4.5) failed++;
    rows.push({ 类别: 'banner', 主题: theme === 'dark' ? '深色屏' : '浅色屏', 选择器: '.' + cls, 填充: pct + '%', 对比度: n.toFixed(2), 判定: tag(n) });
  }
}

console.log('对比度审计 · 基底口径：chip 坐在卡片表面上 / banner 直接叠屏渐变 / 渐变两端取较差者\n');
console.table(rows);
console.log(failed === 0 ? '全部达标（≥ 4.5:1）' : `有 ${failed} 项低于 4.5:1，需修`);
process.exit(failed === 0 ? 0 : 1);
