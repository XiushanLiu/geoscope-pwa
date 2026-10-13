/**
 * 行程领域模型（纯函数：无 DOM、无网络、无 i18n、无持久化副作用）
 *
 * 职责：定义 Trip / PlanInput / RouteInfo / Stopover / CheckIn 的形状、schema 版本与迁移、
 * 三类筛选语义、行程导出载荷与导入校验。**持久化由 core/tripstore.js 负责**，本模块只算。
 *
 * ★为什么**从第一天起**就要 schema 版本号 + `migrateTrip()`（历史真坑，改代码前先读）：
 *   既有的 `core/store.js` 的 `setLastSnapshot()/getLastSnapshot()` 是**整包读写**，
 *   没有版本号、没有字段迁移 —— 于是「新增一个字段」在 TTL 内**不会自愈**：老快照里没有
 *   那个字段，读出来就是 undefined，界面一直显示「—」（真机踩过：降水概率那一列）。
 *   行程是要**长期留在本机**的用户数据，把同样的坑再踩一次是不可接受的。
 *   所以：每条行程带 `schema`，读时一律过 `migrateTrip()`（缺字段补齐、不动已有值），
 *   撞到**更高**版本则**拒绝并给 reasonKey** —— 不改写、不猜测，让用户知道该升级了。
 *
 * ★筛选的 `pass / fail / unknown` 三元组（产品红线：不许编造）：
 *   `unknown` = 该字段为 **null**（用户没补录）。它必须**单独成组并计数**，
 *   永不进 pass（缺不等于达标），也永不被静默删除（用户得看见「有多少条看不清」）。
 *   房价 / 景区等级 / 菜名这三项自动源一个都拿不到，缺就如实显示「未填」。
 *
 * 分层：core 层，**不许 import i18n**（core ← data ← ui ← html 单向依赖）。
 *   因此本模块的一切失败都是 `{ reasonKey, reasonParams }`，一句人话都不拼 ——
 *   中英文案由 UI 层 `tr()` 出来。core 里出现中文字面量的可能性为零。
 */

import { byteSize } from './cache.js';
import { stamp as exportFilenameStamp } from './format.js';

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 行程 schema 版本号（整数）。
 *
 * ★改动规则（务必遵守）：**形状变了就 +1，并在 `migrateTrip()` 里加一条分支**。
 *   只加可选字段且不改变既有字段语义时，也建议 +1 —— 因为「老数据读出来缺这个字段」
 *   正是要靠迁移补的那一类。
 */
export const SCHEMA_VERSION = 1;

/** 行程导出文件的 app 标识（用于拒绝别的应用/别的功能的文件）。 */
export const TRIP_FILE_APP_ID = 'geoscope-roadtrip';

/** 行程名单条上限（防止一个畸形文件把内存态撑爆）。 */
export const MAX_TRIPS = 200;

/** 行程名长度上限（字符数）。 */
export const TRIP_NAME_MAX = 40;

/** 必经点数量上限（UI 限 6；OSRM 实测 12 点可用，保守留余量）。 */
export const MAX_VIA = 6;

/** 每天驾驶目标的三档预设（秒）：3h / 4h / 5h。 */
export const DAILY_PRESETS = [10800, 14400, 18000];

/** 默认每天驾驶目标：4 小时。 */
export const DEFAULT_DAILY_TARGET_SEC = 14400;

/** 末段不足该秒数就不再切新停留点（避免「最后一天只开 22 分钟」）。 */
export const DEFAULT_MIN_GAP_SEC = 1800;

/** 吸附距离警示阈值（米）：超过就提示用户核对途经点（实测可达 3363 m）。 */
export const SNAP_WARN_M = 2000;

/** 单条行程的持久化体积预算（字节）。★几何不落盘才能守住这个数。 */
export const TRIP_MAX_BYTES = 20480;

/** 景区等级 → 可比序号（用于「≥4A」这类比较）。 */
export const LEVEL_RANK = { '1A': 1, '2A': 2, '3A': 3, '4A': 4, '5A': 5 };

/** 打卡类型。 */
export const CHECKIN_TYPES = ['stay', 'sight', 'food'];

/** 停留点锚点来源。 */
export const ANCHOR_SOURCES = ['cumulative-4h', 'via', 'manual'];

/** 坐标来源（★'manual' 允许 coord 为 null：列表显示「未定位」，图上不画这个点）。 */
export const COORD_SOURCES = ['gps', 'amap', 'map-tap', 'manual'];

