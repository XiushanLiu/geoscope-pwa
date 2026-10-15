/**
 * 地点候选的**排序与消歧**（`src/data/openmeteo.js::rankPlaces` / `parseGeocode`）
 *
 * 为什么单独钉这一件事：真机报障「搜索出发地和目的地，出现一些莫名其妙的候选项」，
 * 截图里搜「北京」的三条是：北京·北京市 / 北京·重庆市 / 北京·四川；
 * 搜「上海」七条里有三条**长得一模一样**的「上海·云南」。
 *
 * 我 curl Open-Meteo Geocoding（GeoNames 数据）实测，截图**逐条重现、顺序都一致**：
 *   · 那些候选**全都是真的** —— 中国有大量叫「北京」「上海」的村庄（`PPL`）；
 *   · 根因不是数据错，是我们**没有排序**（服务端给什么序就什么序，
 *     于是一个 1896 万人口的首都和一个无名村庄平起平坐），
 *     而且 `parseGeocode` **把 `admin2` 丢了** ——
 *     那三条「上海·云南」其实是丽江市 / 曲靖市 / 昆明市，丢了 admin2 就再也分不开。
 *
 * 下面两组 fixture 是**真实响应的精简版**（只保留本文件用到的字段，数值原样）。
 *
 * 环境：纯 data 层，零第三方依赖（node:test + node:assert）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeocodeRequest, parseGeocode, rankPlaces } from '../src/data/openmeteo.js';

/** 搜「北京」的真实响应（3 条，顺序原样）。 */
const BEIJING_RAW = [
  { name: '北京', latitude: 39.9075, longitude: 116.39723, admin1: '北京市', admin2: '北京市', feature_code: 'PPLC', population: 18960744 },
  { name: '北京', latitude: 30.72608, longitude: 108.67483, admin1: '重庆市', admin2: '重庆市', feature_code: 'PPL' },
  { name: '北京', latitude: 30.9699, longitude: 103.94, admin1: '四川', admin2: '成都市', feature_code: 'PPL' },
];

/** 搜「上海」的真实响应（7 条，顺序原样）。 */
const SHANGHAI_RAW = [
  { name: '上海', latitude: 31.22222, longitude: 121.45806, admin1: '上海市', admin2: '上海市', feature_code: 'PPLA', population: 24874500 },
  { name: '上海', latitude: 29.32955, longitude: 121.05804, admin1: '浙江', admin2: '绍兴市', feature_code: 'PPL' },
  { name: '上海', latitude: 27.0741, longitude: 100.107, admin1: '云南', admin2: '丽江市', feature_code: 'PPL' },
  { name: '上海', latitude: 26.5058, longitude: 103.158, admin1: '云南', admin2: '曲靖市', feature_code: 'PPL' },
  { name: '上海', latitude: 26.0577, longitude: 103.282, admin1: '云南', admin2: '昆明市', feature_code: 'PPL' },
  { name: '上海', latitude: 27.5656, longitude: 101.432, admin1: '四川', admin2: '凉山彝族自治州', feature_code: 'PPL' },
  { name: '上海', latitude: 30.49409, longitude: 122.36624, admin1: '浙江', admin2: null, feature_code: 'ISL' },
];

/**
 * 把真实响应**倒序**再喂进去。
 *
 * ★为什么必须打乱：真实数据里最重要那条（上海市）恰好本来就排在第一 ——
 *   直接用它测「是否排序」，即使 `parseGeocode` 完全不排序也照样通过。
 *   变异测试当场抓到了这个洞（把 `return rankPlaces(mapped)` 改成 `return mapped`
 *   时 14 条测试全绿）。服务端的返回顺序我们无权假设，排序必须由我们自己保证。
 *
 * @param {Array<Object>} raw 原始 results。
 * @returns {Array<Object>} 倒序后的副本。
 */
function scrambled(raw) {
  return [...raw].reverse();
}

/* ------------------------------------------------------------------ */
/* 1. 排序：等级 → 人口 → 原始顺序                                      */
/* ------------------------------------------------------------------ */

test('★首都必须排在村庄前面（截图里「北京·重庆市」曾与首都平起平坐）', () => {
  const out = parseGeocode({ results: scrambled(BEIJING_RAW) });
  assert.equal(out.length, 3);
  assert.equal(out[0].admin1, '北京市', 'PPLC（1896 万人口的首都）必须排第一');
  assert.equal(out[0].featureCode, 'PPLC');
  assert.deepEqual(
    out.slice(1).map((p) => p.admin2),
    ['成都市', '重庆市'],
    '两条 PPL 村庄排在其后，且保持输入里的相对顺序（稳定排序）'
  );
});

test('★省级首府排在村庄前面（搜「上海」的七条）', () => {
  const out = parseGeocode({ results: scrambled(SHANGHAI_RAW) });
  assert.equal(out.length, 7);
  assert.equal(out[0].admin1, '上海市', 'PPLA（2487 万人口的省级首府）必须排第一');
});

