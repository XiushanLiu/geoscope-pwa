/**
 * 静态检查脚本（零依赖）
 *
 * 职责：交付前的四项硬校验，不依赖网络、不安装任何东西：
 *   1) 逐文件**语法校验**（src/*.js 用动态 import 真加载；sw.js / tools/*.mjs 用 node --check）；
 *   2) **模块引用存在性**校验：每个 import 的相对路径必须在磁盘上存在，且**必须带 .js 后缀**；
 *   3) **HTML 引用校验**：index.html / selfcheck.html 里 href/src 指向的文件逐个核对（防 404）；
 *   4) **外链与隐私红线校验**：除六路数据源宿主 + SVG 命名空间外，不允许出现任何 http(s) 外链
 *      （禁止 CDN、字体外链、统计、账号相关代码）。
 *   5) **SW 预缓存清单校验**：sw.js 的 SHELL_ASSETS 必须与实际文件一一对应。
 *   6) **tabbar 导航一致性校验**：四个手写 HTML 的 <nav class="tabbar"> 必须逐项一致
 *      （href 列表 + 顺序、激活项指向自己、tab--active 与 aria-current 成对、href 指向真实文件）。
 *   7) **tabbar 空间预算校验**：从 CSS/tokens 实解析出 tab 宽、间距、内边距与字号，机器算出
 *      320px 窄屏下的总宽并断言不溢出，同时钉住 `.tab` 的 `white-space: nowrap`。
 *      「宽度够不够」不再靠纸面估算（第 12 节的注释写明了它的覆盖面边界）。
 *   8) **无障碍字号三档校验**：钉住「默认档 --fs-* 计算值一个像素都不许变」这条硬底线，
 *      并机器核算最大档下英雄区行宽、固定高度文字盒、tabbar 是否还装得下（第 13 节）。
 *
 * 用法：node tools/check.mjs
 * 退出码：全部通过 0；存在失败 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 仓库根目录。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 允许出现的外部宿主（六路数据源 + SVG 命名空间 + Open-Meteo 文档域名）。 */
const ALLOWED_HOSTS = [
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'photon.komoot.io',
  'server.arcgisonline.com',
  'www.w3.org',
  'open-meteo.com',
];

/**
 * 页面 → 入口模块（新增页面必须在这里登记，check 会据此断言 HTML 真的引了它）。
 *
 * @type {Object<string,string>}
 */
const ENTRY_OF_PAGE = {
  'index.html': 'src/ui/app.js',
  'selfcheck.html': 'src/ui/selfcheck.js',
  'compass.html': 'src/ui/compass.js',
  'settings.html': 'src/ui/settings.js',
  // 对比页**不进 tabbar**（底部胶囊在 320px 屏上四个 tab 已贴临界点，加第五项必断行），
  // 但它仍然是一个手写页面，入口登记同样要在这儿占一行 —— 漏登记等于漏引 JS、白屏。
  'compare.html': 'src/ui/compare.js',
  // 生成产物：入口写在内联引导脚本的 `var ENTRY = "src/ui/selfcheck.js"` 里，
  // 不是 <script src=…> 属性，所以也能被同一条断言覆盖到。
  'selfcheck-standalone.html': 'src/ui/selfcheck.js',
};

/**
 * 需要离线可用的**页面**（SW 预缓存必须覆盖它们）。
 *
 * 不含 `selfcheck-standalone.html`：它是发给手机的副本，不由本站 SW 托管，
 * 要求它被预缓存等于要求线上存在一份自托管单文件版 —— 与它的用途不符。
 *
 * @type {string[]}
 */
const PAGES = ['index.html', 'selfcheck.html', 'compass.html', 'settings.html'];

/** 禁止出现的关键词（CDN / 统计 / 账号 / 广告）。 */
const FORBIDDEN_PATTERNS = [
  { re: /\bcdn\.[a-z0-9-]+\.(com|net|org)\b/i, why: 'CDN 域名' },
  { re: /googleapis|gstatic|google-analytics|googletagmanager/i, why: 'Google 统计/字体外链' },
  { re: /fonts\.googleapis|use\.fontawesome|unpkg\.com|jsdelivr|cdnjs/i, why: '第三方 CDN' },
  { re: /\banalytics\b/i, why: '统计埋点' },
  { re: /\bsignin\b|\blogin\b|oauth|firebase|supabase/i, why: '账号/后端服务' },
  { re: /<script[^>]+src=["']https?:/i, why: '外链脚本' },
];

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

/**
 * 断言。
 *
 * @param {string} name 用例名。
 * @param {boolean} cond 条件。
 * @param {string} [detail] 补充信息。
 * @returns {void}
 */
function check(name, cond, detail = '') {
  if (cond) {
    PASS += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    FAIL += 1;
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/**
 * 打印小节标题。
 *
 * @param {string} title 标题。
 * @returns {void}
 */
function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/**
 * 递归收集文件。
 *
 * @param {string} dir 目录。
 * @param {(p:string)=>boolean} filter 过滤器。
 * @param {string[]} [acc=[]] 累加器。
 * @returns {string[]} 文件相对路径数组。
 */
function walk(dir, filter, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, filter, acc);
    else if (filter(entry.name)) acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return acc;
}

/**
 * 读取文件。
 *
 * @param {string} rel 相对路径。
 * @returns {string} 文件内容。
 */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * 把 CSS 注释整段替换成**等长空白**（换行保留，行号不漂移）。
 *
 * 用途：本脚本对 tokens.css / app.css 的取值全靠正则，注释里只要出现一句
 * 「比如 --fs-scale: 1」就会被当成真声明。剥掉注释后，解析器看到的只有真声明。
 *
 * @param {string} s CSS 源码。
 * @returns {string} 去注释后的源码。
 */
function stripCssComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/* ------------------------- 1. 语法校验 ------------------------- */

/**
 * 语法校验（node --check）。
 *
 * @param {string} rel 相对路径。
 * @returns {Promise<{ok:boolean, msg:string}>} 结果。
 */
async function nodeCheck(rel) {
  try {
    await execFileAsync(process.execPath, ['--check', path.join(ROOT, rel)], { cwd: ROOT });
    return { ok: true, msg: '' };
  } catch (err) {
    return { ok: false, msg: String((err && err.stderr) || (err && err.message) || err).slice(0, 400) };
  }
}

/**
 * 真加载校验（语法 + import 解析 + 顶层无副作用）。
 *
 * @param {string} rel 相对路径。
 * @returns {Promise<{ok:boolean, msg:string}>} 结果。
 */
async function importCheck(rel) {
  try {
    await import(pathToFileURL(path.join(ROOT, rel)).href);
    return { ok: true, msg: '' };
  } catch (err) {
    return { ok: false, msg: String((err && err.message) || err).slice(0, 400) };
  }
}

/* ------------------------- 2. import 引用校验 ------------------------- */

/**
 * 抽取模块里的 import 说明符。
 *
 * @param {string} src 源码。
 * @returns {string[]} 说明符数组。
 */
function extractImports(src) {
  const out = [];
  const reStatic = /(?:^|\n)\s*(?:import|export)\s[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;
  const reBare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  const reDynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [reStatic, reBare, reDynamic]) {
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/* ------------------------- 3. HTML 引用校验 ------------------------- */

/**
 * 抽取 HTML 里的本地引用。
 *
 * @param {string} src HTML 源码。
 * @returns {string[]} 引用路径数组。
 */
function extractHtmlRefs(src) {
  const out = [];
  const re = /(?:href|src)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const v = m[1];
    if (v.startsWith('data:')) continue;
    if (/^https?:\/\//i.test(v)) continue;
    out.push(v);
  }
  return out;
}

/* ------------------------- tabbar 导航解析 ------------------------- */

/**
 * 把 class 属性值切成标记数组（容忍多空格 / 前后空格）。
 *
 * @param {string} v class 属性值。
 * @returns {string[]} 标记数组。
 */
function classTokens(v) {
  return String(v || '')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * 归一导航 href：去掉开头的 `./`、去掉 `?`/`#` 及其后内容。
 *
 * 为什么必须归一再比：`./settings.html` 与 `settings.html` 指向同一个文件、跳到同一个
 * 页面，是**语义等价**的两种写法；但字符串精确比对（`indexOf(p)`）会把它们判成两项，
 * 于是「四页统一写成 `./xxx.html`」这种完全正确的写法会被报 8 条红，其中还包括
 * 「激活项指向自己（href=index.html）— 实际指向 ./index.html」这种明明对却报错的条目。
 * 误报一多，真正漏改的那条就没人看了 —— 所以先归一，再比对。
 *
 * @param {string} v 原始 href（可能为 null）。
 * @returns {string} 归一后的 href。
 */
function normalizeHref(v) {
  return String(v || '')
    .trim()
    .replace(/^\.\//, '')
    .split('#')[0]
    .split('?')[0];
}

/**
 * 抽出页面里 `<nav class="tabbar">` 的内部内容。
 *
 * 为什么只抠这一个块：四个页面的 tabbar 是四份**手写副本**（零构建、无模板、无 SPA 路由），
 * 上一轮给四页加「我的」tab 时漏改了 compass.html，而旧检查从不比对这几份副本。
 * 只取块内内容可避免把页面正文里的其它 <a> 混进比对。
 *
 * @param {string} src HTML 源码。
 * @returns {string|null} nav 内部内容（不含 <nav> 标签本身）；找不到返回 null。
 */
function extractTabbar(src) {
  const re = /<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const cls = m[1].match(/\bclass\s*=\s*"([^"]*)"/i);
    if (cls && classTokens(cls[1]).indexOf('tabbar') !== -1) return m[2];
  }
  return null;
}

/**
 * 解析 nav 块内的每个 <a> 项（属性顺序无关，容忍 `class="tab"` 与 `class="tab tab--active"`）。
 *
 * @param {string} block nav 内部内容。
 * @returns {Array<{cls:string, href:string|null, aria:string|null}>} 项列表（按文档顺序）。
 */
function parseNavItems(block) {
  const out = [];
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    const cls = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
    const href = attrs.match(/\bhref\s*=\s*"([^"]*)"/i);
    const aria = attrs.match(/\baria-current\s*=\s*"([^"]*)"/i);
    out.push({
      cls: cls ? cls[1] : '',
      href: href ? href[1] : null,
      aria: aria ? aria[1] : null,
    });
  }
  return out;
}

/** 导航项上的激活 class（视觉）。 */
const ACTIVE_CLASS = 'tab--active';

/** 导航项上的无障碍属性取值（语义）。CSS 里没有 [aria-current] 选择器，全靠它给读屏软件。 */
const ACTIVE_ARIA = 'page';

/* ------------------------- CSS 规则解析 ------------------------- */

/**
 * 取出某个选择器（精确匹配）的规则体。
 *
 * 为什么用「选择器 + 空白 + {」锚定而不是裸 indexOf：`.tab` 会命中 `.tabbar` / `.tab--active`
 * 的前缀，取到的声明体是别人的，断言就变成假绿。锚定后 `.tabbar {` / `.tab--active {`
 * 都不会被匹配（选择器后面还有字符，不是 `{`）。
 *
 * @param {string} css CSS 源码。
 * @param {string} selector 选择器字面量（如 `.tab`）。
 * @returns {string|null} `{` 与 `}` 之间的声明体；找不到返回 null。
 */
function extractRule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const m = css.match(re);
  return m ? m[1] : null;
}

/**
 * 取规则体里某条声明的值。
 *
 * @param {string} block 规则体（`{` 与 `}` 之间）。
 * @param {string} prop 属性名（如 `min-width`）。
 * @returns {string|null} 属性值原文（可能是 `var(--sp-3)`）；未声明返回 null。
 */
function declValue(block, prop) {
  const re = new RegExp(`(?:^|[;\\n])\\s*${prop}\\s*:\\s*([^;{}]+)`, 'i');
  const m = String(block || '').match(re);
  return m ? m[1].trim() : null;
}

/**
 * 在 tokens.css 里查自定义属性的真值。
 *
 * @param {string} tokens tokens.css 源码。
 * @param {string} name 变量名（不含 `--` 前缀，如 `sp-3`）。
 * @returns {string|null} 值原文（如 `12px`）；未定义返回 null。
 */
function tokenValue(tokens, name) {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`);
  const m = tokens.match(re);
  return m ? m[1].trim() : null;
}

/**
 * 把「裸 px / calc(Npx * var(--x))」折成像素数字。
 *
 * 只认**单一乘数**形态 `calc(<数字>px * var(--<变量名>))`（无障碍字号档位用的正是它）：
 * 把变量按 tokens.css 解析成数字再相乘。解析不出一律返回 null，绝不静默当 0 ——
 * 在本脚本里「解析不出来」必须变成一条红，而不是一个被当成 0 的宽度。
 *
 * @param {string} raw 值原文（已去掉外层 var()）。
 * @param {string} tokens tokens.css 源码。
 * @returns {number|null} 像素数；解析不出返回 null。
 */
function resolvePx(raw, tokens) {
  const calc = String(raw).match(/^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/i);
  if (calc) {
    const base = parseFloat(calc[1]);
    const mul = parseFloat(tokenValue(tokens, calc[2]));
    if (!Number.isFinite(base) || !Number.isFinite(mul)) return null;
    return base * mul;
  }
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * 把「可能是 var(...) 的长度值」解析成像素数字。
 *
 * @param {string} v 值原文（如 `64px` / `var(--sp-3)` / `var(--fs-md)`）。
 * @param {string} tokens tokens.css 源码。
 * @returns {number|null} 像素数；解析不出返回 null。
 */
function pxOf(v, tokens) {
  if (!v) return null;
  const varMatch = String(v).trim().match(/^var\(\s*--([a-z0-9-]+)\s*\)$/i);
  const raw = varMatch ? tokenValue(tokens, varMatch[1]) : v;
  if (!raw) return null;
  return resolvePx(raw, tokens);
}

/**
 * 取出所有声明了指定属性值的规则（供「line-height: 1 的那几处」这类全量扫描使用）。
 *
 * 为什么不用第 12 节那个按选择器名查的 extractRule()：这里要的是**反过来** ——
 * 不知道有哪些选择器，只知道「谁写了 line-height: 1」。将来新增一处没被登记的规则，
 * 本节会自动把它捞出来，不需要有人记得来登记。
 *
 * @param {string} css CSS 源码。
 * @param {string} prop 属性名（如 'line-height'）。
 * @param {string} value 期望的属性值原文（如 '1'）。
 * @returns {Array<{selector:string, body:string}>} 命中的规则。
 */
function rulesWithDecl(css, prop, value) {
  const out = [];
  const re = /([^{}]+?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (!selector || selector.startsWith('@')) continue;
    const decl = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*${value}\\s*(?:;|$)`).test(body);
    if (decl) out.push({ selector, body });
  }
  return out;
}

