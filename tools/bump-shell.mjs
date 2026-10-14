/**
 * 发布前必跑：把 sw.js 里的壳缓存版本号 +1（`geoscope-shell-v1` → `v2`），
 *   并**重算并写回壳资产指纹** `SHELL_FINGERPRINT`。
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
 * ★`SHELL_FINGERPRINT` 是「靠人记住」的**兜底**：版本号只解决「要记得 bump」，
 *   指纹解决「忘了 bump 要能被发现」—— `tools/check.mjs` 第 22 节重算一遍与它比对，
 *   不一致就报红。于是「改了壳资产却没发布」从**静默**变成**门禁红**，
 *   不再依赖发布的人记得跑这个脚本。
 *
 * ★指纹算法的两条硬约定（改之前先读）：
 *   1) **算 hash 前必须把 CRLF 规范成 LF**。本仓 `.gitattributes` 锁 `* text=auto eol=lf`，
 *      但 bump 之后工作副本在 Windows 上会变 CRLF（`git checkout --` 引起的换行回写），
 *      若不规范化，指纹会随平台漂移 → 护栏假红 → 比没有护栏更糟（大家会学会忽略它）。
 *      这里用 `normalizeEol()` 统一，且**只规范化换行**，不改任何其它字节。
 *   2) **按 `SHELL_ASSETS` 数组顺序**拼接，并把每个文件的相对路径也拼进去：
 *      顺序变了（清单被重排）同样要算「变了」，否则两个不同清单可能撞出同一个指纹。
 *      指纹取 sha256 的前 16 位 hex —— 够用即可，它防的是疏忽，不是碰撞攻击。
 *
 * 用法：node tools/bump-shell.mjs
 * 输出：v1 -> v2（并就地改写 sw.js）
 * 退出码：成功 0；找不到版本号 / 匹配到多处 / 读写失败 / 壳资产缺失 均为非 0。
 *
 * ★本模块被 `tools/check.mjs` import（复用同一份算法，避免两处各写一份而漂移），
 *   所以 `main()` 只在**直接运行**时执行 —— 否则 check 一跑就顺手 bump 一次版本号。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'sw.js');

/** 版本号形态：`geoscope-shell-v` + 至少一位数字。 */
const VERSION_RE = /geoscope-shell-v(\d+)/g;

/** 指纹常量：只认 `'…'` 单引号、16 位 hex 的形状。 */
const FINGERPRINT_RE = /const SHELL_FINGERPRINT\s*=\s*'([^']*)';/;

/** 指纹长度（sha256 hex 的前 16 位）。 */
const FINGERPRINT_LEN = 16;

/* ------------------------------------------------------------------ */
/* 指纹                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把换行统一成 LF。
 *
 * ★为什么必须做：Windows 上工作副本会变 CRLF（本仓 `.gitattributes` 锁 `eol=lf`，
 *   `git checkout --` 之后必然发生），指纹若跟着换行漂移就是**假红**。
 *   假红比没有护栏更糟 —— 第一次大家会去查，第二次开始就会习惯性忽略它。
 *
 * @param {string} s 文件内容。
 * @returns {string} 换行规范为 `\n` 的内容。
 */
export function normalizeEol(s) {
  // 先 `\r\n` 再裸 `\r`：后者覆盖古老的 CR-only 换行，顺序反了会把 `\r\n` 拆成两个 `\n`。
  return String(s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * 解析 sw.js 里的 `SHELL_ASSETS` 清单（保持数组顺序）。
 *
 * @param {string} swSrc sw.js 源码。
 * @returns {string[]} 资产路径数组（形如 `./index.html`）；解析不到时为空数组。
 */
export function parseShellAssets(swSrc) {
  const block = String(swSrc).match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/);
  if (!block) return [];
  const out = [];
  const re = /'([^']+)'|"([^"]+)"/g;
  let m;
  while ((m = re.exec(block[1])) !== null) out.push(m[1] || m[2]);
  return out;
}

/**
 * 计算壳资产指纹。
 *
 * @param {string} swSrc sw.js 源码（从中读 `SHELL_ASSETS`）。
 * @param {string} [root] 仓库根目录；缺省本文件所在目录的上一级。
 * @returns {{fingerprint:string, assets:string[], missing:string[], count:number}}
 *   指纹（16 位 hex）、参与计算的资产、读不到的资产、资产总数。
 */