/** 默认住宿筛选（取用户原始需求：≤150 元，特殊房型可到 200）。 */
export const DEFAULT_STAY_FILTER = {
  enabled: { price: true, roomType: true, rating: false },
  maxPriceCny: 150,
  flexMaxPriceCny: 200,
  roomTypes: ['standard', 'king'],
  minRating: null,
};

/** 默认景点筛选（≥4A、评分 ≥4.6）。 */
export const DEFAULT_SIGHT_FILTER = {
  enabled: { level: true, rating: true },
  minLevel: '4A',
  minRating: 4.6,
  levels: ['3A', '4A', '5A'],
};

/** 默认美食筛选（当地特色）。 */
export const DEFAULT_FOOD_FILTER = {
  enabled: { localSpecial: true, keywords: false },
  requireLocalSpecial: true,
  keywords: ['当地特色', '名菜'],
};

/** 三类默认筛选（PlanInput.filters 的初值）。 */
export const DEFAULT_FILTERS = {
  stay: DEFAULT_STAY_FILTER,
  sight: DEFAULT_SIGHT_FILTER,
  food: DEFAULT_FOOD_FILTER,
};

/** @type {number} id 生成用的单调计数器（同毫秒内多次生成也不会撞号）。 */
let _idSeq = 0;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

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
 * 生成 id：`<prefix>-<时间戳36进制><序号>`。
 *
 * 为什么加序号：同一次点击里可能连续生成多个打卡，Date.now() 在同一毫秒内会撞号，
 * 而 id 撞号的表现是「列表里第二条覆盖第一条」—— 用户数据静默丢失，最难排查的那一类。
 *
 * @param {string} prefix 前缀（'trip' / 'so' / 'ck'）。
 * @param {number} [atMs=Date.now()] 时刻。
 * @returns {string} id。
 */
export function newId(prefix, atMs = Date.now()) {
  _idSeq += 1;
  return `${prefix}-${Math.floor(atMs).toString(36)}${_idSeq.toString(36)}`;
}

/**
 * 归一坐标（非法一律 null）。
 *
 * @param {*} c 形如 {lat, lon}。
 * @returns {{lat:number, lon:number}|null} 坐标或 null。
 */
