/**
 * 对比度审计（tools/contrast-audit.mjs）
 *
 * 为什么有这个脚本：配色对比度问题在本项目被连续发现四次（状态色当文字色、告警红当文字色、
 * 降级横幅缺样式钩、次要文字色在 11–12px 下跌破门槛），共同特点是「测试全绿、肉眼才看得出」。
 * tests/contrast.test.mjs 只能压住**写法**（状态色不得出现在 color: 上），压不住**数值**。
 * 这个脚本补的就是数值这一半。
 *
 * 覆盖面（v2 起改为数据驱动）：
 *   不再手工罗列要审的选择器，而是解析 styles/app.css，**凡是声明了 color: 的规则全部纳入**。
 *   这样新增任何一条文字样式都会被自动发现 —— v1 只硬编码了 9 个选择器（chip×6 + banner×3），
 *   方位屏新增的 .card-note / .compass-hero-signed / .compass-mark / .compass-arrow 全部漏在外面，
 *   于是「18 项全达标」这句话只在它自己那 9 个选择器范围内成立，被误读成了全局结论。
 *
 * 基底口径（数字不可比的主因，改口径必须同步改这里）：
 *   · 文字的基底按「由下往上」合成：屏渐变 → 容器填色 → 自身填色。
 *   · 屏渐变有两端（--c-screen-a / --c-screen-b），一律取**较差的那一端**。
 *   · 浅色屏卡片填充是**不透明的 #ffffff**，与屏渐变无关（两端同值）。
 *   · 「不在卡片内」的少数区域由 BASE_OVERRIDES 声明（CSS 自身看不出 DOM 层级，只能显式声明）；
 *     其余一律按**卡片表面**算 —— 这是本项目绝大多数文字的落点，也是更常见的那一侧。
 *   · color-mix 按**预乘语义**展开（见 mixLayer），不是朴素 RGB 插值。
 *
 * 判定门槛：一律 4.5:1。WCAG 对「大字」放宽到 3:1，本工具**只认 18pt（24px）这一档**；
 *   「14pt bold」那条因 bold 无明确阈值定义（600 还是 700？规范没说），不采用 —— 宁可严，
 *   不给自己找台阶。唯一会落到 3:1 的是 24px 以上的大号数值。
 *
 * 字号口径（v15 起，无障碍字号三档）：styles/tokens.css 把八个 --fs-* 写成了
 *   `calc(<基准 px> × var(--fs-scale))`，本工具一律按**默认档**（--fs-scale: 1）折算。
 *   那是全档**最严**的口径（门槛随字号单调不升、对比度与字号无关），所以本节全绿
 *   在 large / xlarge 下同样成立 —— 完整推导见 pxOfToken() 的 JSDoc。
 *
 * 用法：node tools/contrast-audit.mjs
 * 退出码：有任何一项低于门槛时为 1（可接进 CI），全部达标为 0。
 */

