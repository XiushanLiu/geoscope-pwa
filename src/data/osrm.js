/**
 * OSRM 路线规划适配器
 *
 * 职责：只做「构造请求 + 解析响应」，网络与缓存分别由 core/http.js 与 core/cache.js
 * 负责。**本模块一行 fetch 都不写**（既有纪律：全应用唯一网络出口是 core/http.js，
 * 它提供并发 1 / 超时 / 重试 / 离线短路 / 统一 SourceResult）。
 *
 * 端点：`https://router.project-osrm.org/route/v1/driving/{lon},{lat};{lon},{lat};…`
 *
 * ★三个照实测固化的点（改参数前先看架构文档 §0）：
 *   - 坐标顺序是 **lon,lat**（写反会绕到地球另一侧，且往往仍返回 200）；
 *   - `overview=full&geometries=geojson` 是可用的，但 726 km 路线达 **137 KB / 5987 点**，
 *     所以几何**只在内存里活一次**，绝不落 localStorage（由源声明 `cacheable:false` 保证）；
 *   - 业务失败是 **HTTP 200 + `code` 不是 "Ok"**（如 `{"code":"InvalidOptions"}`），
 *     以及「HTTP 200 但 distance 全 0」—— 两者都必须在 parse 内翻译成带文案键的错误，
 *     否则 http.js 会把它们当成成功数据（本项目踩过的「假成功源」同类坑）。
 *
 * ⚠️ 口径：上述体积 / 时延数字均为**沙箱实测**（架构文档 §0 E1–E9），不是真机结论。
 */

import { makeErrorWithKey } from '../core/http.js';

/** OSRM 公共实例基址。 */
export const OSRM_HOST = 'https://router.project-osrm.org';

/** 许可署名的**文案键**（不是成品串）：存键的原因见 data/photon.js 同名注释。 */
export const OSRM_ATTRIBUTION_KEY = 'attr.osrm';

/** 时长口径标记：OSRM 公共实例给的是**自由流**时长，不是实时路况。界面必须照此标注。 */
export const DURATION_KIND = 'osrm-freeflow';

/** 请求坐标的精度：6 位小数（≈0.1 m）。 */
const URL_DIGITS = 6;

/** 缓存键坐标精度：4 位小数（≈11 m），与全项目 coordKey 口径一致。 */
const KEY_DIGITS = 4;

/**
 * 安全取有限数字（缺失一律 null，绝不变成 0）。
 *
 * @param {*} v 任意值。
 * @returns {number|null} 有限数字或 null。
 */
function _num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (Array.isArray(v)) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 定小数位输出（非有限数字输出该精度的 '0'，供键与 URL 的兜底位使用）。
 *
 * ★为什么不让 null 直接炸：缓存键与 URL 是在**不同时刻**被构造的（http.js 先算
 *   cacheKey 再 build），缓存键那一侧拿到的 ctx 未必已经过 `buildRouteRequest()` 的
 *   点数与坐标过滤。让一个坏点在构造缓存键时抛异常，表现出来是「请求还没发出就崩了」，
 *   而真正该报错的地方（`buildRouteRequest` 的 needMorePoints）反而没机会说话。
 *
 * @param {*} v 数值。
 * @param {number} digits 小数位。
 * @returns {string} 定长小数串。
 */
function _fixed(v, digits) {
  const n = _num(v);
  return (n === null ? 0 : n).toFixed(digits);
}

/**
 * 把点列拼成 OSRM 的路径片段：`{lon},{lat};{lon},{lat}`。
 *
 * ★顺序是**经度在前**（OSRM / GeoJSON 惯例）。写反不会报错，只会算到地球另一侧去 ——
 *   属于「看起来正常但错了」的那类 bug，所以这里显式注释并写进单测。
 *
 * @param {Array<{lat:number, lon:number}>} points 点列（≥2）。
 * @returns {string} 路径片段。
 */
export function pointsUrl(points) {
  const list = Array.isArray(points) ? points : [];
  return list.map((p) => `${_fixed(p.lon, URL_DIGITS)},${_fixed(p.lat, URL_DIGITS)}`).join(';');
}

/**
 * 生成缓存键用的点列指纹（4 位小数，≈11 m 粒度）。
 *
 * 为什么与 URL 用不同精度：URL 要的是**尽量准**（精度直接影响吸附距离），缓存键要的是
 * **稳**（11 m 内的抖动应命中同一份缓存，否则每挪一点就重算一次，配额与等待都白花）。
 *
 * @param {Array<{lat:number, lon:number}>} points 点列。
 * @returns {string} 形如 '39.9087,116.3975;34.3416,108.9398'。
 */
export function pointsHash(points) {
  const list = Array.isArray(points) ? points : [];
  return list.map((p) => `${_fixed(p.lat, KEY_DIGITS)},${_fixed(p.lon, KEY_DIGITS)}`).join(';');
}

/**
 * 构造路线请求。
 *
 * @param {{points:Array<{lat:number,lon:number}>, overview?:'full'|'simplified',
 *          annotations?:boolean}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 * @throws {Object} 点数不足 2 时抛出带 `rt.err.needMorePoints` 的 SourceError
 *          —— OSRM 对单点返回 HTTP 400，与其等一个必然失败的请求，不如当场失败。
 */