function _coord(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const lat = _num(c.lat);
  const lon = _num(c.lon);
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/**
 * 归一字符串（截断到指定长度；null/非字符串一律空串）。
 *
 * @param {*} v 原始值。
 * @param {number} max 长度上限。
 * @returns {string} 字符串。
 */
function _str(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** @type {(v:*)=>string|null} 可空字符串（空串归一成 null：缺失就是缺失，不是空串）。 */
function _strOrNull(v) {
  const s = _str(v, 200);
  return s === '' ? null : s;
}

/* ------------------------------------------------------------------ */
/* 各子结构的构造与归一                                                 */
/* ------------------------------------------------------------------ */

/**
 * 构造一个 PlaceRef（出发地 / 目的地 / 必经点）。
 *
 * @param {{lat?:number, lon?:number, name?:string, source?:string, amapId?:string|null}} [patch] 补丁。
 * @returns {Object} PlaceRef。
 */
export function newPlaceRef(patch = {}) {
  const source = patch && (patch.source === 'search' || patch.source === 'gps' || patch.source === 'manual') ? patch.source : 'manual';
  return {
    lat: _num(patch.lat),
    lon: _num(patch.lon),
    name: _str(patch.name, 60),
    source,
    amapId: _strOrNull(patch.amapId),
  };
}

/**
 * 归一 PlaceRef（缺字段补齐，**已有值不动**）。
 *
 * @param {*} p 原始值。
 * @returns {Object|null} PlaceRef；坐标完全非法时返回 null（由调用方决定跳过还是拒绝）。
 */
function _placeRef(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const base = newPlaceRef(p);
  const coord = _coord(p);
  return { ...base, lat: coord ? coord.lat : null, lon: coord ? coord.lon : null };
}

/**
 * 构造空的 RouteInfo（**不含几何**）。
 *
 * ★`geometry` / `cumulativeS` 这两个字段**存在但恒为 null**（而不是整个键不存在）：
 *   存在的意义是「这个位置本来应该有数据，现在是空的」—— 缺失与「没有这个字段」
 *   在 JSON 往返后必须长得一样，否则导出再导入会平白多/少字段。
 *
 * @returns {Object} RouteInfo 空壳。
 */
export function emptyRoute() {
  return {
    ok: false,
    errorKey: null,
    fetchedAt: null,
    distanceM: null,
    durationS: null,
    durationKind: null,
    waypoints: [],
    snapMaxM: null,
    legs: [],
    cumulativeS: null,
    // ★Σ annotation.duration（逐边实算）。它与 durationS（OSRM 总时长）**不是同一个数**：
    //   实测恒小 0.13 %–0.66 %（726 km 差 38 s）。两者都留着，UI 注脚要照实写，不许混用。
    cumulativeTotalS: null,
    cumulativeKind: 'none',
    geometry: null,
    geometryPoints: 0,
    shape: null,
    requestedOverview: null,
  };
}

/**
 * ★把 RouteInfo 压成**可持久化**的形状：几何与逐边累积曲线一律置 null。
 *
 * 为什么必须压（架构 §4.3 存储纪律，改这里之前先读）：
 *   `overview=full` 单次响应达 **137 KB / 5987 点**（726 km 路线）。写进
 *   localStorage 的后果有两个：① 4.5 MB 预算几趟长行程就见底；② `core/cache.js` 的
 *   `evictOldest()` / `prune()` 在配额满时会按 `storedAt` 淘汰最旧条目 ——
 *   **行程是用户数据，被当成缓存淘汰是灾难**。所以几何只在内存里活一次。
 *   需要离线看图时由用户显式点「缓存此行程的路线几何」，那时存的是
 *   `shape`（overview=simplified，1.4 KB 量级），本函数**保留** shape。
 *   ★口径：137 KB / 5987 点 / 1.4 KB 这几个数**引自架构文档（架构师沙箱实测），
 *     不是本仓库工程师自测**；更完整的里程对照表见 `src/data/osrm.js` 文件头。
 *     写在这里只为说明「为什么绝不能落盘」，文档若修订以文档为准。
 *
 * @param {*} route 原始 RouteInfo。
 * @returns {Object} 可持久化形状。
 */
export function slimRoute(route) {
  const base = emptyRoute();
  if (!route || typeof route !== 'object' || Array.isArray(route)) return base;

  const waypoints = Array.isArray(route.waypoints)
    ? route.waypoints.map((w, i) => ({
        inputIndex: Number.isInteger(w && w.inputIndex) ? w.inputIndex : i,
        snapped: _coord(w && w.snapped),
        name: typeof (w && w.name) === 'string' ? w.name : '',
        snapDistanceM: _num(w && w.snapDistanceM),
      }))
    : [];

  const legs = Array.isArray(route.legs)
    ? route.legs.map((l, i) => ({
        fromIndex: Number.isInteger(l && l.fromIndex) ? l.fromIndex : i,
        toIndex: Number.isInteger(l && l.toIndex) ? l.toIndex : i + 1,
        distanceM: _num(l && l.distanceM),
        durationS: _num(l && l.durationS),
      }))
    : [];

  return {
    ...base,
    ok: !!route.ok,
    errorKey: typeof route.errorKey === 'string' ? route.errorKey : null,
    fetchedAt: _num(route.fetchedAt),
    distanceM: _num(route.distanceM),
    durationS: _num(route.durationS),
    durationKind: typeof route.durationKind === 'string' ? route.durationKind : null,
    waypoints,
    snapMaxM: _num(route.snapMaxM),
    legs,
    // ★两个大头：一律不落盘
    cumulativeS: null,
    // 单个标量，落盘（界面注脚要在重载后仍说得清「两者相差 <1 %」）
    cumulativeTotalS: _num(route.cumulativeTotalS),
    cumulativeKind: typeof route.cumulativeKind === 'string' ? route.cumulativeKind : 'none',
    geometry: null,
    geometryPoints: _num(route.geometryPoints) === null ? 0 : _num(route.geometryPoints),
    // shape 是用户显式缓存下来的简化几何（1.4 KB 量级），**允许**落盘
    shape: route.shape && Array.isArray(route.shape.pts) ? route.shape : null,
    requestedOverview: typeof route.requestedOverview === 'string' ? route.requestedOverview : null,
  };
}

/**
 * 构造一条住宿 / 景点 / 美食打卡。
 *
 * ★缺字段一律 null（不是 0、不是空串）：这是「不许编造」在创建侧的落地 ——
 *   房价 0 会被读成「免费」，评分 0 会被读成「零分」，两者都是造假。
 *
 * @param {'stay'|'sight'|'food'} type 类型。
 * @param {Object} [patch] 补丁（覆盖默认值）。
 * @returns {Object} CheckIn。
 */
export function newCheckIn(type, patch = {}) {
  const t = CHECKIN_TYPES.indexOf(type) === -1 ? 'sight' : type;
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  const base = {
    id: typeof p.id === 'string' && p.id !== '' ? p.id : newId('ck'),
    type: t,
    tripId: _strOrNull(p.tripId),
    stopoverId: _strOrNull(p.stopoverId),
    coord: _coord(p.coord),
    coordSource: COORD_SOURCES.indexOf(p.coordSource) === -1 ? null : p.coordSource,
    accuracyM: _num(p.accuracyM),
    atMs: _num(p.atMs) === null ? Date.now() : _num(p.atMs),
    name: _str(p.name, 60),
    address: _strOrNull(p.address),
    category: _strOrNull(p.category),
    amapId: _strOrNull(p.amapId),
    source: p.source === 'amap' ? 'amap' : 'manual',
    // ★原始凭证：随时可以换个算法重算，绝不丢
    raw: p.raw && typeof p.raw === 'object' ? { ...p.raw } : null,
    converted: !!p.converted,
    stay: null,
    sight: null,
    food: null,
    common: {
      rating: _num(p.common && p.common.rating),
      note: _str(p.common && p.common.note, 200),
      tags: Array.isArray(p.common && p.common.tags) ? p.common.tags.filter((s) => typeof s === 'string') : [],
    },
  };

  if (t === 'stay') {
    const s = p.stay && typeof p.stay === 'object' ? p.stay : {};
    base.stay = {
      pricePerNight: _num(s.pricePerNight),
      roomType: s.roomType === 'standard' || s.roomType === 'king' ? s.roomType : null,
      nights: _num(s.nights),
    };
  } else if (t === 'sight') {
    const s = p.sight && typeof p.sight === 'object' ? p.sight : {};
    base.sight = {
      level: typeof s.level === 'string' && Object.prototype.hasOwnProperty.call(LEVEL_RANK, s.level) ? s.level : null,
      levelRaw: _strOrNull(s.levelRaw),
      rating: _num(s.rating),
      ticketCny: _num(s.ticketCny),
    };
  } else {
    const s = p.food && typeof p.food === 'object' ? p.food : {};
    base.food = {
      dishes: Array.isArray(s.dishes)
        ? s.dishes.map((d) => ({
            name: _str(d && d.name, 40),
            priceCny: _num(d && d.priceCny),
            note: _str(d && d.note, 100),
          }))
        : [],
      localSpecial: typeof s.localSpecial === 'boolean' ? s.localSpecial : null,
      perHeadCny: _num(s.perHeadCny),
    };
  }

  return base;
}

/**
 * 归一一个 CheckIn（迁移用：缺字段补齐，**已有值不动**）。
 *
 * @param {*} raw 原始值。
 * @returns {Object|null} CheckIn 或 null（连类型都不是这三类就丢掉）。
 */
function _checkIn(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const type = CHECKIN_TYPES.indexOf(raw.type) === -1 ? null : raw.type;
  if (type === null) return null;
  const out = newCheckIn(type, raw);
  out.id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : out.id;
  // common.rating：仅当真的有值才保留（高德没给就是 null，不许用默认值占位）
  if (raw.common && typeof raw.common === 'object' && _num(raw.common.rating) === null) {
    out.common.rating = null;
  }
  return out;
}

/**
 * 采用一个高德候选 → CheckIn（保留原始凭证）。
 *
 * @param {Object} candidate PoiCandidate（src/data/amap.js 产出，从不落盘）。
 * @param {'stay'|'sight'|'food'} type 类型。
 * @param {Object} [patch] 用户补录字段（房价 / 等级 / 菜名等）。
 * @returns {Object} CheckIn。
 */
export function adoptCandidate(candidate, type, patch = {}) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  return newCheckIn(type, {
    name: c.name,
    address: c.address,
    category: c.type,
    amapId: c.id,
    coord: c.coord,
    coordSource: 'amap',
    raw: c.raw,
    converted: !!c.converted,
    source: 'amap',
    common: { rating: _num(c.rating), note: '', tags: [] },
    ...(patch && typeof patch === 'object' ? patch : {}),
  });
}

/**
 * 归一一个 Stopover。
 *
 * @param {*} raw 原始值。
 * @returns {Object|null} Stopover 或 null。
 */
function _stopover(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const anchorFrom = ANCHOR_SOURCES.indexOf(raw.anchorFrom) === -1 ? 'manual' : raw.anchorFrom;
  const placeSource = raw.placeSource === 'reverse' || raw.placeSource === 'user' ? raw.placeSource : 'coord';
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('so'),
    day: Number.isInteger(raw.day) && raw.day >= 1 ? raw.day : 1,
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : 0,
    coord: _coord(raw.coord),
    anchorFrom,
    cumSecAtArrival: _num(raw.cumSecAtArrival),
    driveFromPrevS: _num(raw.driveFromPrevS),
    driveFromPrevM: _num(raw.driveFromPrevM),
    placeName: _strOrNull(raw.placeName),
    placeSource,
    note: _str(raw.note, 200),
    // 实录：实际停下的位置与时间（缺即 null，列表显示「未记录」）
    actual: _actual(raw.actual),
  };
}

