/**
 * 源注册表（唯一真相源）
 *
 * 职责：集中声明数据源的 id / 标签 / 宿主 / 超时 / 重试 / TTL / 缓存键 / 请求构造 /
 * 响应解析 / 瓦片指纹 / 署名 / 优先级。适配器只负责「构造 + 解析」，UI 只负责渲染，
 * 新增数据源只需在此追加条目，不改 UI（架构第 3 条）。
 *
 * ★两张表，别搞混（架构 §3.2）：
 *   - `SOURCES` / `SOURCE_LIST`：**自检六路**。自检页遍历它，`tests/sources.test.mjs:57`
 *     与 `tools/verify-standalone.mjs:106` 用「恰好六路」硬断言钉着。
 *   - `SOURCE_TABLE`：**全量表**（六路 + 气候常态一路 = 七路）。`getSource()`
 *     查它，也就是 `core/http.js` 解析源规格时看到的全部。
 *   拆开这两张表，是为了让「自检只跑那六路可公开取样的源」与「新源可以被请求」
 *   同时成立 —— 气候常态一路不进自检（单次响应 303 KB、
 *   耗时十几秒，放进自检取样只会让自检永远跑不完，而且它是**用户点按钮才发起**的
 *   查阅物，不是每屏都要探的源）。把它塞进 SOURCE_LIST 会直接把那两条断言弄红。
 *
 * ★2026-10-17 自驾下线：原来的「自驾两路」（路线规划 / POI 候选）已从全量表摘除，
 *   九路 → 七路。它们本就依赖用户自填的第三方 Key、且路线规划源响应不可缓存，不属于
 *   「可公开取样的环境数据源」；摘除后 `SOURCE_LIST` 仍是原本的六路，一条没动。
 *
 * 依赖方向：data → core。本模块在加载时把 getSource 注入 core/http.js 的解析器，
 * 从而让 core 层保持对 data 层零依赖。
 *
 * 实测契约固化值（不得改动）：
 *   weather   6000ms / retry 1 / TTL 600000
 *   air       6000ms / retry 1 / TTL 600000
 *   geocode   6000ms / retry 1 / TTL 86400000
 *   elevation 6000ms / retry 1 / TTL 604800000
 *   reverse   6000ms / retry 1 / TTL 604800000
 *   tile      6000ms / retry 0 / 不缓存
 */

import { makeKey } from '../core/cache.js';
import { setSourceResolver } from '../core/http.js';
import { round4 } from '../core/geo.js';
import { t } from '../i18n/index.js';
import {
  WEATHER_HOST,
  AIR_HOST,
  GEOCODE_HOST,
  ELEVATION_HOST,
  OPENMETEO_ATTRIBUTION_KEY,
  buildWeatherRequest,
  parseWeather,
  buildAirRequest,
  parseAir,
  buildGeocodeRequest,
  parseGeocode,
  buildElevationRequest,
  parseElevation,
} from './openmeteo.js';
import {
  PHOTON_HOST,
  PHOTON_ATTRIBUTION_KEY,
  buildReverseRequest,
  parseReverse,
} from './photon.js';
import { TILE_BASE, TILE_ATTRIBUTION_KEY, tileUrl, fingerprint } from './tiles.js';
// 气候常态（ERA5 1991–2020 自算月平均）：同样只进全量表，不进自检六路，
// 理由见文件头与 data/climate.js 的 CLIMATE_SOURCES 注释。
import { CLIMATE_SOURCES } from './climate.js';

/**
 * ★label 与 attribution 是**惰性 getter**，不是写死的字符串：
 *   SOURCES 在模块求值那一刻构造，而入口模块（app.js / selfcheck.js …）顶层的
 *   `applyLocale(getLocale())` 要等它 import 完才轮得到自己执行 —— 若在此处就调 `t()`，
 *   存的语言偏好是英文、六路源名却永远是中文（import 先于 body 求值，改不了的顺序）。
 *   所以这里只存 labelKey / attributionKey，真正的翻译留到**被读取时**发生。
 *   调用方写法不变（照旧 `spec.label` / `spec.attribution`），故无需改任何消费点。
 *
 * @typedef {Object} SourceSpec
 * @property {string} id
 * @property {string} labelKey
 * @property {string} label
 * @property {string} host
 * @property {number} timeoutMs
 * @property {number} retry
 * @property {number} ttlMs
 * @property {boolean} cacheable
 * @property {(ctx:Object)=>string} cacheKey
 * @property {(ctx:Object)=>Object} build
 * @property {(payload:*, ctx:Object)=>*} parse
 * @property {(bytes:*, headers:*)=>Promise<{fp:string, algo:string}>} [fingerprint]
 * @property {string} attributionKey
 * @property {string} attribution
 * @property {number} priority
 * @property {boolean} critical
 * @property {'api'|'tile'} kind  // 取样方式分组：api 走「预热 + N 次取样」，tile 走「3 样式 × 3 坐标指纹」
 */

/** 坐标型缓存键：'gs:v1:<id>:<lat4>:<lon4>'。 */
function _coordKey(id, ctx) {
  return makeKey(id, round4(ctx.lat).toFixed(4), round4(ctx.lon).toFixed(4));
}