export function buildRouteRequest(ctx = {}) {
  const points = Array.isArray(ctx.points) ? ctx.points.filter((p) => p && _num(p.lat) !== null && _num(p.lon) !== null) : [];
  if (points.length < 2) {
    throw makeErrorWithKey('EMPTY', 'osrmRoute', 'rt.err.needMorePoints', {
      params: { n: points.length },
    });
  }
  const overview = ctx.overview === 'simplified' ? 'simplified' : 'full';
  // annotations 只在 full 时请求：切段要用逐边时长（实测 Σannotation 与 leg.duration 差 0.13%），
  // 而 simplified 的几何点太少，累积曲线对它没有意义，请求它只是白花几十 KB。
  const wantAnnotations = overview === 'full' && ctx.annotations !== false;

  const params = { overview, geometries: 'geojson', steps: false };
  if (wantAnnotations) params.annotations = 'true';

  return {
    url: `${OSRM_HOST}/route/v1/driving/${pointsUrl(points)}`,
    params,
    responseType: 'json',
  };
}

/**
 * 解析 OSRM 响应 → RouteInfo（架构 §4.3）。
 *
 * ★业务态判定（顺序不能变）：
 *   1) `code !== 'Ok'` → HTTP 层是 200，但 **没有路线**（如 `InvalidOptions`）。抛
 *      `rt.err.noRoute`，绝不返回 `{ok:true, data:{...空}}` —— 那正是「假成功源」。
 *   2) `distance === 0` → 两点可能落在没有道路的地方（实测：海上两坐标返回 200 但全 0）。
 *      抛 `rt.err.zeroDistance`，让用户看见「算出来是 0」而不是看到一条 0 km 的路线。
 *   3) 几何为空 → 抛 `rt.err.noGeometry`。
 *
 * @param {Object} json 响应 JSON。
 * @param {{overview?:string}} [ctx] 上下文（用于回填 requestedOverview）。
 * @returns {Object} RouteInfo；`geometry` 只在内存里活，调用方不得落盘。
 * @throws {Object} 业务态失败时抛出带文案键的 SourceError（由 http.js 提升为 SourceResult）。
 */
export function parseRoute(json, ctx = {}) {
  const code = json && json.code !== undefined && json.code !== null ? String(json.code) : '';
  if (code !== 'Ok') {
    throw makeErrorWithKey('BUSINESS', 'osrmRoute', 'rt.err.noRoute', {
      params: { code: code === '' ? 'UNKNOWN' : code },
    });
  }

  const routes = json && Array.isArray(json.routes) ? json.routes : [];
  const route = routes.length > 0 ? routes[0] : null;
  if (!route || typeof route !== 'object') {
    throw makeErrorWithKey('BUSINESS', 'osrmRoute', 'rt.err.noRoute', { params: { code: 'EMPTY_ROUTES' } });
  }

  const distanceM = _num(route.distance);
  const durationS = _num(route.duration);
  if (distanceM === null || distanceM === 0) {
    throw makeErrorWithKey('BUSINESS', 'osrmRoute', 'rt.err.zeroDistance', {});
  }

  const geo = route.geometry && Array.isArray(route.geometry.coordinates) ? route.geometry.coordinates : [];
  if (geo.length === 0) {
    throw makeErrorWithKey('BUSINESS', 'osrmRoute', 'rt.err.noGeometry', {});
  }

  /* ---- 途经点吸附：每个输入点被挪了多远（★必须显示，否则「途经点被挪了」是静默造假） ---- */
  const rawWaypoints = Array.isArray(json.waypoints) ? json.waypoints : [];
  const waypoints = rawWaypoints.map((w, i) => {
    const loc = Array.isArray(w && w.location) ? w.location : [];
    return {
      inputIndex: i,
      snapped: { lat: _num(loc[1]), lon: _num(loc[0]) },
      name: w && typeof w.name === 'string' ? w.name : '',
      snapDistanceM: _num(w && w.distance),
    };
  });
  let snapMaxM = null;
  for (const w of waypoints) {
    if (w.snapDistanceM === null) continue;
    if (snapMaxM === null || w.snapDistanceM > snapMaxM) snapMaxM = w.snapDistanceM;
  }

  /* ---- 分段 ---- */
  const rawLegs = Array.isArray(route.legs) ? route.legs : [];
  const legs = rawLegs.map((leg, i) => ({
    fromIndex: i,
    toIndex: i + 1,
    distanceM: _num(leg && leg.distance),
    durationS: _num(leg && leg.duration),
  }));

  /* ---- 逐边累积时长曲线：切段的唯一依据 ---- */
  // 只在 annotations 齐备时构建。缺失时给 null（kind='none'）而不是按距离比例估算 ——
  // 「距离 ÷ 假想速度」推出来的分段时长是编的，宁可让上层看见「没有依据」。
  let cumulativeS = null;
  let cumulativeKind = 'none';
  let edgeCount = 0;
  for (const leg of rawLegs) {
    const durs = leg && leg.annotation && Array.isArray(leg.annotation.duration) ? leg.annotation.duration : null;
    if (!durs) {
      edgeCount = -1;
      break;
    }
    edgeCount += durs.length;
  }
  if (edgeCount >= 0 && geo.length === edgeCount + 1) {
    const acc = [];
    let sum = 0;
    for (const leg of rawLegs) {
      const durs = leg.annotation.duration;
      for (let i = 0; i < durs.length; i += 1) {
        acc.push(sum);
        sum += _num(durs[i]) || 0;
      }
    }
    acc.push(sum);
    cumulativeS = acc;
    cumulativeKind = 'annotations';
  }

  return {
    ok: true,
    errorKey: null,
    fetchedAt: Date.now(),
    distanceM,
    durationS,
    durationKind: DURATION_KIND,
    waypoints,
    snapMaxM,
    legs,
    cumulativeS,
    cumulativeKind,
    geometry: geo,
    geometryPoints: geo.length,
    // shape 由用户显式「缓存此行程的路线几何」时才写入（single simplified 请求，实测 1.4 KB）
    shape: null,
    requestedOverview: ctx && ctx.overview === 'simplified' ? 'simplified' : 'full',
  };
}
