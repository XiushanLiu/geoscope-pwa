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
    const re = /import\s+([^;'"]*?)\s+from\s+['"](\.[^'"]+)['"]/g;
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
  check('UI 文案走 t()（now.js 无硬编码中文键名遗漏抽查）', nowSrc.includes("from '../i18n/zh.js'"));
  const zh = read('src/i18n/zh.js');
  check('i18n 无 md5 字样', !/md5/i.test(zh));
  const tiles = read('src/data/tiles.js');
  check('瓦片指纹用 SHA-256（无 md5）', /SHA-256/.test(tiles) && !/md5/i.test(tiles));

  /* ---------- 9. i18n 键完整性 ---------- */
  section('9. i18n 键完整性（data-i18n 占位 + t() 调用）');
  const zhSrc = read('src/i18n/zh.js');
  const i18nKeys = new Set();
  const keyRe = /^\s*'([a-zA-Z0-9._-]+)':/gm;
  let km;
  while ((km = keyRe.exec(zhSrc)) !== null) i18nKeys.add(km[1]);
  check('i18n 表非空', i18nKeys.size > 50, String(i18nKeys.size));
  for (const html of htmlFiles) {
    const src = read(html);
    const re = /data-i18n="([^"]+)"/g;
    let m;
    let n = 0;
    while ((m = re.exec(src)) !== null) {
      n += 1;
      check(`${html} data-i18n="${m[1]}" 存在于文案表`, i18nKeys.has(m[1]), m[1]);
    }
    check(`${html} 的静态文案全部走 i18n（共 ${n} 处）`, n > 0);
  }
  // t('literal') 字面量调用必须命中
  for (const rel of srcFiles) {
    const src = read(rel);
    const re = /\bt\(\s*'([a-zA-Z0-9._-]+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      check(`${rel} → t('${m[1]}') 存在于文案表`, i18nKeys.has(m[1]), m[1]);
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
