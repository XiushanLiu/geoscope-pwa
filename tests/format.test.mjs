/**
 * core/format.js 独立验证（含工程师自报「缺失值显示成 0」缺陷的回归用例）
 *
 * 覆盖：null / undefined / 空串 / NaN / 布尔 / 非数值字符串 → 一律显示占位符 '—'，
 * **绝不显示成 0**；0 本身必须正常显示；单位后缀正确；坐标 / 时延 / 陈旧时长 /
 * 相对时间 / 文件名时间戳。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlaceholder } from './harness.mjs';

const fmt = await import('../src/core/format.js');
const i18nMod = await import('../src/i18n/index.js');

/** 缺失值集合（业务层最可能出现的形式）。 */
const MISSING = [null, undefined, '', NaN, true, false, 'abc', {}, () => 1];

test('占位符常量与缺失值：所有数值格式化函数都不显示成 0', () => {
  assert.equal(fmt.DASH, '—');
  const fns = ['num', 'tempC', 'feelsC', 'humidity', 'precipMm', 'wind', 'pressure', 'visibility', 'elevationM', 'pollutant', 'latency', 'bytes'];
  for (const name of fns) {
    for (const bad of MISSING) {
      assertPlaceholder(fmt[name](bad), `fmt.${name}(${String(bad)})`);
    }
  }
});

test('缺失值：hhmm / mdHm / duration / coord / staleFor / relativeTime 同样显示占位符', () => {
  for (const bad of MISSING) {
    assertPlaceholder(fmt.hhmm(bad), `hhmm(${String(bad)})`);
    assertPlaceholder(fmt.mdHm(bad), `mdHm(${String(bad)})`);
    assertPlaceholder(fmt.duration(bad), `duration(${String(bad)})`);
    assertPlaceholder(fmt.staleFor(bad), `staleFor(${String(bad)})`);
    assertPlaceholder(fmt.relativeTime(bad), `relativeTime(${String(bad)})`);
    assertPlaceholder(fmt.coord(bad, 116), `coord(${String(bad)},116)`);
    assertPlaceholder(fmt.coord(39, bad), `coord(39,${String(bad)})`);
  }
});

test('回归：空对象 / 数组下标的脏值不得渲染成 0', () => {
  // 上游 _n() 会把缺失字段写成 null，下面模拟「解析出 null 的字段」逐一回归
  const dirty = { tempC: null, feelsC: null, humidityPct: undefined, precipMm: '', windMs: NaN };
  assertPlaceholder(fmt.tempC(dirty.tempC), 'tempC=null');
  assertPlaceholder(fmt.tempC(dirty.feelsC), 'feelsC=null');
  assertPlaceholder(fmt.humidity(dirty.humidityPct), 'humidity=undefined');
  assertPlaceholder(fmt.precipMm(dirty.precipMm), 'precipMm=""');
  assertPlaceholder(fmt.wind(dirty.windMs), 'windMs=NaN');
  // 且绝不能出现「0」字样
  for (const v of [fmt.tempC(dirty.tempC), fmt.humidity(dirty.humidityPct), fmt.precipMm(dirty.precipMm)]) {
    assert.ok(!/0/.test(v), `缺失值渲染结果不得包含 0：${v}`);
  }
});

test('0 必须正常显示（区分「真 0」与缺失）', () => {
  assert.equal(fmt.tempC(0), '0°');
  assert.equal(fmt.humidity(0), '0%');
  assert.equal(fmt.precipMm(0), '0.0 mm');
  assert.equal(fmt.num(0, 1, '°C'), '0.0 °C');
  assert.equal(fmt.latency(0), '0 ms');
  assert.equal(fmt.bytes(0), '0 B');
  assert.equal(fmt.elevationM(0), '0 m');
  assert.equal(fmt.pollutant(0), '0.0 µg/m³');
});

test('单位与换算正确', () => {
  assert.equal(fmt.num(23.44, 1, '°C'), '23.4 °C');
  assert.equal(fmt.tempC(-5.6, 0), '-6°');
  assert.equal(fmt.humidity(47.6), '48%');
  assert.equal(fmt.precipMm(0.44), '0.4 mm');
  assert.equal(fmt.wind(3.2), '3.2 m/s · 11.5 km/h', '风速必须同时给 km/h');
  assert.equal(fmt.pressure(1013.6), '1014 hPa');
  assert.equal(fmt.visibility(12400), '12.4 km', '≥1000m 必须转 km');
  assert.equal(fmt.visibility(800), '800 m');
  assert.equal(fmt.visibility(999.6), '1000 m');
  assert.equal(fmt.elevationM(43.4), '43 m');
  assert.equal(fmt.pollutant(12.34), '12.3 µg/m³');
  assert.equal(fmt.latency(1234.6), '1235 ms');
  assert.equal(fmt.bytes(512), '512 B');
  assert.equal(fmt.bytes(2048), '2.0 KB');
  assert.equal(fmt.bytes(5 * 1024 * 1024), '5.00 MB');
});