export function shellFingerprint(swSrc, root = ROOT) {
  const assets = parseShellAssets(swSrc);
  const h = createHash('sha256');
  const missing = [];

  for (const a of assets) {
    // `'./'` 是导航根，落到 index.html（它在清单里也单独列了一次，重复拼接不影响正确性）
    const rel = String(a).replace(/^\.\//, '') || 'index.html';
    // ★把路径本身也喂进 hash：清单被重排 / 换了个同名同内容的文件，也应当算「变了」
    h.update(`\n<<shell-asset:${rel}>>\n`);
    let body = null;
    try {
      body = readFileSync(join(root, rel), 'utf8');
    } catch (err) {
      body = null;
    }
    if (body === null) {
      missing.push(a);
      h.update('<<missing>>\n');
      continue;
    }
    h.update(normalizeEol(body));
    h.update('\n');
  }

  return {
    fingerprint: h.digest('hex').slice(0, FINGERPRINT_LEN),
    assets,
    missing,
    count: assets.length,
  };
}

/**
 * 把指纹常量写进 sw.js 源码（已有则就地替换，没有则插到 `SHELL_CACHE` 常量之后）。
 *
 * @param {string} src sw.js 源码。
 * @param {string} fp 指纹（16 位 hex）。
 * @returns {string} 改写后的源码。
 * @throws {Error} 找不到 `SHELL_CACHE` 常量且也没有指纹常量时抛出。
 */
export function writeFingerprint(src, fp) {
  // ★注释里的反引号会截断模板字符串，这里一律用「」代替（正文可读性不损失）。
  const decl =
    '/**\n'
    + ' * 壳资产指纹：SHELL_ASSETS 全部文件内容按清单顺序拼接后的 sha256 前 16 位（CRLF 已规范为 LF）。\n'
    + ' *\n'
    + ' * ★为什么需要它：浏览器只看 sw.js 自身字节判断要不要更新，改了业务文件而 sw.js 没变，\n'
    + ' *   真机会一直用旧壳 —— 而且**没有任何报错**。tools/check.mjs 第 22 节拿它重算比对，\n'
    + ' *   不一致就报红；改完壳资产跑一次 node tools/bump-shell.mjs 即可（本脚本自动维护它）。\n'
    + ' */\n'
    // 末尾多一个 \n：与后面的 SHELL_ASSETS 之间留一个空行（就地替换时不影响任何其它字节）
    + `const SHELL_FINGERPRINT = '${fp}';\n\n`;

  if (FINGERPRINT_RE.test(src)) return src.replace(FINGERPRINT_RE, `const SHELL_FINGERPRINT = '${fp}';`);

  const cacheRe = /(const SHELL_CACHE\s*=\s*'[^']*';\n)/;
  if (!cacheRe.test(src)) {
    throw new Error(
      'sw.js 里既没有 SHELL_FINGERPRINT、也找不到 SHELL_CACHE 常量 —— 无法决定插在哪儿。'
      + '请把 `const SHELL_CACHE = \'geoscope-shell-vN\';` 补回 sw.js。'
    );
  }
  return src.replace(cacheRe, `$1\n${decl}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

/**
 * 主流程：版本号 +1，并按新源码重算指纹一并写回。
 *
 * @returns {void}
 * @throws {Error} 找不到版本号、匹配到多处、读写失败、或壳资产缺失时抛出。
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
  // ★先 bump 版本号再算指纹：指纹只由 SHELL_ASSETS 里的文件决定（sw.js 不在清单内），
  //   所以两者互不影响；顺序反了也能跑，但先写版本号更贴近「发布一次 = 一个版本」的语义。
  const bumped = src.replace(VERSION_RE, whole.replace(/\d+$/, String(to)));

  const { fingerprint, missing, count } = shellFingerprint(bumped, ROOT);
  if (missing.length > 0) {
    throw new Error(
      `SHELL_ASSETS 里有 ${missing.length} 个文件读不到（${missing.join('、')}）：`
      + '清单指向不存在的文件时，装上去的壳是残的。先修清单再 bump。'
    );
  }

  const next = writeFingerprint(bumped, fingerprint);

  try {
    writeFileSync(TARGET, next, 'utf8');
  } catch (err) {
    throw new Error(`写回 ${TARGET} 失败：${err && err.message ? err.message : err}`);
  }

  process.stdout.write(`v${from} -> v${to}\n`);
  process.stdout.write(`SHELL_FINGERPRINT = ${fingerprint}（${count} 个壳资产）\n`);
  process.stdout.write(`${TARGET} 已改写，请随发布一起提交（sw.js 字节已变化，浏览器才会触发更新）。\n`);
}

// ★只在「直接运行本文件」时执行：check.mjs 会 import 这里的指纹算法，
//   若不加这道门，每次跑 check 都会顺手把版本号 +1 —— 那是最难查的一类副作用。
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[bump-shell] ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