/**
 * 归一「实际停下」记录。
 *
 * @param {*} raw 原始值。
 * @returns {Object|null} actual 或 null。
 */
function _actual(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    // ★coord 允许为 null：没有定位就是没有，绝不给一个假坐标
    coord: _coord(raw.coord),
    coordSource: COORD_SOURCES.indexOf(raw.coordSource) === -1 ? null : raw.coordSource,
    accuracyM: _num(raw.accuracyM),
    atMs: _num(raw.atMs),
  };
}

/**
 * 归一 PlanInput（缺字段补齐，**已有值不动**）。
 *
 * @param {*} raw 原始值。
 * @returns {Object} PlanInput。
 */
function _plan(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const via = Array.isArray(p.via)
    ? p.via.map(_placeRef).filter((v) => v !== null).slice(0, MAX_VIA)
    : [];
  const dailyTargetSec = DAILY_PRESETS.indexOf(_num(p.dailyTargetSec)) === -1
    ? DEFAULT_DAILY_TARGET_SEC
    : _num(p.dailyTargetSec);
  const filters = p.filters && typeof p.filters === 'object' && !Array.isArray(p.filters) ? p.filters : {};
  return {
    origin: _placeRef(p.origin),
    destination: _placeRef(p.destination),
    via,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(p.startDate) ? p.startDate : null,
    days: Number.isInteger(p.days) && p.days > 0 ? p.days : null,
    dailyTargetSec,
    minGapSec: _num(p.minGapSec) === null ? DEFAULT_MIN_GAP_SEC : _num(p.minGapSec),
    filters: {
      stay: filters.stay && typeof filters.stay === 'object' ? { ...DEFAULT_STAY_FILTER, ...filters.stay } : { ...DEFAULT_STAY_FILTER },
      sight: filters.sight && typeof filters.sight === 'object' ? { ...DEFAULT_SIGHT_FILTER, ...filters.sight } : { ...DEFAULT_SIGHT_FILTER },
      food: filters.food && typeof filters.food === 'object' ? { ...DEFAULT_FOOD_FILTER, ...filters.food } : { ...DEFAULT_FOOD_FILTER },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 迁移（★本模块存在的理由）                                            */
/* ------------------------------------------------------------------ */

/**
 * 校验并迁移一条行程。
 *
 * 三条铁律：
 *   1) **已有值一个字都不改**（只补缺失字段）—— 迁移不是重新解释用户数据；
 *   2) 缺 `schema`（旧结构）视作待迁移，**不拒绝**；
 *   3) `schema > SCHEMA_VERSION`（更高版本）→ **拒绝**，给 `trip.newerSchema`，
 *      不改写、不猜测 —— 猜一个字段语义出来的行程，比打不开更危险。
 *
 * @param {*} raw 原始行程对象。
 * @returns {{ok:boolean, trip?:Object, reasonKey?:string, reasonParams?:Object}} 结果。
 */
export function migrateTrip(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasonKey: 'trip.notObject' };
  }

  const schema = raw.schema;
  if (schema !== undefined && schema !== null) {
    if (!Number.isInteger(schema)) {
      return { ok: false, reasonKey: 'trip.badSchema', reasonParams: { schema: String(schema) } };
    }
    if (schema > SCHEMA_VERSION) {
      return { ok: false, reasonKey: 'trip.newerSchema', reasonParams: { schema: String(schema) } };
    }
    if (schema < 1) {
      return { ok: false, reasonKey: 'trip.badSchema', reasonParams: { schema: String(schema) } };
    }
  }

  const now = Date.now();
  const stopovers = Array.isArray(raw.stopovers) ? raw.stopovers.map(_stopover).filter((s) => s !== null) : [];
  const checkIns = Array.isArray(raw.checkIns) ? raw.checkIns.map(_checkIn).filter((c) => c !== null) : [];

  return {
    ok: true,
    trip: {
      schema: SCHEMA_VERSION,
      id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId('trip'),
      name: _str(raw.name, TRIP_NAME_MAX),
      createdAt: _num(raw.createdAt) === null ? now : _num(raw.createdAt),
      updatedAt: _num(raw.updatedAt) === null ? now : _num(raw.updatedAt),
      plan: _plan(raw.plan),
      // ★route 一律过 slimRoute：哪怕调用方塞了一整条 geometry 进来，也在这道口子上被拦下
      route: slimRoute(raw.route),
      stopovers,
      checkIns,
      lastErrorKey: typeof raw.lastErrorKey === 'string' ? raw.lastErrorKey : null,
    },
  };
}

/**
 * 新建一条行程（schema 恒为当前版本）。
 *
 * @param {Object} [plan] PlanInput（缺字段用默认值补齐）。
 * @returns {Object} Trip。
 */
export function newTrip(plan = {}) {
  const now = Date.now();
  return {
    schema: SCHEMA_VERSION,
    id: newId('trip', now),
    name: '',
    createdAt: now,
    updatedAt: now,
    plan: _plan(plan),
    route: emptyRoute(),
    stopovers: [],
    checkIns: [],
    lastErrorKey: null,
  };
}

/**
 * 压成可持久化 / 可导出的形状（= 迁移后的 Trip，几何已被 slimRoute 置 null）。
 *
 * @param {Object} trip 行程。
 * @returns {Object} 可落盘形状。
 */
export function slimTrip(trip) {
  const m = migrateTrip(trip);
  return m.ok ? m.trip : null;
}

/**
 * 估算一条行程的持久化体积（字节）。
 *
 * @param {Object} trip 行程。
 * @returns {number} 字节数；非法行程返回 0。
 */
export function tripBytes(trip) {
  const slim = slimTrip(trip);
  if (slim === null) return 0;
  return byteSize(JSON.stringify(slim));
}

/* ------------------------------------------------------------------ */
/* 三类筛选：pass / fail / unknown                                      */
/* ------------------------------------------------------------------ */

/**
 * 判定某个条件是否生效。
 *
 * @param {Object} f 该类目的筛选条件。
 * @param {string} name 条件名。
 * @param {*} threshold 阈值（null/undefined = 没设这条条件 = 不参与筛选）。
 * @returns {boolean} 是否生效。
 */
function _active(f, name, threshold) {
  if (f.enabled && Object.prototype.hasOwnProperty.call(f.enabled, name) && f.enabled[name] === false) return false;
  return threshold !== null && threshold !== undefined;
}

/**
 * 逐条评估一个打卡项的各类条件。
 *
 * @param {'stay'|'sight'|'food'} type 类型。
 * @param {Object} item CheckIn。
 * @param {Object} f 该类目的筛选条件。
 * @returns {{states:string[], unknownFields:string[]}} 各条件的判定与「未填」字段名。
 */
function _evaluate(type, item, f) {
  /** @type {string[]} */
  const states = [];
  /** @type {string[]} */
  const unknownFields = [];

  /**
   * 记一条判定。
   *
   * @param {string} field 字段名（进 unknownCounts 的键）。
   * @param {string} state 'pass' | 'fail' | 'unknown'。
   * @returns {void}
   */
  const put = (field, state) => {
    if (state === 'unknown') unknownFields.push(field);
    states.push(state);
  };

  if (type === 'stay') {
    const s = item.stay && typeof item.stay === 'object' ? item.stay : {};

    const maxPrice = _num(f.maxPriceCny);
    if (_active(f, 'price', maxPrice)) {
      const v = _num(s.pricePerNight);
      const flex = _num(f.flexMaxPriceCny);
      if (v === null) put('pricePerNight', 'unknown');
      else if (v <= maxPrice) put('pricePerNight', 'pass');
      else if (flex !== null && v <= flex) put('pricePerNight', 'pass');
      else put('pricePerNight', 'fail');
    }

    const roomTypes = Array.isArray(f.roomTypes) && f.roomTypes.length > 0 ? f.roomTypes : null;
    if (_active(f, 'roomType', roomTypes)) {
      const v = typeof s.roomType === 'string' ? s.roomType : null;
      if (v === null) put('roomType', 'unknown');
      else if (roomTypes.indexOf(v) !== -1) put('roomType', 'pass');
      else put('roomType', 'fail');
    }
  } else if (type === 'sight') {
    const s = item.sight && typeof item.sight === 'object' ? item.sight : {};

    const minLevel = typeof f.minLevel === 'string' ? f.minLevel : null;
    if (_active(f, 'level', minLevel)) {
      const v = typeof s.level === 'string' ? s.level : null;
      const vr = v === null ? null : LEVEL_RANK[v] || null;
      const mr = LEVEL_RANK[minLevel] || null;
      if (v === null) put('level', 'unknown');
      // 有值但认不出等级：判 fail（不达标），不谎称「看不清」——它明明填了
      else if (vr === null || mr === null) put('level', 'fail');
      else if (vr >= mr) put('level', 'pass');
      else put('level', 'fail');
    }
  } else {
    const s = item.food && typeof item.food === 'object' ? item.food : {};

    if (_active(f, 'localSpecial', f.requireLocalSpecial === true ? true : null)) {
      const v = typeof s.localSpecial === 'boolean' ? s.localSpecial : null;
      if (v === null) put('localSpecial', 'unknown');
      else if (v === true) put('localSpecial', 'pass');
      else put('localSpecial', 'fail');
    }

    const kws = Array.isArray(f.keywords) && f.keywords.length > 0 ? f.keywords : null;
    if (_active(f, 'keywords', kws)) {
      const tags = Array.isArray(item.common && item.common.tags) ? item.common.tags : [];
      const dishNames = Array.isArray(s.dishes) ? s.dishes.map((d) => (d && d.name) || '') : [];
      const hay = [...tags, ...dishNames].filter((s2) => typeof s2 === 'string' && s2 !== '');
      if (hay.length === 0) put('keywords', 'unknown');
      else if (kws.some((k) => hay.some((h) => h.indexOf(k) !== -1))) put('keywords', 'pass');
      else put('keywords', 'fail');
    }
  }

  // 评分三类共用：★仅当真的有值才参与比较（高德没给 = null = 未填）
  const minRating = _num(f.minRating);
  if (_active(f, 'rating', minRating)) {
    const v = _num(item.common && item.common.rating);
    if (v === null) put('rating', 'unknown');
    else if (v >= minRating) put('rating', 'pass');
    else put('rating', 'fail');
  }

  return { states, unknownFields };
}

/**
 * 三类筛选的统一语义：**返回三元组，不是布尔**。
 *
 * - `pass`：条件成立；
 * - `fail`：有值但不达标（例如房价 260 > 150，即使 < 200 也进 fail，界面标注「超出上限」）；
 * - `unknown`：该字段为 **null**（用户没补录）—— 单独成组并计数，
 *   **永不进 pass**（缺不等于达标），也**永不被静默删除**（`pass+fail+unknown === total`）。
 *
 * ★为什么「fail 优先于 unknown」：一条 260 元的住宿如果被算进「未填：房价」，
 *   用户就不会知道它超预算了 —— 把**确定的违规**藏起来比把「看不清」露出来更糟。
 *   而「未填」的数量由 `unknownCounts` **按字段**单独统计（与分组无关），
 *   所以「未填：房价（3）」这个计数依然是全量、诚实的。
 *
 * @param {Array<Object>} list CheckIn 列表（按各自的 type 取对应的筛选条件）。
 * @param {{stay?:Object, sight?:Object, food?:Object}} [filters] 三类筛选条件（PlanInput.filters 的形状）。
 * @returns {{pass:Array, fail:Array, unknown:Array, unknownCounts:Object, total:number}} 三元组与计数。
 */
export function partitionByFilter(list, filters = {}) {
  const items = Array.isArray(list) ? list : [];
  const f = filters && typeof filters === 'object' ? filters : {};
  /** @type {Array<Object>} */
  const pass = [];
  /** @type {Array<Object>} */
  const fail = [];
  /** @type {Array<Object>} */
  const unknown = [];
  /** @type {Object<string, Object<string, number>>} */
  const unknownCounts = { stay: {}, sight: {}, food: {} };

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = CHECKIN_TYPES.indexOf(item.type) === -1 ? null : item.type;
    const cfg = type === null ? null : f[type];
    if (type === null || !cfg || typeof cfg !== 'object') {
      // 没有对应的筛选条件 = 不筛选，原样通过（不筛选 ≠ 达标，但也不该被藏起来）
      pass.push(item);
      continue;
    }
    const { states, unknownFields } = _evaluate(type, item, cfg);
    for (const field of unknownFields) {
      unknownCounts[type][field] = (unknownCounts[type][field] || 0) + 1;
    }
    if (states.length === 0) {
      pass.push(item);
    } else if (states.indexOf('fail') !== -1) {
      fail.push(item);
    } else if (states.indexOf('unknown') !== -1) {
      unknown.push(item);
    } else {
      pass.push(item);
    }
  }

  return { pass, fail, unknown, unknownCounts, total: items.length };
}

