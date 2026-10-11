/**
 * 发布前必跑：把 sw.js 里的壳缓存版本号 +1（`geoscope-shell-v1` → `v2`）。
 *
 * 为什么必须有它（不是洁癖，是一道真 bug 的防线）：
 * 浏览器判断 Service Worker 要不要更新，看的是 **sw.js 自身的字节有没有变化** ——
 * 每次导航都会后台重新拉一次 sw.js 做逐字节比对，变了才安装新版、进 install/activate，
 * 没变就继续沿用已经装着的那一份。注意它**不看业务文件**。
 *
 * 于是有一个陷阱：只改业务文件的提交（styles/app.css、src/ui/app.js、src/ui/now.js…）
 * 一个字节都没动到 sw.js，浏览器判定「没变」→ 不触发更新 → 已经安装的真机会一直从旧的
 * 壳缓存里拿旧文件，改了等于没改。最近一轮配色大改就属于这类提交。
 *
 * 而改动碰巧涉及 sw.js 的提交看起来「发布正常」，那是侥幸不是机制：新增 compass.html /
 * src/ui/map.js / src/core/mag.js / src/data/wmm2025.js 时改动恰好玩到 SHELL_ASSETS 清单，
 * 字节才顺带变了。清单不动的那次，就是线上静默不更新的那次。
 *
 * 所以缓存版本号必须**每次发布都 +1**：bump 之后 sw.js 必然字节变化 → 更新判定必然触发
 * → activate 里再把上一个 `geoscope-shell-vN-1` 删掉。这件事靠人记住不可靠，交给这个脚本。
 *
 * 用法：node tools/bump-shell.mjs
 * 输出：v1 -> v2（并就地改写 sw.js）
 * 退出码：成功 0；找不到版本号 / 匹配到多处 / 读写失败 均为非 0。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'sw.js');

/** 版本号形态：`geoscope-shell-v` + 至少一位数字。 */
const VERSION_RE = /geoscope-shell-v(\d+)/g;

/**
 * 主流程。
 *
 * @returns {void}
 * @throws {Error} 找不到版本号、或匹配到多处时抛出。
 */
function main() {
  let src = '';
  try {
    src = readFileSync(TARGET, 'utf8');
  } catch (err) {
    throw new Error(`读不到 ${TARGET}：${err && err.message ? err.message : err}`);
  }

  const matches = [...src.matchAll(VERSION_RE)];

  if (matches.length === 0) {
    throw new Error(
      'sw.js 里找不到 geoscope-shell-v<数字>：要么缓存名常量被改名/删除了，'
      + '要么版本号格式变了。离线壳靠这个名字区分版本，改名请同步改本工具的正则。'
    );
  }

  // 多处命中 = 有人把常量复制了一份。此时 +1 只会改到其中一处（或多处），
  // 结果是「install 写 A 名、fetch 读 B 名」这种更难查的错，所以直接停下来。
  if (matches.length > 1) {
    const at = matches.map((m) => `第 ${src.slice(0, m.index).split('\n').length} 行 ${m[0]}`).join('、');
    throw new Error(`sw.js 里匹配到 ${matches.length} 处版本号（${at}）：只能有一处定义，请去掉重复。`);
  }

  const [whole, digits] = matches[0];
  const from = Number(digits);
  const to = from + 1;
  const next = src.replace(VERSION_RE, whole.replace(/\d+$/, String(to)));

  try {
    writeFileSync(TARGET, next, 'utf8');
  } catch (err) {
    throw new Error(`写回 ${TARGET} 失败：${err && err.message ? err.message : err}`);
  }

  process.stdout.write(`v${from} -> v${to}\n`);
  process.stdout.write(`${TARGET} 已改写，请随发布一起提交（sw.js 字节已变化，浏览器才会触发更新）。\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[bump-shell] ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