test('同等级按人口降序；无人口的沉到最后', () => {
  const out = rankPlaces([
    { name: 'a', admin1: '甲', featureCode: 'PPL' },
    { name: 'b', admin1: '乙', featureCode: 'PPL', population: 500 },
    { name: 'c', admin1: '丙', featureCode: 'PPL', population: 9000 },
  ]);
  assert.deepEqual(out.map((p) => p.admin1), ['丙', '乙', '甲'], '有人口的按人口降序，无人口的排最后');
});

test('等级优先于人口：小省会也要排在大城市型村庄前面', () => {
  const out = rankPlaces([
    { name: 'big-village', featureCode: 'PPL', population: 900000 },
    { name: 'small-capital', featureCode: 'PPLA', population: 1000 },
  ]);
  assert.equal(out[0].name, 'small-capital', 'PPLA(1) < PPL(7)，等级先于人口比较');
});

test('★排序稳定：同级同人口时保持服务端原始顺序', () => {
  const list = [
    { name: 'one', featureCode: 'PPL' },
    { name: 'two', featureCode: 'PPL' },
    { name: 'three', featureCode: 'PPL' },
  ];
  assert.deepEqual(rankPlaces(list).map((p) => p.name), ['one', 'two', 'three']);
});

test('未知 / 缺失的 feature_code 走默认等级，不抛错', () => {
  const out = rankPlaces([
    { name: 'unknown', featureCode: 'ZZZZ' },
    { name: 'none', featureCode: null },
    { name: 'capital', featureCode: 'PPLC' },
  ]);
  assert.equal(out[0].name, 'capital');
  assert.deepEqual(out.slice(1).map((p) => p.name), ['unknown', 'none']);
});

test('rankPlaces 对非数组输入返回空数组，不抛错', () => {
  assert.deepEqual(rankPlaces(null), []);
  assert.deepEqual(rankPlaces(undefined), []);
  assert.deepEqual(rankPlaces({ results: [] }), []);
});

/* ------------------------------------------------------------------ */
/* 2. 消歧：admin2 必须留下来                                           */
/* ------------------------------------------------------------------ */

test('★parseGeocode 必须补出 admin2 / featureCode / population', () => {
  const out = parseGeocode({ results: scrambled(BEIJING_RAW) });
  assert.equal(out[0].admin2, '北京市');
  assert.equal(out[0].featureCode, 'PPLC');
  assert.equal(out[0].population, 18960744);
});

test('★三条「上海 · 云南」的 admin2 各不相同 —— 靠它才分得开', () => {
  const out = parseGeocode({ results: SHANGHAI_RAW });
  const yunnan = out.filter((p) => p.admin1 === '云南');
  assert.equal(yunnan.length, 3, '截图里那三条同名条目确实存在');
  const admin2s = yunnan.map((p) => p.admin2);
  assert.deepEqual(admin2s, ['丽江市', '曲靖市', '昆明市'], '丢掉 admin2 就无法区分这三条');
});

test('缺 admin2 的条目给 null，不编造', () => {
  const out = parseGeocode({ results: [{ name: 'x', latitude: 1, longitude: 2 }] });
  assert.equal(out[0].admin2, null);
  assert.equal(out[0].featureCode, null);
  assert.equal(out[0].population, null);
});

test('population 缺失不变成 0（0 会混进「有人口」那一档）', () => {
  const out = parseGeocode({ results: [{ name: 'x', latitude: 1, longitude: 2 }] });
  assert.equal(out[0].population, null, '缺失必须是 null，不能是 0');
});

/* ------------------------------------------------------------------ */
/* 3. 端到端：请求参数 + 解析后已排序                                    */
/* ------------------------------------------------------------------ */

test('★请求要 count=20（多拿候选，否则村庄挤掉城市后无处可排）', () => {
  const req = buildGeocodeRequest({ keyword: '北京' });
  assert.equal(req.params.count, 20);
  assert.equal(req.params.name, '北京');
});

test('★parseGeocode 出来就是排好序的（调用方不该再排一次）', () => {
  const out = parseGeocode({ results: scrambled(SHANGHAI_RAW) });
  assert.equal(out[0].admin1, '上海市', '解析结果的第一条就是最重要的那条');
  assert.deepEqual(
    out.map((p) => p.featureCode),
    ['PPLA', 'PPL', 'PPL', 'PPL', 'PPL', 'PPL', 'ISL'],
    '等级从高到低'
  );
});

test('空结果 / 畸形响应不崩', () => {
  assert.deepEqual(parseGeocode({}), []);
  assert.deepEqual(parseGeocode(null), []);
  assert.deepEqual(parseGeocode({ results: 'oops' }), []);
});
