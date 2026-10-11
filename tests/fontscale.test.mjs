/**
 * 无障碍字号三档回归（<html data-fs> + tokens.css 乘数）
 *
 * 背景：主题那一轮的教训是「写错不报错、也不让任何既有用例变红，只会让用户看到错的东西」。
 * 字号档位有同一个毛病，而且**更隐蔽一档**：光把 `applyFontScale()` 写对还不够 ——
 * 真正决定「字有没有变大」的是 styles/tokens.css 里那两个乘数。JS 写对了而 CSS 没跟上，
 * 界面上就是「点了特大，一个像素都没动」，而所有只测 JS 的用例依然是全绿。
 *
 * 所以本文件分两半：
 *   ① JS 侧：属性落得对不对（与 tests/theme.test.mjs 同构）；
 *   ② CSS 侧：**独立再解析一遍 tokens.css**，算出三档下每个 --fs-* 的实际 px，
 *      断言默认档与基线逐值相等、放大档确实放大。这一段刻意不复用 tools/check.mjs
 *      的解析器 —— 两个独立实现算出同一个数，才是「真的生效」而不是「一个实现自证」。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeDom, installNavigator, installStorage, FakeStorage, uninstallDom } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

installStorage(new FakeStorage());
installNavigator({ online: true });
// 'app' 是设置页的挂载点（_renderPage 往里塞卡片）。
// ★'font-scale' 与 'font-result' 必须预置：假 DOM 的 getElementById 只认预置 id，而
//   _bindSeg / _setStatus 走的正是 getElementById。不预置的话监听根本挂不上，
//   测试会变成「点了没反应还说通过了」—— 那比没有这条用例更糟。
//   注意分辨两颗同 id 的节点：预置那颗挂着事件监听，_renderPage 造的那颗装着三个按钮
//   （真实浏览器里是同一颗，假 DOM 的索引表做不到），详见端到端那个用例。
const dom = createFakeDom([{ id: 'app' }, { id: 'font-scale' }, { id: 'font-result' }]);
/** 字号档位写在 <html> 上，即 document.documentElement。 */
const root = dom.html;

// 必须在 import 被测模块**之前**装好全局（store.js 在加载期决定走内存还是 localStorage）
const { setFontScale, getFontScale, replaceState } = await import('../src/core/store.js');
const { applyFontScale } = await import('../src/ui/theme.js');
const { FONT_SCALES, init } = await import('../src/ui/settings.js');

/** 预置脚本读的键（与 core/cache.js 的 NS + makeKey('store','prefs') 一致）。 */
const PREFS_KEY = 'gs:v1:store:prefs';

/**
 * 取 <html data-fs> 当前值（无属性时为 null）。
 *
 * @returns {string|null} 属性值。
 */
function fsAttr() {
  return root.getAttribute('data-fs');
}

beforeEach(() => {
  setFontScale('normal');
  applyFontScale('normal');
});

/* ------------------------------------------------------------------ */
/* ① JS 侧：属性落得对不对                                              */
/* ------------------------------------------------------------------ */

test('applyFontScale(large) → <html data-fs="large">', () => {
  assert.equal(applyFontScale('large'), 'large');
  assert.equal(fsAttr(), 'large');
});

test('applyFontScale(xlarge) → <html data-fs="xlarge">', () => {
  assert.equal(applyFontScale('xlarge'), 'xlarge');
  assert.equal(fsAttr(), 'xlarge');
});

test('applyFontScale(normal) → 属性被移除（默认档不设属性，与 data-theme 的 system 同构）', () => {
  applyFontScale('xlarge');
  assert.equal(fsAttr(), 'xlarge');
  assert.equal(applyFontScale('normal'), 'normal');
  assert.equal(fsAttr(), null);
  assert.equal(root.hasAttribute('data-fs'), false);
});

test('非法值钳位为 normal（宁可回到默认字号，也不写 CSS 认不出来的值）', () => {
  applyFontScale('xlarge');
  assert.equal(applyFontScale('超大'), 'normal');
  assert.equal(fsAttr(), null);
  setFontScale('XLARGE');
  assert.equal(getFontScale(), 'normal');
  setFontScale(undefined);
  assert.equal(getFontScale(), 'normal');
});

