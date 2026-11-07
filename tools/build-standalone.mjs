/**
 * 打包「数据源自检页」为单文件 HTML。
 *
 * 目的：让用户把这一个文件发到手机（微信 / 邮件 / 文件传输助手），
 * 直接在手机浏览器打开即可跑自检 —— 不需要服务器、不需要托管、不需要账号。
 *
 * 手法：把 ORDER 里登记的每个 ES Module 源码内联进 HTML（**不写死数量**，加模块只改 ORDER 一处），
 * 运行时按依赖顺序
 * 逐个生成 Blob URL（把相对 import 说明符改写成已生成的 Blob URL），
 * 最后动态 import 入口模块。这样每个模块仍是独立作用域，不会互相污染命名。
 *
 * 用法：node tools/build-standalone.mjs
 * 输出：selfcheck-standalone.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
// ★换行规范化**只准有一份实现**：直接复用 bump-shell.mjs 导出的 `normalizeEol()`，
//   不在这里抄第三份。抄散了就会互相打架（壳指纹按 A 规范化、产物按 B 规范化），
//   而这类不一致不报错，只在「哪天有人改了其中一份」的时候突然冒出来。
import { normalizeEol } from './bump-shell.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读文件（**全仓唯一的读取入口**，规范化也只在这一处做）。
 *
 * ★为什么要规范化：本仓 `.gitattributes` 锁 `* text=auto eol=lf`，但工作副本在 Windows 上
 *   会残留 CRLF（`styles/app.css`、`index.html` 实测就是）。产物把源码**原样**内联，
 *   于是产物字节会随工作副本的换行形态漂移 —— 实测 1473 字节（= app.css 1405 行 +
 *   index.html 68 行的 CR）。那会污染一个真在用的判据：「重跑 build 后 git status 干净
 *   ⇒ 产物真没变」—— 它可能因为 EOL 变化而脏，也可能因为 EOL 恰好抵消而干净。
 *   产物字节必须只由源码的**逻辑内容**决定。
 *
 * @param {string} p 仓库相对路径。
 * @returns {string} 换行统一为 `\n` 的内容。
 */
const read = (p) => normalizeEol(readFileSync(resolve(ROOT, p), 'utf8'));

/**
 * 单文件产物专用的内联 favicon（SVG data-URI）。
 *
 * ★只能内联：selfcheck-standalone.html 是发到手机单独打开的，没有服务器，
 *   任何指向 `icons/*.png` 的相对引用都会 404。其余 5 页用真实 PNG（PWA 安装流程
 *   只认位图），单文件诊断页用这份内联 SVG —— 两者**必须分开**，这是硬约定，
 *   `tests/icons.test.mjs` 会断言产物里仍然是 data-URI。
 *
 * @type {string}
 */
const INLINE_FAVICON =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20512%20512'%3E%3Crect%20width='512'%20height='512'%20rx='96'%20fill='%231E9C8C'/%3E%3Ccircle%20cx='256'%20cy='256'%20r='120'%20fill='none'%20stroke='%23ffffff'%20stroke-width='24'/%3E%3Cpath%20d='M256%2096v320M96%20256h320'%20stroke='%23ffffff'%20stroke-width='16'%20opacity='.85'/%3E%3C/svg%3E";

/** 入口模块 */
const ENTRY = 'src/ui/selfcheck.js';