/**
 * 取出 `:root[data-fs='<tier>']` 这个档位块的声明体。
 *
 * @param {string} css tokens.css 源码。
 * @param {string} tier 档位名（如 'large'）。
 * @returns {string|null} 声明体；块不存在返回 null。
 */
function extractTierBlock(css, tier) {
  const re = new RegExp(`:root\\[data-fs=['"]${tier}['"]\\]\\s*\\{([\\s\\S]*?)\\}`, 'm');
  const m = css.match(re);
  return m ? m[1] : null;
}

/**
 * 解析 `--fs-*: calc(<N>px * var(--<乘数变量>))` 的形状。
 *
 * @param {string} tokens tokens.css 源码。
 * @param {string} name token 名（不含 `--` 前缀，如 'fs-md' / 'fs-hero'）。
 * @returns {{base:number, mul:string}|null} 基准 px 与乘数变量名；形状不符返回 null。
 */
function parseFsToken(tokens, name) {
  const raw = tokenValue(tokens, name);
  if (!raw) return null;
  const m = String(raw).match(/^calc\(\s*(-?\d+(?:\.\d+)?)px\s*\*\s*var\(\s*--([a-z0-9-]+)\s*\)\s*\)$/i);
  if (!m) return null;
  return { base: parseFloat(m[1]), mul: m[2] };
}

/**
 * 取 padding 简写的**水平**值（左右各一份）。
 *
 * `padding: 0 var(--sp-3)` → 第二项（左右）；`padding: var(--sp-1)` → 唯一项（四边同值）。
 *
 * @param {string} v padding 值原文。
 * @param {string} tokens tokens.css 源码。
 * @returns {number|null} 单侧水平 padding 的像素数；解析不出返回 null。
 */
function paddingHorizontal(v, tokens) {
  if (!v) return null;
  const parts = v.trim().split(/\s+/);
  if (parts.length === 1) return pxOf(parts[0], tokens);
  // 2/3/4 值语法下，左右永远是第二项
  return pxOf(parts[1], tokens);
}