test('坐标：四位小数 + N/S/E/W，负号消掉', () => {
  assert.equal(fmt.coord(39.9087, 116.3975), '39.9087°N, 116.3975°E');
  assert.equal(fmt.coord(-33.8688, 151.2093), '33.8688°S, 151.2093°E');
  assert.equal(fmt.coord(0, 0), '0.0000°N, 0.0000°E');
  assert.equal(fmt.coord(-0.00001, -0.00001), '0.0000°S, 0.0000°W');
});

test('时延 hhmm / mdHm 按时区偏移换算，pad2 容错', () => {
  assert.equal(fmt.pad2(null), '00');
  assert.equal(fmt.pad2(7), '07');
  assert.equal(fmt.pad2(7.9), '07');
  assert.equal(fmt.hhmm(Date.UTC(2025, 0, 5, 7, 12), 0), '07:12');
  assert.equal(fmt.hhmm(Date.UTC(2025, 0, 4, 23, 20), 8 * 3600), '07:20', '东八区偏移必须生效');
  assert.equal(fmt.mdHm(Date.UTC(2025, 0, 5, 7, 12), 0), '01-05 07:12');
});

test('duration / staleFor / relativeTime 分档（★产出结构化量，由 tr() 翻译成话）', () => {
  // 这三个函数现在返回 { key, params } 而不是字符串：core 不许 import i18n，而中英文
  // 的语序不同（「10 小时 32 分」 vs "10h 32m"），拼片段必错。这里同时钉住两件事：
  //   (a) 分档（选哪个时间单位、数字是多少）必须仍然正确 —— 这是纯计算；
  //   (b) 经 tr() 之后，中英文各是各自正确的那句话。
  const { tr, t, setLocale, getLocale } = i18nMod;
  const saved = getLocale();

  const zhCases = [
    [fmt.duration(0), '0 分'],
    [fmt.duration(45 * 60000), '45 分'],
    [fmt.duration(10 * 3600000 + 32 * 60000), '10 小时 32 分'],
    [fmt.duration(-1000), '0 分'],
    [fmt.staleFor(1500), '2 秒'],
    [fmt.staleFor(0), '1 秒'],
    [fmt.staleFor(3 * 60000 + 2000), '3 分钟'],
    [fmt.staleFor(2 * 3600000), '2 小时'],
    [fmt.staleFor(3 * 86400000), '3 天'],
  ];
  setLocale('zh');
  for (const [spec, want] of zhCases) {
    assert.equal(tr(spec), want, `中文：${JSON.stringify(spec)} 应为 ${want}`);
  }

  // 英文语序：'10h 32m' / '3 min' —— 不是把「小时」「分」两个词翻出来拼回去的结果
  setLocale('en');
  assert.equal(tr(fmt.duration(10 * 3600000 + 32 * 60000)), '10h 32m');
  assert.equal(tr(fmt.duration(45 * 60000)), '45m');
  assert.equal(tr(fmt.staleFor(3 * 60000 + 2000)), '3 min');
  assert.equal(tr(fmt.staleFor(1500)), '2 s');
  setLocale(saved);

  const now = Date.UTC(2025, 0, 5, 12, 0);
  setLocale('zh');
  assert.equal(tr(fmt.relativeTime(now - 5000, now)), '刚刚');
  assert.equal(tr(fmt.relativeTime(now - 3 * 60000, now)), '3 分钟前');
  assert.equal(tr(fmt.relativeTime(now - 2 * 3600000, now)), '2 小时前');
  assert.equal(tr(fmt.relativeTime(now - 3 * 86400000, now)), '3 天前');
  assert.equal(tr(fmt.relativeTime(now - 60 * 86400000, now)), '2 个月前');
  assert.equal(tr(fmt.relativeTime(now + 60000, now)), '刚刚', '未来时刻按「刚刚」处理（不得出现负数）');
  setLocale('en');
  assert.equal(tr(fmt.relativeTime(now - 3 * 60000, now)), '3 min ago');
  assert.equal(tr(fmt.relativeTime(now - 2 * 3600000, now)), '2 h ago');
  setLocale(saved);

  // 缺失仍返回占位符（字符串，不是 key），tr() 必须原样透传
  for (const bad of [null, undefined, NaN, 'x', {}]) {
    assert.equal(tr(fmt.duration(bad)), '—');
    assert.equal(tr(fmt.staleFor(bad)), '—');
    assert.equal(tr(fmt.relativeTime(bad)), '—');
  }
  // 缺 key 时 t() 返回 key 本身——这条是「可见的失败」策略，别改成返回空串
  assert.equal(t('definitely.not.a.key'), 'definitely.not.a.key');
});

