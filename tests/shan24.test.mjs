/**
 * 二十四山表与角度换算的行为契约（`src/core/shan24.js`）。
 *
 * 压住三件事：
 *   ① 山序与四正位的对应：卯 = 90°、午 = 180°、酉 = 270°、子 = 0°；
 *   ② 边界归山：每山跨 15°、以山名中心对称，355° 与 345° 分属「子」「壬」；
 *   ③ 非法入参返回 −1 / null —— 绝不把「没有角度」当成正北「子」。
 *
 * 零依赖：node:test + node:assert。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SHAN24, shanIndexOf, shanOf } from '../src/core/shan24.js';

test('SHAN24：24 个山名、无重复、四正位落点正确', () => {
  assert.equal(SHAN24.length, 24, '二十四山必须正好 24 个');
  assert.equal(new Set(SHAN24).size, 24, '山名不得重复');
  assert.equal(SHAN24[0], '子', '索引 0 必须是子（正北）');
  assert.equal(SHAN24[6], '卯', '索引 6 必须是卯（正东）');
  assert.equal(SHAN24[12], '午', '索引 12 必须是午（正南）');
  assert.equal(SHAN24[18], '酉', '索引 18 必须是酉（正西）');
});

test('shanIndexOf：四正位与整 15° 中心角', () => {
  assert.equal(shanIndexOf(0), 0, '0° → 子');
  assert.equal(shanIndexOf(90), 6, '90° → 卯');
  assert.equal(shanIndexOf(180), 12, '180° → 午');
  assert.equal(shanIndexOf(270), 18, '270° → 酉');
  // 每个山的中心角必须回到自己
  for (let i = 0; i < 24; i += 1) {
    assert.equal(shanIndexOf(i * 15), i, `${i * 15}° 应落在 ${SHAN24[i]}`);
  }
});

test('shanIndexOf：跨山边界与负角 / 超 360° 归一', () => {
  assert.equal(shanIndexOf(7.4), 0, '7.4° 仍属子');
  assert.equal(shanIndexOf(7.5), 1, '7.5° 起属癸');
  assert.equal(shanIndexOf(352.5), 0, '352.5° 起属子（子跨 −7.5°～7.5°）');
  assert.equal(shanIndexOf(355), 0, '355° 属子');
  assert.equal(shanIndexOf(345), 23, '345° 属壬');
  assert.equal(shanIndexOf(360), 0, '360° 归一到 0°');
  assert.equal(shanIndexOf(450), 6, '450° 归一到 90°（卯）');
  assert.equal(shanIndexOf(-15), 23, '−15° 归一到 345°（壬）');
  assert.equal(shanIndexOf(-90), 18, '−90° 归一到 270°（酉）');
});

test('shanIndexOf / shanOf：非法入参不得被当成正北', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '', '  ', 'abc', true, false, [], {}]) {
    assert.equal(shanIndexOf(bad), -1, `${String(bad)} 必须返回 −1`);
    assert.equal(shanOf(bad), null, `${String(bad)} 的 shanOf 必须返回 null`);
  }
  // 数字字符串是合法入参（与 Number() 口径一致）
  assert.equal(shanIndexOf('90'), 6, "字符串 '90' 应读成 90°");
});

test('shanOf：返回山名与中心角，且中心角与该山索引一致', () => {
  const shan = shanOf(92);
  assert.deepEqual(shan, { index: 6, name: '卯', centerDeg: 90 });
  assert.equal(shanOf(0).name, '子');
  assert.equal(shanOf(359).name, '子');
  assert.equal(shanOf(358).centerDeg, 0);
});
