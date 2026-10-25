/**
 * 底图三态（map / grid / no-map）契约复核。
 *
 * 背景：2026-10-11 四轮真机实测（瓦片中位 693 ms、峰值 3198 ms、波动 13 倍）后，
 * 主理人拍板把瓦片层从「单块失败即宣布无地图」改为「整批结束后三态裁决」：
 *   全成 → map；部分失败 → grid（仅网格 + 坐标，不宣布无地图）；全败 → no-map。
 *
 * 本文件只做一件事：验证这个契约在**主页面**真的落地了，而不只是 API 层存在。
 * 三态裁决函数本身是正确的（见前两条用例），问题出在调用方只喂给它一块瓦片。
 *
 * 零第三方依赖，纯 node:test + node:assert。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MAP_MODE,
  mapMode,
  setMapMode,
  degradeMapMode,
  isNoMapMode,
} from '../src/data/tiles.js';
import { overallMode, resetHealth } from '../src/data/health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

beforeEach(() => {
  setMapMode(MAP_MODE.MAP);
});

test('三态裁决函数本身正确：全成→map / 部分成→grid / 全败→no-map', () => {
  assert.equal(degradeMapMode([{ ok: true }, { ok: true }, { ok: true }]), 'map');
  assert.equal(degradeMapMode([{ ok: true }, { ok: true }, { ok: false }]), 'grid');
  assert.equal(degradeMapMode([{ ok: true }, { ok: false }, { ok: false }]), 'grid');
  assert.equal(degradeMapMode([{ ok: false }, { ok: false }, { ok: false }]), 'no-map');
});

test('空批不动模式（避免异常路径误伤底图）', () => {
  setMapMode(MAP_MODE.MAP);
  assert.equal(degradeMapMode([]), 'map');
  assert.equal(degradeMapMode(null), 'map');
  assert.equal(degradeMapMode(undefined), 'map');
});

// ---------------------------------------------------------------------------
// 以下是本轮复核的核心发现 —— 现已修复，下面 3 条是从「缺陷证据」翻转过来的正向断言
// ---------------------------------------------------------------------------

test('三块探测下 grid 可达（原「grid 数学上不可达」缺陷已修复）', () => {
  // 修复前 app.js 只探一块 → ok 只能取 0/1 → grid 的判定区间 0 < ok < 1 是空集。
  // 现在探 sampleTiles() 给出的 3 块：部分失败真的会落到 grid，而不是直接宣布无地图。
  assert.equal(degradeMapMode([{ ok: true }, { ok: true }, { ok: true }]), 'map');
  assert.equal(degradeMapMode([{ ok: true }, { ok: true }, { ok: false }]), 'grid', '3 块坏 1 块 → grid');
  assert.equal(degradeMapMode([{ ok: true }, { ok: false }, { ok: false }]), 'grid', '3 块坏 2 块 → grid');
  assert.equal(degradeMapMode([{ ok: false }, { ok: false }, { ok: false }]), 'no-map', '全败才宣布无地图');

  // 单块形态下确实没有 grid（这条保留，用来解释「为什么必须探多块」）
  assert.equal(degradeMapMode([{ ok: false }]), 'no-map');
  assert.notEqual(degradeMapMode([{ ok: false }]), 'grid');
});

test('探测多块瓦片并把整批结果交给 degradeMapMode（源码级确认）', () => {
  // ★2026-10-17 导航重构：`probeTileBatch()` 连同 `TILE_PROBE_COUNT` /
  //   `TILE_PROBE_BUDGET_MS` 已从 `ui/app.js` 迁到 `data/tiles.js`（地理页 compass.js
  //   要用同一条探测逻辑）。所以**整批探测的形状**改锁 tiles.js，
  //   而「调用方确实把整批结果喂给 degradeMapMode」这条接线仍锁 app.js。
  const tilesSrc = readFileSync(join(SRC, 'data', 'tiles.js'), 'utf8');
  const appSrc = readFileSync(join(SRC, 'ui', 'app.js'), 'utf8');

  for (const src of [tilesSrc, appSrc]) {
    assert.doesNotMatch(src, /tiles\[0\]/, '不得再只取 tiles[0] 单块探测');
    assert.doesNotMatch(src, /degradeMapMode\(\[probe\]\)/, '不得再把单元素数组喂给裁决函数');
  }
  // 探测循环搬进了 probeTileBatch()：整批时间预算要「逐块按剩余预算收紧超时」，
  // 循环因此必须留在一个能拿到整批起点的函数里。锁的是新形状，意图不变。
  assert.match(tilesSrc, /export async function probeTileBatch\(/, '整批探测函数必须在 data/tiles.js 里');
  assert.match(tilesSrc, /tiles\.slice\(0, count\)/, '整批探测内部应遍历取样坐标逐块探测');
  assert.match(tilesSrc, /TILE_PROBE_COUNT = 3/, '探测块数必须 ≥ 2，否则 grid 区间为空集');
  assert.match(tilesSrc, /TILE_PROBE_BUDGET_MS = 8000/, '整批预算必须仍是 8 s');
  // 接线：气候页（app.js）仍然探多块，并把整批结果交给裁决函数
  assert.match(appSrc, /probeTileBatch\('street', tiles, \{/, '应调用整批探测函数并传入取样坐标');
  assert.match(appSrc, /count: TILE_PROBE_COUNT/, '整批探测的块数必须由 TILE_PROBE_COUNT 决定');
  assert.match(appSrc, /degradeMapMode\(probes\)/, '应把整批结果交给裁决函数');
});

test('grid 态在健康层可见：overallMode() 返回 partial 而不是 live', () => {
  // health.js 原只在 isNoMapMode() 为真时返回 'no-map'，而 grid 时它恒为 false
  // → 会一路落到 return 'live'，出现「底图几乎全空却显示一切正常」的静默降级。
  // 现已补 grid 分支（复用 partial，不新增状态）。
  resetHealth();
  setMapMode(MAP_MODE.GRID);

  assert.equal(mapMode(), 'grid');
  assert.equal(isNoMapMode(), false, 'grid 态下 isNoMapMode() 仍应为 false');
  assert.equal(overallMode(), 'partial', 'grid 必须给出「部分不可用」，绝不能落到 live');

  // 回归：no-map 仍优先于 grid 语义，全败时该说无地图就说无地图
  setMapMode(MAP_MODE.NO_MAP);
  assert.equal(overallMode(), 'no-map');
  // 全成 → 一切正常
  setMapMode(MAP_MODE.MAP);
  assert.equal(overallMode(), 'live');
});

test('i18n 已备齐 mapMode 三态文案，但只有自检页在用', () => {
  const zh = readFileSync(join(SRC, 'i18n', 'zh.js'), 'utf8');
  for (const k of ['sc.mapMode.map', 'sc.mapMode.grid', 'sc.mapMode.no-map']) {
    assert.ok(zh.includes(`'${k}'`), `i18n 缺少文案键 ${k}`);
  }

  const sc = readFileSync(join(SRC, 'ui', 'selfcheck.js'), 'utf8');
  assert.match(sc, /sc\.mapMode\.\$\{/, '自检页应消费 sc.mapMode.<mode> 模板键');

  // sc.mapMode.* 是自检页术语，主页面不得消费（硬约束）。
  // 主页面表达 grid 走的是另一条：mode.grid 文案 + .banner--grid 变体
  //（原先这里写的是「grid 态在主页面没有任何上屏表现」，grid 上屏后该结论已失效，故更正）。
  // 正向断言见 tests/grid-banner.test.mjs。
  const app = readFileSync(join(SRC, 'ui', 'app.js'), 'utf8');
  assert.ok(
    !app.includes('sc.mapMode'),
    '主页面 app.js 不得消费 sc.mapMode（自检页术语）；grid 的上屏表达走 mode.grid'
  );
});