import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const APP_CSS_PATH = 'styles/app.css';
// 注释整段换成等长空白（保留换行，行号不漂移）后再解析：注释里只要出现一句
// 「比如 --fs-scale: 1」这种长得像声明的文字，token() 的正则就会把它当成真声明，
// 取回一个根本不存在的值，而且不报错。
const tokens = readFileSync(new URL('styles/tokens.css', ROOT), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const appCssRaw = readFileSync(new URL(APP_CSS_PATH, ROOT), 'utf8');

/** 注释整体替换为空格但**保留换行**，这样行号不漂移（清单要报文件与行号） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const appCss = stripComments(appCssRaw);
const lineOf = (idx) => appCss.slice(0, idx).split('\n').length;

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
const tag = (n, min) => (n >= 7 ? 'AAA' : n >= min ? (min === 4.5 ? 'AA' : 'AA大字') : '✗不达标');
/** 门槛：只有 18pt（24px）及以上才适用 WCAG 的大字 3:1；14pt-bold 那条不采用（见文件头） */
const thresholdOf = (px) => (px >= 24 ? 3.0 : 4.5);

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
const MIX_RE = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+?)\s*\)$/;
/** 渐变 / 图片背景无法折算成单一底色：不静默当成透明，单独记下来在汇总里点名 */
const isFlatColor = (v) => !!v && !/gradient\(|url\(|image\(/.test(v);

/**
 * 把一个 CSS 颜色值（含 var() / color-mix / rgba / hex / transparent）解析成 {rgb, a}。
 * color-mix 按**预乘语义**展开：outA = p·aA + (1−p)·aB；outRGB = (p·aA·rgbA + (1−p)·aB·rgbB) / outA。
 * 这正是浏览器在 srgb 空间里对带透明分量做混合的方式，朴素 RGB 插值会算错底色。
 *
 * @param {string} value CSS 颜色值。
 * @param {'dark'|'light'} theme 主题。
 * @param {number} depth 递归深度（防循环引用）。
 * @returns {{rgb: number[], a: number}} 归一化后的颜色。
 */
function color(value, theme, depth = 0) {
  if (depth > 8) throw new Error('token 引用过深，可能循环');
  const v = value.trim();
  if (v === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return color(token(ref[1].slice(2), theme), theme, depth + 1);
  if (v.startsWith('#')) return { rgb: hx(v), a: 1 };
  const p = v.match(/rgba?\(([^)]+)\)/);
  if (p) {
    const n = p[1].split(',').map(Number);
    return { rgb: [n[0], n[1], n[2]], a: n.length > 3 ? n[3] : 1 };
  }
  const mix = v.match(MIX_RE);
  if (mix) {
    const a = color(mix[1], theme, depth + 1);
    const b = color(mix[3], theme, depth + 1);
    const p2 = Number(mix[2]) / 100;
    const outA = p2 * a.a + (1 - p2) * b.a;
    if (outA <= 0) return { rgb: [0, 0, 0], a: 0 };
    const premult = [0, 1, 2].map((i) => p2 * a.a * a.rgb[i] + (1 - p2) * b.a * b.rgb[i]);
    return { rgb: premult.map((c) => c / outA), a: outA };
  }
  throw new Error(`无法解析颜色: ${v}`);
}

const screenEnds = (theme) =>
  ['c-screen-a', 'c-screen-b'].map((k) => color(token(k, theme), theme).rgb);
/** 卡片表面：卡片填充叠在屏渐变上（浅色填充不透明，两端同值） */
const cardSurface = (theme) => {
  const fill = color(token('c-card-fill', theme), theme);
  return screenEnds(theme).map((ep) => over(fill.rgb, fill.a, ep));
};

// ---------- app.css 解析 ----------

/**
 * 把一段 CSS 解析成规则列表；@media / @supports 递归展开（保留 media 头以便区分基础规则），
 * @keyframes / @font-face 整体跳过（里面没有 color:）。
 *
 * @param {string} css 已去注释的 CSS 全文。
 * @param {number} start 起始下标。
 * @param {number} end 结束下标（不含）。
 * @param {string|null} media 外层 @media 头，顶层为 null。
 * @returns {Array<{selector: string, decls: Array<{prop: string, value: string, offset: number}>, bodyStart: number, media: string|null}>}
 */
function parseRules(css, start = 0, end = css.length, media = null) {
  const rules = [];
  let i = start;
  while (i < end) {
    const open = css.indexOf('{', i);
    if (open === -1 || open >= end) break;
    let depth = 0;
    let close = -1;
    for (let j = open; j < end; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') {
        depth--;
        if (depth === 0) { close = j; break; }
      }
    }
    if (close === -1) break;
    const head = css.slice(i, open).trim();
    const bodyStart = open + 1;
    i = close + 1;
    if (head.startsWith('@')) {
      if (/^@(media|supports)\b/.test(head)) rules.push(...parseRules(css, bodyStart, close, head));
      continue;
    }
    const decls = parseDecls(css.slice(bodyStart, close));
    for (const sel of head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean)) {
      rules.push({ selector: sel, decls, bodyStart, media });
    }
  }
  return rules;
}

/**
 * 解析声明块为 {prop, value, offset} 列表（offset 相对块首，用于回算行号）。
 *
 * @param {string} body 声明块内容（不含花括号）。
 * @returns {Array<{prop: string, value: string, offset: number}>}
 */
function parseDecls(body) {
  const out = [];
  let i = 0;
  while (i < body.length) {
    const semi = body.indexOf(';', i);
    const stop = semi === -1 ? body.length : semi;
    const chunk = body.slice(i, stop);
    const c = chunk.indexOf(':');
    if (c !== -1) {
      const prop = chunk.slice(0, c).trim();
      const value = chunk.slice(c + 1).trim();
      if (prop && value) out.push({ prop, value, offset: i });
    }
    if (semi === -1) break;
    i = semi + 1;
  }
  return out;
}

const rules = parseRules(appCss);
const declOf = (rule, prop) => rule.decls.find((d) => d.prop === prop) || null;
const compoundOf = (selector) => selector.split(/\s+/).filter(Boolean);

/**
 * 取一个字号 token 的 px 值（**默认档**口径）。
 *
 * 无障碍字号三档把八个 --fs-* 都写成了 `calc(<基准 px> × var(--fs-scale))`，所以这里
 * 必须认这个单一乘数形态，并把乘数按默认档（--fs-scale: 1）折算。
 *
 * ★为什么「按默认档算」是全档**最严**的口径（不是偷懒，是刻意选的）：
 *   WCAG 只在字号变大时**放宽**门槛（≥ 24px 走大字 3:1，其余 4.5:1），门槛随字号单调
 *   不升；而对比度数值本身与字号无关（同一对颜色，放大到哪儿都是那个比值）。
 *   所以在默认档算出来达标的配色，在任何放大档下都达标 —— 反过来不成立。
 *   也就是说：本节全绿在默认档成立，在 large / xlarge 下同样成立。
 */
function pxOfToken(name) {
  const raw = token(name, 'dark');
  const calc = String(raw).match(/^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/i);
  if (calc) {
    const base = parseFloat(calc[1]);
    const mul = parseFloat(token(calc[2], 'dark'));
    if (!Number.isFinite(base) || !Number.isFinite(mul)) throw new Error(`无法解析字号 token: --${name} = ${raw}`);
    return base * mul;
  }
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) throw new Error(`无法解析字号 token: --${name} = ${raw}`);
  return n;
}