test('setFontScale(xlarge) 经 applyFontScale 落到 <html>：xlarge', () => {
  setFontScale('xlarge');
  assert.equal(getFontScale(), 'xlarge');
  assert.equal(applyFontScale(getFontScale()), 'xlarge');
  assert.equal(fsAttr(), 'xlarge');
});

test('档位真的写进了 localStorage（刷新后仍在，不是只在内存里）', () => {
  setFontScale('large');
  const raw = localStorage.getItem(PREFS_KEY);
  assert.ok(raw, `偏好应写在 ${PREFS_KEY} 下`);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v.fontScale, 'large', 'cache.js 的载荷形状是 { v, t, ttl }');
});

test('FONT_SCALES 三档顺序固定（界面顺序即数组顺序）', () => {
  assert.deepEqual(FONT_SCALES, ['normal', 'large', 'xlarge']);
  for (const s of FONT_SCALES) {
    assert.equal(applyFontScale(s), s);
    setFontScale(s);
    assert.equal(getFontScale(), s, `${s} 存进去再读出来必须还是它自己`);
  }
});

test('导入备份不会把本机字号抹回默认（fontScale 不在备份里，与 themeMode 同一条规矩）', () => {
  setFontScale('xlarge');
  // applyBackup 走的就是 replaceState 这条路：它只带 5 个字段，不带 fontScale
  replaceState({
    defaultPlace: { lat: 31.2304, lon: 121.4737, name: '上海' },
    unitSystem: 'metric',
    networkType: 'unknown',
    debug: false,
    favorites: [],
  });
  assert.equal(getFontScale(), 'xlarge', '导入一次备份就把字号清掉，用户会以为应用坏了');
});

test('四个手写页面的 <head> 都有字号预置脚本（漏一页就先跳一帧默认字号）', () => {
  for (const p of ['index.html', 'selfcheck.html', 'compass.html', 'settings.html']) {
    const src = fs.readFileSync(path.resolve(ROOT, p), 'utf8');
    assert.ok(src.indexOf('data-fs') !== -1, `${p} 缺字号档位预置脚本`);
    assert.ok(src.indexOf(PREFS_KEY) !== -1, `${p} 预置脚本读的键不是 ${PREFS_KEY}`);
  }
});

/* ------------------------------------------------------------------ */
/* ② CSS 侧：独立再算一遍乘数（不复用 tools/check.mjs 的解析器）          */
/* ------------------------------------------------------------------ */