/** 依赖闭包，按「依赖在前」的手工拓扑序（构建时会自动校验） */
const ORDER = [
  'src/i18n/zh.js',
  'src/i18n/en.js',
  // i18n 入口（持有当前 locale 与 t()）：zh/en 两张表都必须在它之前。
  'src/i18n/index.js',
  'src/core/cache.js',
  'src/core/geo.js',
  'src/core/format.js',
  'src/core/sun.js',
  'src/core/store.js',
  'src/core/wmo.js',
  'src/core/http.js',
  // 简繁转换与拼音映射：placesearch.js 的直接依赖（均无自身依赖），必须在它之前。
  // zhvariant.js 是补登记 —— 存量漏登（placesearch.js 早在补「市」繁体那轮就 import 它），
  // 期间没人重跑 build 所以一直没暴露，2026-11 v95 构建时才被闭包校验拦下。
  'src/core/zhvariant.js',
  'src/core/pinyin.js',
  'src/data/tiles.js',
  'src/data/openmeteo.js',
  'src/data/photon.js',
  // 气候常态：sources.js 顶层 `import { CLIMATE_SOURCES } from './climate.js'`，
  // 而 climate.js 又依赖 core/cache.js / core/geo.js / i18n/index.js / data/openmeteo.js
  // （四者都已登记在它之前），所以 climate.js 必须排在 sources.js **之前**，
  // 少登记一个 build 就直接「打包中止」（依赖校验未通过）。
  'src/data/climate.js',
  'src/data/sources.js',
  'src/data/health.js',
  'src/ui/theme.js',
  // 语言引导与错误文案：now.js / selfcheck.js 都 import 它们，必须先于两者。
  'src/ui/locale.js',
  'src/ui/errtext.js',
  'src/ui/placesearch.js',
  // 指标释义：now.js 在 renderSkeleton() 里建它的槽位，所以必须在 now.js **之前**。
  // 自检页本身不显示图例，但闭包校验是「import 了就必须在闭包内」，少登记会直接打包中止。
  'src/ui/legend.js',
  'src/ui/now.js',
  // ★ `src/ui/map.js` **故意不登记在 ORDER 里**：2026-10-17 导航重构后它只被地理页入口
  //   `src/ui/compass.js` import（气候页入口 `src/ui/app.js` 在 T04 瘦身后已不再用它，
  //   `src/ui/now.js` 也不许 import 它 —— `map.js` 要用 now.js 的 `h()`，反向依赖成环），
  //   不在本产物入口 `src/ui/selfcheck.js` 的依赖闭包内 —— 内联进去是 20.3 KB 的死重量。
  //   ⚠️ 上面那组「登记时 X 模块 / Y KB，移除后 …」的对照数字已删除 —— 它们是 2026-10
  //   某次实测的旧值，与今天产物（自检闭包）的真实规模对不上，留在注释里只会误导。
  //   要引用就**现在重新跑一次 `node tools/build-standalone.mjs` 取数**，别抄旧数字。
  //   文件本身**保留在仓库**（不是死代码，是地理页在用的真模块），只是不进这个单文件产物。
  //   ⚠️ 将来若 selfcheck.js 的闭包真的引到它，build 会直接「打包中止：依赖不在闭包内」——
  //   那是提示，不是 bug：届时把它登记回来即可。**别靠注释解释，注释对 check 是不可见的。**
  //   （「不登记」是**硬闸**而不是「体积别涨」那种观察指标 —— 口径见 ORDER 之后那段。）
  'src/ui/download.js',
  'src/ui/selfcheck.js',
];