/** 字号变量 / calc(…) / 字面 px → px；解析不出来抛错（宁可炸，不要静默按 14px 放过） */
function pxOf(value) {
  const v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return pxOfToken(ref[1].slice(2));
  // app.css 里少数几处（如 .map-cell-x）直接写 `calc(24px * var(--fs-scale))` 而不是
  // 引用某个 --fs-* —— 它们同样要按默认档折算，口径与 pxOfToken 一致。
  const calc = v.match(/^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/i);
  if (calc) {
    const base = parseFloat(calc[1]);
    const mul = parseFloat(token(calc[2], 'dark'));
    if (!Number.isFinite(base) || !Number.isFinite(mul)) throw new Error(`无法解析字号: ${v}`);
    return base * mul;
  }
  const m = v.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (m) return parseFloat(m[1]);
  throw new Error(`无法解析字号: ${v}`);
}

/**
 * 解析一条规则的字号：自己声明的优先；否则按「类族最长前缀」找最近的祖先规则；
 * 都没有则落到 body 的 14px。@media 里的覆盖不参与（审计按基础样式算）。
 *
 * @param {object} rule 规则。
 * @returns {number} 字号（px）。
 */
function fontSizePx(rule) {
  const own = declOf(rule, 'font-size');
  if (own) return pxOf(own.value);
  const parts = compoundOf(rule.selector);
  let best = null;
  for (let k = parts.length - 1; k >= 0; k--) {
    const part = parts[k];
    for (const r of rules) {
      if (r.media) continue;
      const d = declOf(r, 'font-size');
      if (!d) continue;
      if (part.startsWith(r.selector) && (!best || r.selector.length > best.selector.length)) best = r;
    }
    if (best) break;
  }
  return best ? pxOf(declOf(best, 'font-size').value) : pxOf('var(--fs-md)');
}

// ---------- 结构声明：CSS 自身看不出 DOM 层级，只能显式声明「不在卡片内」的少数区域 ----------
/* 这是一张**结构表**（容器归属），不是审计项清单 —— 审计项由上面的自动扫描得出。
   新增组件若不在卡片内，需在此登记；漏登记的代价是按更常见的「卡片表面」计算。 */