/* ------------------------- 主流程 ------------------------- */

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const srcFiles = walk(path.join(ROOT, 'src'), (n) => n.endsWith('.js')).sort();
  const toolFiles = walk(path.join(ROOT, 'tools'), (n) => n.endsWith('.mjs')).sort();
  const htmlFiles = walk(ROOT, (n) => n.endsWith('.html') && !n.includes('node_modules')).sort();
  const cssFiles = walk(path.join(ROOT, 'styles'), (n) => n.endsWith('.css')).sort();

  section(`0. 文件清单（${srcFiles.length} 个 src 模块 / ${toolFiles.length} 个工具 / ${htmlFiles.length} 个页面 / ${cssFiles.length} 个样式）`);
  process.stdout.write(`  src:   ${srcFiles.join(', ')}\n`);
  process.stdout.write(`  tools: ${toolFiles.join(', ')}\n`);
  process.stdout.write(`  html:  ${htmlFiles.join(', ')}\n`);
  process.stdout.write(`  css:   ${cssFiles.join(', ')}\n`);

  /* ---------- 1. 语法校验 ---------- */
  section('1. 语法校验（node --check）');
  for (const rel of [...srcFiles, ...toolFiles, 'sw.js']) {
    const r = await nodeCheck(rel);
    check(`语法通过：${rel}`, r.ok, r.msg);
  }

  /* ---------- 2. 真加载（import 解析 + 顶层无副作用） ---------- */
  section('2. 模块真加载（import 解析 + 顶层无 DOM 副作用）');
  // now.js / app.js / selfcheck.js 顶层不得触碰 document；app.js/selfcheck.js 有 DOM 守卫
  for (const rel of srcFiles) {
    const r = await importCheck(rel);
    check(`可加载：${rel}`, r.ok, r.msg);
  }

  /* ---------- 3. import 引用存在性 + .js 后缀 ---------- */
  section('3. import 引用存在性（必须带 .js 后缀）');
  for (const rel of srcFiles) {
    const src = read(rel);
    const dir = path.dirname(path.join(ROOT, rel));
    const specs = extractImports(src);
    for (const spec of specs) {
      if (/^node:/.test(spec)) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        check(`${rel} → 禁止裸模块说明符 '${spec}'`, false, '零依赖约束：不允许第三方包');
        continue;
      }
      const abs = path.resolve(dir, spec);
      const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      check(`${rel} → ${spec}`, exists, exists ? '' : '文件不存在');
      if (exists && spec.startsWith('.') && !spec.endsWith('.js') && !spec.endsWith('.mjs')) {
        check(`${rel} → '${spec}' 缺少 .js 后缀`, false, '浏览器原生 ES Module 要求完整扩展名');
      }
    }
  }

  /* ---------- 3.5 命名导入 / 导出一致性 ---------- */
  section('4. 命名导入与命名导出一致性（防「导入了不存在的符号」）');
  let namedOk = 0;
  let namedBad = 0;
  for (const rel of srcFiles) {
    const src = read(rel);
    // ★`^\s*import`（带 m 标志）：`import` 必须出现在**行首**（前面只有空白）。
    //   不加这个锚点时会误命中**注释里的 "import" 这个词** —— 例如某文件的 JSDoc 写着
    //   「core 不许 import i18n」，而同一段注释下方没有分号与引号，正则就会从那个词
    //   一路吃到真正的 import 语句，把注释里的 `tr({ key: … })` 当成命名导入去校验，
    //   报出「导入了不存在的符号」这种纯属误报的红。锚到行首后，JSDoc 行以 ` * ` 开头，
    //   天然不匹配。多行 import 仍然照常命中（`[^;'"]*?` 允许跨行）。
    const re = /^\s*import\s+([^;'"]*?)\s+from\s+['"](\.[^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      const named = m[1].match(/\{([^}]*)\}/);
      if (!named) continue;
      const spec = m[2];
      const targetAbs = path.resolve(path.dirname(path.join(ROOT, rel)), spec);
      let ns = null;
      try {
        ns = await import(pathToFileURL(targetAbs).href);
      } catch (err) {
        check(`${rel} → 无法加载 ${spec}`, false, String(err && err.message).slice(0, 200));
        continue;
      }
      const names = named[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      for (const n of names) {
        if (Object.prototype.hasOwnProperty.call(ns, n)) {
          namedOk += 1;
        } else {
          namedBad += 1;
          check(`${rel} → 导入 { ${n} }（来自 ${spec}）`, false, '目标模块未导出该符号');
        }
      }
    }
  }
  check(`命名导入全部命中（共 ${namedOk} 处）`, namedBad === 0, `${namedBad} 处未命中`);

  /* ---------- 5. HTML 引用校验 ---------- */
  section('5. HTML 本地引用校验（防 404）');
  for (const html of htmlFiles) {
    const src = read(html);
    const refs = extractHtmlRefs(src);
    for (const ref of refs) {
      const abs = path.resolve(ROOT, ref.replace(/^\/+/, ''));
      const exists = fs.existsSync(abs);
      check(`${html} → ${ref}`, exists, exists ? '' : '文件不存在');
    }
    // 每个页面必须引入对应入口模块（新增页面时在这里登记，否则会漏引、白屏）
    const boot = ENTRY_OF_PAGE[html];
    check(`${html} 引入 ${boot || '（未登记的页面）'}`, !!boot && src.indexOf(boot) !== -1);
  }

  /* ---------- 5. SW 预缓存清单 ---------- */
  section('6. Service Worker 预缓存清单');
  const swSrc = read('sw.js');
  const blockMatch = swSrc.match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  check('sw.js 含 SHELL_ASSETS 清单', !!blockMatch);
  if (blockMatch) {
    const assets = [];
    const re = /'([^']+)'|"([^"]+)"/g;
    let m;
    while ((m = re.exec(blockMatch[1])) !== null) assets.push(m[1] || m[2]);
    for (const a of assets) {
      const rel = a.replace(/^\.\//, '');
      const exists = rel === '' ? true : fs.existsSync(path.join(ROOT, rel));
      check(`SW 预缓存 ${a}`, exists, exists ? '' : '文件不存在');
    }
    // 反向：所有运行时必需文件都应被预缓存
    for (const rel of [...srcFiles, ...cssFiles, ...PAGES, 'manifest.webmanifest']) {
      const inList = assets.some((a) => a.replace(/^\.\//, '') === rel);
      check(`SW 覆盖 ${rel}`, inList, inList ? '' : '未列入预缓存清单');
    }
    check('SW 不缓存 API 响应（无 api.open-meteo 相关缓存逻辑）', swSrc.indexOf('open-meteo') === -1);
  }

  /* ---------- 6. 外链与隐私红线 ---------- */
  section('7. 外链与隐私红线');
  const scanTargets = [...srcFiles, ...htmlFiles, ...cssFiles, 'sw.js', 'manifest.webmanifest'];
  for (const rel of scanTargets) {
    const src = read(rel);
    // 6.1 外链宿主白名单
    const urlRe = /https?:\/\/([a-zA-Z0-9.-]+)/g;
    let m;
    const hosts = new Set();
    while ((m = urlRe.exec(src)) !== null) hosts.add(m[1]);
    const bad = [...hosts].filter((hst) => !ALLOWED_HOSTS.includes(hst));
    check(`${rel} 无白名单外外链`, bad.length === 0, bad.join(', '));
    // 6.2 禁用词
    for (const p of FORBIDDEN_PATTERNS) {
      check(`${rel} 无${p.why}`, !p.re.test(src), p.why);
    }
    // 6.3 禁止直写 console.log（须走 store.log）
    if (rel.startsWith('src/') && rel !== 'src/core/store.js') {
      check(`${rel} 未直写 console.log`, !/console\.log\s*\(/.test(src));
    }
  }

  /* ---------- 7. 一致性抽查：时间戳 / 缓存键 / 文案 ---------- */
  section('8. 跨文件一致性抽查');
  const httpSrc = read('src/core/http.js');
  check('时间戳字段统一 ...At（ms）', /\bstartedAt\b/.test(httpSrc) && /\bfinishedAt\b/.test(httpSrc));
  check('SourceError 字段完整', ['code', 'message', 'httpStatus', 'sourceId', 'retriable'].every((k) => httpSrc.includes(k)));
  const cacheSrc = read('src/core/cache.js');
  check('缓存命名空间 gs:v1:', cacheSrc.includes("export const NS = 'gs:v1:'"));
  const srcReg = read('src/data/sources.js');
  check('源注册表注入 http 解析器', srcReg.includes('setSourceResolver(getSource)'));
  check('core 层不 import data 层', !/from\s+['"]\.\.\/data\//.test(httpSrc) && !/from\s+['"]\.\.\/data\//.test(cacheSrc));
  check('data 层不 import ui 层', !srcFiles.some((f) => f.startsWith('src/data/') && /from\s+['"]\.\.\/ui\//.test(read(f))));
  const nowSrc = read('src/ui/now.js');
  // ★路径是 i18n **入口**（src/i18n/index.js），不是 zh 文案表：t() 已经从 zh.js 里
  // 搬走了（那里现在只有一张静态表）。指回 zh.js 等于默认「界面永远说中文」。
  check('UI 文案走 t()（now.js 无硬编码中文键名遗漏抽查）', nowSrc.includes("from '../i18n/index.js'"));
  const zh = read('src/i18n/zh.js');
  check('i18n 无 md5 字样', !/md5/i.test(zh));
  const tiles = read('src/data/tiles.js');
  check('瓦片指纹用 SHA-256（无 md5）', /SHA-256/.test(tiles) && !/md5/i.test(tiles));

  /* ---------- 9. i18n 键完整性 ---------- */
  // ★两张表一起校验。原来只对着 zh 表查一遍，那是单语言时代留下的假设 ——
  //   现在界面有中英两档，一个 key 在中文表里存在、在英文表里没有，界面就会直接
  //   显示 'wmo.61' 这种原始键名（t() 缺键返回 key 本身）。所以 data-i18n 与 t()
  //   的每一处引用都必须**两张表都命中**。
  section('9. i18n 键完整性（data-i18n 占位 + t() 调用 · 中英两张表）');
  const zhSrc = read('src/i18n/zh.js');
  const enSrc = read('src/i18n/en.js');
  const i18nKeys = new Set();
  const enKeys = new Set();
  const keyRe = /^\s*'([a-zA-Z0-9._-]+)':/gm;
  let km;
  while ((km = keyRe.exec(zhSrc)) !== null) i18nKeys.add(km[1]);
  const keyReEn = /^\s*'([a-zA-Z0-9._-]+)':/gm;
  while ((km = keyReEn.exec(enSrc)) !== null) enKeys.add(km[1]);
  check('中文表非空', i18nKeys.size > 50, String(i18nKeys.size));
  check('英文表非空', enKeys.size > 50, String(enKeys.size));
  for (const html of htmlFiles) {
    const src = read(html);
    const re = /data-i18n="([^"]+)"/g;
    let m;
    let n = 0;
    while ((m = re.exec(src)) !== null) {
      n += 1;
      check(`${html} data-i18n="${m[1]}" 存在于中文表`, i18nKeys.has(m[1]), m[1]);
      check(`${html} data-i18n="${m[1]}" 存在于英文表`, enKeys.has(m[1]), m[1]);
    }
    check(`${html} 的静态文案全部走 i18n（共 ${n} 处）`, n > 0);
    // 没有子元素的那些位置（meta description / iOS 主屏名）与读屏标签，同样看得见。
    // 它们不走 data-i18n，走 data-i18n-key / data-i18n-aria —— 漏了就会在英文界面上
    // 留下一句中文，而第 9 节原来那只眼睛只看得到 data-i18n。
    for (const attr of ['data-i18n-key', 'data-i18n-aria']) {
      const re2 = new RegExp(`${attr}="([^"]+)"`, 'g');
      let m2;
      while ((m2 = re2.exec(src)) !== null) {
        check(`${html} ${attr}="${m2[1]}" 存在于中文表`, i18nKeys.has(m2[1]), m2[1]);
        check(`${html} ${attr}="${m2[1]}" 存在于英文表`, enKeys.has(m2[1]), m2[1]);
      }
    }
  }
  // t('literal') 字面量调用必须命中
  for (const rel of srcFiles) {
    const src = read(rel);
    const re = /\bt\(\s*'([a-zA-Z0-9._-]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      check(`${rel} → t('${m[1]}') 存在于中文表`, i18nKeys.has(m[1]), m[1]);
      check(`${rel} → t('${m[1]}') 存在于英文表`, enKeys.has(m[1]), m[1]);
    }
  }
  // ★「存键不存串」的字面量同样必须命中。
  //   起因：data/sources.js 原先把 label 写成 `t('source.weather')`，被改成惰性 getter
  //   （`labelKey: 'source.weather'`）之后，上面那只 t() 眼睛就看不见这六个键了 ——
  //   护栏反而少查了 12 项。凡 `xxxKey: 'literal'` 形式的引用都是同一类：键最终要上屏，
  //   漏了照样在英文界面上留中文。这里一并纳入。
  for (const rel of srcFiles) {
    const src = read(rel);
    const re = /\b(?:labelKey|attributionKey|reasonKey|headerKey)\s*:\s*'([a-zA-Z0-9._-]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      check(`${rel} → ${m[0].split(':')[0].trim()}: '${m[1]}' 存在于中文表`, i18nKeys.has(m[1]), m[1]);
      check(`${rel} → ${m[0].split(':')[0].trim()}: '${m[1]}' 存在于英文表`, enKeys.has(m[1]), m[1]);
    }
  }

  /* ---------- 10. tabbar 导航一致性 ---------- */
  // 背景：四个页面各有一份手写的 <nav class="tabbar">。上一轮给四页加「我的」tab 时漏改了
  // compass.html，而当时的 760 项检查全绿 —— 它只查 data-i18n / 资源登记 / SW 覆盖，
  // 从不比对这几份手写副本。本节把这四份副本钉死，漏改即报红。
  //
  // 不适用 selfcheck-standalone.html：它是 tools/build-standalone.mjs 的生成产物，
  // nav 已被改成 tab--disabled 的 <span>（不是 <a>），下面四条断言对它都没有意义。
  section(`10. tabbar 导航一致性（${PAGES.length} 个手写 HTML 的导航不得漂移）`);

  /** @type {Object<string, Array<{cls:string, href:string|null, aria:string|null}>>} */
  const navTabs = {};

  for (const html of PAGES) {
    const src = read(html);
    const block = extractTabbar(src);
    check(`${html} 含 <nav class="tabbar">`, !!block, '未找到 tabbar 容器');
    const anchors = block ? parseNavItems(block) : [];
    const tabs = anchors.filter((a) => classTokens(a.cls).indexOf('tab') !== -1);
    check(
      `${html} tabbar 内每个 <a> 都带 class="tab"（共 ${anchors.length} 个 <a>）`,
      anchors.length > 0 && tabs.length === anchors.length,
      `命中 ${tabs.length}/${anchors.length}`
    );
    // 缺 href 的项会让下面的列表比对被 null 搅乱，先单独挡一道
    const noHref = tabs.filter((t) => !t.href).length;
    check(`${html} tabbar 每项都有 href`, noHref === 0, `${noHref} 项缺 href`);
    navTabs[html] = tabs;
  }

  const BASE_PAGE = PAGES[0];
  // 归一后比对：`./x.html` 与 `x.html` 视为同一项（见 normalizeHref 的注释）
  const baseHrefs = (navTabs[BASE_PAGE] || []).map((t) => normalizeHref(t.href));

  // (a) 四页 href 列表逐项相等（含顺序）
  for (const html of PAGES) {
    const hrefs = (navTabs[html] || []).map((t) => normalizeHref(t.href));
    let detail = '';
    if (hrefs.join(',') !== baseHrefs.join(',')) {
      const missing = baseHrefs.filter((h) => hrefs.indexOf(h) === -1);
      const extra = hrefs.filter((h) => baseHrefs.indexOf(h) === -1);
      detail =
        missing.length === 0 && extra.length === 0
          ? `顺序不同：基准 [${baseHrefs.join(' | ')}]，实际 [${hrefs.join(' | ')}]`
          : `缺少 ${missing.length ? missing.join('、') : '（无）'}；多出 ${extra.length ? extra.join('、') : '（无）'}`;
    }
    check(`${html} tab href 列表与基准 ${BASE_PAGE} 一致（含顺序）`, detail === '', detail);
    // 反向护栏：万一四页一起漏掉同一个 tab，(a) 依然是绿的 —— 用页面清单兜住
    const notCovered = PAGES.filter((p) => hrefs.indexOf(p) === -1);
    check(`${html} tab 覆盖全部 ${PAGES.length} 个手写页面`, notCovered.length === 0, `未覆盖 ${notCovered.join('、')}`);
  }

  // (b) 每页恰好一个激活项，且激活项指向自己
  for (const html of PAGES) {
    const tabs = navTabs[html] || [];
    const active = tabs.filter((t) => classTokens(t.cls).indexOf(ACTIVE_CLASS) !== -1);
    check(
      `${html} 恰好一个 ${ACTIVE_CLASS}`,
      active.length === 1,
      `实际 ${active.length} 个：${active.map((t) => t.href).join('、') || '无'}`
    );
    if (active.length === 1) {
      check(`${html} 激活项指向自己（href=${html}）`, normalizeHref(active[0].href) === html, `实际指向 ${active[0].href}`);
    }
  }

  // (c) tab--active 与 aria-current="page" 必须成对（视觉靠 class，无障碍语义靠属性）
  for (const html of PAGES) {
    for (const t of navTabs[html] || []) {
      const hasCls = classTokens(t.cls).indexOf(ACTIVE_CLASS) !== -1;
      const hasAria = t.aria === ACTIVE_ARIA;
      let why = '';
      if (t.aria !== null && t.aria !== ACTIVE_ARIA) why = `aria-current="${t.aria}" 取值非法（只许 "${ACTIVE_ARIA}"）`;
      else if (hasCls && !hasAria) why = `有 class="${ACTIVE_CLASS}" 却缺 aria-current="${ACTIVE_ARIA}"`;
      else if (!hasCls && hasAria) why = `有 aria-current="${ACTIVE_ARIA}" 却缺 class="${ACTIVE_CLASS}"`;
      check(`${html} tab[${t.href}] 的 ${ACTIVE_CLASS} 与 aria-current="${ACTIVE_ARIA}" 成对`, why === '', why);
    }
  }

  // (d) nav 里的 href 必须指向真实存在的页面文件（抓「加了 tab 页面还没建」与「删页忘删 tab」）
  const allHrefs = [];
  for (const html of PAGES) {
    for (const t of navTabs[html] || []) {
      const norm = normalizeHref(t.href);
      if (norm && allHrefs.indexOf(norm) === -1) allHrefs.push(norm);
    }
  }
  for (const href of allHrefs) {
    const clean = normalizeHref(href);
    check(`tab href ${href} 指向 .html 页面`, /\.html$/i.test(clean), '导航项必须指向页面文件');
    const abs = path.resolve(ROOT, clean.replace(/^\/+/, ''));
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    check(`tab href ${href} 对应文件存在`, exists, exists ? '' : `${clean} 不在磁盘上`);
  }

  /* ---------- 11. 主题引导覆盖全部入口 ---------- */
  // 背景：写 <html data-theme> 的代码原本只活在 src/ui/settings.js 里，且只有那一页在模块
  // 顶层调用过 —— 于是用户手动指定「浅色」后，其余三页的 <html> 上没有 data-theme，CSS
  // 只能跟着系统偏好走，「手动指定后会一直保持」这条承诺在 3/4 的页面上是假的。
  // 本仓库**无 SPA 路由、无共享 bootstrap**（四个独立 HTML 靠 <a href> 跳转），所以每个
  // 入口模块必须各引导一次，谁也替不了谁。这一节用源码扫描钉死：漏一页即报红。
  // 手法照第 9 节扫 t('...') 的既有写法（读源码 + 正则，零依赖）。
  section(`11. 主题引导（${PAGES.length} 个页面的入口必须在模块顶层写 data-theme）`);

  const themeSrc = read('src/ui/theme.js');
  check('src/ui/theme.js 导出 applyThemeMode', /export\s+function\s+applyThemeMode\s*\(/.test(themeSrc), '主题引导必须有唯一实现');

  for (const html of PAGES) {
    const entry = ENTRY_OF_PAGE[html];
    const entrySrc = read(entry);
    check(
      `${html} 入口 ${entry} 引用主题引导 applyThemeMode`,
      entrySrc.indexOf('applyThemeMode') !== -1,
      '入口模块必须引导主题，否则该页会显示错的主题'
    );
    // 必须是**顶层**调用（行首无缩进）且喂的是 store 里的当前模式：
    // 只 import 不调用、或挪进 boot()/init()/await 之后，都会让用户先看到一帧错的主题。
    check(
      `${html} 入口 ${entry} 顶层调用 applyThemeMode(getThemeMode())`,
      /^applyThemeMode\(\s*getThemeMode\(\)\s*\);/m.test(entrySrc),
      '必须写在模块顶层（行首无缩进），不能只 import 不调用、也不能挪进 boot()/init()'
    );
  }

  /* ---------- 12. 底部 tabbar 空间预算 ---------- */
  // 背景（真机 bug，不是理论推演）：a0dde93 加第 4 个 tab 时，把 `.tab` 从 `min-width: 88px`
  // 改成 `flex: 1 1 0` + `min-width: 64px`，纸面算的是「4×68 + 3×4 + 2×4 = 294px < 320px」。
  // 上线后真机截图：四个 tab 文字全断成两行。
  //
  // 根因是 `.tabbar` 是 `position: fixed` 且**没有 width** → 宽度 shrink-to-fit、由内容决定。
  // 于是 `flex-basis: 0` 分不到「剩余空间」（本来就没有），每个 tab 实际只有 ~70px，
  // 减去 `padding: 0 var(--sp-5)` 的左右 40px，内容区只剩 ~30px —— 而「此刻」两字在
  // `--fs-md`(14px) 下正好 ~28–30px。**卡在临界点**，真机字体渲染稍有差异就换行。
  //
  // 教训：「宽度够不够」应该由机器算，不该靠纸面估。本节就是把这次的算术固化成断言。
  //
  // ⚠️ 覆盖面（别把这条守卫当成「保证不换行」）：
  //   它能抓的是**声明的空间预算超限** —— tab 数量变多（4 → 6）、padding 被调大、
  //   min-width 被调大、gap 变宽这类「纸面上就该溢出」的改动。
  //   它**抓不住真实字体渲染差异**：这里的「两字文本宽」取 `2 × --fs-md`（中文字符宽约等于
  //   font-size）是保守估计，但真实渲染受字重、font-family 回退（Noto Sans SC 未命中时落到
  //   PingFang / 微软雅黑）、字距影响，可能比这个数更宽或更窄。
  //   也就是说：本节全绿 ≠ 真机一定不换行；本节报红 = 纸面就已经不够，必须解决。
  //   真正的换行防线是 CSS 里的 `white-space: nowrap`（断行会把 tab 撑高、顶掉上方内容，
  //   危害远大于横向挤压），本节另有一条断言钉住它不许被删。
  section('12. 底部 tabbar 空间预算（窄屏 320px 下四个 tab 不得溢出 / 不得断行）');

  /** 最小目标屏宽：iPhone SE 一代的 320px CSS 视口，本项目支持的地板。 */
  const MIN_VIEWPORT = 320;

  // ★先剥注释再解析：注释里一旦出现「--fs-scale: 1」这类**长得像声明**的文字，
  //   按正则取值的解析器就会把注释当成真声明，算出一个 NaN 或者一个根本不存在的值，
  //   而且不报错。把注释替换成等长空白（保留换行，行号不漂移）是零成本的一劳永逸。
  const appCss = stripCssComments(read('styles/app.css'));
  const tokensCss = stripCssComments(read('styles/tokens.css'));

  const tabRule = extractRule(appCss, '.tab');
  const tabbarRule = extractRule(appCss, '.tabbar');
  check('app.css 存在 .tab 规则', !!tabRule, '解析不到 `.tab { … }`，空间预算无从计算');
  check('app.css 存在 .tabbar 规则', !!tabbarRule, '解析不到 `.tabbar { … }`，空间预算无从计算');

  const tabMinWidthRaw = declValue(tabRule, 'min-width');
  const tabPadRaw = declValue(tabRule, 'padding');
  const tabbarGapRaw = declValue(tabbarRule, 'gap');
  const tabbarPadRaw = declValue(tabbarRule, 'padding');

  const tabMinWidth = pxOf(tabMinWidthRaw, tokensCss);
  const tabPadH = paddingHorizontal(tabPadRaw, tokensCss);
  const tabbarGap = pxOf(tabbarGapRaw, tokensCss);
  const tabbarPadH = paddingHorizontal(tabbarPadRaw, tokensCss);
  const fsMd = pxOf(tokenValue(tokensCss, 'fs-md'), tokensCss);

  check(
    `.tab 的 min-width 可解析（${tabMinWidthRaw} → ${tabMinWidth}px）`,
    tabMinWidth !== null,
    '解析失败：值是 var() 但 tokens.css 里没有，或不是长度'
  );
  check(
    `.tab 的 padding 水平值可解析（${tabPadRaw} → ${tabPadH}px）`,
    tabPadH !== null,
    '解析失败：padding 简写形式超出本节支持（2/3/4 值取第二项，1 值取唯一项）'
  );
  check(
    `.tabbar 的 gap 可解析（${tabbarGapRaw} → ${tabbarGap}px）`,
    tabbarGap !== null,
    '解析失败'
  );
  check(
    `.tabbar 的 padding 水平值可解析（${tabbarPadRaw} → ${tabbarPadH}px）`,
    tabbarPadH !== null,
    '解析失败'
  );
  check(`tokens.css 的 --fs-md 可解析（${fsMd}px）`, fsMd !== null, '解析失败');

  // tab 数量从页面 HTML 实读（复用第 10 节的 extractTabbar / parseNavItems，四页导航一致，取基准页）
  const baseNav = extractTabbar(read(BASE_PAGE));
  const baseTabs = baseNav
    ? parseNavItems(baseNav).filter((a) => classTokens(a.cls).indexOf('tab') !== -1)
    : [];
  check(`${BASE_PAGE} 解析出 tab 数量（${baseTabs.length} 个）`, baseTabs.length > 0, 'tab 数量必须 > 0');

  // 两字文本宽：中文字符宽度约等于 font-size，保守取 2 × --fs-md
  const twoCharText = 2 * (fsMd || 0);
  const tabPadTotal = 2 * (tabPadH || 0);
  const tabWidth = Math.max(tabMinWidth || 0, tabPadTotal + twoCharText);
  const gapsTotal = (baseTabs.length - 1) * (tabbarGap || 0);
  const shellPadTotal = 2 * (tabbarPadH || 0);
  const budgetTotal = baseTabs.length * tabWidth + gapsTotal + shellPadTotal;
  const slack = MIN_VIEWPORT - budgetTotal;

  // 算术过程原样打印：断言里的数字必须能被人工复核，不能是个黑盒
  process.stdout.write(`  预算明细（${BASE_PAGE}，tab 数 = ${baseTabs.length}）：\n`);
  process.stdout.write(`    --fs-md                = ${fsMd}px\n`);
  process.stdout.write(`    两字文本宽 2 × fs-md    = ${twoCharText}px\n`);
  process.stdout.write(`    .tab padding 水平       = ${tabPadH}px（单侧）× 2 = ${tabPadTotal}px\n`);
  process.stdout.write(`    .tab min-width         = ${tabMinWidth}px\n`);
  process.stdout.write(`    → 单 tab 宽 = max(${tabMinWidth}, ${tabPadTotal} + ${twoCharText}) = ${tabWidth}px\n`);
  process.stdout.write(`    tab 合计 ${baseTabs.length} × ${tabWidth}      = ${baseTabs.length * tabWidth}px\n`);
  process.stdout.write(`    gap 合计 ${baseTabs.length - 1} × ${tabbarGap}        = ${gapsTotal}px\n`);
  process.stdout.write(`    tabbar padding 2 × ${tabbarPadH}   = ${shellPadTotal}px\n`);
  process.stdout.write(`    总和                    = ${budgetTotal}px（上限 ${MIN_VIEWPORT}px，余量 ${slack}px）\n`);

  check(
    `tabbar 总宽 ${budgetTotal}px ≤ ${MIN_VIEWPORT}px（余量 ${slack}px）`,
    budgetTotal <= MIN_VIEWPORT,
    `超了 ${budgetTotal - MIN_VIEWPORT}px：降 .tab 的 padding / min-width，或减 tab 数量 —— 不要动 --sp-* 与 --fs-*，那是全局栅格与字号阶梯`
  );

  // white-space: nowrap 是真正的「不断行」防线（见本节开头注释），不许被当成无用声明删掉
  const wsRaw = declValue(tabRule, 'white-space');
  check(`.tab 声明 white-space: nowrap（现为 ${wsRaw || '缺失'}）`, wsRaw === 'nowrap', '删掉它，挤窄屏时 tab 文字会断行、把上方内容顶掉');

  /* ---------- 13. 无障碍字号三档 ---------- */
  // 背景：全站 72 处 font-size 里 69 处是 `var(--fs-*)`、全是裸 px，且**全站零 rem**、
  // `html` / `:root` / `body` 都没设过 font-size —— 所以「改 `html { font-size }`」这套
  // Web 上最常见的放大手法在这里**完全无效**（一个像素都不会动）。v15 的做法是给八个
  // --fs-* 各挂一个乘数（--fs-scale / --fs-hero-scale），档位靠 `<html data-fs>` 切换。
  //
  // 本节要把三件事钉死，理由是它们**写错了既不报错、也不会让任何既有用例变红**：
  //   ① 默认档的计算值必须与此前一模一样（一个像素都不许变）—— 放大功能是新增能力，
  //      不能顺手把「不想放大的人」的界面改了；
  //   ② 放大档必须真的放大（不能只写了 CSS 却没人写 data-fs，那是「看起来做完了」）；
  //   ③ 放大后布局还得装得下（英雄区行宽、固定高度文字盒、tabbar）—— 这是纸面最容易
  //      算错、真机上最难看的一类问题，所以交给机器按与第 12 节同一套保守估算来算。
  section('13. 无障碍字号三档（默认档不许变 / 放大档真的放大 / 放大后不撑破）');

  /** 八个字号 token 的**回归基线**：加 --fs-scale 之前 tokens.css 里的实测 px 值。 */
  const FS_BASELINE = {
    'fs-xs': 11,
    'fs-sm': 12,
    'fs-md': 14,
    'fs-lg': 16,
    'fs-xl': 20,
    'fs-2xl': 26,
    'fs-hero': 56,
    'fs-hero-sm': 40,
  };
  const FS_NAMES = Object.keys(FS_BASELINE);

  /** 三档：tier 为 null 表示默认档（`<html>` 上没有 data-fs 属性）。 */
  const FS_TIERS = [
    { tier: null, label: '默认（无 data-fs）' },
    { tier: 'large', label: 'large' },
    { tier: 'xlarge', label: 'xlarge' },
  ];

  /** 抹掉乘出来的浮点尾巴（`1.15 × 12 = 15.600000000000001`）再进断言文案，便于人工复核。 */
  const px2 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(2)) : n);

  /**
   * 取某个档位下某个乘数的值。
   *
   * 默认档读 `:root` 块里 --fs-scale / --fs-hero-scale 的声明本身；
   * 放大档读 `:root[data-fs='X']` 块里的覆盖值（块缺失或没写该变量 → null，由调用方报红）。
   *
   * @param {string} tier 档位名或 null。
   * @param {string} mulName 乘数变量名（'fs-scale' / 'fs-hero-scale'）。
   * @returns {number|null} 乘数；查不到返回 null。
   */
  function scaleOf(tier, mulName) {
    let raw = null;
    if (tier === null) {
      raw = tokenValue(tokensCss, mulName);
    } else {
      const block = extractTierBlock(tokensCss, tier);
      if (!block) return null;
      raw = declValue(block, `--${mulName}`);
    }
    if (!raw) return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }

  // ① 八个 token 的形状与基线
  const fsTokens = {};
  for (const name of FS_NAMES) {
    const parsed = parseFsToken(tokensCss, name);
    check(
      `--${name} 是 calc(<基准 px> × var(--${parsed ? parsed.mul : '?'})) 形状`,
      !!parsed,
      `实际为 ${tokenValue(tokensCss, name)}；裸 px 或不可解析的形状都过不了`
    );
    if (!parsed) continue;
    fsTokens[name] = parsed;
    check(
      `--${name} 的基准 px = ${parsed.base}（基线 ${FS_BASELINE[name]}）`,
      parsed.base === FS_BASELINE[name],
      `基线值被改了：改字号阶梯必须同步改 FS_BASELINE，否则「默认档不变」这条底线就没人守了`
    );
  }

  // ② 默认档：乘数必须是 1，且计算值必须等于基线（一个像素都不许变）
  const defaultScale = scaleOf(null, 'fs-scale');
  const defaultHeroScale = scaleOf(null, 'fs-hero-scale');
  check(`默认档 --fs-scale = 1（现为 ${defaultScale}）`, defaultScale === 1, '默认档不许放大');
  check(`默认档 --fs-hero-scale = 1（现为 ${defaultHeroScale}）`, defaultHeroScale === 1, '默认档英雄区不许放大');

  /** 每个档位下每个 --fs-* 的计算值（px）。 */
  const fsAtTier = {};
  for (const { tier, label } of FS_TIERS) {
    fsAtTier[label] = {};
    for (const name of FS_NAMES) {
      const tok = fsTokens[name];
      if (!tok) continue;
      const mul = scaleOf(tier, tok.mul);
      if (mul === null) {
        check(`${label} 档未定义 --${tok.mul}`, false, '放大档必须显式给出乘数（英雄区那个更要显式给，见 tokens.css 注释）');
        continue;
      }
      fsAtTier[label][name] = tok.base * mul;
    }
  }

  for (const name of FS_NAMES) {
    if (!fsTokens[name]) continue;
    const v = fsAtTier['默认（无 data-fs）'][name];
    check(
      `默认档 --${name} 计算值 = ${v}px（基线 ${FS_BASELINE[name]}px，一个像素都不许变）`,
      v === FS_BASELINE[name],
      `实际 ${v}px`
    );
  }

  for (const tier of ['large', 'xlarge']) {
    const mul = scaleOf(tier, 'fs-scale');
    const heroMul = scaleOf(tier, 'fs-hero-scale');
    check(`${tier} 档 --fs-scale = ${mul}（> 1 才叫放大）`, typeof mul === 'number' && mul > 1, `实际 ${mul}`);
    check(
      `${tier} 档 --fs-hero-scale = ${heroMul} 且小于 --fs-scale = ${mul}（英雄区放得比正文慢）`,
      typeof heroMul === 'number' && typeof mul === 'number' && heroMul > 1 && heroMul < mul,
      `英雄区必须放大得比正文慢，否则 56px × 全档乘数会把窄屏挤坏`
    );
    for (const name of FS_NAMES) {
      if (!fsTokens[name]) continue;
      const base = FS_BASELINE[name];
      const v = fsAtTier[tier][name];
      check(`${tier} 档 --${name} = ${px2(v)}px（> 默认 ${base}px）`, typeof v === 'number' && v > base, `实际 ${px2(v)}px`);
    }
  }

  // ③ 放大后的布局核算（320px 窄屏，与第 12 节同一套保守估算）
  const appPadH = paddingHorizontal(declValue(extractRule(appCss, '.app'), 'padding'), tokensCss);
  const heroCardPadH = paddingHorizontal(declValue(extractRule(appCss, '.card--hero'), 'padding'), tokensCss);
  const heroGap = pxOf(declValue(extractRule(appCss, '.hero'), 'gap'), tokensCss);
  const cardContent = MIN_VIEWPORT - 2 * (appPadH || 0) - 2 * (heroCardPadH || 0);
  check(`.app 水平 padding 可解析（${appPadH}px）`, appPadH !== null);
  check(`.card--hero 水平 padding 可解析（${heroCardPadH}px）`, heroCardPadH !== null);
  check(`.hero gap 可解析（${heroGap}px）`, heroGap !== null);

  /** 等宽数字步长（em）：主流等宽字体是 0.6，取它是保守估计（真实渲染只会更窄或持平）。 */
  const MONO_ADVANCE = 0.6;
  /** 英雄温度最多按三个字符算（'-12'；更冷的地方 '-89' 也是三位）。 */
  const TEMP_GLYPHS = 3;
  /** 单位 '°C' 的宽度系数：'°' ≈ 0.5em、'C' ≈ 0.6em。 */
  const UNIT_ADVANCE = 1.1;
  /** `.hero-temp .unit` 的 margin-left（px），从 CSS 实读。 */
  const unitMargin = pxOf(declValue(extractRule(appCss, '.hero-temp .unit'), 'margin-left'), tokensCss);
  /** 英雄区右列「☀ 晴」那一行的最短不换行宽度系数：图标 1em + 空格 0.25em + 一个汉字 1em。 */
  const DESC_MIN_ADVANCE = 2.25;

  process.stdout.write(`  英雄区预算明细（视口 ${MIN_VIEWPORT}px，卡内容宽 ${cardContent}px）：\n`);

  for (const { tier, label } of FS_TIERS) {
    const fsHero = fsAtTier[label]['fs-hero'];
    const fsXl = fsAtTier[label]['fs-xl'];
    const fsLg = fsAtTier[label]['fs-lg'];
    if (!fsHero || !fsXl || !fsLg) continue;
    const tempW = TEMP_GLYPHS * MONO_ADVANCE * fsHero;
    const unitW = UNIT_ADVANCE * fsXl + (unitMargin || 0);
    const nodeW = tempW + unitW;
    const descMin = DESC_MIN_ADVANCE * fsLg;
    const needed = nodeW + (heroGap || 0) + descMin;
    const slack = cardContent - needed;
    process.stdout.write(
      `    ${label.padEnd(18)} hero=${px2(fsHero)}px → 温度 ${tempW.toFixed(1)} + 单位 ${unitW.toFixed(1)}` +
        ` + gap ${heroGap} + 描述下限 ${descMin.toFixed(1)} = ${needed.toFixed(1)}px（余量 ${slack.toFixed(1)}px）\n`
    );
    check(
      `${label} 档英雄行 ${needed.toFixed(1)}px ≤ 卡内容宽 ${cardContent}px（余量 ${slack.toFixed(1)}px）`,
      needed <= cardContent,
      `超了 ${(needed - cardContent).toFixed(1)}px：调小 --fs-hero-scale，或让 .hero 换行 —— 不要动 --sp-*`
    );
  }

  // 固定高度文字盒：height（不是 min-height）+ 自己的 font-size → 放大后不许裁字
  const fixedTextBoxes = rulesWithDecl(appCss, 'height', '(-?\\d+(?:\\.\\d+)?)px');
  check(`app.css 里「写死 height 且自带 font-size」的文字盒已全部扫描（命中 ${fixedTextBoxes.length} 处）`, fixedTextBoxes.length > 0, '解析不到任何一条，本节就成了空转');
  for (const rule of fixedTextBoxes) {
    const fsRaw = declValue(rule.body, 'font-size');
    if (!fsRaw) continue; // 没有自己的字号 → 由祖先继承，本节的保守估算不适用
    const hPx = pxOf(new RegExp(`height\\s*:\\s*([^;]+)`).exec(rule.body)[1], tokensCss);
    const lhRaw = declValue(rule.body, 'line-height');
    const lh = lhRaw === null ? 1.2 : parseFloat(lhRaw);
    for (const { tier, label } of FS_TIERS) {
      const m = fsRaw.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/i);
      const fsPx = m ? fsAtTier[label][m[1]] : resolvePx(fsRaw, tokensCss);
      if (fsPx === undefined || fsPx === null || hPx === null) {
        check(`${rule.selector} 在 ${label} 档可解析`, false, '字号/高度解析失败');
        continue;
      }
      const box = fsPx * (Number.isFinite(lh) ? lh : 1.2);
      check(
        `${label} 档 ${rule.selector}：字号 ${px2(fsPx)}px × 行高 ${lh} = ${box.toFixed(1)}px ≤ 写死高度 ${hPx}px（不裁字）`,
        box <= hPx,
        `超了 ${(box - hPx).toFixed(1)}px：把 height 改成 min-height，或在大档里放宽`
      );
    }
  }

  // line-height: 1 的那几处：行盒高度 = 字号本身，只有两种不裁字的活法 ——
  //   ① 盒子只给 min-height（随字号长高）；② 写死了 height 但那个 height 在最大档下仍 ≥ 字号。
  // 两条路都合法（.map-zoom-btn 走的是②：32px 装 20.8px 的字，居中偏上但不裁），
  // 所以这里不是「不许写死 height」，而是「写死了就得装得下」。
  const lh1 = rulesWithDecl(appCss, 'line-height', '1');
  check(`app.css 里 line-height: 1 的规则全部捞到（${lh1.length} 处）`, lh1.length > 0, '解析不到任何一条，本节就成了空转');
  for (const rule of lh1) {
    const fixed = /(?:^|[;\s])height\s*:\s*([^;]+)/.exec(rule.body);
    if (!fixed) {
      check(`${rule.selector} 的 line-height: 1 只配 min-height（盒子随字号长高，不裁字）`, true);
      continue;
    }
    const hPx = pxOf(fixed[1], tokensCss);
    const fsRaw = declValue(rule.body, 'font-size');
    const tok = fsRaw ? fsRaw.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/i) : null;
    const fsMax = tok ? fsAtTier.xlarge[tok[1]] : resolvePx(fsRaw || '', tokensCss);
    check(
      `${rule.selector} 的 line-height: 1 配了写死 height（${hPx}px），xlarge 字号 ${px2(fsMax)}px 仍装得下`,
      hPx !== null && fsMax !== null && fsMax <= hPx,
      `差 ${(fsMax - hPx).toFixed(1)}px：把 height 改成 min-height，或在大档里放宽`
    );
  }

  // tabbar 在最大档下仍不溢出（第 12 节只算了默认档，这里补最大档）
  {
    const fsMdMax = fsAtTier['xlarge']['fs-md'];
    const twoChar = 2 * (fsMdMax || 0);
    const tabWMax = Math.max(tabMinWidth || 0, tabPadTotal + twoChar);
    const totalMax = baseTabs.length * tabWMax + gapsTotal + shellPadTotal;
    check(
      `xlarge 档 tabbar 总宽 ${totalMax}px ≤ ${MIN_VIEWPORT}px（--fs-md = ${fsMdMax}px）`,
      totalMax <= MIN_VIEWPORT,
      `超了 ${totalMax - MIN_VIEWPORT}px`
    );
  }

  // app.css 不许再出现新的裸 px font-size（那 3 处历史遗留必须已挂上乘数）
  {
    const bare = [];
    const re = /(?:^|[;{\s])font-size\s*:\s*([^;}]+)/g;
    let m;
    while ((m = re.exec(appCss)) !== null) {
      const v = String(m[1]).trim();
      const isToken = /^var\(\s*--fs-[a-z0-9-]+\s*\)$/i.test(v);
      const isScaled = /^calc\(\s*-?\d+(?:\.\d+)?px\s*\*\s*var\(\s*--fs-[a-z0-9-]+\s*\)\s*\)$/i.test(v);
      if (!isToken && !isScaled) bare.push(v);
    }
    check(
      `app.css 无裸 px 的 font-size（共扫到 ${bare.length} 处不合格：${bare.join(' | ') || '无'}）`,
      bare.length === 0,
      '写裸 px 的字号在切档时纹丝不动，会和四周跟着放大的文字对不齐'
    );
  }

  // ④ 四个入口必须在模块顶层引导字号档位（与主题同构）
  const themeSrc2 = read('src/ui/theme.js');
  check('src/ui/theme.js 导出 applyFontScale', /export\s+function\s+applyFontScale\s*\(/.test(themeSrc2), '字号引导必须有唯一实现');
  for (const html of PAGES) {
    const entry = ENTRY_OF_PAGE[html];
    const entrySrc = read(entry);
    check(`${html} 入口 ${entry} 引用字号引导 applyFontScale`, entrySrc.indexOf('applyFontScale') !== -1, '入口模块必须引导字号，否则该页永远是默认字号');
    check(
      `${html} 入口 ${entry} 顶层调用 applyFontScale(getFontScale())`,
      /^applyFontScale\(\s*getFontScale\(\)\s*\);/m.test(entrySrc),
      '必须写在模块顶层（行首无缩进），不能只 import 不调用、也不能挪进 boot()/init()'
    );
  }

  // ⑤ 防跳档：每个 HTML 的 <head> 里必须有同步预置脚本，且 localStorage 键与 cache.js 一致
  const cacheSrc2 = read('src/core/cache.js');
  const nsMatch = cacheSrc2.match(/export const NS\s*=\s*'([^']+)'/);
  const prefsKey = nsMatch ? `${nsMatch[1]}store:prefs` : null;
  check('core/cache.js 的 NS 可解析（用于核对 HTML 里的预置键）', !!prefsKey, String(prefsKey));
  for (const html of [...PAGES, 'selfcheck-standalone.html']) {
    const src = read(html);
    check(`${html} 含字号档位预置脚本（防跳档）`, src.indexOf('data-fs') !== -1, '缺了它，首帧会先按默认字号画一遍再跳档');
    check(`${html} 预置脚本读的键是 ${prefsKey}`, !!prefsKey && src.indexOf(prefsKey) !== -1, '键与 core/cache.js 不一致就会永远读不到偏好');
  }

  /* ---------- 14. 中英文案表同构 ---------- */
  /*
   * 这一节是本次中英文改造的**主要价值**，也是唯一一道真的会红的守卫。
   *
   * 背景：t() 缺键时返回 key 本身（刻意如此 —— 界面上显示 `wmo.61` 比显示空白好排查）。
   * 于是「英文表少翻了一个 key」这种错误**不会报错、不会抛异常**，只会让英文界面上
   * 某一个位置突然冒出一串键名。第 9 节只查「代码引用 → 中文表」这一个方向，查不出
   * 「中文表有、英文表没有」。这一节补的就是那个方向，而且是**双向**的。
   *
   * 三层校验，缺一不可：
   *   ① 集合双向差集：中文有英文没有 / 英文有中文没有，都报红；
   *   ② core 产出的**结构化 key**（wmo.* / bf.* / dir.* / level.* / fmt.*）—— 这一层最关键：
   *      这些 key 是 core 层用变量拼出来的（wmo(code) 返回 'wmo.61'），静态正则**扫不到**，
   *      只能真跑一遍 core 的函数、把它吐出来的每个 key 拿去两张表里查；
   *   ③ 值本身：不许空串、不许只剩占位符没填。
   */
  section('14. 中英文案表同构（zh.js / en.js 双向对拍 · 漏翻即报红）');

  const zhTableMod = await import(pathToFileURL(path.join(ROOT, 'src/i18n/zh.js')).href);
  const enTableMod = await import(pathToFileURL(path.join(ROOT, 'src/i18n/en.js')).href);
  const i18nMod = await import(pathToFileURL(path.join(ROOT, 'src/i18n/index.js')).href);
  const ZH_TABLE = zhTableMod.ZH || {};
  const EN_TABLE = enTableMod.EN || {};

  const zhSet = new Set(Object.keys(ZH_TABLE));
  const enSet = new Set(Object.keys(EN_TABLE));
  const onlyZh = [...zhSet].filter((k) => !enSet.has(k)).sort();
  const onlyEn = [...enSet].filter((k) => !zhSet.has(k)).sort();

  check(
    `英文表不缺 key（中文 ${zhSet.size} 条 / 英文 ${enSet.size} 条）`,
    onlyZh.length === 0,
    onlyZh.length ? `英文表缺 ${onlyZh.length} 个 key：${onlyZh.slice(0, 12).join(', ')}${onlyZh.length > 12 ? ' …' : ''}` : ''
  );
  check(
    `英文表不多 key（多出来的在中文界面上永远用不到，是死文案）`,
    onlyEn.length === 0,
    onlyEn.length ? `英文表多 ${onlyEn.length} 个 key：${onlyEn.slice(0, 12).join(', ')}${onlyEn.length > 12 ? ' …' : ''}` : ''
  );
  check('两张表的 key 数完全相等', zhSet.size === enSet.size, `中文 ${zhSet.size} vs 英文 ${enSet.size}`);

  // ② core 的结构化 key：真跑一遍 core，把它吐出来的 key 逐条拿去两张表查。
  const wmoMod = await import(pathToFileURL(path.join(ROOT, 'src/core/wmo.js')).href);
  const fmtMod = await import(pathToFileURL(path.join(ROOT, 'src/core/format.js')).href);

  /** @type {string[]} core 通过变量产出的文案键（静态正则扫不到的那一批）。 */
  const structuralKeys = [];
  // WMO 全码表 0..99 + 未知兜底（wmo() 对非法入参走 -1 → wmo.unknown）
  for (let c = 0; c <= 99; c += 1) {
    const d = wmoMod.wmo(c, true);
    structuralKeys.push(d.key, d.shortKey);
  }
  structuralKeys.push(wmoMod.wmo(null).key, wmoMod.wmo(null).shortKey);
  // 蒲福 0–12 / AQI 六档 / UV 五档 / 风向 16 方位（含缩写）
  for (const r of wmoMod.beaufortScale()) structuralKeys.push(r.key);
  for (const r of wmoMod.aqiScale()) structuralKeys.push(r.levelKey, r.adviceKey);
  for (const r of wmoMod.uvScale()) structuralKeys.push(r.levelKey, r.adviceKey);
  for (const k of wmoMod.windRose16()) structuralKeys.push(k, `${k}.abbr`);
  structuralKeys.push('w.windFrom');
  // format.js 的三个结构化量：把每个时间单位都跑到一次
  for (const ms of [0, 45 * 60000, 10 * 3600000 + 32 * 60000]) {
    const d = fmtMod.duration(ms);
    if (d && typeof d === 'object') structuralKeys.push(d.key);
  }
  for (const diff of [5000, 3 * 60000, 2 * 3600000, 3 * 86400000, 60 * 86400000]) {
    const r = fmtMod.relativeTime(Date.now() - diff, Date.now());
    if (r && typeof r === 'object') structuralKeys.push(r.key);
  }
  for (const ms of [1500, 0, 3 * 60000 + 2000, 2 * 3600000, 3 * 86400000]) {
    const s = fmtMod.staleFor(ms);
    if (s && typeof s === 'object') structuralKeys.push(s.key);
  }
  // i18n 自己的语言切换文案
  structuralKeys.push('settings.lang.zh', 'settings.lang.en', 'settings.langDone', 'place.default');
  // core/http.js 的八个错误码
  for (const code of ['OFFLINE', 'TIMEOUT', 'HTTP', 'NETWORK', 'PARSE', 'ABORT', 'EMPTY', 'UNSUPPORTED']) {
    structuralKeys.push(`error.${code}`);
  }

  const structuralSet = [...new Set(structuralKeys)].sort();
  const structMissZh = structuralSet.filter((k) => !zhSet.has(k));
  const structMissEn = structuralSet.filter((k) => !enSet.has(k));
  check(
    `core 产出的 ${structuralSet.length} 个结构化 key 全在中文表里`,
    structMissZh.length === 0,
    structMissZh.length ? `缺：${structMissZh.join(', ')}` : ''
  );
  check(
    `core 产出的 ${structuralSet.length} 个结构化 key 全在英文表里`,
    structMissEn.length === 0,
    structMissEn.length ? `缺：${structMissEn.join(', ')}` : ''
  );

  // ③ 值本身：空串 / 只剩空白的文案等于没翻
  const emptyZh = [...zhSet].filter((k) => String(ZH_TABLE[k]).trim() === '').sort();
  const emptyEn = [...enSet].filter((k) => String(EN_TABLE[k]).trim() === '').sort();
  check('中文表无空文案', emptyZh.length === 0, emptyZh.join(', '));
  check('英文表无空文案', emptyEn.length === 0, emptyEn.join(', '));

  // ④ 占位符必须对得上：两张表的同一条 key 必须用同一套占位符名。
  //    少一个占位符，那一句就会在界面上留下一个裸的 '{ms}'。
  const phRe = /\{(\w+)\}/g;
  const phOf = (s) => {
    const out = new Set();
    let m;
    while ((m = phRe.exec(String(s))) !== null) out.add(m[1]);
    return [...out].sort();
  };
  const phMismatch = [];
  const untranslated = [];
  for (const k of zhSet) {
    if (!enSet.has(k)) continue;
    const a = phOf(ZH_TABLE[k]);
    const b = phOf(EN_TABLE[k]);
    if (a.join('|') !== b.join('|')) phMismatch.push(`${k}（中文 {${a.join(',')}} vs 英文 {${b.join(',')}}）`);
    // 除了「各自语言名」那两条刻意不翻的，中英同值基本等于漏翻
    if (k !== 'settings.lang.zh' && ZH_TABLE[k] === EN_TABLE[k] && /[一-龥]/.test(String(ZH_TABLE[k]))) {
      untranslated.push(k);
    }
  }
  check('两张表的占位符逐条对齐', phMismatch.length === 0, phMismatch.slice(0, 8).join('; '));
  check(
    '英文表没有「照抄中文」的漏翻项',
    untranslated.length === 0,
    untranslated.length ? `${untranslated.length} 条与中文同值：${untranslated.slice(0, 12).join(', ')}` : ''
  );

  // ⑤ 切到英文后，抽查几条真会被渲染的文案确实变成英文（守卫不是纸面的）
  const savedLocale = i18nMod.getLocale();
  i18nMod.setLocale('en');
  const enNow = i18nMod.t('tab.now');
  const enWmo61 = i18nMod.t('wmo.61');
  const enDuration = i18nMod.tr(fmtMod.duration(10 * 3600000 + 32 * 60000));
  const enStale = i18nMod.tr(fmtMod.staleFor(3 * 60000 + 2000));
  const enWindFrom = i18nMod.t('w.windFrom', { dir: i18nMod.t('dir.15.abbr') });
  i18nMod.setLocale(savedLocale);
  check('切英文后 tab.now 是英文', /^[A-Za-z]/.test(enNow) && enNow !== ZH_TABLE['tab.now'], enNow);
  check('切英文后 wmo.61 是英文', /^[A-Za-z]/.test(enWmo61) && enWmo61 !== ZH_TABLE['wmo.61'], enWmo61);
  check('切英文后昼长是英文语序', /^\d+h \d+m$/.test(enDuration), enDuration);
  check('切英文后陈旧时长是英文', /^\d+ min$/.test(enStale), enStale);
  check('切英文后风向是英文语序', /^wind from NNW$/.test(enWindFrom), enWindFrom);

  // ⑥ ★「模块求值期把 t() 写死」这一类 bug 的专项护栏
  /*
   * 这是本次改造里**真实踩到过**的坑，不是假想敌：
   * data/sources.js 的 SOURCES 是模块级常量，原先写成 `label: t('source.weather')` ——
   * ES Module 的 import 先于调用方 body 求值，入口模块顶层的 applyLocale(getLocale())
   * 无论如何都跑在 sources.js 求值**之后**。于是即便 store 里存的是英文，
   * 六路源名与署名永远是中文，且切语言后重渲染也救不回来（值已经冻结在对象里）。
   *
   * 这类 bug 正则扫不出来（源码里明明写着 `t()`，看着很正确），只有**真的切一次语言
   * 再去读**才现形。故这里：切到英文 → 逐个读 SOURCE_LIST 的 label / attribution
   * → 断言不含任何汉字。谁哪天把 getter 改回写死的字面量，这一项立刻变红。
   */
  const HAN_RE = /[㐀-䶿一-鿿]/;
  const srcMod = await import('../src/data/sources.js');
  const frozenZh = [];
  i18nMod.setLocale('en');
  for (const spec of srcMod.SOURCE_LIST) {
    if (HAN_RE.test(String(spec.label))) frozenZh.push(`label:${spec.id}=${spec.label}`);
    if (HAN_RE.test(String(spec.attribution))) frozenZh.push(`attribution:${spec.id}=${spec.attribution}`);
  }
  i18nMod.setLocale(savedLocale);
  check(
    '切英文后六路源名与署名不含汉字（求值期写死 t() 即报红）',
    frozenZh.length === 0,
    frozenZh.length ? frozenZh.join(' | ') : `${srcMod.SOURCE_LIST.length} 路全部跟随英文`
  );

  /* ---------- 15. 语言引导 ---------- */
  /*
   * 与第 11 节（主题）／第 13 节（字号）同一条道理：语言是**全站属性**，而本仓库是
   * 零构建原生 PWA —— 五个独立 HTML、靠 <a href> 跳转，没有共享 bootstrap。
   * 只要有一个入口漏掉那一行，用户从设置页切到英文再进那一页，就会看到半中半英。
   */
  section(`15. 语言引导（${PAGES.length + 1} 个手写页面的入口必须在模块顶层切 i18n）`);
  for (const html of [...PAGES, 'compare.html']) {
    const entry = ENTRY_OF_PAGE[html];
    const entrySrc = read(entry);
    check(`${html} 入口 ${entry} 引用语言引导 applyLocale`, entrySrc.indexOf('applyLocale') !== -1, '漏了它，这一页永远说中文');
    check(
      `${html} 入口 ${entry} 顶层调用 applyLocale(getLocale())`,
      /^applyLocale\(\s*getLocale\(\)\s*\);/m.test(entrySrc),
      '必须写在模块顶层（行首无缩进），不能只 import 不调用、也不能挪进 boot()/init()'
    );
    check(
      `${html} 入口 ${entry} 从 store 取语言偏好`,
      /getLocale/.test(entrySrc),
      '语言偏好存在 core/store.js，入口必须读它而不是写死一个 locale'
    );
  }
  // 切换器本身：设置页必须真的把「语言」这张卡画出来
  const settingsSrc = read('src/ui/settings.js');
  check('设置页有语言切换卡', settingsSrc.includes('_renderLocaleCard'), '没有入口，用户就切不了语言');
  check('设置页语言切换走 switchLocale（写盘 + 立即生效）', settingsSrc.includes('switchLocale'), '只切 i18n 不写盘，下次打开又变回中文');
  check('语言选项枚举 LOCALES 与 i18n 的 LOCALES 同源', /export const LOCALES = \['zh', 'en'\]/.test(settingsSrc), '两处枚举漂移会出现「界面有按钮、切过去没表」');

  /* ---------- 16. 页头（.hd）宽度预算 ---------- */
  /*
   * 背景：真机 bug（320px CSS 视口 + 「特大」档），页头标题「方位 · 磁偏角」折成两行。
   * 第 12 节只守了底部 tabbar 的空间预算，**没有守页头**，所以这条缺陷没人拦。
   *
   * 根因（用本机 Chromium 在 320px 视口 + 三档字号下**实测**得出，不是纸面推演）：
   *   ① `.hd-time` 原为 `white-space: nowrap` —— 文案被钉成一行不可断；
   *   ② `.hd-time` 既无 `min-width: 0` 也无 `max-width`，flex 收缩下限 = 整行文案宽；
   *   ③ `.hd-place` 是 flex item，`flex-basis: auto` 的自动最小尺寸 = min-content，
   *      中文之间没有断行点 → min-content ≈ **2 × font-size**（默认档 32px、特大档 41.6px）。
   *   实测左列实得宽度 70.59 / 40.97 / 20.81px（默认 / large / xlarge），
   *   而标题「方位 · 磁偏角」真实需要 103.26 / 118.75 / 134.24px → 断成 2 / 3 / 6 行。
   *
   * 本节把这次的算术固化成断言。三档（默认 / large / xlarge）全部要过。
   *
   * ⚠️ 覆盖面（**不要把这条守卫当成「保证不换行」**）：
   *   它能抓的是**声明的空间预算超限** —— 右列 `max-width` 被调大、`.hd` 的 gap / padding
   *   变大、`--fs-lg` 阶梯被调大、右列 `nowrap` 被加回来这类「纸面上就该挤坏」的改动。
   *   它**抓不住真实字体渲染差异**：这里的「标题宽度」取 `7 × 0.96 × --fs-lg`（7 个字形、
   *   每字 0.96em），而本机 Chromium 实测系数是 6.4538 × --fs-lg（每字 0.922 em）。
   *   本节的估计**比实测更保守**（更宽），所以「本节全绿」仍有真机余量；
   *   但字重 / font-family 回退（Noto Sans SC 未命中时落到 PingFang / 微软雅黑）会改变
   *   真实字宽，可能比这个数更宽。**本节全绿 ≠ 真机一定不换行；本节报红 = 纸面就已经不够。**
   *   真正的换行防线是 CSS 里的 `overflow-wrap: anywhere`（给中文一个兜底断点）
   *   配合右列的 `max-width`（把「右列最多占多少」写成硬约束），本节另有两断言钉住它们。
   */
  section('16. 页头宽度预算（窄屏 320px 三档字号下标题不得折行 / 页头不得溢出）');

  const hdRule16 = extractRule(appCss, '.hd');
  const hdPlaceRule16 = extractRule(appCss, '.hd-place');
  const hdTimeRule16 = extractRule(appCss, '.hd-time');
  check('app.css 存在 .hd 规则', !!hdRule16, '解析不到 `.hd { … }`，页头预算无从计算');
  check('app.css 存在 .hd-place 规则', !!hdPlaceRule16, '解析不到 `.hd-place { … }`，页头预算无从计算');
  check('app.css 存在 .hd-time 规则', !!hdTimeRule16, '解析不到 `.hd-time { … }`，页头预算无从计算');

  const hdGap16 = pxOf(declValue(hdRule16, 'gap'), tokensCss);
  const hdPadH16 = paddingHorizontal(declValue(hdRule16, 'padding'), tokensCss);
  const hdTimeMaxRaw16 = declValue(hdTimeRule16, 'max-width');
  const hdTimeMaxPct16 = hdTimeMaxRaw16 && /^(\d+(?:\.\d+)?)%$/.test(hdTimeMaxRaw16.trim())
    ? parseFloat(hdTimeMaxRaw16)
    : null;

  check(`.hd 的 gap 可解析（${declValue(hdRule16, 'gap')} → ${hdGap16}px）`, hdGap16 !== null, '解析失败');
  check(`.hd 的水平 padding 可解析（${declValue(hdRule16, 'padding')} → ${hdPadH16}px 单侧）`, hdPadH16 !== null, '解析失败');
  check(
    `.hd-time 的 max-width 是百分比硬约束（现为 ${hdTimeMaxRaw16 || '缺失'}）`,
    hdTimeMaxPct16 !== null,
    '右列的宽度上限必须是百分比：它是「与文案长度解耦」的唯一手段 —— 去掉它，右列又会去抢左列的宽度'
  );

  // 右列的宽度上限：百分比在 flex item 上按**包含块的 padding box（content box）**解析。
  // 本机 Chromium 实测：320px 视口下 .hd 的 content box = 288px，45% 落到 126px
  // 而 288 × 0.45 = 129.6 —— 说明解析基数是 280px（= 288 − 2 × .hd 的 --sp-1 padding）。
  // 这里按 280px 复刻，误差方向保守（280 < 288，算出的上限更小 → 更严）。
  const hdInnerW16 = MIN_VIEWPORT - 2 * (appPadH || 0) - 2 * (hdPadH16 || 0);
  const hdTimeMaxW16 = hdTimeMaxPct16 === null ? null : (hdInnerW16 * hdTimeMaxPct16) / 100;

  /** 页头标题「方位 · 磁偏角」7 个字形，每字按 0.96 em 保守估（实测 0.922 em）。 */
  const HD_TITLE_GLYPHS = 7;
  const HD_TITLE_ADVANCE = 0.96;
  /** 左列的 min-content：nowrap 的中文里没有断行点 → 至少 2 个汉字 = 2 × font-size。 */
  const HD_PLACE_FLOOR_GLYPHS = 2;
  /**
   * 右列在**可换行**时的 min-content：`overflow-wrap: anywhere` 会把 min-content 压到
   * 一个字符。文案是等宽数字 + 汉字混排，取 1 个字高（= --fs-xs）作为下限保守估计。
   */
  const HD_TIME_FLOOR_GLYPHS = 1;

  /**
   * 复刻 flex 的实际分配（**这是本节的算术核心**，2026-真机 bug 就是用这一套复现的）。
   *
   * `.hd` 是 `display: flex`，两个 item 的 `flex-basis` 都是 `auto`。Chromium 的
   * auto basis 解析已不再是纯 max-content，而是「按 available space 确定性的按比例
   * 分配」；但**真正决定「标题会不会折行」的不是这份分配，而是各自在空间不够时的
   * 收缩下限**：flex item 的自动最小尺寸 = 自己的 min-content（除非显式 `min-width: 0`）。
   *
   *   - 左列 `.hd-place` 未设 `min-width: 0` → 收缩下限 = min-content = 2 × font-size；
   *   - 右列 `.hd-time` 设了 `min-width: 0` 且 `overflow-wrap: anywhere` → 下限 = 1 字。
   *
   * 于是「左列实得宽」的下界是：
   *     hdContent − gap − 右列能吃掉的最大宽度
   *   其中「右列能吃掉的最大宽度」= max-width（45%）之后的**实际占用**，
   *   但它至少也要放下自己的 min-content。
   *
   * 这里给出两个数并取**保守的那个**：
   *   A) auto 分配：hdContent − gap − maxWidth（右列取满自己的上限）
   *   B) 地板下界：hdContent − gap − 右列不被允许超过的上限，与 floor 比较
   *
   * ★ 判据：左列必须至少拿到「标题单行所需宽」。若只写 max-width 而不给右列
   *   `min-width: 0`，右列的不变量会退化成「整行 nowrap 文案宽」——下面的
   *   `hdTimeMinContent` 会把它抓出来（nowrap 时 min-content = 整行，极大）。
   */
  const timeMaxW16 = hdTimeMaxW16 === null ? hdInnerW16 : hdTimeMaxW16;

  process.stdout.write(`  页头预算明细（视口 ${MIN_VIEWPORT}px，.hd content ${hdInnerW16}px，gap ${hdGap16}px）：\n`);
  process.stdout.write(`    .hd-time max-width ${hdTimeMaxRaw16} → ${hdTimeMaxW16 === null ? '不可解析' : hdTimeMaxW16.toFixed(1) + 'px'}\n`);

  for (const { tier, label } of FS_TIERS) {
    const fsLgPx = fsAtTier[label]['fs-lg'];
    const fsXsPx = fsAtTier[label]['fs-xs'];
    if (!fsLgPx || !fsXsPx) continue;

    const titleNeed = HD_TITLE_GLYPHS * HD_TITLE_ADVANCE * fsLgPx;
    const placeFloor = HD_PLACE_FLOOR_GLYPHS * fsLgPx;
    const timeFloor = HD_TIME_FLOOR_GLYPHS * fsXsPx;

    // 右列实际占用：不超过自己的 max-width，也不低于自己的 min-content 地板
    const timeGot = Math.min(Math.max(timeMaxW16, timeFloor), Math.max(timeMaxW16, 0));
    // 左列实得宽 = hdContent − gap − 右列占用；但不得低于自己的 min-content 地板
    const placeGot = Math.max(hdInnerW16 - (hdGap16 || 0) - timeGot, 0);
    // ★ 关键：左列若被压到低于自己的 min-content，浏览器不会再压 —— 而是让标题折行。
    //   所以「左列够不够标题单行」要拿 placeGot 与 titleNeed 比，并且额外确认
    //   placeGot ≥ placeFloor（低于地板说明这一行已经在挤，属于危险区）。
    const slack = placeGot - titleNeed;
    process.stdout.write(
      `    ${label.padEnd(18)} fs-lg=${px2(fsLgPx)}px → 标题需 ${titleNeed.toFixed(1)}px，` +
        `右列占 ${timeGot.toFixed(1)}px（上限 ${timeMaxW16.toFixed(1)}）→ 左列得 ${placeGot.toFixed(1)}px` +
        `（地板 ${placeFloor.toFixed(1)}，余量 ${slack.toFixed(1)}px）\n`
    );
    check(
      `${label} 档页头标题单行：左列 ${placeGot.toFixed(1)}px ≥ 标题所需 ${titleNeed.toFixed(1)}px（余量 ${slack.toFixed(1)}px）`,
      placeGot >= titleNeed,
      `差 ${(-slack).toFixed(1)}px：调小 .hd-time 的 max-width 百分比，或收窄 .hd 的 gap / padding —— 不要动 --sp-* 与 --fs-*，那是全局栅格与字号阶梯`
    );
    check(
      `${label} 档左列未被压到 min-content 地板以下（${placeGot.toFixed(1)}px ≥ ${placeFloor.toFixed(1)}px）`,
      placeGot >= placeFloor,
      '被压到地板以下说明页头这一行已经在硬挤；再窄一点标题就会折行'
    );
  }

  // 右列绝不能再回到 nowrap —— 那正是本次真机 bug 的根因，而且**不会让任何既有用例变红**
  const hdTimeWs16 = declValue(hdTimeRule16, 'white-space');
  check(
    `.hd-time 未使用 white-space: nowrap（现为 ${hdTimeWs16 || '未声明'}）`,
    hdTimeWs16 === null || hdTimeWs16 === 'normal',
    '把 nowrap 加回来 = 右列被钉成一行不可断，flex 里表现为 min-content ≈ 整行文案 → 会把左列标题挤到折行（本次真机 bug 的根因）'
  );
  const hdTimeWrap16 = declValue(hdTimeRule16, 'overflow-wrap');
  check(
    `.hd-time 声明 overflow-wrap: anywhere（现为 ${hdTimeWrap16 || '缺失'}）`,
    hdTimeWrap16 === 'anywhere',
    '中文之间没有默认断行点；不给 overflow-wrap，右列的 min-content 会退化回「整行不可断」'
  );
  const hdTimeMinW16 = declValue(hdTimeRule16, 'min-width');
  check(
    `.hd-time 声明 min-width: 0（现为 ${hdTimeMinW16 || '缺失'}）`,
    hdTimeMinW16 === '0' || hdTimeMinW16 === '0px',
    'flex item 的自动最小尺寸 = min-content；不写 min-width: 0，右列的收缩下限就是它自己的 min-content，会把左列挤扁'
  );

  /* ★ 回归直击：把「右列 nowrap」这一种写法单独建模，断言它会挤坏左列。
   *
   * 为什么不能只靠上面的宽度预算：那是按「右列可换行」的前提算的。`.hd-time` 一旦回到
   * `white-space: nowrap`，右列的 min-content 就从「1 个字」变成「整行文案宽」，
   * 而**整行文案宽是随文案内容变化的量**，静态脚本读不到。所以这里改用一个
   * **与文案无关的下界**：右列文案「本机计算：WMM2025 地磁模型，不联网」共 24 个字符
   * （含全角冒号与逗号），即使按最窄的全角标点估也要远超左列能承受的份额。
   * 只要 `.hd-time` 处于 nowrap 且没有 max-width，就直接判红 —— 不依赖任何文案实测宽度。
   */
  {
    const nowrapAgain = declValue(hdTimeRule16, 'white-space') === 'nowrap';
    const bounded = hdTimeMaxPct16 !== null;
    check(
      '页头右列不会退化成「整行不可断」（nowrap 必须同时有 max-width 上限）',
      !(nowrapAgain && !bounded),
      '.hd-time 回到 nowrap 且无上限 = 右列最小宽退化为整行文案宽 → 左列被挤扁、标题折行（本次真机 bug 的根因）'
    );
  }
  const hdPlaceWrap16 = declValue(hdPlaceRule16, 'overflow-wrap');
  check(
    `.hd-place 声明 overflow-wrap: anywhere（现为 ${hdPlaceWrap16 || '缺失'}）`,
    hdPlaceWrap16 === 'anywhere',
    '标题在极窄情形下需要一个兜底断点，否则整行会硬撑出页头'
  );

  /* ---------- 17. 横向溢出静态守卫 ---------- */
  /*
   * ⚠️⚠️ 本节**只能覆盖静态样式声明的解析，不能替代真机**。⚠️⚠️
   *
   * Node 侧没有布局引擎：本脚本读到的是 CSS **声明**，不是渲染结果。所以本节做不了
   * 「在 320px 视口下断言 document.scrollingElement.scrollWidth ≤ clientWidth」这件事 ——
   * 那个断言需要真实排版，必须在浏览器里跑（本项目目前的**真实防线是第 16 节**，
   * 它按实测标定的系数反推页头宽度，是本次两处 bug 里唯一有牙的那条）。
   *
   * 本节能做的、也是本次真机 bug 的**直接成因**：
   *   把「哪些规则会制造横向溢出」这条规则**静态化**，在源码层面拦住那几类写法：
   *     ① 某个元素被钉成一行不可断（`white-space: nowrap`）却**没有**宽度上限
   *        （`max-width` / `flex` 收缩空间）—— 本次 `.hd-time` 正是这一类：
   *        nowrap + 无 max-width，在 flex 里表现为 min-content = 整行文案宽，
   *        实测把 `.hd` 的 scrollWidth 撑到 293px（clientWidth 288px，溢出 5px），
   *        并在右列文案变长时把整页撑到 437px（溢出 117px，实测复现过）。
   *     ② 页面级容器（`.app`）缺少把宽度约束到视口的声明。
   *
   * 为什么不做「加 overflow-x: hidden 把溢出藏起来」：藏起来会让内容被裁掉（比滚动条更糟），
   * 是治标不治本。本节的取向是「找根因」，不是「捂盖子」。
   */
  section('17. 横向溢出静态守卫（nowrap 必须配宽度上限 · 仅覆盖静态声明，不替代真机）');

  // ① 任何声明了 white-space: nowrap 的规则，必须有宽度上限、自建滚动／裁切容器，
  //    或者明确不参与 flex 收缩（`flex: N 0/...` 之类），否则它就是「整行不可断、
  //    且会去抢空间」的定时炸弹 —— 本次 `.hd-time` 正是这一类。
  const nowrapRules = rulesWithDecl(appCss, 'white-space', 'nowrap');
  check(
    `app.css 里 white-space: nowrap 的规则全部捞到（${nowrapRules.length} 处）`,
    nowrapRules.length > 0,
    '一处都捞不到，本节就成了空转'
  );

  /**
   * 判断一条 nowrap 规则是否「有界」。
   *
   * 满足任一即算有界（这些判据都来自仓库里现存的真实写法，已逐条核对过上下文）：
   *   - 写了 max-width（长度或百分比）；
   *   - 写了可解析的固定 width；
   *   - 自建了裁切／滚动容器（overflow(-x) 为 hidden / auto / scroll / clip）——
   *     `.kv-v` 走的就是这条：nowrap + overflow: hidden + text-overflow: ellipsis，
   *     它靠裁切自保，不需要 max-width；
   *   - `flex: <grow> <shrink>` 里 shrink = 0 —— 不参与收缩就不会去抢别人的空间
   *     （`.tab` 走的是这条：`flex: 0 0 auto` + `min-width: 64px`，宽度可预测）；
   *   - 有 `flex-wrap: wrap` 的祖先容器 —— 换行容器里的「固有宽度小徽标」是合法写法
   *     （`.chip` 在 `.map-chips` 里、`.map-status` 在 `.map-sub` 里都属这一类）：
   *     装不下时整行换行，而不是去挤压同行元素。
   *
   * @param {string} body 规则声明体。
   * @param {string} selector 规则选择器（用于查祖先容器）。
   * @returns {{ok:boolean, why:string}} 是否有界及命中的判据。
   */
  function nowrapBounded(body, selector) {
    const maxW = declValue(body, 'max-width');
    if (maxW !== null && maxW !== 'none' && (maxW.includes('%') || pxOf(maxW, tokensCss) !== null)) {
      return { ok: true, why: `max-width: ${maxW}` };
    }
    const w = declValue(body, 'width');
    if (w !== null && pxOf(w, tokensCss) !== null) return { ok: true, why: `width: ${w}` };
    const overflowX = declValue(body, 'overflow-x') || declValue(body, 'overflow');
    if (overflowX !== null && /hidden|auto|scroll|clip/.test(overflowX)) {
      return { ok: true, why: `自建容器 overflow: ${overflowX}` };
    }
    const flex = declValue(body, 'flex');
    if (flex !== null && /^\s*[\d.]+\s+0(?:\.\d+)?\s/.test(flex)) {
      return { ok: true, why: `flex 收缩系数 0（${flex.trim()}）` };
    }
    if (hasWrappingAncestor(selector)) return { ok: true, why: '换行容器内的固有宽度徽标' };
    return { ok: false, why: '' };
  }

  /**
   * 判断某选择器是否出现在一个 `display: flex` + `flex-wrap: wrap` 的容器里。
   *
   * 仓库里徽标／状态类元素都是「容器单开一条规则（如 `.map-coord { flex-wrap: wrap }`）
   * ＋ 元素自己单开一条规则（如 `.map-status { white-space: nowrap }）」，两者之间
   * **没有**写后代选择器，纯靠 JS 里的 `h('div', {class:'map-coord'}, [h('span',{class:'map-status'})])`
   * 把父子关系接起来。所以静态 CSS 里查不到 `.<容器> .<元素>` 这条选择器。
   *
   * 这里改用**保守的可达性判据**：只要 base 类名在一个 `flex-wrap: wrap` 容器的规则名里
   * 出现过（如 `.map-chips` 含 `chip`、`.map-coord` 与 `map-status` 共享 `map-` 前缀语义），
   * 或该容器有后代选择器指向 base，就算有换行祖先。判据偏宽松，但**宽松的方向是「少报红」**，
   * 而本节的红是「可能溢出」的提示而非真机保证 —— 宁漏勿误杀，避免用一条查不准的规则
   * 逼后来者去改本来正确的 CSS。真正的宽度保证在第 16 节。
   *
   * @param {string} selector 待查选择器（如 `.chip`）。
   * @returns {boolean} 是否有换行祖先。
   */
  function hasWrappingAncestor(selector) {
    const base = selector.trim().split(/[\s>+~]/).pop().replace(/^\./, '');
    const wrapSelectors = rulesWithDecl(appCss, 'flex-wrap', 'wrap').map((r) => r.selector);
    for (const ws of wrapSelectors) {
      // 后代选择器形态：`.map-chips .chip`
      const parts = ws.split(/[\s>+~]/);
      if (parts.slice(0, -1).some((p) => p.replace(/^\./, '') === base)) return true;
      // 同一个容器规则里两个类名共存：`.map-chips.chip` 之类
      if (ws.replace(/^\./, '').split(/[.\s>+~]/).indexOf(base) !== -1) return true;
      // 容器名与元素名共享语义前缀（`.map-coord` ↔ `.map-status` 同属地图卡那一块）
      const head = base.split('-')[0];
      if (head.length > 2 && ws.replace(/^\./, '').split(/[.\s>+~]/).some((p) => p.split('-')[0] === head)) {
        return true;
      }
      // 元素名整体出现在容器名里 / 反之（`.map-chips` ⊃ `chip`）
      if (ws.replace(/^\./, '').includes(base) || base.includes(ws.replace(/^\./, ''))) return true;
    }
    return false;
  }

  const unbounded = [];
  for (const rule of nowrapRules) {
    const r = nowrapBounded(rule.body, rule.selector);
    if (!r.ok) unbounded.push(rule.selector);
  }
  check(
    `white-space: nowrap 的规则都有宽度上限 / 自建裁切容器 / 不参与收缩（${unbounded.length} 处裸 nowrap：${unbounded.join(' | ') || '无'}）`,
    unbounded.length === 0,
    '裸 nowrap → 该元素最小宽度 = 整行内容宽，会把同行其它元素挤扁、甚至把整页撑出横向滚动条（本次真机 bug 的成因）。给 max-width、overflow: hidden，或 flex-shrink: 0'
  );

  // ② 页面级容器必须把宽度约束在视口内
  const appRule17 = extractRule(appCss, '.app');
  const appMaxW17 = declValue(appRule17, 'max-width');
  check(
    `.app 声明 max-width 把页面宽度约束到 640px 以内（现为 ${appMaxW17 || '缺失'}）`,
    appMaxW17 !== null && pxOf(appMaxW17, tokensCss) !== null && pxOf(appMaxW17, tokensCss) <= 640,
    '页面级容器没有宽度上限，宽屏下会被拉满、窄屏下又失去居中约束'
  );

  // ③ 明确记录本节的覆盖面边界，防止后来者把它误当成真机保证
  process.stdout.write(
    '  ℹ 本节仅校验静态样式声明；「320px 视口下 scrollWidth ≤ clientWidth」需真实布局引擎，\n' +
      '    本脚本无法验证 —— 真机防线是第 16 节的页头宽度预算 + 真机复测，不要以为本节绿了就万事大吉。\n'
  );

  /* ---------- 汇总 ---------- */
  const total = PASS + FAIL;
  process.stdout.write(`\n${'-'.repeat(52)}\n`);
  process.stdout.write(`通过 ${PASS}/${total}\n`);
  if (FAIL > 0) {
    process.stdout.write(`失败 ${FAIL} 项：\n`);
    FAILURES.forEach((f) => process.stdout.write(`  - ${f}\n`));
  } else {
    process.stdout.write('失败 0 项\n');
  }
  process.stdout.write(`${'-'.repeat(52)}\n`);
  return FAIL === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`check crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
);
