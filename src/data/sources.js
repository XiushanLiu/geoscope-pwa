/**
 * 源注册表（唯一真相源）
 *
 * 职责：集中声明六路数据源的 id / 标签 / 宿主 / 超时 / 重试 / TTL / 缓存键 / 请求构造 /
 * 响应解析 / 瓦片指纹 / 署名 / 优先级。适配器只负责「构造 + 解析」，UI 只负责渲染，
 * 新增数据源只需在此追加条目，不改 UI（架构第 3 条）。
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
import { t } from '../i18n/zh.js';
import {
  WEATHER_HOST,
  AIR_HOST,
  GEOCODE_HOST,
  ELEVATION_HOST,
  OPENMETEO_ATTRIBUTION,
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
  PHOTON_ATTRIBUTION,
  buildReverseRequest,
  parseReverse,
} from './photon.js';
import { TILE_BASE, TILE_ATTRIBUTION, tileUrl, fingerprint } from './tiles.js';

/**
 * @typedef {Object} SourceSpec
 * @property {string} id
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
    label: t('source.weather'),
    host: WEATHER_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 600000,
    cacheable: true,
    critical: true,
    kind: 'api',
    priority: 1,
    attribution: OPENMETEO_ATTRIBUTION,
    cacheKey: (ctx) => _coordKey('weather', ctx),
    build: buildWeatherRequest,
    parse: parseWeather,
  },

  air: {
    id: 'air',
    label: t('source.air'),
    host: AIR_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 600000,
    cacheable: true,
    critical: true,
    kind: 'api',
    priority: 2,
    attribution: OPENMETEO_ATTRIBUTION,
    cacheKey: (ctx) => _coordKey('air', ctx),
    build: buildAirRequest,
    parse: parseAir,
  },

  geocode: {
    id: 'geocode',
    label: t('source.geocode'),
    host: GEOCODE_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 86400000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 5,
    attribution: OPENMETEO_ATTRIBUTION,
    cacheKey: (ctx) => makeKey('geocode', encodeURIComponent(String(ctx.keyword || '')), ctx.lang || 'zh'),
    build: buildGeocodeRequest,
    parse: parseGeocode,
  },

  elevation: {
    id: 'elevation',
    label: t('source.elevation'),
    host: ELEVATION_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 604800000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 3,
    attribution: OPENMETEO_ATTRIBUTION,
    cacheKey: (ctx) => _coordKey('elevation', ctx),
    build: buildElevationRequest,
    parse: parseElevation,
  },

  reverse: {
    id: 'reverse',
    label: t('source.reverse'),
    host: PHOTON_HOST,
    timeoutMs: 6000,
    retry: 1,
    ttlMs: 604800000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 4,
    attribution: PHOTON_ATTRIBUTION,
    cacheKey: (ctx) => _coordKey('reverse', ctx),
    build: buildReverseRequest,
    parse: parseReverse,
  },

  tile: {
    id: 'tile',
    label: t('source.tile'),
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
    attribution: TILE_ATTRIBUTION,
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

/** 自检页与聚合遍历顺序（= 上表键顺序）。 */
export const SOURCE_LIST = Object.values(SOURCES);

/**
 * 按 id 取源规格。
 *
 * @param {string} id 源 id。
 * @returns {SourceSpec|null} 源规格或 null。
 */
export function getSource(id) {
  return Object.prototype.hasOwnProperty.call(SOURCES, id) ? SOURCES[id] : null;
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