const BASE_OVERRIDES = [
  // —— 直接叠屏渐变：既不在卡片内，自身也没有填色 ——
  ['body', 'screen'],            // 兜底正文
  ['.hd', 'screen'],             // 顶部标题区（.hd-place / .hd-coord / .hd-time）
  ['.skeleton-note', 'screen'],  // 骨架提示，直接在 #app 上
  ['.tab', 'screen'],            // Tab 在 .tabbar 里（.tabbar 更长，先命中；填色由 CONTAINER_OF 补上）
  ['.tabbar', 'screen'],         // 浮动玻璃条
  ['.banner', 'screen'],         // 降级横幅不在卡片里
  ['.about', 'screen'],          // 页脚（.about / .about-title / .about-list strong）
  ['.empty', 'screen'],          // 空态是虚线框，无填色
  ['.sc-title', 'screen'], ['.sc-sub', 'screen'], ['.sc-h2', 'screen'], ['.sc-dedupe', 'screen'],
  // —— 自带填色、且不在别的卡片内：填色由「自身填色」那一层补，基底仍按屏算 ——
  ['.sc-summary', 'screen'], ['.sc-log', 'screen'],
  /* 两个坑，都是「前缀匹配贪心」踩出来的，改这张表时必须一起想：
     ① 不能写 '.sc-' 通配符：自检页整页确实不在卡片里，但 .sc-row-* 坐在 .sc-row 自带的那层
        卡片填色上，通配符会把它们误判成「直接叠屏」，少算一层、数字虚高（5.41 → 实测 4.41）。
     ② 也不能写 '.sc-row'：它会把 .sc-row-metrics / .sc-row-url 一起带跑，同样少算一层。
        所以这里只登记**自身被审计**的 .sc-summary / .sc-log，其余交给默认「卡片表面」。 */
].sort((a, b) => b[0].length - a[0].length);

/* 少数处：文字所在的**父容器**自带填色，且该父容器不在自己的选择器里（CSS 看不出来）。 */
const CONTAINER_OF = [
  ['.compass-mark', '.compass-dial'],  // N/E/S/W 压在盘面（8% 品牌色）上
  ['.seg-btn', '.seg'],                // 分段按钮压在 .seg 的卡片填色上
  ['.prov-url', '.prov-item'],         // 溯源 URL 压在气泡填色上
  ['.tab', '.tabbar'],                 // Tab 压在玻璃底上
].sort((a, b) => b[0].length - a[0].length);

const baseOf = (sel) => {
  for (const [p, b] of BASE_OVERRIDES) if (sel.startsWith(p)) return b;
  return 'card';
};
const containerOf = (sel) => {
  for (const [p, c] of CONTAINER_OF) if (sel.startsWith(p) && c !== sel) return c;
  return null;
};

// ---------- 语义标注：这段字承载的是必要信息还是纯装饰 ----------
/* 无法从 CSS 自动推导，只能人工判断；**未列出的默认按「必要」**（保守方向）。
   本标注不参与判定，只出现在不达标清单里，供拍板时排优先级。 */
const ROLE = {
  '.compass-arrow': ['装饰', '箭头「→」：方向已由输入框前的 .field-label（真方位/磁方位）与输出值的位置自解释，缺它仍能读懂'],
  '.compass-hero-signed': ['半装饰', '有符号原始值：方向语义已被同行 .compass-hero-num 的「西偏/东偏」完整承载，此处是同一数值的另一种写法'],
  '.compass-mark': ['必要', '盘面 N/E/S/W：罗盘唯一的方位锚点，缺了盘面无法定向'],
  '.hero-temp .unit': ['必要', '单位符号 °C：缺了温度数值无法解读'],
};
const roleOf = (sel) => ROLE[sel] || ['必要', '未标注者一律按「承载必要信息」处理（保守方向）'];

/* 方位屏本轮新增的 4 处 var(--c-text-3)（app.css 638/666/689/741 行）：
   这里用**选择器**而不是行号做标记 —— 行号会随任何一处插入漂移，选择器不会。 */
const NEW_THIS_ROUND = ['.card-note', '.compass-hero-signed', '.compass-mark', '.compass-arrow'];

