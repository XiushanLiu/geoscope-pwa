/**
 * 高德 Web 服务 POI 搜索适配器
 *
 * 职责：把「住宿 / 景点 / 美食」三类候选查回来，并把 GCJ-02 坐标转成 WGS84。
 * 只做「构造请求 + 解析响应」，网络与缓存由 core/http.js / core/cache.js 负责，
 * **本模块一行 fetch 都不写**。
 *
 * ★三条必须守住的事（都是本项目会踩的坑）：
 *   1) **业务失败是 HTTP 200 + `status:"0"`**（实测：`{"status":"0","info":"INVALID_USER_KEY",
 *      "infocode":"10001"}`）。只看 HTTP 状态码会把业务失败当成功 —— 必须在 parse 里
 *      显式判 `status`，并按 infocode 翻译成**具体的桶**（Key 无效 / 配额用尽 / 限频 /
 *      签名未关），让 UI 说得出人话。
 *   2) **坐标必须转 WGS84**。高德返回 GCJ-02，与 OSRM 路线、Esri 底图相差可达 531 m
 *      （实测天安门）。转换后同时保留 `raw`（原文）与 `converted` 标记，任何时候可重算。
 *   3) **没填 Key 就别发请求**。空 Key 必然换来一次 10001，白白消耗一次配额。
 *      `build()` 当场抛 `rt.amap.noKey`，而不是退化成一个空函数悄悄返回 —— 那正是
 *      本项目历史踩过的「回调取不到就退化成空函数」的静默断线模式。
 *
 * ⚠️ 端点与参数集合**未经真 Key 实测**（架构 §10 Q3：v5 与 v3 的 POI 搜索并存，
 *    v5 的参数名与 v3 不同）。这里按架构决策先走 v5，路径与参数集中在下面的常量里，
 *    真机验证后若需回退 v3，改动只发生在这一处。
 */

import { makeErrorWithKey } from '../core/http.js';
import { getAmapKey } from '../core/apikeys.js';
import { gcj02ToWgs84, isInOffsetZone, distanceKm } from '../core/geo.js';

/** 高德 Web 服务基址。 */
export const AMAP_HOST = 'https://restapi.amap.com';

/**
 * POI 关键字搜索端点。
 *
 * ★【待真 Key 实测】：架构 §3.1 定的是 v5 `/v5/place/text`，v3 为 `/v3/place/text`
 * （参数名不同：v5 用 page_size/page_num/region，v3 用 offset/page/city）。
 * 抽成常量就是为了「实测结论出来后改一行」。
 */
export const AMAP_POI_PATH = '/v5/place/text';

/** 许可署名的**文案键**（不是成品串）：存键的原因见 data/photon.js 同名注释。 */
export const AMAP_ATTRIBUTION_KEY = 'attr.amap';

/**
 * 三类候选的 POI 大类码（实测多源一致，架构 §0 E13）。
 *
 * ⚠️ 覆盖率【待真 Key 实测】：大类码可用不等于返回的 POI 都是用户想要的（例如 050000
 *    里混着快餐），筛选与排序只能基于**真实拿到的字段**，不许自己打分。
 */
export const AMAP_TYPES = {
  stay: '100000',
  sight: '110000',
  food: '050000',
};

/** 单页条数（v5 参数名 page_size；v3 为 offset）。 */
export const AMAP_PAGE_SIZE = 20;

/** 默认搜索半径（米）。 */
export const AMAP_DEFAULT_RADIUS = 5000;

/**
 * infocode → 文案键桶。
 *
 * 分桶的意义：这几种失败**用户的应对动作完全不同**（换 Key / 等明天 / 稍后再试 /
 * 去控制台关签名），一句「请求失败」等于什么都没说。
 *
 * @param {string} infocode 高德 infocode。
 * @returns {string} 文案键。
 */
export function bucketOf(infocode) {
  const code = infocode === null || infocode === undefined ? '' : String(infocode);
  switch (code) {
    case '10001':
      return 'rt.amap.invalidKey';
    case '10003':
      return 'rt.amap.quota';
    case '10004':
      return 'rt.amap.busy';
    case '10008':
      return 'rt.amap.sig';
    default:
      return 'rt.amap.other';
  }
}

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
 * 解析高德的 'lon,lat' 串。
 *
 * @param {*} s 形如 '116.397499,39.908722'。
 * @returns {{lat:number, lon:number}|null} 坐标或 null。
 */