test('stamp 生成 YYYYMMDD-HHmm 形态（本地时区）', () => {
  const s = fmt.stamp(new Date(2025, 0, 5, 14, 23).getTime());
  assert.ok(/^\d{8}-\d{4}$/.test(s), `文件名戳格式错误：${s}`);
  assert.equal(s.slice(0, 8), '20250105');
  assert.equal(s.slice(9), '1423');
  assert.notEqual(fmt.stamp(), fmt.stamp(0));
});

test('空白串 / 空数组 / 空白数组必须视为缺失（硬规则：缺失绝不显示成 0）', () => {
  // 硬约束「null/undefined/空串/NaN 一律显示占位符」的延伸：
  // 纯空白串与空数组在语义上同样是「没有值」，不得被 Number() 兜成 0。
  for (const bad of [' ', '\t', '\n', [], [0]]) {
    assert.equal(fmt.tempC(bad), fmt.DASH, `fmt.tempC(${JSON.stringify(bad)}) 必须显示占位符`);
    assert.equal(fmt.num(bad), fmt.DASH, `fmt.num(${JSON.stringify(bad)}) 必须显示占位符`);
  }
  // 数字字符串仍要正常解析（不能把 '23' 当成缺失）
  assert.equal(fmt.tempC('23'), '23°');
  assert.equal(fmt.num('23.4', 1), '23.4');
});

/* ---------- placeTitle：页头地名标题的排版加固（间隔号不落行首） ---------- */

test('placeTitle：间隔号前必为 NBSP，普通空格 + 间隔号的组合不复存在', () => {
  const s = '林溪别墅社区 · 百善镇 · 北京市 · 中国';
  const out = fmt.placeTitle(s);
  // 折行时「·」不会再落在行首：每处间隔号前是 NBSP（不可断），断点被挤到间隔号之后
  assert.equal(/ · /.test(out), false, '结果里不得再出现「普通空格 + 间隔号」的组合');
  const outArr = [...out];
  outArr.forEach((ch, i) => {
    if (ch === '·') {
      assert.equal(outArr[i - 1], '\u00A0', `第 ${i} 位间隔号前必须是 NBSP`);
    }
  });
  // 语义抽查：完整形态逐字符对照（3 处替换，其余原样）
  assert.equal(out, '林溪别墅社区\u00A0· 百善镇\u00A0· 北京市\u00A0· 中国');
});

test('placeTitle：幂等 —— 重复调用逐字节等价，不会出现连续 NBSP', () => {
  for (const x of ['林溪别墅社区 · 百善镇 · 北京市 · 中国', 'a · b · c', '北京市', '']) {
    const once = fmt.placeTitle(x);
    assert.equal(fmt.placeTitle(once), once, `placeTitle 应幂等：${JSON.stringify(x)}`);
    assert.equal(once.includes('\u00A0\u00A0'), false, '不得出现连续 NBSP');
  }
});

test('placeTitle：无间隔号的普通串原样返回（含坐标串）', () => {
  assert.equal(fmt.placeTitle('北京市'), '北京市');
  assert.equal(fmt.placeTitle('圣安东尼奥德洛斯巴尼奥斯'), '圣安东尼奥德洛斯巴尼奥斯');
  assert.equal(fmt.placeTitle(fmt.coord(39.9087, 116.3975)), fmt.coord(39.9087, 116.3975));
  // 行首/行末的孤立间隔号（无两侧空格）不属于替换模式，原样保留
  assert.equal(fmt.placeTitle('·'), '·');
  assert.equal(fmt.placeTitle('a·b'), 'a·b');
});

test('placeTitle：null / undefined / 数字 / 空串不抛异常，返回合理值', () => {
  // 调用方是首屏渲染路径，本函数永不抛
  assert.equal(fmt.placeTitle(null), '');
  assert.equal(fmt.placeTitle(undefined), '');
  assert.equal(fmt.placeTitle(''), '');
  assert.equal(fmt.placeTitle(123), '123');
  assert.equal(fmt.placeTitle(0), '0');
  // 数字转串里若真带分隔模式也照常处理
  assert.equal(fmt.placeTitle(12), '12');
});

test('placeTitle：替换是 1:1 的，结果长度与入参相同', () => {
  for (const x of ['林溪别墅社区 · 百善镇 · 北京市 · 中国', 'a · b', 'abc', '']) {
    assert.equal(fmt.placeTitle(x).length, x.length, `长度应逐字符相等：${JSON.stringify(x)}`);
  }
});