/* ------------------------------------------------------------------ */
/* 导出 / 导入（照 core/backup.js 的「先 inspect 后 apply」两步法）      */
/* ------------------------------------------------------------------ */

/**
 * 生成行程导出文件名。
 *
 * @param {number} [atMs=Date.now()] 导出时刻。
 * @returns {string} 形如 'geoscope-roadtrip-20250105-1423.json'。
 */
export function roadtripFilename(atMs = Date.now()) {
  return `${TRIP_FILE_APP_ID}-${exportFilenameStamp(atMs)}.json`;
}

/**
 * 导出行程（**不含几何**，理由见 slimRoute 的注释）。
 *
 * ⚠️ 隐私：文件里含用户去过的地方（行程名、停留点、打卡坐标），与备份 JSON 同级敏感，
 *   UI 层必须在导出前告知。本函数不联网、不上传。
 *
 * @param {Array<Object>} trips 行程列表。
 * @param {number} [atMs=Date.now()] 导出时刻。
 * @returns {{schema:number, app:string, exportedAt:string, trips:Array<Object>}} 载荷。
 */
export function exportTrips(trips, atMs = Date.now()) {
  const list = Array.isArray(trips) ? trips : [];
  const out = [];
  for (const t of list) {
    const slim = slimTrip(t);
    if (slim !== null) out.push(slim);
    if (out.length >= MAX_TRIPS) break;
  }
  return {
    schema: SCHEMA_VERSION,
    app: TRIP_FILE_APP_ID,
    exportedAt: new Date(atMs).toISOString(),
    trips: out,
  };
}