function _parseLocation(s) {
  if (typeof s !== 'string') return null;
  const parts = s.split(',');
  if (parts.length < 2) return null;
  const lon = _num(parts[0]);
  const lat = _num(parts[1]);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

/**
 * 构造 POI 搜索请求。
 *
 * @param {{lat:number, lon:number, typecode:string, keyword?:string,
 *          radius?:number, page?:number}} ctx 上下文（lat/lon 是搜索圆心，WGS84）。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 * @throws {Object} 未配置 Key 时抛出带 `rt.amap.noKey` 的 SourceError。
 */
export function buildPoiRequest(ctx = {}) {
  const key = getAmapKey();
  if (key === '') {
    // ★不返回空 URL、不返回 unavailable 标记：那两种写法都要靠调用方记得判断，漏了就
    //   变成一个必然 10001 的请求（白花一次配额）。抛错让失败在**调用那一刻**发生。
    throw makeErrorWithKey('NOKEY', 'amapPoi', 'rt.amap.noKey', {});
  }

  const lat = _num(ctx.lat);
  const lon = _num(ctx.lon);
  if (lat === null || lon === null) {
    throw makeErrorWithKey('EMPTY', 'amapPoi', 'rt.err.badAnchor', {});
  }

  const radius = _num(ctx.radius) === null ? AMAP_DEFAULT_RADIUS : Math.max(1, Math.round(_num(ctx.radius)));
  const page = _num(ctx.page) === null ? 1 : Math.max(1, Math.round(_num(ctx.page)));
  const typecode = typeof ctx.typecode === 'string' && ctx.typecode !== '' ? ctx.typecode : AMAP_TYPES.sight;
  const keyword = typeof ctx.keyword === 'string' ? ctx.keyword : '';

  return {
    url: `${AMAP_HOST}${AMAP_POI_PATH}`,
    params: {
      key,
      keywords: keyword,
      types: typecode,
      location: `${lon},${lat}`,
      radius: String(radius),
      page_size: String(AMAP_PAGE_SIZE),
      page_num: String(page),
      extensions: 'all',
    },
    responseType: 'json',
  };
}

/**
 * 解析高德 POI 响应 → 候选列表（架构 §4.6，**从不落盘**）。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} [ctx] 上下文（圆心，用于算直线距离）。
 * @returns {{count:number, items:Array<Object>, anchor:{lat:number, lon:number}|null}} 候选结果。
 * @throws {Object} `status !== '1'` 时抛出带具体桶文案键的 SourceError。
 */
export function parsePoi(json, ctx = {}) {
  const status = json && json.status !== undefined && json.status !== null ? String(json.status) : '';
  if (status !== '1') {
    const infocode = json && json.infocode !== undefined && json.infocode !== null ? String(json.infocode) : '';
    throw makeErrorWithKey('BUSINESS', 'amapPoi', bucketOf(infocode), { params: { code: infocode } });
  }

  const rawPois = json && Array.isArray(json.pois) ? json.pois : [];
  const anchorLat = _num(ctx && ctx.lat);
  const anchorLon = _num(ctx && ctx.lon);
  const anchor = anchorLat === null || anchorLon === null ? null : { lat: anchorLat, lon: anchorLon };

  const items = [];
  for (const poi of rawPois) {
    if (!poi || typeof poi !== 'object') continue;
    const raw = _parseLocation(poi.location);
    if (raw === null) continue; // 没有坐标的 POI 画不到图上，跳过（不是错误，是高德偶有缺项）

    // ★转换，不是隔离：高德给的是 GCJ-02，不转就与 OSRM/Esri 差几百米。
    const inZone = isInOffsetZone(raw.lat, raw.lon);
    const coord = gcj02ToWgs84(raw.lat, raw.lon);
    const biz = poi.biz_ext && typeof poi.biz_ext === 'object' ? poi.biz_ext : {};

    items.push({
      id: typeof poi.id === 'string' ? poi.id : '',
      name: typeof poi.name === 'string' ? poi.name : '',
      type: typeof poi.type === 'string' ? poi.type : null,
      typecode: typeof poi.typecode === 'string' ? poi.typecode : null,
      address: typeof poi.address === 'string' && poi.address !== '' ? poi.address : null,
      // 评分与人均：高德【待实测】覆盖率，拿不到就是 null —— 界面显示「未填」，
      // 绝不用 4.0 之类默认值占位（产品红线：不许编造）。
      rating: _num(biz.rating),
      cost: _num(biz.cost),
      coord,
      raw: { lat: raw.lat, lon: raw.lon, coordSys: 'GCJ-02' },
      converted: inZone,
      distanceM: anchor === null ? null : Math.round(distanceKm(anchor, coord) * 1000),
      // ★标明是直线距离：它不是路网距离，不能直接当「开车多远」用。
      distanceKind: 'straight',
    });
  }

  const count = _num(json && json.count) === null ? items.length : _num(json.count);
  return { count, items, anchor };
}
