/**
 * 配色红线：告警红不得作为文字色。
 *
 * 背景（本轮修掉的真实缺陷）：`.chip--failed` 与 `.kv-v--alert` 拿 `var(--c-alert)`
 * （#c9584b）当**文字色**。按 WCAG 相对亮度实算，深色屏下分别只有 2.50:1 与 3.04:1，
 * 远低于 4.5:1 的小字门槛 —— 越需要被看见的告警，反而越看不清，传达效果是负的。
 *
 * 定下的规矩：**红只做低透明度底纹与边框，不做文字色**；文字一律走随主题翻转的
 * `--c-text-1`。这样深浅两态都不必按主题分别取值，且必然达标（实测 ≥ 10.5:1）。
 *
 * 本文件做的事：把这条规矩变成可执行断言，防止后人（包括我们自己）再犯。
 * 纯源码扫描，零第三方依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const cssSrc = read('styles/app.css');

/**
 * 取出所有「文字色」声明（排除 border-color / background-color 这类带前缀的）。
 *
 * @param {string} css CSS 源码。
 * @returns {Array<{name:string, value:string}>} 变量名列表。
 */
function textColorVars(css) {
  const out = [];
  // (?<!-) 用来排除 border-color: / background-color: —— 它们也含 "color:" 子串
  const re = /(?<!-)color:\s*var\((--[a-z0-9-]+)\)/g;
  let m;
  while ((m = re.exec(css)) !== null) out.push({ name: m[1], value: m[0] });
  return out;
}

test('告警红不得作为文字色出现在任何规则里', () => {
  // 这是本轮修的缺陷本身。红底纹没问题（那是填充），红字不行。
  const offenders = textColorVars(cssSrc).filter(
    (c) => c.name === '--c-alert' || c.name === '--c-state-failed'
  );
  assert.deepEqual(
    offenders,
    [],
    `以下规则把告警红当成了文字色（深色屏实测 2.50~3.04:1，低于 4.5:1）：\n` +
      offenders.map((c) => `  ${c.value}`).join('\n') +
      `\n告警语义请用填充/边框承载，文字色改用 --c-text-1。`
  );
});

test('.chip--failed 与 .kv-v--alert：文字走 --c-text-1，红色只留在填充上', () => {
  const chip = cssSrc.match(/\.chip--failed\s*\{([^}]*)\}/);
  const kv = cssSrc.match(/\.kv-v--alert\s*\{([^}]*)\}/);
  assert.ok(chip && kv, '两条规则都要在');

  assert.match(chip[1], /color:\s*var\(--c-text-1\)/, '.chip--failed 的文字色必须是 --c-text-1');
  assert.match(kv[1], /color:\s*var\(--c-text-1\)/, '.kv-v--alert 的文字色必须是 --c-text-1');

  // 告警语义不能因此整个丢掉：chip 的红色填充必须还在
  assert.match(
    chip[1],
    /background:\s*color-mix\([^)]*var\(--c-state-failed\)/,
    '.chip--failed 的红色填充必须保留 —— 告警语义靠底纹承载，不靠文字颜色'
  );
});

test('扫描器本身有效：能认出「红字」也能放行「红底纹」', () => {
  // 防这条扫描器变成永远为绿的摆设：拿一段假 CSS 验证它真的会命中红字、
  // 且不会误伤 border-color / background 里的红。
  const bad = '.x { color: var(--c-alert); border-color: color-mix(in srgb, var(--c-alert) 45%, transparent); }';
  const hits = textColorVars(bad).filter((c) => c.name === '--c-alert' || c.name === '--c-state-failed');
  assert.equal(hits.length, 1, `红字必须被命中，且 border-color 里的红不算（实际命中 ${hits.length} 次）`);

  const good = '.y { background: color-mix(in srgb, var(--c-alert) 20%, var(--c-card-fill)); border-color: var(--c-alert); }';
  assert.equal(
    textColorVars(good).filter((c) => c.name === '--c-alert').length,
    0,
    '红底纹与红边框是允许的写法，不得误报'
  );
});

test('有状态填充的 chip 变体：文字统一 --c-text-1，状态色只留在填充上', () => {
  // 推广自 .chip--failed 的修法：状态色当文字色在深色屏全线跌破 4.5:1
  // （ok 2.82 / stale 1.90 浅色 / offline 3.14 …），改中性字色后全部 ≥ 8.6:1。
  // 含 .chip--idle：它原先是例外（填充与基础 .chip 同色、无专属徽点，文字色是唯一信号），
  // 已按「先补信号再改文字色」修好 —— 填充换成 38% --c-state-idle 后与基础 chip 底拉开 1.33:1。
  for (const v of ['ok', 'stale', 'failed', 'offline', 'degraded', 'idle']) {
    const r = cssSrc.match(new RegExp(`\\.chip--${v}\\s*\\{([^}]*)\\}`));
    assert.ok(r, `缺少 .chip--${v}`);
    assert.match(r[1], /color:\s*var\(--c-text-1\)/, `.chip--${v} 的文字色必须是 --c-text-1`);
    // 语义不能因此丢：填充必须还是状态色（不是被一起改成中性）
    assert.match(
      r[1],
      /background:\s*color-mix\([^)]*var\(--c-(?:state-(?:ok|stale|failed|offline|idle)|warn)\)/,
      `.chip--${v} 的状态色填充必须保留 —— 语义靠填充与徽点承载，不靠文字颜色`
    );
  }
});

test('横幅三档色阶递进：partial 7% < grid 14% < empty 20%', () => {
  const fillOf = (sel) => {
    const r = cssSrc.match(new RegExp(`\\.banner--${sel}\\s*\\{([^}]*)\\}`));
    assert.ok(r, `缺少 .banner--${sel}`);
    return Number((r[1].match(/var\(--c-(?:alert|warn)\)\s*(\d+)%/) || [])[1] || 0);
  };
  const [partial, grid, empty] = [fillOf('partial'), fillOf('grid'), fillOf('empty')];
  assert.ok(partial < grid, `partial(${partial}%) 必须轻于 grid(${grid}%)`);
  assert.ok(grid < empty, `grid(${grid}%) 必须轻于 empty(${empty}%)`);
  // 最重的 empty 用红系，其余两档用琥珀
  assert.match(cssSrc.match(/\.banner--empty\s*\{([^}]*)\}/)[1], /var\(--c-alert\)/);
  assert.match(cssSrc.match(/\.banner--grid\s*\{([^}]*)\}/)[1], /var\(--c-warn\)/);
});