/** 去注释后的 tokens.css（注释里一句「--fs-scale: 1」就能骗过正则解析器）。 */
const TOKENS = fs
  .readFileSync(path.resolve(ROOT, 'styles/tokens.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

/**
 * 取某个选择器块（从锚点后第一个 `{` 到它配对的第一个 `}`）。
 *
 * @param {string} css CSS 源码。
 * @param {string} anchor 选择器锚点。
 * @returns {string|null} 声明体。
 */
function blockOf(css, anchor) {
  const i = css.indexOf(anchor);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  return css.slice(open + 1, close);
}

const ROOT_BLOCK = blockOf(TOKENS, ':root {');
const LARGE_BLOCK = blockOf(TOKENS, ":root[data-fs='large']");
const XLARGE_BLOCK = blockOf(TOKENS, ":root[data-fs='xlarge']");

/**
 * 取块内某个自定义属性的声明值原文。
 *
 * @param {string} block 声明体。
 * @param {string} name 变量名（不含 `--`）。
 * @returns {string|null} 值原文。
 */
function declOf(block, name) {
  const m = String(block || '').match(new RegExp(`(?:^|\\n)\\s*--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

/**
 * 解析 `calc(<N>px * var(--<mul>))` 的形状。
 *
 * @param {string} v 值原文。
 * @returns {{base:number, mul:string}|null} 基准与乘数名。
 */
function calcOf(v) {
  const m = String(v || '').match(/^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/);
  return m ? { base: parseFloat(m[1]), mul: m[2] } : null;
}

/**
 * 算出某个字号 token 在指定档位下的实际 px。
 *
 * @param {string} name token 名（'fs-md'）。
 * @param {string|null} tierBlock 档位块声明体；null = 默认档（读 :root 里的乘数）。
 * @returns {number} px。
 */
function fsPx(name, tierBlock) {
  const calc = calcOf(declOf(ROOT_BLOCK, name));
  assert.ok(calc, `--${name} 不是 calc(<px> × var(--<乘数>)) 形状，放大档对它无效`);
  const mulRaw = tierBlock ? declOf(tierBlock, calc.mul) : declOf(ROOT_BLOCK, calc.mul);
  const mul = parseFloat(mulRaw);
  assert.ok(Number.isFinite(mul), `--${calc.mul} 在${tierBlock ? '该档位' : '默认档'}下不可解析：${mulRaw}`);
  return calc.base * mul;
}

/** 八个字号 token 的**回归基线**（加 --fs-scale 之前的实测值）。 */
const BASELINE = { 'fs-xs': 11, 'fs-sm': 12, 'fs-md': 14, 'fs-lg': 16, 'fs-xl': 20, 'fs-2xl': 26, 'fs-hero': 56, 'fs-hero-sm': 40 };

test('三档的乘数块都在 tokens.css 里（缺一块，那一档就只是「写了 JS」）', () => {
  assert.ok(ROOT_BLOCK, '解析不到主 :root 块');
  assert.ok(LARGE_BLOCK, "解析不到 :root[data-fs='large'] 块");
  assert.ok(XLARGE_BLOCK, "解析不到 :root[data-fs='xlarge'] 块");
});

test('默认档：八个 --fs-* 的计算值与基线逐值相等（一个像素都不许变）', () => {
  for (const [name, base] of Object.entries(BASELINE)) {
    const v = fsPx(name, null);
    assert.ok(Math.abs(v - base) < 1e-9, `--${name} 默认档应为 ${base}px，实际 ${v}px`);
  }
});

test('large 档：八个 --fs-* 全部放大到 1.15 倍', () => {
  for (const [name, base] of Object.entries(BASELINE)) {
    if (name.indexOf('hero') !== -1) continue; // 英雄区走单独的、更小的乘数，下面单独断言
    const v = fsPx(name, LARGE_BLOCK);
    assert.ok(Math.abs(v - base * 1.15) < 1e-9, `--${name} 应为 ${base * 1.15}px，实际 ${v}px`);
  }
});

test('xlarge 档：正文类 --fs-* 放大到 1.3 倍（--fs-md：14px → 18.2px）', () => {
  assert.ok(Math.abs(fsPx('fs-md', XLARGE_BLOCK) - 18.2) < 1e-9, `--fs-md 应为 18.2px，实际 ${fsPx('fs-md', XLARGE_BLOCK)}px`);
  for (const [name, base] of Object.entries(BASELINE)) {
    if (name.indexOf('hero') !== -1) continue;
    const v = fsPx(name, XLARGE_BLOCK);
    assert.ok(Math.abs(v - base * 1.3) < 1e-9, `--${name} 应为 ${base * 1.3}px，实际 ${v}px`);
  }
});

test('英雄区放得比正文慢，且仍真的放大了（xlarge：56px → 64.4px，不是 72.8px）', () => {
  const hero = fsPx('fs-hero', XLARGE_BLOCK);
  assert.ok(Math.abs(hero - 64.4) < 1e-9, `--fs-hero 应为 56 × 1.15 = 64.4px，实际 ${hero}px`);
  assert.ok(hero > 56, '英雄区也必须有可见的放大');
  assert.ok(hero < 56 * 1.3, '英雄区不许按正文的 1.3 放大（窄屏会挤坏，见 tokens.css 注释）');
  const heroLarge = fsPx('fs-hero', LARGE_BLOCK);
  assert.ok(Math.abs(heroLarge - 61.6) < 1e-9, `--fs-hero 在 large 档应为 61.6px，实际 ${heroLarge}px`);
  // 两档的单调性：default < large < xlarge，且每一档都比正文慢
  assert.ok(56 < heroLarge && heroLarge < hero, '英雄区三档必须单调递增');
  assert.ok(heroLarge < 56 * 1.15, 'large 档英雄区也必须比正文慢');
});

test('styles/app.css 不再有裸 px 的 font-size（切档时它们纹丝不动就会对不齐）', () => {
  const css = fs
    .readFileSync(path.resolve(ROOT, 'styles/app.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const bad = [];
  for (const m of css.matchAll(/(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g)) {
    const v = m[1].trim();
    const ok =
      /^var\(\s*--fs-[a-z0-9-]+\s*\)$/.test(v) ||
      /^calc\(\s*-?\d+(?:\.\d+)?px\s*\*\s*var\(\s*--fs-[a-z0-9-]+\s*\)\s*\)$/.test(v);
    if (!ok) bad.push(v);
  }
  assert.deepEqual(bad, [], `app.css 里出现了不跟档位走的字号：${bad.join(' | ')}`);
});

/* ------------------------------------------------------------------ */
/* ③ 端到端：渲染「我的」页 → 点「特大」→ 属性与反馈一起变                  */
/* ------------------------------------------------------------------ */

test('端到端：设置页渲染出三档，点「特大」后 <html data-fs> 与反馈文案同步生效', async () => {
  init();

  // 监听挂在这颗**预置**节点上（_bindSeg 走 getElementById）
  const seg = dom.byId['font-scale'];
  assert.ok(seg, '没取到 #font-scale 容器，事件委托无处可挂');
  // 三个按钮在 _renderPage 造的那颗同 id 节点里 —— 从 #app 子树里按 data-value 认出来
  // （主题卡那三颗的取值是 system/light/dark，与字号的 normal/large/xlarge 不重叠）
  const buttons = dom.byId.app
    .querySelectorAll('.seg-btn')
    .filter((b) => FONT_SCALES.indexOf(b.getAttribute('data-value')) !== -1);
  assert.equal(buttons.length, 3, '字号卡必须有且只有三档按钮');
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('data-value')),
    ['normal', 'large', 'xlarge'],
    '界面顺序必须与 FONT_SCALES 一致'
  );

  // 假 DOM 的 FakeNode 没有 closest()，而 _bindSeg 的事件委托靠它命中按钮 ——
  // 这里只给这三颗按钮补一个最小实现（生产代码一行不改），否则点击会被静默丢掉。
  buttons.forEach((b) => {
    b.closest = (sel) => (sel === '.seg-btn' && b.classList.contains('seg-btn') ? b : null);
  });

  assert.equal(fsAttr(), null, '刚渲染完应是默认档（没有属性）');
  // 事件监听挂在容器上，靠 ev.target 定位到按钮 —— 这正是 _bindSeg 的写法
  await seg.fire('click', { target: buttons[2], preventDefault() {} });

  assert.equal(getFontScale(), 'xlarge', 'store 必须记住用户的选择');
  assert.equal(fsAttr(), 'xlarge', '<html data-fs> 必须立刻跟上（否则这一页白点）');
  assert.equal(
    dom.byId['font-result'].textContent,
    '字号已切换为「特大」',
    '点完要有反馈，用户才知道有没有生效'
  );

  // 再点回「默认」：属性必须被移除，而不是留一个 "normal"
  await seg.fire('click', { target: buttons[0], preventDefault() {} });
  assert.equal(getFontScale(), 'normal');
  assert.equal(fsAttr(), null, '默认档必须是移除属性，与 data-theme 的 system 同构');
});

test('无 document 时是空操作，不抛（Node 侧静态检查会 import 本模块）', () => {
  uninstallDom();
  try {
    assert.equal(applyFontScale('large'), 'large');
    assert.equal(applyFontScale('normal'), 'normal');
  } finally {
    // 本用例放最后，恢复只为保持全局干净
    createFakeDom([{ id: 'app' }, { id: 'font-result' }]);
  }
});
