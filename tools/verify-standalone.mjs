/**
 * 校验 selfcheck-standalone.html（单文件自检页）是否装配正确：
 * 1. HTML 里不能残留任何相对资源引用（模块 src / 样式 href / manifest / index.html 死链）
 * 2. 内联的模块**清单**与 build-standalone.mjs 的登记表逐项一致（不比数量，比成员），
 *    且能按真实目录结构落盘并被 Node 正常 import
 * 3. 关键导出可用（apiSources 应为 5 路、SOURCE_LIST 6 条、瓦片 URL 路径正确）
 *
 * 为什么不写死「模块数量 = N」：这个数字会随正常开发变化（新增模块就 +1），写死就等于
 * 给下一个人埋雷 —— 本项目已经栽过一次（tests/sw-offline.test.mjs 曾写死「22 项」，
 * sw.js 的 SHELL_ASSETS 正常补两行就把测试打红）。这条断言的**真实意图**不是「恰好 N 个」，
 * 而是「产物里内联的 == 登记表里登记的」，所以直接读登记表来比，且比成员不比数量：
 * 数量凑巧相同但成员错了也能抓到。
 *
 * 用法：node tools/verify-standalone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'selfcheck-standalone.html'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

console.log('\n[1] HTML 结构检查');
ok('无残留 <script src="src/…">', !/src=["']src\//.test(html));
ok('无残留 <link rel="stylesheet" href="styles/…">', !/href=["']styles\//.test(html));
ok('样式已内联为 <style>', /<style>/.test(html) && /--c-/.test(html));
ok('无残留 manifest 链接', !/manifest\.webmanifest/.test(html));
ok('无 index.html 死链', !/href=["']index\.html["']/.test(html));
// 方位屏是第三个页面：它的导航链接同样必须被单文件版改成不可点，否则发到手机上是死链
ok('无 compass.html 死链', !/href=["']compass\.html["']/.test(html));
ok('含引导脚本 MODULES', /var MODULES = \{/.test(html));

console.log('\n[2] 提取内联模块');
const start = html.indexOf('var MODULES = {');
const endMark = html.indexOf('\n  };', start);
const body = html.slice(html.indexOf('{', start) + 1, endMark);
let MODULES;
try {
  MODULES = new Function('return {' + body + '}')();
  ok('解析出模块对象', true);
} catch (e) {
  ok('解析出模块对象', false, String(e && e.message));
  process.exit(1);
}
const keys = Object.keys(MODULES);

/**
 * 从 build-standalone.mjs 读出模块登记表本身（ORDER 数组）。
 * 不能直接 import 那个文件 —— 它顶层就有副作用，一 import 就会重新打包并写盘。
 * 所以走与上面提取 MODULES 相同的手法：定位 `const ORDER = [...]` 后求值。
 * 以后加模块只需在登记表改一处，这条断言自动跟随，不需要有人记得回来改数字。
 *
 * @returns {string[]} 登记表里的模块路径。
 */
function readRegistry() {
  const src = readFileSync(resolve(ROOT, 'tools/build-standalone.mjs'), 'utf8');
  const m = src.match(/const ORDER = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('build-standalone.mjs 里找不到 `const ORDER = [...]` 登记表');
  const list = new Function('return ' + m[1])();
  if (!Array.isArray(list) || list.length === 0) throw new Error('ORDER 登记表为空或不是数组');
  return list;
}

const registry = readRegistry();
const missing = registry.filter((k) => !keys.includes(k));   // 登记表里有、产物里没有
const extra = keys.filter((k) => !registry.includes(k));     // 产物里有、登记表里没有
const diff = [
  missing.length ? `缺少 ${missing.join('、')}` : '',
  extra.length ? `多出 ${extra.join('、')}` : '',
].filter(Boolean).join('；');
ok(
  `模块清单与 build-standalone.mjs 登记表一致（${registry.length} 项）`,
  missing.length === 0 && extra.length === 0,
  diff || `实际 ${keys.length} 项`
);
ok('含入口 src/ui/selfcheck.js', keys.includes('src/ui/selfcheck.js'));

console.log('\n[3] 落盘后按真实结构 import');
const tmp = resolve(ROOT, '.tmp-standalone-verify');
rmSync(tmp, { recursive: true, force: true });
for (const k of keys) {
  const p = resolve(tmp, k);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, MODULES[k], 'utf8');
}
try {
  const entry = pathToFileURL(resolve(tmp, 'src/ui/selfcheck.js')).href;
  const mod = await import(entry);
  ok('入口模块 import 成功（无 document 时跳过 init）', typeof mod === 'object');
  ok('导出 runSelfCheck', typeof mod.runSelfCheck === 'function');
  ok('导出 exportReport', typeof mod.exportReport === 'function');

  const src = await import(pathToFileURL(resolve(tmp, 'src/data/sources.js')).href);
  const api = src.apiSources();
  ok('apiSources() = 5 路', Array.isArray(api) && api.length === 5, `实际 ${api && api.length}`);
  ok('SOURCE_LIST = 6 条', src.SOURCE_LIST.length === 6, `实际 ${src.SOURCE_LIST.length}`);

  const tiles = await import(pathToFileURL(resolve(tmp, 'src/data/tiles.js')).href);
  const url = tiles.tileUrl('street', 12, 3372, 1552);
  ok(
    'tileUrl 街道图路径正确',
    url === 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/12/1552/3372',
    url
  );
  const dark = tiles.tileUrl('dark', 12, 3372, 1552);
  ok('tileUrl 暗色图含 Canvas 层级', dark.includes('/Canvas/World_Dark_Gray_Base/MapServer/tile/'), dark);
} catch (e) {
  ok('模块 import', false, String(e && e.message));
}
rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
