/**
 * 拼音映射（`src/core/pinyin.js`）
 *
 * 钉死的是「键的归一化」这件事：查表前会把空格/连字符/下划线全部去掉，
 * 所以表里若写成 `'heng dian'` 这种带空格的键，**永远命中不了**，而且不会报错 ——
 * 表现只是「用户打 hengdian 搜不到」。v95 首发就踩了这个坑，实测：
 *   pinyinToChinese('hengdian') → null（表里是 'heng dian'）
 *   chineseToPinyin('横店')     → 'heng dian'（带空格的拼音发给上游，必然是 0 条）
 *
 * 环境：纯 core 层，零依赖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pinyinToChinese, chineseToPinyin, looksLikePinyin } from '../src/core/pinyin.js';

test('拼音 → 中文：大小写、空格、连字符都要归一后命中', () => {
  assert.equal(pinyinToChinese('wuzhen'), '乌镇');
  assert.equal(pinyinToChinese('Wuzhen'), '乌镇');
  assert.equal(pinyinToChinese('  WUZHEN  '), '乌镇');
  // ★回归：这三种写法以前全返回 null（表里存的是带空格的 'heng dian'）
  assert.equal(pinyinToChinese('hengdian'), '横店');
  assert.equal(pinyinToChinese('heng dian'), '横店');
  assert.equal(pinyinToChinese('heng-dian'), '横店');
});

test('拼音 → 中文：未收录 / 空值 / 非字符串一律 null，不许抛异常', () => {
  assert.equal(pinyinToChinese('shaoxing'), null, '未收录的拼音必须如实返回 null');
  assert.equal(pinyinToChinese(''), null);
  assert.equal(pinyinToChinese(null), null);
  assert.equal(pinyinToChinese(123), null);
});

test('中文 → 拼音：返回值必须是无空格形态（带空格的拼音发给上游必然 0 条）', () => {
  assert.equal(chineseToPinyin('乌镇'), 'wuzhen');
  assert.equal(chineseToPinyin('横店'), 'hengdian');
  assert.ok(!/\s/.test(chineseToPinyin('横店')), '★反查结果不许带空格');
});

test('中文 → 拼音：带行政后缀的词去后缀后仍能反查到', () => {
  // ★回归：以前 '乌镇镇' 反查是 null，而这类带后缀的地名恰恰最需要拼音兜底
  assert.equal(chineseToPinyin('乌镇镇'), 'wuzhen');
  assert.equal(chineseToPinyin('华西村'), 'huaxicun');
  assert.equal(chineseToPinyin('横店镇'), 'hengdianzhen', '表里有整词就优先用整词');
});

test('中文 → 拼音：未收录返回 null', () => {
  assert.equal(chineseToPinyin('泉州'), null);
  assert.equal(chineseToPinyin(''), null);
  assert.equal(chineseToPinyin(null), null);
});

test('looksLikePinyin：单段与「两段 + 空格/连字符」都算，中文与单字母不算', () => {
  assert.equal(looksLikePinyin('wuzhen'), true);
  assert.equal(looksLikePinyin('heng dian'), true, '★分词拼音要能进兜底分支');
  assert.equal(looksLikePinyin('heng-dian'), true);
  assert.equal(looksLikePinyin('北京'), false);
  assert.equal(looksLikePinyin('a'), false, '单字母不算');
  assert.equal(looksLikePinyin('new york city'), false, '三段以上不当作拼音（是完整英文地名）');
  assert.equal(looksLikePinyin(''), false);
  assert.equal(looksLikePinyin(null), false);
});