// ---------- v1 遗留的 9 个选择器：回归护栏，不是审计项来源 ----------
/* v1 只审这 9 个 × 2 主题 = 18 项。v2 起它们只是全量扫描里的普通成员，
   这里额外断言「自动扫描确实把它们都覆盖到了」，防止扫描逻辑哪天漏掉既有审计项。 */
const LEGACY_SELECTORS = [
  '.chip--ok', '.chip--stale', '.chip--degraded', '.chip--offline', '.chip--failed', '.chip--idle',
  '.banner--grid', '.banner--partial', '.banner--empty',
];

/* ---------- 曾经不达标、靠压深色值修好的小字：同样钉住「一直被扫描到」 ---------- */
/* 这两个是 11–12px 的 `--c-text-3`（历史数字 4.41 / 3.51 见 tokens.css 那条注释，
   现值为 5.95 / 5.36）。它们不在 v1 的 9 项里，却是最容易「被人改回去」的一类：
   小字 + 次要色，改的人觉得只是淡了一点点。钉住覆盖率，扫描逻辑哪天漏掉它们、
   或色值被改回旧值，这里都要报 —— 否则又是靠人肉发现。 */
const PATCHED_SELECTORS = ['.card-note', '.compass-hero-signed'];

// ---------- 组装审计项 ----------
/**
 * 合成文字的实际基底：屏渐变 → 容器填色 → 自身填色（自下而上）。
 *
 * @param {'dark'|'light'} theme 主题。
 * @param {string} base 'card' | 'screen'。
 * @param {string|null} containerFill 父容器填色的 CSS 值。
 * @param {string|null} ownFill 自身填色的 CSS 值。
 * @returns {number[]} 合成后的不透明底色。
 */
function stack(theme, base, containerFill, ownFill) {
  const bottoms = base === 'screen' ? screenEnds(theme) : cardSurface(theme);
  return bottoms.map((b) => {
    let cur = b;
    for (const v of [containerFill, ownFill]) {
      if (!v) continue;
      const L = color(v, theme);
      cur = over(L.rgb, L.a, cur);
    }
    return cur;
  });
}

/**
 * 实测某条规则在两个主题下的最差对比度。
 *
 * @param {'dark'|'light'} theme 主题。
 * @param {object} item 审计项。
 * @returns {number} 对比度（渐变两端取较差者）。
 */
function measure(theme, item) {
  const text = color(item.colorValue, theme).rgb;
  return Math.min(...stack(theme, item.base, item.containerFill, item.ownFill).map((bg) => contrast(text, bg)));
}

const items = [];
const unflat = [];
for (const rule of rules) {
  const cd = declOf(rule, 'color');
  if (!cd) continue;
  const container = containerOf(rule.selector);
  const containerRule = container ? rules.find((r) => r.selector === container && !r.media) : null;
  const rawContainerFill = containerRule ? (declOf(containerRule, 'background') || {}).value || null : null;
  const rawOwn = declOf(rule, 'background');
  const rawOwnFill = rawOwn ? rawOwn.value : null;
  // 渐变/图片底不折算：记下来点名，避免「算不出来就当透明」这种静默降级
  if (rawContainerFill && !isFlatColor(rawContainerFill)) unflat.push(`${rule.selector} ← 容器 ${container}`);
  if (rawOwnFill && !isFlatColor(rawOwnFill)) unflat.push(`${rule.selector} ← 自身`);
  items.push({
    selector: rule.selector,
    line: lineOf(rule.bodyStart + cd.offset),
    colorValue: cd.value,
    px: fontSizePx(rule),
    base: baseOf(rule.selector),
    container: container || '',
    containerFill: isFlatColor(rawContainerFill) ? rawContainerFill : null,
    ownFill: isFlatColor(rawOwnFill) ? rawOwnFill : null,
  });
}

const rows = [];
const failures = [];
for (const item of items) {
  const dark = measure('dark', item);
  const light = measure('light', item);
  const min = thresholdOf(item.px);
  const bad = dark < min || light < min;
  const [role, why] = roleOf(item.selector);
  const row = {
    选择器: item.selector,
    行: `${APP_CSS_PATH}:${item.line}`,
    文字色: item.colorValue.replace('var(--', '').replace(')', ''),
    字号: `${item.px}px`,
    基底: item.base === 'screen' ? '屏渐变' : '卡片表面',
    深色屏: dark.toFixed(2),
    浅色屏: light.toFixed(2),
    门槛: min.toFixed(1),
    判定: bad ? '✗不达标' : tag(Math.min(dark, light), min),
    归属: NEW_THIS_ROUND.includes(item.selector) ? '本轮新增' : '既有',
    角色: role,
    _why: why,
  };
  rows.push(row);
  if (bad) failures.push(row);
}

