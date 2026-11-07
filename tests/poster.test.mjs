/**
 * 分享海报绘制的行为契约（`src/core/poster.js`）。
 *
 * 压住四件事：
 *   ① 画布尺寸就是 750×1000（分享卡的固定比例），背景铺满整张；
 *   ② 地点、温度、单位、页脚这些文案**确实被画上去**（不是只存在于数据里）；
 *   ③ 超长地名被省略号截断，不会冲出画布；
 *   ④ 空数据 / 坏 ctx 不抛异常 —— 点一下按钮不该让页面白屏。
 *
 * 零依赖：node:test + node:assert + 一个记录调用的假 ctx（无需真实 canvas）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { drawPoster, POSTER_W, POSTER_H } from '../src/core/poster.js';

/**
 * 假 2D 上下文：只记录调用，不做像素运算。
 *
 * measureText 按「每字 10px」估算 —— 足够验证截断逻辑，且与真实字体无关。
 *
 * @returns {Object} 假 ctx。
 */
function fakeCtx() {
  const texts = [];
  return {
    texts,
    fillStyle: '',
    font: '',
    textAlign: '',
    save() {},
    restore() {},
    createLinearGradient() { return { addColorStop() {} }; },
    fillRect() {},
    fillText(text, x, y) { texts.push({ text: String(text), x, y }); },
    measureText(text) { return { width: String(text).length * 10 }; },
  };
}

/** 一份完整海报数据（与 ui/now.js 组装出来的字段一一对应）。 */
function model() {
  return {
    brand: '地候 GeoScope',
    place: '杭州',
    coord: '30.2741°N, 120.1551°E',
    temp: '23',
    unit: '°C',
    desc: '☀️ 晴',
    feels: '体感 26°',
    stats: [
      { label: '今日最高', value: '28°' },
      { label: '今日最低', value: '17°' },
      { label: '降水概率', value: '10%' },
      { label: '湿度', value: '54%' },
    ],
    date: '11-07 14:30',
    footer: '数据来源 Open-Meteo',
  };
}

test('尺寸固定为 750×1000，且绘制成功返回 true', () => {
  assert.equal(POSTER_W, 750);
  assert.equal(POSTER_H, 1000);
  const ctx = fakeCtx();
  let bg = null;
  ctx.fillRect = (x, y, w, h) => { if (!bg) bg = [x, y, w, h]; };
  assert.equal(drawPoster(ctx, model()), true);
  assert.deepEqual(bg, [0, 0, POSTER_W, POSTER_H], '背景必须铺满整张画布');
});

test('地点、温度、单位、页脚都被画到画布上', () => {
  const ctx = fakeCtx();
  drawPoster(ctx, model());
  const all = ctx.texts.map((c) => c.text);
  for (const expect of ['杭州', '23', '°C', '体感 26°', '数据来源 Open-Meteo', '地候 GeoScope']) {
    assert.ok(all.includes(expect), `缺少文案「${expect}」`);
  }
  // 温度与单位必须分开画（避免「23°°C」这种重复单位）
  assert.ok(!all.includes('23°C'), '温度与单位不得拼成一条文本');
});

test('超长地名以省略号收尾，且宽度不超出画布可用区', () => {
  const ctx = fakeCtx();
  const long = 'A'.repeat(200);
  drawPoster(ctx, { ...model(), place: long });
  const drawn = ctx.texts.find((c) => c.text.indexOf('A') === 0);
  assert.ok(drawn, '地名必须被画出来');
  assert.ok(drawn.text.endsWith('…'), '超长地名必须以省略号收尾');
  assert.ok(drawn.text.length * 10 <= POSTER_W - 128, '截断后仍不超出左右边距');
});

test('空数据不崩：缺字段画占位符，返回 true', () => {
  const ctx = fakeCtx();
  assert.equal(drawPoster(ctx, {}), true);
  assert.equal(drawPoster(ctx, null), true);
  assert.ok(ctx.texts.length > 0, '空数据也要有占位内容');
});

test('ctx 不可用时返回 false 且不抛异常（调用方据此播报失败）', () => {
  assert.equal(drawPoster(null, model()), false);
  assert.equal(drawPoster({}, model()), false);
});
