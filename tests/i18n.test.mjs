/**
 * 中英文改造的守卫（tools/check.mjs 第 14 节的运行期孪生）
 *
 * 为什么两套都要：check.mjs 是**静态 + 反射**扫描，跑在提交前；这里是**真 import、真切换
 * locale、真调函数**，跑在 node --test 里。两者查的是同一件事的两个面 —— check 能扫到
 * 「中文表有、英文表没有」这种集合差，单测能查到「切到英文后界面上那句话真的变了」。
 *
 * 本文件钉死这四条底线：
 *   1) 两张文案表逐键同构（漏翻 / 多翻都失败）；
 *   2) core 层**不许 import i18n**（core ← data ← ui ← html 单向依赖）；
 *   3) core 产出的结构化 key，两张表里都有；
 *   4) 切到英文后，那些「中英语序不同」的句子真的按英文语序出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const i18n = await import('../src/i18n/index.js');
const { ZH } = await import('../src/i18n/zh.js');
const { EN } = await import('../src/i18n/en.js');
const wmo = await import('../src/core/wmo.js');
const fmt = await import('../src/core/format.js');
const http = await import('../src/core/http.js');
const store = await import('../src/core/store.js');

/** 还原 locale，避免用例之间互相污染（同一进程内 i18n 的 locale 是模块级的）。 */
function withLocale(locale, fn) {
  const saved = i18n.getLocale();
  i18n.setLocale(locale);
  try {
    return fn();
  } finally {
    i18n.setLocale(saved);
  }
}