/**
 * 【只校验、不写入】解析一份行程文件，产出可预览的「导入计划」。
 *
 * 为什么必须先 inspect：导入是**覆盖性**操作（同名 id 的行程会被替换）。
 * 让用户选完文件就覆盖，等于把「误选一个月前的旧文件」做成不可逆事故。
 * 本函数**不触碰任何本机状态**，同一份文件调两次结果完全一致。
 *
 * @param {string|Object} input JSON 字符串或已解析对象。
 * @returns {{ok:boolean, plan?:Object, reasonKey?:string, reasonParams?:Object}} 校验结果。
 */
export function inspectTripFile(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { ok: false, reasonKey: 'trip.badJson' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reasonKey: 'trip.notObject' };
  }
  if (!Number.isInteger(data.schema) || data.schema !== SCHEMA_VERSION) {
    return { ok: false, reasonKey: 'trip.badSchema', reasonParams: { schema: String(data.schema) } };
  }
  if (data.app !== TRIP_FILE_APP_ID) {
    return { ok: false, reasonKey: 'trip.notRoadtrip' };
  }
  if (!Array.isArray(data.trips)) {
    return { ok: false, reasonKey: 'trip.noTrips' };
  }

  const trips = [];
  let dropped = 0;
  for (const raw of data.trips) {
    const m = migrateTrip(raw);
    if (!m.ok) {
      dropped += 1;
      continue; // 单条非法跳过（不整体拒绝：一条坏行程不该毁掉整份文件）
    }
    if (trips.length >= MAX_TRIPS) {
      dropped += 1;
      continue;
    }
    trips.push(m.trip);
  }

  return {
    ok: true,
    plan: {
      trips,
      /** 因结构非法 / 超出 200 条上限而未被导入的条数（UI 预览时据此提示）。 */
      dropped,
      /** 文件本身的导出时刻（预览用；不是本机写入时刻）。 */
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    },
  };
}

/**
 * 【真正落地】把 `inspectTripFile()` 产出的计划转成可写入本机的行程列表。
 *
 * 为什么不在这里直接写盘：本模块是**纯** core（不许碰 localStorage，那是 cache.js /
 * tripstore.js 的活）。写入由 `core/tripstore.js` 的 `saveTrip()` 逐条完成 ——
 * 于是「校验」与「落盘」仍然是分开的两步，且 UI 可以先给人看再写。
 *
 * @param {Object} plan `inspectTripFile()` 返回的计划。
 * @returns {{ok:boolean, trips?:Array<Object>, reasonKey?:string}} 结果。
 */
export function applyTripFile(plan) {
  const p = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  if (!Array.isArray(p.trips)) {
    // ★不宽容成 []：那会得到一个 ok:true + 行程被清空的结果，用户数据没了还以为成功了
    return { ok: false, reasonKey: 'trip.planNoTrips' };
  }
  const trips = [];
  for (const raw of p.trips) {
    const m = migrateTrip(raw);
    if (m.ok) trips.push(m.trip);
  }
  return { ok: true, trips };
}