// ---------- 输出 ----------
const scanned = new Set(items.map((i) => i.selector));
const missingLegacy = LEGACY_SELECTORS.filter((s) => !scanned.has(s));
const legacyBad = failures.filter((r) => LEGACY_SELECTORS.includes(r.选择器)).length;
const missingPatched = PATCHED_SELECTORS.filter((s) => !scanned.has(s));
const patchedBad = failures.filter((r) => PATCHED_SELECTORS.includes(r.选择器)).length;

console.log('对比度审计 · 数据驱动全量扫描');
console.log(`基底口径：屏渐变两端取较差者 → 容器填色 → 自身填色；color-mix 按预乘语义展开`);
console.log(`扫描范围：${APP_CSS_PATH} 中全部 ${items.length} 条 color: 声明（v1 只覆盖硬编码的 9 个选择器）\n`);

console.log('—— 全量清单 ——');
console.table(rows.map((r) => ({
  选择器: r.选择器, 行: r.行, 文字色: r.文字色, 字号: r.字号, 基底: r.基底,
  深色屏: r.深色屏, 浅色屏: r.浅色屏, 门槛: r.门槛, 判定: r.判定, 归属: r.归属,
})));

if (failures.length) {
  console.log(`\n—— 不达标清单（${failures.length} 条）——`);
  console.table(failures.map((r) => ({
    选择器: r.选择器, 行: r.行, 文字色: r.文字色, 字号: r.字号,
    深色屏: r.深色屏, 浅色屏: r.浅色屏, 门槛: r.门槛,
    角色: r.角色, 归属: r.归属,
  })));
  console.log('\n—— 角色判定理由 ——');
  for (const r of failures) console.log(`  ${r.选择器.padEnd(24)} ${r.角色}　${r._why}`);
}

console.log('\n—— 汇总 ——');
const newBad = failures.filter((r) => r.归属 === '本轮新增').length;
const oldBad = failures.length - newBad;
console.log(`全量：${items.length} 条，不达标 ${failures.length} 条（本轮新增 ${newBad} / 既有 ${oldBad}）`);
console.log(`既有 18 项护栏：${missingLegacy.length === 0 ? 9 - legacyBad : 0}/9 选择器被自动扫描命中` +
  ` → ${2 * (9 - legacyBad)}/18 项达标${missingLegacy.length ? `（漏扫描：${missingLegacy.join(', ')}）` : ''}`);
console.log(`曾不达标的小字护栏：${PATCHED_SELECTORS.length - missingPatched.length - patchedBad}` +
  `/${PATCHED_SELECTORS.length} 选择器被扫描到且达标` +
  `${missingPatched.length ? `（漏扫描：${missingPatched.join(', ')}）` : ''}` +
  `${patchedBad ? `（不达标：${failures.filter((r) => PATCHED_SELECTORS.includes(r.选择器)).map((r) => r.选择器).join(', ')}）` : ''}`);
if (unflat.length) {
  console.log(`\n未折算的渐变/图片底（${unflat.length} 处，按「无额外填色」处理，非静默当透明）：`);
  for (const u of unflat) console.log(`  · ${u}`);
}

if (missingLegacy.length) {
  console.error(`\n自动扫描漏掉了 v1 既有的审计项：${missingLegacy.join(', ')}`);
  process.exit(1);
}
if (missingPatched.length) {
  console.error(`\n自动扫描漏掉了「曾不达标、靠压深修好」的小字：${missingPatched.join(', ')}`);
  process.exit(1);
}
if (patchedBad) {
  console.error('\n「曾不达标」的小字又掉到门槛以下了（多半是 --c-text-3 被改回旧值）');
  process.exit(1);
}
console.log(failures.length === 0 ? '\n全部达标' : `\n有 ${failures.length} 条低于门槛，需修`);
process.exit(failures.length === 0 ? 0 : 1);
