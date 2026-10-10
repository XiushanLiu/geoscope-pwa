/**
 * 校验 selfcheck-standalone.html（单文件自检页）是否装配正确：
 * 1. HTML 里不能残留任何相对资源引用（模块 src / 样式 href / manifest / index.html 死链）
 * 2. 内联的 15 个模块能按真实目录结构落盘并被 Node 正常 import
 * 3. 关键导出可用（apiSources 应为 5 路、SOURCE_LIST 6 条、瓦片 URL 路径正确）
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
ok('模块数量 = 15', keys.length === 15, `实际 ${keys.length}`);
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