/**
 * ★产物体积口径（2026-10-17 主理人裁定 —— 改 ORDER 之前先读这一段）
 *
 * 两条约束**性质不同**，别混为一谈：
 *
 * 1) **硬闸（破了就是缺陷）**：产物**模块数不许增加**，也不许有新模块进闭包。
 *    尤其这三个大文件 —— `src/ui/map.js`（20.3 KB）、`src/core/mag.js`（26.6 KB）、
 *    `src/data/wmm2025.js`（9.5 KB）—— 谁把它们弄进 ORDER，谁就是往一个诊断页里塞死重量。
 *    它们都是**别的页面在用的真模块**（地理页在用），不是死代码，只是不进这个单文件产物。
 *    ⚠️ build 只能兜一半：闭包里**少**登记一个依赖会直接「打包中止」，而**多**登记一个
 *    不报错也不警告 —— 所以「多登记」只能靠人在改 ORDER 时把关。
 *
 * 2) **观察指标（不是闸）**：体积。
 *    ★★当前基线（2026-11-07 当场实测，不许抄旧数字）：
 *      v95（搜索增强：拼音/混合输入/外置别名表）— **26 模块 / 569,981 B（556.6 KiB）**
 *      模块数 24 → 26：`src/core/zhvariant.js`（+14,821 B，补登记存量漏登）与
 *      `src/core/pinyin.js`（+3,180 B，本轮新建）入闭包；其余增量为 v94 周期内
 *      placesearch.js 别名表扩充 / 兜底链路 / i18n 文案的累计（该周期未重跑过 build，
 *      基线一直停留在 2026-10-31，本轮是第一次当场实测）。
 *    旧基线（2026-10-31 当场实测）：
 *      截至 HEAD `6719ccd` — **24 模块 / 498,075 B（486.4 KiB）**
 *      本轮（壳更新提示条，只挂四个 live 页面）之后 — **24 模块 / 498,781 B（487.1 KiB）**
 *      ⚠️ 这两个数都是**跑一次 `node tools/build-standalone.mjs` 当场读出来的**。
 *         上一版注释写的是「479.0 KiB（490,481 B）」，与实测差了 9.5 KB ——
 *         它是「上一版注释的数字 + 本次增量」推出来的，**从来没人重新跑过**，
 *         于是误差一轮轮累积，直到有人偶然对了一次才发现。写基线必须重新跑，
 *         **不许在旧数字上做加法**。这条比「涨了多少要归因」更要紧：
 *         基数错了，归因得再仔细也是错的。
 *    涨了必须能 **100% 归因**：说清每个模块各涨多少、其中代码与注释各占多少。
 *    ★为什么它不是闸：把符号搬到它该在的层（`ui` → `core` / `data`）**本来就会让产物变重** ——
 *    承接方（如 `src/core/geo.js`、`src/data/tiles.js`）在闭包内，而搬出方
 *    （如 `src/ui/app.js`）不在闭包内，那边的瘦身一点都抵消不上。
 *    2026-10-17 实测：T04 把 `parsePlaceParam` / `resolveCoord` 迁进 `core/geo.js`、
 *    把 `probeTileBatch` 迁进 `data/tiles.js`，产物 463.1 → 475.7 KiB
 *    （+12,854 B，其中代码 +2,668 B、注释 +10,186 B —— **把注释全删光也仍有 +2.7 KiB**）；
 *    T05 又因导出搜索面板与两条 i18n 文案 +3,370 B。全程模块数 24、闭包清单一个没变。
 *    2026-10-26 修三个真机文案缺陷（瓦片终态「已加载」/ 缓存命中不许显示 0 ms /
 *    模型卡末行标签改「计算时刻」）：产物 479.0 → 480.3 KiB（+1,347 B），
 *    100% 归因 —— 源码侧 zh.js +1,373 B、en.js +1,289 B、now.js +324 B
 *    （now.js / i18n 两张表在闭包内；map.js / compass.js / pull.js 的注释不在闭包内，
 *    不计入）。其中 3 条新文案键本身约 +550 B 源码，**把三条理由注释全删也仍有约 +0.2 KiB**
 *    —— 也就是说「不许涨」这条在「新增文案键」面前物理上无法满足，只能归因、不能硬压。
 *    同日删除「方位 · 磁偏角」概览卡（磁偏角数值一屏重复两遍）后回落到
 *    **477.1 KiB（488,566 B）**：删掉的是 now.js 里的 `renderBearingCard` 及其 JSDoc
 *    （now.js 在闭包内）+ 两条 i18n 文案键，−3,262 B —— 比 479.0 KiB 基线还小 1,915 B。
 *    已裁定接受：为分层正确性付这个体积代价，好过让地理页 `compass.js` 去 import
 *    气候页入口 `app.js`（ui 层互相 import，正是那次迁移要消除的东西）。
 *    ⚠️ 反过来**不许**为了压体积去删别处的 rationale 注释，也不许拿无关改动掩盖本次
 *    增量 —— 那比增量本身严重得多（2026-10-17 主理人明确肯定的一条）。
 *
 * ★2026-10-31 裁定：`src/ui/shellupdate.js` **不登记进 ORDER**（曾登记过一轮，已回退）
 *
 *    背景：壳更新提示条（`src/ui/shellupdate.js`，5.7 KB）由四个 live 页面入口调用 ——
 *    index / compass / compare / settings。它**不**被本产物入口 `src/ui/selfcheck.js`
 *    import（自检页是静态快照，见下面两条理由），所以不在闭包内、不许登记。
 *
 *    ★为什么不登记（两条，缺一不可 —— 下次再有人提出「也给它加上」先看这里）：
 *
 *    1) **单文件快照里没有「新版本」可言**。selfcheck-standalone.html 是发到手机、
 *       file:// 直接打开的一个静态文件，里面没有 Service Worker。在那儿显示
 *       「有新版本已就绪 · 立即刷新」是一句**假话** —— `location.reload()` 重新加载的
 *       还是同一个快照，什么也不会更新。而「界面说的和实际做的不一样」正是我们这两周
 *       一直在修的那一类缺陷（慕尼黑那一次也不例外：旧壳冒充新版）。往诊断快照里
 *       塞一句在它自己的上下文里为假的话，比多 5.8 KB 严重得多。
 *       ⚠️ 这也是为什么**不**走「在 showNote 里检测 standalone 再隐藏」那条路：
 *         提示条的存在本身就是承诺，靠运行时判断把它藏起来等于承认这个页面不该有它。
 *
 *    2) **需要这条提示的是四个 live 页面，自检页不必占闭包名额**。覆盖率从
 *       「只有我的页」→「四个 live 主页面」已经解决了实际问题（那次事故是用户在
 *       地理 / 气候页看不到），第五个是静态快照页，加它没有收益，只有代价。
 *
 *    ★「不登记」与本仓既有先例同构：`src/ui/map.js` 同样**在 sw.js 的 SHELL_ASSETS 里、
 *    不在 ORDER 里**（见上面第 76 行那段）。两张清单管的是两件事 ——
 *      - SHELL_ASSETS = 「哪些文件要进离线壳缓存」：shellupdate.js 被四个 live 页面
 *        import，**必须在里面**，否则断网时 app.js 的 import 会 504 → 整页起不来；
 *      - ORDER = 「哪些文件内联进这个单文件诊断产物」：只跟 selfcheck.js 的闭包有关。
 *    ⚠️ 别把这两件事混为一谈：从 SHELL_ASSETS 里删掉它是对的还是错的，只取决于
 *       「有没有 live 页面 import 它」，与 ORDER 无关。
 *
 *    体积归因（本轮最终，相较 HEAD `6719ccd` 的 498,075 B）：仅两条 shell.* 文案键
 *      zh.js +333 B / en.js +362 B（都在闭包内）→ 产物 498,075 → **498,781 B（+706 B）**，
 *      **模块数仍为 24**（回退掉那一轮登记后，shellupdate.js 不再进闭包）。
 *
 * ★2026-10-31 第三轮基线（按样式的缩放上限：street 13 / imagery 19 / dark 16）
 *
 *    实测（跑一遍 `node tools/build-standalone.mjs` 当场读出，不许在旧数字上做加法）：
 *      产物 498,781 B → **506,032 B（494.2 KiB）**，**+7,251 B，模块数仍为 24**。
 *
 *    归因：**闭包内**四个文件，逐项实测 → 合计正好等于实测增量，**残差 0 B**。
 *      - `src/data/tiles.js` +6,114 B（新增 91 行：注释 +5,837 B / 代码 +402 B ——
 *        **把注释全删光也仍有约 +0.4 KiB**）；
 *      - `src/i18n/zh.js` +296 B、`src/i18n/en.js` +359 B（新键 `map.zoomMax` 各一条，
 *        外加一句「为什么要有这句提示」的理由注释）；
 *      - `styles/app.css` +482 B（新规则 `.map-cap` 走 `<style>` 内联、**不进模块表**，
 *        故按原文计 —— 按转义口径算会多出 10 B，归因时必须分清这两条口径）。
 *
 *    ⚠️ 本轮最值得记的一条：**产物变重 ≠ 改动变大**。这次改动的主力是 `src/ui/map.js`
 *      （+3,849 B）与两个测试文件（+10,108 B），但三者都在闭包**外**（`map.js` 按上面
 *      第 76 行的裁定不登记），产物字节一点没被它们影响。归因只能落到「在闭包内的那些
 *      文件各自涨了多少」，不能拿改动的页数去解释产物。
 */

