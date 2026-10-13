/**
 * 自驾模块的两路新源（SourceSpec 注册）
 *
 * 职责：把 OSRM 路线与高德 POI 两路源登记成标准 SourceSpec，供 `core/http.js` 统一调度
 * （并发 1 / 超时 / 重试 / 离线短路 / 统一 SourceResult）。**本模块不自己发请求**。
 *
 * ★与「自检六路」的关系（改这里之前先看架构 §3.2）：
 *   `data/sources.js` 的 `SOURCE_LIST` 是**自检页遍历的六路**，被
 *   `tests/sources.test.mjs:57` 与 `tools/verify-standalone.mjs:106` 用「恰好六路」硬断言
 *   钉着。自驾两路**不进** SOURCE_LIST（它们不参与自检取样：OSRM 不可缓存、高德需要 Key，
 *   放进自检页只会让自检结果出现永远的失败项）。它们进 `SOURCE_TABLE`（全量表），
 *   `getSource()` 查全量表 —— 于是「自检仍是六路」与「新源可被请求」两件事都成立。
 *
 * 契约数值（架构 §4.8，不得随意改）：
 *   osrmRoute  9000ms / retry 1 / 不缓存（几何百 KB 量级，禁止落盘；数字口径见 osrm.js）
 *   amapPoi    6000ms / retry 1 / 缓存 6 小时（省每月 5000 次配额）
 */

import { makeKey } from '../core/cache.js';
import { request, makeErrorWithKey } from '../core/http.js';
import { t } from '../i18n/index.js';
import {
  OSRM_HOST,
  OSRM_ATTRIBUTION_KEY,
  buildRouteRequest,
  parseRoute,
  pointsHash,
} from './osrm.js';
import { AMAP_HOST, AMAP_ATTRIBUTION_KEY, buildPoiRequest, parsePoi } from './amap.js';

/**
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
 * @property {string} attributionKey
 * @property {string} attribution
 * @property {number} priority
 * @property {boolean} critical
 * @property {'api'|'tile'} kind
 */

/** @type {Object<string, SourceSpec>} 自驾两路源（键顺序 = 追加到全量表的顺序）。 */
export const ROAD_SOURCES = {
  osrmRoute: {
    id: 'osrmRoute',
    labelKey: 'source.osrmRoute',
    get label() { return t(this.labelKey); },
    host: OSRM_HOST,
    // 9000ms（不是既有源的 6000）：架构 §0 E3/E6 实测 full+annotations 达 362 KB，
    // 弱网下 6 s 偏紧。★仍是沙箱口径，【待真机复测】。
    timeoutMs: 9000,
    retry: 1,
    // ★不缓存：overview=full 单次的几何是百 KB 量级（数字、出处与口径见 src/data/osrm.js
    //   文件头的「体积口径」一节，全仓唯一出处），几趟长行程就能把 4.5 MB 预算吃光；而
    // cache.prune()/evictOldest() 会按 storedAt 淘汰最旧条目 —— 行程是用户数据，
    // 把它当缓存淘汰是灾难。几何只在内存里活一次。
    ttlMs: 0,
    cacheable: false,
    // 不进自检页（SOURCE_LIST），故 critical=false（critical 是「是否触发整体降级态」）。
    critical: false,
    kind: 'api',
    priority: 7,
    attributionKey: OSRM_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => makeKey('osrmRoute', pointsHash(ctx && ctx.points), (ctx && ctx.overview) || 'full'),
    build: buildRouteRequest,
    parse: parseRoute,
  },

  amapPoi: {
    id: 'amapPoi',
    labelKey: 'source.amapPoi',
    get label() { return t(this.labelKey); },
    host: AMAP_HOST,
    timeoutMs: 6000,
    retry: 1,
    // 6 小时：省配额（免费额度 5000 次/月），且候选是「参考信息」不是实测值。
    ttlMs: 21600000,
    cacheable: true,
    critical: false,
    kind: 'api',
    priority: 8,
    attributionKey: AMAP_ATTRIBUTION_KEY,
    get attribution() { return t(this.attributionKey); },
    cacheKey: (ctx) => {
      const lat = ctx && Number.isFinite(Number(ctx.lat)) ? Number(ctx.lat) : 0;
      const lon = ctx && Number.isFinite(Number(ctx.lon)) ? Number(ctx.lon) : 0;
      return makeKey(
        'amapPoi',
        (ctx && ctx.typecode) || '',
        encodeURIComponent(String((ctx && ctx.keyword) || '')),
        lat.toFixed(4),
        lon.toFixed(4),
        String((ctx && ctx.radius) || 0)
      );
    },
    build: buildPoiRequest,
    parse: parsePoi,
  },
};

/**
 * 自驾源的统一入口：**把 build() 抛出的失败收敛成 SourceResult**。
 *
 * 为什么需要这层包装：`core/http.js` 的 `request()` 只对 **parse 抛错**做了兜底（转成
 * SourceResult），而 `build()` 是在 try 之外调用的 —— 抛错会以**裸异常**的形式从
 * `request()` 的 Promise 里冒出来。本模块恰好有两路源会在 build 阶段抛：
 * 「没填高德 Key」（`rt.amap.noKey`）与「OSRM 点数不足 2」（`rt.err.needMorePoints`）。
 * 让它们变成未捕获的 Promise 异常，是本项目最忌讳的「静默断线」的另一种形态：
 * UI 层一个没写 try/catch 的调用点，按钮就点了没反应。
 *
 * 所以：UI 一律调本函数而不是直接 `request()`；它保证**任何失败都是 SourceResult 形状**，
 * 且 `error.messageKey` 是那个具体的文案键（不是一句通用的 error.PARSE）。
 *
 * @param {'osrmRoute'|'amapPoi'} sourceId 源 id。
 * @param {Object} ctx 上下文。
 * @param {{force?:boolean}} [opts] 透传给 http.request。
 * @returns {Promise<{ok:boolean, sourceId:string, data:*, error:Object|null, meta:Object, stale:boolean}>} SourceResult。
 */
export async function requestRoadSource(sourceId, ctx = {}, opts = {}) {
  try {
    return await request(sourceId, ctx, opts);
  } catch (err) {
    const messageKey = err && typeof err.messageKey === 'string' && err.messageKey !== '' ? err.messageKey : 'error.PARSE';
    const error = makeErrorWithKey((err && err.code) || 'BUSINESS', sourceId, messageKey, {
      params: (err && err.messageParams) || {},
    });
    return {
      ok: false,
      sourceId,
      data: null,
      error,
      meta: {
        attempts: 0,
        latencyMs: 0,
        queuedMs: 0,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        fromCache: false,
        cacheState: 'n/a',
        staleAgeMs: 0,
        requestUrl: '',
        httpStatus: null,
        bytes: null,
      },
      stale: false,
    };
  }
}
