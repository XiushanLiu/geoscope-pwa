/**
 * 「我的」页导出 CSV 卡的回归（概要文案口径 + 按钮可用态）
 *
 * 为什么单独一个文件：tests/csv.test.mjs 测的是 core/csv.js 这份纯逻辑，而用户真正
 * 看得见的是设置页那张卡。踩过的两个坑都出在这层「两块拼起来」的接缝上 ——
 *   1) 概要里的时间原本用 fmt.mdHm()，只到月日。跨年的旧快照会显示得像「刚刚」，
 *      而备份那张卡是带年份的（_fmtExportedAt 的注释里写明了为什么）。同一页两张卡
 *      两种年份口径，比统一不带年份更糟。
 *   2) 导入备份会**整体覆盖**快照（core/backup.js），导入完这张卡若还写着上一次的
 *      地点就是假话，所以 _refreshCsv() 必须跟着 _refreshFavorites() 一起跑。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });

// 只预置设置页真正会 getElementById 的那几个 id（同 fontscale.test.mjs 的做法）。
// 'btn-csv' / 'csv-current' 虽然也是 id，但它们是 _renderPage 现场造的、不在静态 HTML 里，
// 假 DOM 的索引表认不到 —— 所以下面一律从 #app 子树里按属性找，不走 byId。
const dom = createFakeDom([
  { id: 'app' },
  { id: 'theme-mode' },
  { id: 'font-scale' },
  { id: 'font-result' },
  { id: 'csv-result' },
  { id: 'export-current' },
  { id: 'export-privacy' },
]);

/** 必须在 import 被测模块之前装好全局（store.js 在加载期决定走内存还是 localStorage）。 */
const { setLastSnapshot, getLastSnapshot } = await import('../src/core/store.js');
const { init } = await import('../src/ui/settings.js');
const { t } = await import('../src/i18n/zh.js');

/**
 * 从 #app 子树里按 id 属性找节点（假 DOM 的 getElementById 只索引预置 id）。
 *
 * @param {string} id 目标 id。
 * @returns {Object|null} 节点或 null。
 */
function nodeById(id) {
  const hits = dom.byId.app.descendants().filter((n) => n.getAttribute('id') === id);
  return hits.length ? hits[hits.length - 1] : null;
}

/** 一份「跨年」的快照：2024-12-31 23:50 取的，2025 年才来导出。 */
const OLD_SNAPSHOT = {
  atMs: new Date(2024, 11, 31, 23, 50).getTime(),
  coord: { lat: 39.9042, lon: 116.4074, source: 'geocode' },
  placeName: '北京',
  elevationM: 44,
  weather: {
    atMs: new Date(2024, 11, 31, 23, 50).getTime(),
    tzOffsetSec: 8 * 3600,
    tempC: -3.2,
    feelsC: -6.1,
    humidityPct: 51,
    precipMm: 0,
    windMs: 2.1,
    windDeg: 20,
    pressureHpa: 1024.1,
    visibilityM: 15300,
    wmoCode: 0,
    uvMax: 1.4,
  },
  air: { europeanAqi: 42, pm25: 21 },
  provenance: [],
};

beforeEach(() => {
  setLastSnapshot(null);
});

test('无快照时：导出按钮是禁用的，并给出「先去此刻页取一次」的提示', () => {
  assert.equal(getLastSnapshot(), null, '前置：本用例假定没有快照');
  init();

  const btn = nodeById('btn-csv');
  assert.ok(btn, '导出卡必须有 #btn-csv');
  assert.equal(btn.hasAttribute('disabled'), true, '没有数据时不许让人点出一个空文件');

  const notes = dom.byId.app
    .descendants()
    .map((n) => n.textContent)
    .filter((s) => s && s.indexOf('可导出') !== -1);
  assert.ok(
    notes.some((s) => s.indexOf(t('settings.csvEmpty')) !== -1),
    `应给出「${t('settings.csvEmpty')}」的提示，实际：${JSON.stringify(notes)}`
  );
});

test('有快照时：按钮可点，且概要里写清了是哪个地点', () => {
  setLastSnapshot(OLD_SNAPSHOT);
  init();

  const btn = nodeById('btn-csv');
  assert.ok(btn, '导出卡必须有 #btn-csv');
  assert.equal(btn.hasAttribute('disabled'), false, '有数据时不该还禁用');

  const cur = nodeById('csv-current');
  assert.ok(cur, '导出卡必须有 #csv-current 概要行');
  assert.ok(cur.textContent.indexOf('北京') !== -1, `概要要带地点，实际：${cur.textContent}`);
});

test('概要时间必须带年份（跨年旧快照不许显示得像「刚刚」）', () => {
  setLastSnapshot(OLD_SNAPSHOT);
  init();

  const cur = nodeById('csv-current');
  assert.ok(cur, '导出卡必须有 #csv-current 概要行');
  // 这份快照是 2024-12-31 取的。用 fmt.mdHm() 只会写出「12-31 23:50」——没有年份，
  // 用户在 2025 年看着它就是「今年的 12 月」，会把 N 天前的老数据当成刚导出的。
  assert.match(
    cur.textContent,
    /当前可导出：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · /,
    `概要时间必须是 YYYY-MM-DD HH:MM，实际：${cur.textContent}`
  );
  assert.ok(
    cur.textContent.indexOf('2024-') !== -1,
    `这份快照是 2024 年取的，概要里必须看得出年份，实际：${cur.textContent}`
  );
});