/** 把相对说明符解析成闭包内的绝对路径 */
function absPath(fromModule, spec) {
  const base = posix.dirname(fromModule);
  return posix.normalize(posix.join(base, spec));
}

const modules = {};
for (const key of ORDER) modules[key] = read(key);

/**
 * 静态校验：
 * 1. 每个模块里出现的相对 import 都必须在闭包内；
 * 2. 依赖必须在自己之前出现（拓扑序正确）。
 */
const errors = [];
const IMPORT_RE = /(\bfrom\s*['"])(\.\.?\/[^'"]+?\.js)(['"])/g;
ORDER.forEach((key, idx) => {
  for (const m of modules[key].matchAll(IMPORT_RE)) {
    const dep = absPath(key, m[2]);
    if (!modules[dep]) {
      errors.push(`${key} 依赖 ${dep}（${m[2]}）不在闭包内`);
      continue;
    }
    if (ORDER.indexOf(dep) > idx) {
      errors.push(`${key} 的依赖 ${dep} 排在它后面，拓扑序错了`);
    }
  }
});
if (errors.length > 0) {
  console.error('打包中止，依赖校验未通过：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

/** 内联 CSS（tokens + app，无外部引用） */
const css = `<style>\n${read('styles/tokens.css')}\n${read('styles/app.css')}\n</style>`;

/** 内联模块源码，供运行时拼 Blob */
const moduleMap = ORDER.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(modules[k])},`).join('\n');

/**
 * 运行时引导脚本：
 * - 按 ORDER 依次把每个模块的相对 import 替换成已生成的 Blob URL
 * - 生成该模块的 Blob URL
 * - 最后动态 import 入口
 * 注意：这段是普通脚本（非 module），所以用 import() 动态引入。
 */
const bootstrap = `
<script>
(function () {
  var MODULES = {
${moduleMap}
  };
  var ORDER = ${JSON.stringify(ORDER, null, 2).replace(/\n/g, '\n  ')};
  var ENTRY = ${JSON.stringify(ENTRY)};

  function dirname(p) {
    var i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }
  function absPath(from, spec) {
    var parts = (dirname(from) + '/' + spec).split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === '' || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return out.join('/');
  }

  var urls = {};
  try {
    for (var i = 0; i < ORDER.length; i++) {
      var key = ORDER[i];
      var src = MODULES[key].replace(
        /(\\bfrom\\s*['"])(\\.\\.?\\/[^'"]+?\\.js)(['"])/g,
        function (m, a, spec, c) {
          var dep = absPath(key, spec);
          if (!urls[dep]) throw new Error('依赖缺失: ' + dep);
          return a + urls[dep] + c;
        }
      );
      urls[key] = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
  } catch (err) {
    var box = document.createElement('pre');
    box.style.cssText = 'padding:16px;color:#C0563C;font:13px/1.6 monospace;white-space:pre-wrap';
    box.textContent = '自检页装配失败：' + (err && err.message ? err.message : String(err));
    document.body.insertBefore(box, document.body.firstChild);
    return;
  }

  import(urls[ENTRY]).catch(function (err) {
    var box = document.createElement('pre');
    box.style.cssText = 'padding:16px;color:#C0563C;font:13px/1.6 monospace;white-space:pre-wrap';
    box.textContent = '自检页加载失败：' + (err && err.message ? err.message : String(err));
    document.body.insertBefore(box, document.body.firstChild);
  });
})();
</script>`;

/** 以 selfcheck.html 为模板改造 */
let html = read('selfcheck.html');

// 0. 图标 → 内联 data-URI。
//    ★单文件产物必须自包含：它是发到手机单独打开的（file:// 或内容分享），没有服务器，
//    `icons/icon-192.png` 这种相对引用必然 404 → 退化成空白页图标。
//    selfcheck.html 现在指向真实 PNG（供其余 4 页与 PWA 安装流程用），所以这里把它
//    换回一份内联 SVG —— 浏览器标签页/书签图标用 SVG data-URI 完全够用，且零字节外链。
//    apple-touch-icon 只被 iOS 主屏读取，单文件诊断页用不上，直接删。
html = html.replace(/\s*<link rel="apple-touch-icon"[^>]*\/>/g, '');
html = html.replace(
  /<link rel="icon" href="[^"]*"\s*\/>/,
  `<link rel="icon" href="${INLINE_FAVICON}" />`
);

// 1. 两个样式表 → 内联 <style>
html = html.replace(
  /\s*<link rel="stylesheet" href="styles\/tokens\.css" \/>\s*<link rel="stylesheet" href="styles\/app\.css" \/>/,
  '\n  ' + css
);
// 2. 移除 manifest 链接（file:// 下不可用，留着只会 404）
html = html.replace(/\s*<link rel="manifest" href="manifest\.webmanifest" \/>/, '');
// 3. 导航里指向别页的链接（此刻 / 自检 / 方位）在单文件版里不存在，改成不可点。
//    连闭合标签一起换（</a> → </span>）：只换开标签会留下 <span>…</a> 的错配标记。
html = html.replace(
  /<a class="tab" href="(?:index|compass|settings)\.html"([^>]*)>([^<]*)<\/a>/g,
  '<span class="tab tab--disabled" aria-disabled="true"$1>$2</span>'
);
// 4. 模块脚本 → 引导脚本
html = html.replace(
  /\s*<script type="module" src="src\/ui\/selfcheck\.js"><\/script>/,
  '\n' + bootstrap
);

const out = resolve(ROOT, 'selfcheck-standalone.html');
writeFileSync(out, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`已生成 ${out}`);
console.log(`  内联模块 ${ORDER.length} 个 · 文件大小 ${kb} KB`);
console.log('  用法：把这个文件发到手机，用浏览器打开即可，不需要服务器。');
