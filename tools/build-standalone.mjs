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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** 入口模块 */
const ENTRY = 'src/ui/selfcheck.js';

/** 依赖闭包，按「依赖在前」的手工拓扑序（构建时会自动校验） */
const ORDER = [
  'src/i18n/zh.js',
  'src/core/cache.js',
  'src/core/geo.js',
  'src/core/format.js',
  'src/core/sun.js',
  'src/core/store.js',
  'src/core/wmo.js',
  'src/core/http.js',
  'src/data/tiles.js',
  'src/data/openmeteo.js',
  'src/data/photon.js',
  'src/data/sources.js',
  'src/data/health.js',
  'src/ui/theme.js',
  'src/ui/placesearch.js',
  'src/ui/now.js',
  'src/ui/map.js',
  'src/ui/download.js',
  'src/ui/selfcheck.js',
];

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