/** @type {Object<string, SourceSpec>} 六路源注册表（键顺序 = 自检页遍历顺序）。 */
export const SOURCES = {
  weather: {
    id: 'weather',
    labelKey: 'source.weather',
    get label() { return t(this.labelKey); },
    host: WEATHER_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 600000,
    cacheable: true,
    critical: true,
    kind: 'api',
    priority: 1,
    attributionKey: OPENMETEO_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => _coordKey('weather', ctx),
    build: buildWeatherRequest,
    parse: parseWeather,
  },

  air: {
    id: 'air',
    labelKey: 'source.air',
    get label() { return t(this.labelKey); },
    host: AIR_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 600000,
    cacheable: true,
    critical: true,
    kind: 'api',
    priority: 2,
    attributionKey: OPENMETEO_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => _coordKey('air', ctx),
    build: buildAirRequest,
    parse: parseAir,
  },

  geocode: {
    id: 'geocode',
    labelKey: 'source.geocode',
    get label() { return t(this.labelKey); },
    host: GEOCODE_HOST,
    timeoutMs: 6000,
    retry: 1,
    // ★搜索是用户正在等的操作，必须插队直发：排在后台 6~7 路取数后面时，
    //   弱网下要等几十秒，界面表现就是「搜城市卡死」（见 http.js 的 exec/skipQueue）。
    skipQueue: true,
    ttlMs: 86400000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 5,
    attributionKey: OPENMETEO_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => makeKey('geocode', encodeURIComponent(String(ctx.keyword || '')), ctx.lang || 'zh'),
    build: buildGeocodeRequest,
    parse: parseGeocode,
  },

  elevation: {
    id: 'elevation',
    labelKey: 'source.elevation',
    get label() { return t(this.labelKey); },
    host: ELEVATION_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 604800000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 3,
    attributionKey: OPENMETEO_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => _coordKey('elevation', ctx),
    build: buildElevationRequest,
    parse: parseElevation,
  },

  reverse: {
    id: 'reverse',
    labelKey: 'source.reverse',
    get label() { return t(this.labelKey); },
    host: PHOTON_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 604800000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 4,
    attributionKey: PHOTON_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => _coordKey('reverse', ctx),
    build: buildReverseRequest,
    parse: parseReverse,
  },

  tile: {
    id: 'tile',
    labelKey: 'source.tile',
    get label() { return t(this.labelKey); },
    host: TILE_BASE,
    timeoutMs: 6000,
    retry: 0,
    // ★ttlMs / cacheable 对瓦片**不生效**：瓦片不走 http.js 的缓存层
    // （probeTile 直接用 requestRaw 取字节），它的缓存在 data/tiles.js 里，是纯内存
    // LRU（TILE_CACHE_MAX=96 条 / TILE_CACHE_TTL_MS=7 天），且**仅在该样式被授信后才写**。
    // 真机实测（docs/bench/2026-10-11-summary.md）：瓦片中位 693 ms、峰值 3198 ms（占 6 s 超时 53%），
    // 而同一 z/x/y 的字节与指纹跨四轮完全一致 → 内容确定不变，缓存不会拿到脏数据。
    ttlMs: 0,
    cacheable: false,
    critical: false,
    // kind 用于「自检取样分组」：瓦片不参与 API 结果表（取样方式是 3 样式 × 3 坐标，
    // 需要的 ctx 字段完全不同），必须靠 kind 区分，不能靠源 id 猜。
    kind: 'tile',
    priority: 6,
    attributionKey: TILE_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    // 瓦片不缓存字节：键仅用于会话内标识，不落 localStorage
    cacheKey: (ctx) => makeKey('tile', ctx.styleId || 'street', ctx.z, ctx.x, ctx.y),
    build: (ctx) => ({
      url: tileUrl(ctx.styleId || 'street', ctx.z, ctx.x, ctx.y),
      params: null,
      responseType: 'bytes',
    }),
    parse: (bytes) => ({ bytes: bytes && bytes.byteLength ? bytes.byteLength : 0 }),
    fingerprint,
  },
};

/** 自检页与聚合遍历顺序（= 自检六路的键顺序）。★保持恰好六路，别往里加。 */
export const SOURCE_LIST = Object.values(SOURCES);

/**
 * 全量源表：自检六路 + 气候常态一路（climate）= **七路**。
 *
 * `getSource()` 只查这一张表，因此 `core/http.js` 能解析到气候常态；
 * 而自检与聚合一律走 `SOURCE_LIST`，仍是六路。
 *
 * ★2026-10-17 自驾下线：原本在表里的「路线规划 / POI 候选」两路已随自驾一起删除
 *   （九路 → 七路）。「七路」这个数字被 `tests/climate.test.mjs` 硬断言钉着，
 *   改源表时别忘了同步。
 *
 * @type {Object<string, SourceSpec>}
 */
export const SOURCE_TABLE = { ...SOURCES, ...CLIMATE_SOURCES };

/**
 * 按 id 取源规格（查**全量表**）。
 *
 * @param {string} id 源 id。
 * @returns {SourceSpec|null} 源规格或 null。
 */
export function getSource(id) {
  return Object.prototype.hasOwnProperty.call(SOURCE_TABLE, id) ? SOURCE_TABLE[id] : null;
}

/**
 * 取关键源 id 列表（整体降级态判定用）。
 *
 * @returns {string[]} 关键源 id。
 */
export function criticalSourceIds() {
  return SOURCE_LIST.filter((s) => s.critical).map((s) => s.id);
}

/**
 * 取参与「API 结果表」的源（排除瓦片）。
 *
 * 自检页的 results[] 只统计这类源；瓦片在下方单独成表（3 样式 × 3 坐标）。
 *
 * @returns {SourceSpec[]} API 源列表。
 */
export function apiSources() {
  return SOURCE_LIST.filter((s) => s.kind === 'api');
}

/**
 * 取瓦片类源（当前只有 tile 一路）。
 *
 * @returns {SourceSpec[]} 瓦片源列表。
 */
export function tileSources() {
  return SOURCE_LIST.filter((s) => s.kind === 'tile');
}

// 注入解析器：让 core/http.js 可在不 import data 层的前提下解析源规格
setSourceResolver(getSource);
