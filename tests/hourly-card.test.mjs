/**
 * 今日逐时曲线卡（阶段二：24h 温度 + 降水概率）
 *
 * 钉三条「不许造假」的口径：
 *   1) 只画取回来的点，不插值、不外推；
 *   2) 某点为 null 就断开折线，有空洞时**不许**填面积；
 *   3) 有效点不足 2 个就出空态，不许画一条平线糊弄。
 *
 * 另外锁一个替身层的地雷：SVG 必须走 createElementNS —— 用 createElement('svg')
 * 只会得到 HTMLUnknownElement，浏览器不渲染也不报错，测试里则直接 TypeError。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeDom, installStorage, installNavigator, installFetch, FakeStorage, text,
} from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });
installFetch();

const dom = createFakeDom([{ id: 'app' }]);
const { renderHourlyCard } = await import('../src/ui/now.js');

/** 本地时间 = UTC + 8h；UTC 06:00 → 当地 14:00。 */
const AT_MS = Date.UTC(2026, 10, 7, 6, 0, 0);

/**
 * 构造只含绘制所需字段的 snapshot。
 *
 * @param {Array<number|null>} temps 24 个温度（℃）。
 * @param {Array<number|null>} pops 24 个降水概率（%）。
 * @returns {Object} NowSnapshot。
 */
function snap(temps, pops) {
  return {
    atMs: AT_MS,
    weather: {
      atMs: AT_MS,
      tzOffsetSec: 8 * 3600,
      hourlyTempC: temps,
      hourlyPopPct: pops,
    },
  };
}

/** 24 个点的温度序列：5 点起升到 30，再降回 15。 */
const T24 = Array.from({ length: 24 }, (_, i) => 15 + Math.round(15 * Math.sin((Math.PI * i) / 23)));

/** 按 class 找节点。 */
const byClass = (cls) => dom.byId.app.descendants().filter((n) => n.classList.contains(cls));

test('完整 24 点：画出折线 + 面积 + 现在位置高亮', () => {
  dom.byId.app.textContent = '';
  renderHourlyCard(dom.byId.app, snap(T24, T24.map((_, i) => (i >= 12 ? 40 : 0))));

  const line = byClass('hourly-line');
  assert.equal(line.length, 1, '温度折线必须只有一条');
  const d = line[0].getAttribute('d');
  assert.equal((d.match(/M/g) || []).length, 1, '无空洞时折线应是一整段（1 个 M）');
  assert.equal((d.match(/L/g) || []).length, 23, '24 个点应为 23 段直线');
  assert.equal(byClass('hourly-area').length, 1, '无空洞才填面积');

  const bars = byClass('hourly-bar');
  assert.equal(bars.length, 12, '只有 12 点以后概率 > 0，应出 12 根柱');
  assert.ok(byClass('hourly-hl-line').length === 1, '必须有一条「现在」竖线');

  // UTC 06:00 + 8h = 当地 14 点：默认提示行显示的应是「现在」
  const tip = text(byClass('hourly-tip')[0]);
  assert.ok(tip.includes('现在'), `提示行应默认停在「现在」，实际：${tip}`);

  // 横轴刻度是今日 0/6/12/18/23 时
  const axis = text(byClass('hourly-axis')[0]);
  assert.ok(axis.includes('0') && axis.includes('23'), `横轴应覆盖 0 与 23 时，实际：${axis}`);
});

test('★中间有空点：折线必须断开成两段，且不许填面积', () => {
  dom.byId.app.textContent = '';
  const temps = T24.slice();
  temps[10] = null; // 第 10 小时缺测
  renderHourlyCard(dom.byId.app, snap(temps, T24.map(() => 0)));

  const d = byClass('hourly-line')[0].getAttribute('d');
  assert.equal((d.match(/M/g) || []).length, 2, `空洞两侧必须断开（2 个 M），实际：${d}`);
  assert.equal(byClass('hourly-area').length, 0, '★有空洞还填面积 = 把「不知道」涂成「有数据」');
});

test('★有效点不足 2 个：出空态，不许画平线', () => {
  dom.byId.app.textContent = '';
  renderHourlyCard(dom.byId.app, snap([null, null, 20, null, null], [null, null, 0, null, null]));

  assert.equal(byClass('hourly-line').length, 0, '画不出线就不许画');
  assert.equal(byClass('hourly-empty').length, 1, '必须如实显示「逐时数据未取到」');
});

test('降水概率为 null 时不出柱（null 是「不知道」，不是 0%）', () => {
  dom.byId.app.textContent = '';
  renderHourlyCard(dom.byId.app, snap(T24, T24.map(() => null)));
  assert.equal(byClass('hourly-bar').length, 0, '概率缺失时不该出现任何柱');
});

test('★等温日：无障碍标签必须报真实极值，不能把留白算进去', () => {
  dom.byId.app.textContent = '';
  // 全天 20℃ 一个值 —— 走「近乎等温」分支（留白 ±1℃），旧代码会读成 19°/21°
  renderHourlyCard(dom.byId.app, snap(Array(24).fill(20), Array(24).fill(0)));
  const label = byClass('hourly-svg')[0].getAttribute('aria-label');
  assert.ok(label.includes('20°'), `标签应报真实极值 20°，实际：${label}`);
  assert.ok(!label.includes('19°') && !label.includes('21°'), `标签不得出现留白值，实际：${label}`);
});

test('两端小时的降水柱不被 viewBox 裁掉', () => {
  dom.byId.app.textContent = '';
  renderHourlyCard(dom.byId.app, snap(T24, Array(24).fill(50)));
  const bars = byClass('hourly-bar');
  assert.equal(bars.length, 24);
  const xs = bars.map((b) => Number(b.getAttribute('x')));
  assert.ok(Math.min(...xs) >= 0, `0 时的柱不得越出左边界：${Math.min(...xs)}`);
  assert.ok(Math.max(...xs) + 6 <= 320, `23 时的柱不得越出右边界：${Math.max(...xs) + 6}`);
});