test('① 两张文案表逐键同构：漏翻、多翻、空值都失败', () => {
  const zhSet = new Set(Object.keys(ZH));
  const enSet = new Set(Object.keys(EN));
  const onlyZh = [...zhSet].filter((k) => !enSet.has(k));
  const onlyEn = [...enSet].filter((k) => !zhSet.has(k));
  assert.deepEqual(onlyZh, [], `英文表缺 key：${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `英文表多 key：${onlyEn.join(', ')}`);
  assert.equal(zhSet.size, enSet.size);
  assert.ok(zhSet.size > 500, `表太小（${zhSet.size}），像是没加载全`);

  for (const k of zhSet) {
    assert.notEqual(String(ZH[k]).trim(), '', `中文表 ${k} 是空的`);
    if (enSet.has(k)) assert.notEqual(String(EN[k]).trim(), '', `英文表 ${k} 是空的`);
  }
});

test('② 占位符逐条对齐：两句的 {name} 集合必须一致', () => {
  const phOf = (s) => {
    const out = new Set();
    for (const m of String(s).matchAll(/\{(\w+)\}/g)) out.add(m[1]);
    return [...out].sort().join('|');
  };
  const bad = [];
  for (const k of Object.keys(ZH)) {
    if (!Object.prototype.hasOwnProperty.call(EN, k)) continue;
    if (phOf(ZH[k]) !== phOf(EN[k])) bad.push(`${k}（中文 {${phOf(ZH[k])}} vs 英文 {${phOf(EN[k])}}）`);
  }
  assert.deepEqual(bad, [], `占位符没对齐：${bad.join('; ')}`);
});

test('③ core 层不许 import i18n（单向依赖 core ← data ← ui ← html）', () => {
  // 「当前界面说哪国话」是上层状态。core 一旦 import 它，就是最底层反向读上层的
  // 全局可变状态 —— 既破坏分层，也让 core 的单测必须先摆好一个 locale。
  const dir = path.join(ROOT, 'src', 'core');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (/from\s+['"][^'"]*i18n\//.test(src)) offenders.push(`src/core/${name}`);
  }
  assert.deepEqual(offenders, [], `core 层不得 import i18n：${offenders.join(', ')}`);
});

test('④ core 产出的每一个结构化 key，两张表里都有', () => {
  const keys = [];
  for (let c = 0; c <= 99; c += 1) {
    const d = wmo.wmo(c);
    keys.push(d.key, d.shortKey);
  }
  keys.push(wmo.wmo(null).key, wmo.wmo(null).shortKey);
  for (const r of wmo.beaufortScale()) keys.push(r.key);
  for (const r of wmo.aqiScale()) keys.push(r.levelKey, r.adviceKey);
  for (const r of wmo.uvScale()) keys.push(r.levelKey, r.adviceKey);
  for (const k of wmo.windRose16()) keys.push(k, `${k}.abbr`);
  keys.push('w.windFrom');
  for (const ms of [0, 45 * 60000, 10 * 3600000 + 32 * 60000]) {
    const d = fmt.duration(ms);
    if (d && typeof d === 'object') keys.push(d.key);
  }
  for (const diff of [5000, 3 * 60000, 2 * 3600000, 3 * 86400000, 60 * 86400000]) {
    const r = fmt.relativeTime(Date.now() - diff, Date.now());
    if (r && typeof r === 'object') keys.push(r.key);
  }
  for (const ms of [1500, 0, 3 * 60000 + 2000, 2 * 3600000, 3 * 86400000]) {
    const s = fmt.staleFor(ms);
    if (s && typeof s === 'object') keys.push(s.key);
  }
  for (const code of ['OFFLINE', 'TIMEOUT', 'HTTP', 'NETWORK', 'PARSE', 'ABORT', 'EMPTY', 'UNSUPPORTED']) {
    keys.push(http.makeError(code, 'w').messageKey);
  }

  const uniq = [...new Set(keys)];
  const missZh = uniq.filter((k) => !Object.prototype.hasOwnProperty.call(ZH, k));
  const missEn = uniq.filter((k) => !Object.prototype.hasOwnProperty.call(EN, k));
  assert.deepEqual(missZh, [], `中文表缺：${missZh.join(', ')}`);
  assert.deepEqual(missEn, [], `英文表缺：${missEn.join(', ')}`);
});

test('⑤ 语序不同的那几句：切英文后真的按英文语序出来（不是拼片段）', () => {
  // 这四条是中英文**语序 / 词序**都不一样的地方，是「拼片段」方案必然翻车的点：
  //   中文「10 小时 32 分」 vs 英文 "10h 32m"
  //   中文「3 分钟前」     vs 英文 "3 min ago"
  //   中文「西北偏北风」   vs 英文 "wind from NNW"（后缀 vs 介词）
  //   中文「清风（4 级）」 vs 英文 "Moderate breeze (force 4)"
  const zhOut = withLocale('zh', () => ({
    duration: i18n.tr(fmt.duration(10 * 3600000 + 32 * 60000)),
    ago: i18n.tr(fmt.relativeTime(Date.now() - 3 * 60000, Date.now())),
    wind: i18n.t('w.windFrom', { dir: i18n.t('dir.15.abbr') }),
    bf: i18n.t('w.beaufortLevel', { name: i18n.t('bf.4'), level: 4 }),
  }));
  const enOut = withLocale('en', () => ({
    duration: i18n.tr(fmt.duration(10 * 3600000 + 32 * 60000)),
    ago: i18n.tr(fmt.relativeTime(Date.now() - 3 * 60000, Date.now())),
    wind: i18n.t('w.windFrom', { dir: i18n.t('dir.15.abbr') }),
    bf: i18n.t('w.beaufortLevel', { name: i18n.t('bf.4'), level: 4 }),
  }));

  assert.equal(zhOut.duration, '10 小时 32 分');
  assert.equal(enOut.duration, '10h 32m');
  assert.equal(zhOut.ago, '3 分钟前');
  assert.equal(enOut.ago, '3 min ago');
  assert.equal(zhOut.wind, '西北偏北风');
  assert.equal(enOut.wind, 'wind from NNW');
  assert.equal(zhOut.bf, '和风（4 级）');
  assert.equal(enOut.bf, 'Moderate breeze (force 4)');
});

test('⑥ 缺 key 返回 key 本身（可见的失败），tr() 透传已成文本', () => {
  assert.equal(i18n.t('no.such.key.at.all'), 'no.such.key.at.all');
  assert.equal(i18n.tr(null), '');
  assert.equal(i18n.tr(undefined), '');
  // 数值缺失时 core 返回占位符「—」，它是**文本**不是 key，必须原样透传
  assert.equal(i18n.tr(fmt.duration(null)), '—');
  assert.equal(i18n.tr({ key: 'app.loading' }), '正在装载…');
});

test('⑦ 语言切换器：两档白名单钳位，读写往返', () => {
  const saved = store.getLocale();
  try {
    store.setLocale('en');
    assert.equal(store.getLocale(), 'en');
    store.setLocale('zh');
    assert.equal(store.getLocale(), 'zh');
    // 拼错 / 非法值一律回落中文（宁可回到默认语言，也不让 i18n 切到没有表的 locale）
    for (const bad of ['jp', '', null, undefined, 'EN', 42, {}]) {
      store.setLocale(bad);
      assert.equal(store.getLocale(), 'zh', `非法值 ${String(bad)} 必须回落 zh`);
    }
    assert.equal(i18n.setLocale('bogus'), 'zh', 'i18n 侧同样钳位');
  } finally {
    store.setLocale(saved);
  }
});

test('⑧ 导入备份不带 locale 时保持当前值（语言是本机属性，不进备份）', () => {
  const saved = store.getLocale();
  try {
    store.setLocale('en');
    // backup.js 的 prefs 里没有 locale 字段 —— 照 themeMode / fontScale 的既有处理
    store.replaceState({
      defaultPlace: { lat: 39.9087, lon: 116.3975, name: 'x' },
      favorites: [],
    });
    assert.equal(store.getLocale(), 'en', '从一台用英文的旧手机导入备份，不该把这台顶回中文');
  } finally {
    store.setLocale(saved);
  }
});

test('⑨ 英文表没有「照抄中文」的漏翻项', () => {
  // 除了两条**故意**不翻的语言名（中文界面里要写着 English 才救得了看不懂中文的人）
  const EXEMPT = new Set(['settings.lang.zh', 'settings.lang.en', 'app.name', 'app.shortName']);
  const copied = [];
  for (const k of Object.keys(ZH)) {
    if (EXEMPT.has(k)) continue;
    if (!Object.prototype.hasOwnProperty.call(EN, k)) continue;
    // 中文串里含汉字，英文表里却一字不差 —— 基本等于忘了翻
    if (/[一-龥]/.test(String(ZH[k])) && ZH[k] === EN[k]) copied.push(k);
  }
  assert.deepEqual(copied, [], `疑似漏翻（与中文同值）：${copied.join(', ')}`);
});

test('⑩ 语言选项名故意不翻：中文界面里那一项写着 English', () => {
  assert.equal(ZH['settings.lang.zh'], '中文');
  assert.equal(ZH['settings.lang.en'], 'English', '★中文界面里必须写着 English —— 用户看不懂当前界面语言时，唯一能救他的正是这个用他母语写着的选项名');
  assert.equal(EN['settings.lang.zh'], '中文');
  assert.equal(EN['settings.lang.en'], 'English');
});

test('⑪ ★六路源名与署名不做「求值期写死」：切英文后不含汉字', async () => {
  /*
   * 这次改造里真实踩到的坑：data/sources.js 的 SOURCES 是模块级常量，
   * 原先写成 `label: t('source.weather')` —— ES Module 的 import 先于调用方 body
   * 求值，入口模块顶层的 applyLocale(getLocale()) 必然跑在它**之后**，
   * 于是 store 里存着英文、六路源名却永远是中文，切语言重渲染也救不回来。
   * 正则看不出这种错（源码里明明写着 t()，看着很对），只有真切一次语言再读才现形。
   */
  const { SOURCE_LIST } = await import('../src/data/sources.js');
  const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

  const badEn = withLocale('en', () => {
    const bad = [];
    for (const s of SOURCE_LIST) {
      if (HAN.test(String(s.label))) bad.push(`label:${s.id}=${s.label}`);
      if (HAN.test(String(s.attribution))) bad.push(`attribution:${s.id}=${s.attribution}`);
    }
    return bad;
  });
  assert.deepEqual(badEn, [], `英文界面下仍含汉字（求值期写死 t()）：${badEn.join(' / ')}`);

  // 反方向也验：中文态下必须是中文，否则说明 getter 压根没接上 i18n
  const zhFirst = withLocale('zh', () => String(SOURCE_LIST[0].label));
  assert.ok(HAN.test(zhFirst), `中文态下源名应为中文：${zhFirst}`);

  // 署名是许可原文：服务商名与协议名不译，但「基于」这类说明词要跟语言走
  const enPhoton = withLocale('en', () => String(SOURCE_LIST.find((s) => s.id === 'reverse').attribution));
  assert.ok(enPhoton.includes('Photon by Komoot'), `署名里的服务商名不许译：${enPhoton}`);
  assert.ok(!HAN.test(enPhoton), `英文态署名不该有汉字：${enPhoton}`);
});

test('⑫ core/backup.js 的失败原因是「键」：切英文后 reasonText 出英文', async () => {
  const { inspectBackup } = await import('../src/core/backup.js');
  const { reasonText } = await import('../src/ui/errtext.js');

  const bad = inspectBackup('这不是 JSON');
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonKey, 'backup.badJson', 'core 只产键，不产成品串（core 不许 import i18n）');
  assert.equal(bad.reason, undefined, '★不许再带成品 reason —— 带着它就成了「不切语言也能work」的捷径，正是漏翻的温床');

  const zhWhy = withLocale('zh', () => reasonText(bad));
  const enWhy = withLocale('en', () => reasonText(bad));
  assert.ok(/[\u4E00-\u9FFF]/.test(zhWhy), `中文态原因应为中文：${zhWhy}`);
  assert.ok(!/[\u4E00-\u9FFF]/.test(enWhy) && enWhy !== zhWhy, `英文态原因应为英文且不同于中文：${enWhy}`);
});
