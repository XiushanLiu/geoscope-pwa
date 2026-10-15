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
// 切段第 5 条（去重）要用两点球面距离；src 的规范写法是 `core/geo.js::distanceKm`。
import { distanceKm } from './geo.js';

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

/**
 * 偏离重规划的**默认阈值**（米）：当前位置离最近的规划停留点超过它就提示重新规划。
 *
 * 50 km 是用户 2026-10-16 拍板的数（最初提 100 km，同轮改为 50 km）。
 * ★它是**可设置**的 —— 不同行程的容忍度不一样（城市周边游 20 km 就该警觉，
 * 西北长线 200 km 才算跑偏），所以放在 `plan.deviationReplanM` 里随行程走，
 * 界面给出 `DEVIATION_PRESETS_M` 几档。**不许在代码里写死成一个字面量**。
 */
export const DEFAULT_DEVIATION_REPLAN_M = 50000;

/** 偏离阈值的可选档位（米）：20 / 50 / 100 / 200 km。 */
export const DEVIATION_PRESETS_M = [20000, 50000, 100000, 200000];

/**
 * 偏离判定的结果键（core 只产键，UI 翻译）。
 */
export const DEVIATION_STATE = {
  /** 判定成立：在阈值内。 */
  OK: 'ok',
  /** 判定成立：超出阈值，建议重新规划。 */
  OVER: 'over',
  /** **判不了**（没有当前位置 / 没有规划停留点）—— 与「没偏离」是两回事，不许混。 */
  UNKNOWN: 'unknown',
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
 * ★`required` 只对**必经点**有意义（出发地 / 目的地永远是路线两端，不存在「可不可以跳过」）：
 *   - `true`（默认）**必须经过**：切段时它**必定**成为停留点，不受吸附容差限制；
 *   - `false` **仅供参考**：只是用它把路线「拽」成想要的大致走向，**允许被跳过** ——
 *     只在同一天的驾驶时长容差内才吸附，过了就当作没这个点。
 *
 *   用户原话（2026-10-16 需求 8.2）：「必经点可以是必须经过的地点，也可以不是
 *   （取决于景点、美食等情况；此时，必经点的作用，只是便于大致地规划路线）」。
 *   所以这不是「要不要走这条路」的开关 —— 两种模式下 OSRM 都会经过它 ——
 *   而是「它算不算一个停留点」的开关。
 *
 *   ⚠️ 设成「必须经过」可能让当天驾驶时长超出目标（`dailyTargetSec`）：目标只是
 *   分天的**参考门槛**，不是硬约束。超了就如实显示，不许为了让时长好看而偷偷跳过。
 *
 * @param {{lat?:number, lon?:number, name?:string, source?:string, amapId?:string|null,
 *          required?:boolean}} [patch] 补丁。
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
    // 只认真正的布尔；其余（含 undefined / 旧数据没有这个字段）一律按「必须经过」——
    // 老行程里加过的必经点，语义本来就是「必经」，不该因为新增字段就变成可跳过。
    required: patch && patch.required === false ? false : true,
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
    // ★逐边累积里程（米）：与 cumulativeS 一一对应，同为「点数」长度。它的唯一用途是让
    //   Stopover.driveFromPrevM 能靠**求和**得到真值（架构 §4.4.1 第 7 条不许估算）。
    //   缺失时为 null —— 那时 driveFromPrevM 也只能为 null，不许按「时长 × 速度」补。
    cumulativeM: null,
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
 *   `overview=full` 单次的几何是**百 KB 量级**（726 km 那条路线就是几百 KB；具体数字、
 *   出处与口径见 `src/data/osrm.js` 文件头的「体积口径」一节 —— 那里是全仓唯一出处，
 *   本处不复制，避免抄散后又互相矛盾）。写进 localStorage 的后果有两个：
 *   ① 4.5 MB 预算几趟长行程就见底；② `core/cache.js` 的 `evictOldest()` / `prune()`
 *   在配额满时会按 `storedAt` 淘汰最旧条目 —— **行程是用户数据，被当成缓存淘汰是灾难**。
 *   所以几何只在内存里活一次。
 *   需要离线看图时由用户显式点「缓存此行程的路线几何」，那时存的是
 *   `shape`（`overview=simplified`，1.2–1.4 KB 量级），本函数**保留** shape。
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
    cumulativeM: null,
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
 * 把高德候选**适配**成 `partitionByFilter()` 吃得下的条目（**不落盘**，纯视图形状）。
 *
 * ★全仓**唯一一份**「候选 → 可筛选条目」的形状契约。`src/ui/roadtrip.js` 想筛候选
 *   必须调它，**不许自己写 `{...cand, type}` 那种行内 map** —— 写散了就会出现
 *   「这边补了、那边没补」的**静默错位**：界面不报错，只是某个条件永远匹配不上。
 *   （2026-10-16 真的撞过一次：同一份适配被写在两处，一处补了评分一处没补。）
 *
 * ★补的是**形状**（同一份数据换个位置），**不是数值**（不许凭空造数）：
 *   - `type`：`partitionByFilter()` 按它取对应的筛选条件。高德候选的 `type` 是
 *     「住宿服务;宾馆酒店」这类**原文**，必须先让位给类别，否则 `type === null` 会走到
 *     「没有筛选条件 = 原样通过」分支 —— 界面表现为**全部落进「达标」、永远没有「未填」**，
 *     那正是把「看不清」伪装成「都挺好」，比报错还糟。非法类别归一成 null（同样是原样通过）。
 *   - `category`：高德原文挪到这里（与 CheckIn 同字段，列表卡照它显示）。
 *   - `common.rating`：`_evaluate()` 的评分分支读 `item.common.rating`（CheckIn 形状），
 *     而 `parsePoi()` 把评分放在**顶层**，两边对不上。不补这一处，同一块屏幕上会同时出现
 *     「★ 4.5」和「未填：评分」（同一个数既已知又未知），而用户要的「4.6 分以上」会
 *     **永远匹配不上任何一条**。评分是高德**真返回**的实测值（`parsePoi` 的 `biz.rating`），
 *     不是均价 / 默认值 / 推算值 —— 所以这不违反「不许补数据」。
 *     ★`adoptCandidate()` 里那一行 `common: { rating: _num(c.rating), ... }` 搬的是
 *     同一个数、同一个形状：本函数只是把这次搬家**提前**到筛选之前，两边同源。
 *
 * ★**绝不补**：房价 / 房型 / 景区等级 / 菜名 / 标签。高德免费接口确实给不了，
 *   没有就是没有 —— 它们必须老老实实进 `unknown` 组并被计数，那是诚实的信息，
 *   不是要消灭的噪音。因此本函数**不会**造出 `stay` / `sight` / `food` 子结构。
 *
 * @param {Object} cand PoiCandidate（src/data/amap.js 产出，从不落盘）。
 * @param {'stay'|'sight'|'food'} type 类型（候选自身没有这个语义，必须由调用方给）。
 * @returns {Object} 可喂给 `partitionByFilter()` 的条目（不改动入参）。
 */
/**
 * 判定「当前位置是否偏离了规划的停留点」（纯函数，可离线单测）。
 *
 * ★语义：比较的是**当前位置 ↔ 最近的规划停留点**的**直线**距离（用户原话：
 *   「若实录或实时定位的停留点不是规划的停留点（例如，距离大于 100 km），
 *   则应重新规划路线（从当前停留点到目的地）」）。
 *
 * ★必须说清用的是直线距离：它是「离那个停留点有多远」的近似，
 *   不是「沿路还要开多远」—— 后者要沿路线几何积分，是两个不同的量。
 *   判「跑偏了没有」用直线距离就够；**界面显示时不许把它说成「还需行驶 X km」**。
 *
 * ★三态，不许压成布尔：没有当前位置、或压根没有规划停留点时返回 `unknown` ——
 *   「判不了」和「没偏离」是两件事。压成 `false` 等于在任何时候都宣称「一切正常」，
 *   那正是把「看不清」伪装成「都挺好」。
 *
 * ★iOS 没有后台定位：这个判定只能在**前台、用户触发**时跑一次，锁屏 / 切走期间的
 *   位置拿不到。这是平台限制，不是实现偷懒 —— UI 必须写明，不许假装能实时追踪。
 *
 * @param {{lat:number, lon:number}|null} current 当前位置。
 * @param {Array<Object>} stopovers 规划的停留点（取 `coord`）。
 * @param {number} [thresholdM] 阈值（米）；非法或缺失时用 `DEFAULT_DEVIATION_REPLAN_M`。
 * @returns {{state:string, nearestKm:number|null, nearestIndex:number|null,
 *            thresholdM:number, locatedCount:number}} `state` 取 `DEVIATION_STATE` 之一。
 */
/**
 * 一个定位结果**能不能拿来判偏离**。
 *
 * ★为什么必须有这一个函数：`core/geo.js::getCurrentPosition()` 在定位失败 / 被拒 /
 *   超时时会**回退到默认地点**（`source:'default'`），坐标是真实可用的经纬度 ——
 *   拿它去算距离会得出一个看起来很有道理的「偏离 N 公里」，那是把默认值冒充实测值，
 *   比直接说「没拿到定位」糟得多。
 *
 * ★收成函数而不是让调用方各自写 `pos.source === 'gps'`：那种写法一旦散开，
 *   漏判一处就是**静默造假**（界面不报错，只是给了一个假数字）。
 *
 * @param {Object|null} pos `getCurrentPosition()` 的结果。
 * @returns {boolean} 只有真实 GPS 定位才算数。
 */
export function isRealGps(pos) {
  return !!(
    pos &&
    pos.source === 'gps' &&
    Number.isFinite(Number(pos.lat)) &&
    Number.isFinite(Number(pos.lon))
  );
}

export function findDeviation(current, stopovers, thresholdM) {
  const thr = Number.isFinite(Number(thresholdM)) && Number(thresholdM) > 0
    ? Number(thresholdM)
    : DEFAULT_DEVIATION_REPLAN_M;
  const cur = _coord(current);
  const list = Array.isArray(stopovers) ? stopovers : [];

  if (!cur || list.length === 0) {
    return { state: DEVIATION_STATE.UNKNOWN, nearestKm: null, nearestIndex: null, thresholdM: thr, locatedCount: 0 };
  }

  let bestKm = null;
  let bestIdx = null;
  let located = 0;
  list.forEach((s, i) => {
    const c = s && _coord(s.coord);
    if (!c) return; // 没坐标的停留点不参与比较，但也不许当成「距离为 0」
    located += 1;
    const km = distanceKm(cur, c);
    if (bestKm === null || km < bestKm) {
      bestKm = km;
      bestIdx = i;
    }
  });

  if (bestKm === null) {
    return { state: DEVIATION_STATE.UNKNOWN, nearestKm: null, nearestIndex: null, thresholdM: thr, locatedCount: 0 };
  }

  return {
    state: bestKm * 1000 > thr ? DEVIATION_STATE.OVER : DEVIATION_STATE.OK,
    nearestKm: bestKm,
    nearestIndex: bestIdx,
    thresholdM: thr,
    locatedCount: located,
  };
}

export function asFilterableCandidate(cand, type) {
  const c = cand && typeof cand === 'object' && !Array.isArray(cand) ? cand : {};
  return {
    ...c,
    type: CHECKIN_TYPES.indexOf(type) === -1 ? null : type,
    category: c.type === undefined ? null : c.type,
    // 与 adoptCandidate() 同源：rating 走 _num()（非数 → null），note / tags 留空壳
    common: { rating: _num(c.rating), note: '', tags: [] },
  };
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
    // 偏离重规划阈值（米）：只认正有限数，其余一律回落默认值 ——
    // ★不许因为「没这个字段」就当成 0（0 = 一动就报偏离，比没有判定更糟）
    deviationReplanM: Number.isFinite(Number(p.deviationReplanM)) && Number(p.deviationReplanM) > 0
      ? Number(p.deviationReplanM)
      : DEFAULT_DEVIATION_REPLAN_M,
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
 * ★入参契约（**踩过一次坑，改这里之前先读**）：`list` 必须是 **CheckIn 形状** ——
 *   它按 `item.type`（只能是 'stay' / 'sight' / 'food'）取对应的筛选条件，并按
 *   `item[type]`（即 `item.stay` / `item.sight` / `item.food`）读参与筛选的字段。
 *
 *   ★`data/amap.js::parsePoi()` 产出的 **PoiCandidate 不是这个形状**：它没有语义上的
 *   `type`（它的 `type` 是高德原文，如「住宿服务;宾馆酒店」），也没有那三个子结构。
 *   直接把候选喂进来，`type` 会判成 null，于是走到「没有对应的筛选条件 = 原样通过」
 *   分支 —— 界面表现为**全部落进「达标」、「未填」组恒为空**，即把「看不清」伪装成
 *   「都挺好」，比报错还糟（T04b 实测）。
 *
 *   ★要筛候选，**必须用 `asFilterableCandidate(cand, type)` 适配**（唯一一份形状契约，
 *   就在本文件）。界线在那边的文档里写死了：补 `type` / `category` / `common.rating`
 *   这类**形状**字段，绝不补房价 / 房型 / 等级 / 菜名 —— 补了就是把推算值冒充实测值。
 *
 *   ⚠️ 2026-10-16 修正：本段曾写「只补 type」，当时 `common.rating` 还没补，
 *   于是「景点 4.6 分以上」永远匹配不上任何一条（评分恒为未填）。文档与实现不一致
 *   比实现本身出错更糟 —— 下一个人照文档写就会踩回去。
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

/* ------------------------------------------------------------------ */
/* 切段：legs 之上那一层（架构 §4.4.1 Stage 2，纯函数）                  */
/* ------------------------------------------------------------------ */

/**
 * 必经点吸附容差（秒）：为「停到必经点」而多开的里程折算成秒数，超过就不吸附。
 *
 * ★这是本实现引入的一个数，架构文档只写了「落在必经点附近则吸附」而没给阈值 ——
 *   阈值必须有一个，否则「附近」没有边界：容差无穷大会把每天的落脚点全拉到必经点上，
 *   一天的行程会被拉到远超 dailyTargetSec。取 **900 s（15 min）** 的理由：
 *   ① 远小于 dailyTargetSec 的最小档 10800 s，吸附后的一天最多多开 8 %；
 *   ② 大于路网里单条边的量级（本仓实测边上 1–5 s），不会天天触发；
 *   ③ 「用户说要经停保定，结果住宿被排到保定前 30 km 的国道边」这条要治，
 *      而 30 km ≠ 15 min 的车程 —— 反过来多开 15 min 到保定市区正是用户想要的。
 *   改这个数请连这里的理由一起改。
 */
export const VIA_SNAP_TOL_SEC = 900;

/**
 * 去重阈值（米）：新锚点与任一**必经点**的直线距离小于它 → 丢弃这一刀。
 *
 * 取 2000 的理由：它与 `SNAP_WARN_M`（2000，同一量级）保持同一把尺子 ——
 * OSRM 会把输入点吸附到路网上（实测可达 3363 m），于是「必经点」其实已经是
 * 吸附后的位置；再在它身边 2 km 内切一个住宿点，等于把同一个地方算成两天。
 */
export const STOPOVER_DEDUP_M = 2000;

/**
 * 切段失败的分类（**机器码**，不是 i18n 键）。
 *
 * ★机器码与 i18n 键为什么**并存**、各管一段：`reasonKind` 给程序分支用（单测断言、
 *   埋点、将来要判「这类失败值不值得重试」），`reasonKey` 给 UI 上屏用。只给机器码，
 *   UI 就得拿 `reasonKind` 自己去猜一句中文 —— 那正是「各层自己编一套说法」，与本仓
 *   「core 产键、UI 翻译」的既定约定相悖；只给键，程序就没法稳定分支。
 *
 * @type {Object<string,string>}
 */
export const SPLIT_FAIL = {
  /** route 压根不是 RouteInfo 形状。 */
  NO_ROUTE: 'noRoute',
  /** 没有几何（或不足 2 个点）。 */
  NO_GEOMETRY: 'noGeometry',
  /** 没有逐边累积时长 —— 切段失去唯一依据（§4.4.1 第 1 条）。 */
  NO_ANNOTATIONS: 'noAnnotations',
  /** dailyTargetSec / plan 不是正数。 */
  BAD_TARGET: 'badTarget',
};

/**
 * 机器码 → i18n 键。
 *
 * ★为什么复用 `rt.err.*` 而不是 `trip.*`：那七个 `trip.*` 全是**文件级**失败
 *   （badJson / badSchema / notRoadtrip / newerSchema …），拿过来界面会告诉用户
 *   「不是途候的行程文件」，而实际原因是这条路线缺逐边时长 —— 张冠李戴比不说话更糟。
 *   `rt.err.*` 是「路线数据本身」这一族的桶（osrm.js 抛的也是它们），语义正好对得上。
 *
 * ★`rt.err.badTarget` 是本轮**新增**的第四个键：本函数有两条失败路径
 *   （`dailyTargetSec <= 0` / `minGapSec < 0`）走 `BAD_TARGET`，它们同样来自用户输入
 *   （「每天开几小时」），同样是用户看得见的失败。若唯独它不给键，UI 就不得不为它
 *   单独编一句文案 —— 那正好是「各层自己编一套说法」，比多一个键糟。
 *
 * ★`NO_ROUTE` 为什么用 `rt.err.noRouteData` 而不是 `rt.err.noRoute`：后者的文案带
 *   `{code}` 占位（「未能算出路线（OSRM 返回 {code}）」），而本分支的成因是「传进来的
 *   压根不是一份 RouteInfo」，**没有 OSRM 错误码可填** —— `t()` 缺参时不替换，占位符会
 *   原样上屏，用户会看到「…（OSRM 返回 {code}）」这种半成品句子。本仓「刻意不兜底」是
 *   让**缺键**变成可见的失败（t() 返回键名本身），不是让**占位符**裸奔 —— 后者是文案
 *   bug，不是诚实。所以这里用不带占位的 `rt.err.noRouteData`；
 *   上游真正拿到 OSRM 错误码的那条路径仍走 `rt.err.noRoute` + `code`，两者不混。
 *
 * @type {Object<string,string>}
 */
export const SPLIT_FAIL_KEY = {
  [SPLIT_FAIL.NO_ROUTE]: 'rt.err.noRouteData',
  [SPLIT_FAIL.NO_GEOMETRY]: 'rt.err.noGeometry',
  [SPLIT_FAIL.NO_ANNOTATIONS]: 'rt.err.noAnnotations',
  [SPLIT_FAIL.BAD_TARGET]: 'rt.err.badTarget',
};

/**
 * 组装一条切段失败结果（机器码与 i18n 键**一起**给）。
 *
 * @param {Object} base 基础结果（成功态的骨架）。
 * @param {string} kind SPLIT_FAIL 的取值。
 * @param {Object} params 失败参数（不含成句）。
 * @returns {Object} 失败结果。
 */
function _splitFail(base, kind, params) {
  return {
    ...base,
    ok: false,
    reasonKind: kind,
    reasonKey: SPLIT_FAIL_KEY[kind] || null,
    reasonParams: params,
  };
}

/**
 * 切段结果。
 *
 * @typedef {Object} SplitResult
 * @property {boolean} ok 是否正常切完（false 时 stopovers 恒为 []）。
 * @property {string|null} reasonKind 失败分类（SPLIT_FAIL 的取值）；成功时 null。
 * @property {Object} reasonParams 失败参数（给 UI 拼文案用，不含成句）。
 * @property {string|null} reasonKey 失败原因的 i18n 键（SPLIT_FAIL_KEY 的产出），
 *   供 UI 层 `tr()` 上屏；成功时 null。core 不许 import i18n，所以这里只给键名。
 * @property {Array<Object>} stopovers Stopover[]（形状见 §4.4）。
 * @property {number} dayCount 天数 = stopovers.length + 1。
 * @property {number|null} totalSecAnn Σ annotation.duration（切段的依据口径）。
 * @property {number|null} totalSecLegs Σ legs[].duration（界面展示的总时长口径）。
 * @property {number|null} driftSec totalSecLegs − totalSecAnn（实测恒 ≥ 0）。
 * @property {number|null} driftRatio driftSec / totalSecLegs（实测 0.13 %–0.66 %）。
 * @property {number} tailMergedSec 末段**被并入**的秒数（0 = 收尾规则没触发）。
 *   注意它不是末段的全部 —— 它是「那刀被作废后、多出来的那一截」；末段全长见 `tailSec`。
 * @property {number|null} tailMergedIntoDay 并入的是第几天（1 基）。
 * @property {number} tailSec 末段全长：从**最后一个停留点**开到终点的驾驶秒数。
 *   没有停留点时它等于全程。★UI 要画「第 N 天开多久」必须用它 —— 只靠 Stopover[] 算不出
 *   最后一天（最后一天没有「落脚点」可挂）。
 * @property {number|null} tailM tailSec 对应的里程（米）；`cumulativeM` 缺失时为 null。
 * @property {number} edgeCount 边数 = 点数 − 1。
 */

/**
 * 校验一份 RouteInfo **对本函数而言**是否够用来切段。
 *
 * 三道门依次是：是不是个对象、有没有几何（≥2 点）、有没有逐边累积时长。
 * 只要有一道不过就 `ok:false` —— 本函数**绝不**用什么东西把缺的那部分补上。
 *
 * @param {*} route RouteInfo。
 * @param {Array<Array<number>>} points 几何点位（[lon, lat] 序列）。
 * @returns {{ok:boolean, kind:string|null, params:Object}} 校验结果。
 */
function _splitInput(route, points) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return { ok: false, kind: SPLIT_FAIL.NO_ROUTE, params: {} };
  }
  if (!Array.isArray(points) || points.length < 2) {
    return { ok: false, kind: SPLIT_FAIL.NO_GEOMETRY, params: { points: Array.isArray(points) ? points.length : 0 } };
  }
  const cumS = Array.isArray(route.cumulativeS) ? route.cumulativeS : null;
  if (!cumS || cumS.length !== points.length) {
    // ★不许按「总时长 ÷ 边数」或「逐边距离 ÷ 假想速度」把累积曲线补出来：
    //   那正是第 7 条要防的事 —— 补出来的每一段都是编的数字。
    //   没有逐边时长就没有切段依据，如实返回「没有依据」。
    return {
      ok: false,
      kind: SPLIT_FAIL.NO_ANNOTATIONS,
      params: { cumLen: cumS ? cumS.length : 0, pointsLen: points.length },
    };
  }
  return { ok: true, kind: null, params: {} };
}

/**
 * 在几何里找离给定坐标最近的那个点的下标。
 *
 * 为什么需要它：多必经点路线的 `waypoints[].snapped` 是 OSRM **吸附之后**的必经点坐标。
 * 实测它与 `geometry` 里同一位置的那一个点**完全相同**（本轮三条真实样本逐一验过：
 * 中间必经点命中的下标正好等于前一条 leg 的边数，如 3 点样本 → 4214），所以按值相等
 * 就能命中；但当浮点有 ±1 ulp 的差异时相等会漏，所以退一步按**最近点**找 ——
 * 在完整几何（`overview=full`）上，相邻两点之间最多一条边的长度，最近点没有歧义空间。
 *
 * @param {Array<Array<number>>} points 几何（[lon, lat] 序列）。
 * @param {{lat:number, lon:number}} target 目标坐标。
 * @returns {number} 下标；形状异常时返回 -1。
 */
function _nearestPointIndex(points, target) {
  let best = -1;
  let bestKm = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    const km = distanceKm(target, { lat: _num(p[1]), lon: _num(p[0]) });
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  return best;
}

/**
 * 取各条 leg 末端（= 必经点）在几何里的下标，**不含起点与终点**。
 *
 * 为什么要把起终点剔除在这里而不是留到切割循环里：第 6 条说「起点 / 终点永不成为
 * Stopover」，它们分别属于 `plan.origin` / `plan.destination`。把它们留在必经点名单里，
 * 去重（第 5 条）就会拿起点去比对每一个新锚点 —— 第一天开出去 100 km 的落脚点本来
 * 不该和起点比，比了只会让规则变得难懂。
 *
 * @param {*} route RouteInfo。
 * @param {Array<Array<number>>} points 几何。
 * @returns {Array<number>} 必经点下标（升序，可能为空数组）。
 */
function _legEndIndices(route, points) {
  const wps = Array.isArray(route && route.waypoints) ? route.waypoints : [];
  const out = [];
  for (const w of wps) {
    const c = _coord(w && w.snapped);
    if (!c) continue;
    const idx = _nearestPointIndex(points, c);
    if (idx <= 0 || idx >= points.length - 1) continue;
    if (out.indexOf(idx) === -1) out.push(idx);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 按「每天开多久」把一条 OSRM 路线切成落脚点（架构 §4.4.1 Stage 2）。
 *
 * ★它存在的理由：`legs[]` 是按**必经点**切的，不是按**天**切的。三点 336 km 那条路线
 *   legs = [154.6 km/1.84 h, 181.6 km/2.17 h]，当天排会变成「两天、每天不到 2.2 h」；
 *   成都→西安只有 1 条 leg（8.14 h），又远超 5 h 上限必须切开。所以在 legs 之上必然
 *   还要这一层。**同一个 legs 输入、不同的 dailyTargetSec 会得到不同天数** —— 这正是
 *   第三、四条单测要钉住的事。
 *
 * 八条契约（§4.4.1 第 1–8 条）在本实现里的落点，逐条对得上：
 *   1. 累积曲线**直接用 `route.cumulativeS`**（`src/data/osrm.js` 产出，前导 0、
 *      长度 = 几何点数），本函数自己不再重算一遍 —— 两处各算一次必然会漂；
 *   2. 锚点 = 第一个 `cumulativeS[k] >= t + dailyTargetSec` 的点，取 `geometry[k]`；
 *   3. 收尾：切完若 `totalSecAnn - cumS[k] < minGapSec`，这一刀作废，余量并入最后一天，
 *      秒数写进 `tailMergedSec` / `tailMergedIntoDay`（UI 据此写「末段 X 分钟并入第 N 天」）。
 *      ★例外：k 之后还有**待落脚的「必须经过」必经点**时不作废，继续切 —— 否则一个
 *      离终点很近的必经点会因为余段短被整个跳过，「必须经过」就成了假的；
 *   4. 必经点优先：k 之后存在 leg 末端时，锚点吸附到那个必经点，`anchorFrom:'via'`，
 *      `t` 推进到该 leg 结束。★两类必经点走**两条判据**（需求 8.2，2026-10-16）：
 *      - `required:true`（**必须经过**，默认）：**无视** `VIA_SNAP_TOL_SEC` 容差，
 *        k 之后第一个就是它 —— 这天可能开超 `dailyTargetSec`，目标只是参考门槛不是硬约束，
 *        超了如实显示，不许为了让时长好看而偷偷跳过；
 *      - `required:false`（**仅供参考**）：沿用容差，落在 `VIA_SNAP_TOL_SEC` 内才吸附，
 *        过了就当没这个点（它的作用只是把路线拽成大致想要的走向）。
 *   5. 去重：新锚点与任一必经点直线距离 < `STOPOVER_DEDUP_M` 则丢弃这一刀。
 *      ★这里的必要澄清（第 4 与第 5 条字面会撞车）：吸附到必经点的那一刀**不能**被
 *      第 5 条判掉 —— 它的距离是 0，判掉就等于第 4 条永不生效。所以第 5 条只对
 *      `anchorFrom:'cumulative-4h'` 的锚点生效；而 via 锚点改按「同一个必经点是否已有
 *      落脚点」去判重。两条规则各管一段，不重叠。
 *   6. 起点 / 终点永不入选：候选区间是 `[1, points.length - 2]`，两端不在里面；
 *   7. 不估算：`driveFromPrevS` = `cumulativeS` 区间相减、`driveFromPrevM` =
 *      `cumulativeM`（我在 Stage 1 补的逐边累积里程）区间相减；任一为 null 就返回 null；
 *   8. 口径诚实：两个总数**分别**返回（`totalSecAnn` 用于停靠位置与每日时长、
 *      `totalSecLegs` 用于界面总时长），差值与比例也一并返回（`driftSec` / `driftRatio`，
 *      实测 0.13 %–0.66 %，恒为 annotation 略小）。**绝不**拿一个冒充另一个。
 *
 * @param {*} route RouteInfo（`src/data/osrm.js::parseRoute` 的产出）。
 * @param {Object} [plan] PlanInput；只用 `dailyTargetSec` / `minGapSec`。
 * @param {{dailyTargetSec?:number, minGapSec?:number, viaSnapTolSec?:number,
 *          dedupM?:number, nowMs?:number}} [opts] 覆盖项（单测用）。
 * @returns {SplitResult} 见上。
 */
export function splitStopovers(route, plan = {}, opts = {}) {
  const p = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};
  const o = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};

  /** @type {SplitResult} */
  const base = {
    ok: true,
    reasonKind: null,
    reasonParams: {},
    reasonKey: null,
    stopovers: [],
    dayCount: 0,
    totalSecAnn: null,
    totalSecLegs: null,
    driftSec: null,
    driftRatio: null,
    tailMergedSec: 0,
    tailMergedIntoDay: null,
    tailSec: 0,
    tailM: null,
    edgeCount: 0,
  };

  const points = Array.isArray(route && route.geometry) ? route.geometry : null;
  const input = _splitInput(route, points);
  if (!input.ok) {
    return _splitFail(base, input.kind, input.params);
  }

  const cumS = route.cumulativeS;
  const cumM =
    Array.isArray(route.cumulativeM) && route.cumulativeM.length === points.length ? route.cumulativeM : null;
  const last = points.length - 1;
  const edgeCount = last;

  /* ---- 参数：显式给了却非法 → 失败；没给 → 用默认 ---- */
  const targetRaw = o.dailyTargetSec !== undefined ? _num(o.dailyTargetSec) : _num(p.dailyTargetSec);
  if (targetRaw !== null && targetRaw <= 0) {
    return _splitFail(base, SPLIT_FAIL.BAD_TARGET, { dailyTargetSec: targetRaw });
  }
  const dailyTargetSec = targetRaw === null ? DEFAULT_DAILY_TARGET_SEC : targetRaw;

  const gapRaw = o.minGapSec !== undefined ? _num(o.minGapSec) : _num(p.minGapSec);
  if (gapRaw !== null && gapRaw < 0) {
    return _splitFail(base, SPLIT_FAIL.BAD_TARGET, { minGapSec: gapRaw });
  }
  const minGapSec = gapRaw === null ? DEFAULT_MIN_GAP_SEC : gapRaw;

  const snapRaw = _num(o.viaSnapTolSec);
  const viaSnapTolSec = snapRaw === null || snapRaw < 0 ? VIA_SNAP_TOL_SEC : snapRaw;
  const dedupRaw = _num(o.dedupM);
  const dedupM = dedupRaw === null || dedupRaw < 0 ? STOPOVER_DEDUP_M : dedupRaw;
  const nowMs = Number.isFinite(Number(o.nowMs)) ? Number(o.nowMs) : Date.now();

  /* ---- 两个总量口径（第 8 条） ---- */
  const totalSecAnn = _num(cumS[last]);
  const legSum = Array.isArray(route.legs) && route.legs.length > 0
    ? route.legs.reduce((acc, l) => acc + (_num(l && l.durationS) || 0), 0)
    : null;
  const totalSecLegs = _num(route.durationS) !== null ? _num(route.durationS) : legSum;
  const driftSec = totalSecAnn === null || totalSecLegs === null ? null : totalSecLegs - totalSecAnn;
  const driftRatio = driftSec === null || !totalSecLegs ? null : driftSec / totalSecLegs;

  /* ---- 必经点（第 4 / 5 条要用） ---- */
  const viaIdx = _legEndIndices(route, points);
  const viaCoords = viaIdx.map((i) => ({ lat: _num(points[i][1]), lon: _num(points[i][0]) }));
  // ★每个必经点「必须 / 建议」的标记，与 `viaIdx` **按位置一一对应**（第 i 个 leg 末端
  //   就是第 i 个必经点）。
  //   ★★三种取值，**「没说」必须和「必须」分开**（2026-10-16 踩过）：
  //     - `true`  = 必须经过 → 无视容差，必定成为停留点；
  //     - `false` = 仅供参考 → 只在容差内才吸附；
  //     - `null`  = **没说**（plan 没带 via / 旧数据没这个字段 / 索引越界）→ 沿用
  //       **原有行为**（容差内才吸附）。
  //     ⚠️ 把 `null` 归并进 `true` 是一次真事故：老单测不传 via，于是所有必经点都变成
  //     「无视容差强制停留」，既有分天行为被静默改写（两条单测当场见红）。
  //     「没说」不等于「必须」—— 缺省必须保守，不能放大语义。
  const viaInput = Array.isArray(p.via) ? p.via : [];
  const viaRequired = viaIdx.map((_, i) => {
    const v = viaInput[i];
    if (!v || typeof v !== 'object') return null;
    return v.required === true ? true : v.required === false ? false : null;
  });

  /* ---- 逐刀 ---- */
  const cuts = [];
  let t = 0;
  let tailMergedSec = 0;
  let tailMergedIntoDay = null;
  // 防御上限：天数上限本就是 ceil(total / target)，这里再给一层以免累积曲线的浮点
  // 异常（NaN / 非单调）把界面拖死。真实路线远到不了这个数。
  const maxIter = Math.ceil((totalSecAnn === null ? 0 : totalSecAnn) / dailyTargetSec) + 8;

  for (let guard = 0; guard < maxIter; guard += 1) {
    const want = t + dailyTargetSec;
    let k = -1;
    // ★候选区间 [1, last-1]：两端分别是起点与终点，第 6 条不许它们入选
    for (let i = 1; i < last; i += 1) {
      if (_num(cumS[i]) !== null && cumS[i] >= want) {
        k = i;
        break;
      }
    }
    if (k < 0) break;

    // ★「待落脚的必须点」：还在 k 之后、且没被任何一刀占用过的**必须经过**的必经点。
    //   第 3 条要为它让路 —— 否则一个离终点很近的必经点会因为「余段不足 minGapSec」
    //   被整个跳过，「必须经过」就成了假的（界面不报错，只是那个点悄悄消失）。
    const pendingRequired = viaIdx.some(
      (vi, i) => vi >= k && viaRequired[i] === true && !cuts.some((c) => c.index === vi)
    );

    const remaining = (totalSecAnn === null ? 0 : totalSecAnn) - cumS[k];
    // 第 3 条：余段不足 minGapSec → 不再切这一刀，余量并入「这一天」（= 已切刀数 + 1）
    if (remaining < minGapSec && !pendingRequired) {
      tailMergedSec = remaining > 0 ? remaining : 0;
      tailMergedIntoDay = cuts.length + 1;
      break;
    }

    // 第 4 条：k 之后存在必经点 → 吸附到它。
    //   ★两类必经点走**两条判据**（用户 2026-10-16 需求 8.2）：
    //     - 「必须经过」：无视容差，k 之后第一个就是它 —— 用户点名要停的地方，
    //       哪怕这一天会开超 `dailyTargetSec` 也要停。目标时长只是分天的**参考门槛**，
    //       不是硬约束，超了就如实显示，不许为了让时长好看而偷偷跳过。
    //     - 「仅供参考」：沿用 `viaSnapTolSec` 容差，落在容差内才吸附，
    //       过了就当没这个点（它的作用只是把路线拽成大致想要的走向）。
    let useIndex = k;
    let anchorFrom = 'cumulative-4h';
    for (let i = 0; i < viaIdx.length; i += 1) {
      const vi = viaIdx[i];
      if (vi < k) continue;
      // `true` 无视容差；`false` 与 `null`（没说）都走容差 —— 缺省保守，不放大语义
      if (viaRequired[i] === true || cumS[vi] - cumS[k] <= viaSnapTolSec) {
        useIndex = vi;
        anchorFrom = 'via';
        break;
      }
    }

    const coord = { lat: _num(points[useIndex][1]), lon: _num(points[useIndex][0]) };

    // 第 5 条：去重（含义见本函数 JSDoc 里 ★那条澄清 —— via 锚点走另一条判据）
    let dropped = false;
    if (anchorFrom === 'via') {
      dropped = cuts.some((c) => c.index === useIndex);
    } else {
      for (const vc of viaCoords) {
        if (distanceKm(coord, vc) * 1000 < dedupM) {
          dropped = true;
          break;
        }
      }
    }
    if (!dropped) cuts.push({ index: useIndex, anchorFrom });

    // ★t 必须严格前进，否则余段不足时会原地打转。`cumS[useIndex] >= want > t`，
    //   所以这里推进到本刀的实际位置后，下一轮的 want 一定更大，循环必然终止。
    t = cumS[useIndex];
  }

  /* ---- 组装 Stopover（形状由 §4.4 定义，走 _stopover() 归一） ---- */
  const stopovers = [];
  let prevIndex = 0;
  cuts.forEach((c, i) => {
    const idx = c.index;
    stopovers.push(
      _stopover({
        id: newId('so', nowMs),
        day: i + 1,
        seq: i + 1,
        coord: { lat: _num(points[idx][1]), lon: _num(points[idx][0]) },
        anchorFrom: c.anchorFrom,
        // 第 8 条：这个值出自 annotation 累积，不是 legs[].duration 那一套
        cumSecAtArrival: _num(cumS[idx]),
        driveFromPrevS: _num(cumS[idx]) - _num(cumS[prevIndex]),
        driveFromPrevM: cumM ? _num(cumM[idx]) - _num(cumM[prevIndex]) : null,
        placeName: null,
        placeSource: 'coord',
        note: '',
        actual: null,
      })
    );
    prevIndex = idx;
  });

  // 末段：最后一个停留点 → 终点。★它是一个真实存在的一段，只是**没有落脚点可挂** ——
  // 不把它单独返回，UI 就画不出最后一天开多久（只靠 Stopover[] 会少掉这一截）。
  const lastCumIdx = cuts.length > 0 ? cuts[cuts.length - 1].index : 0;
  const tailSec = totalSecAnn === null ? 0 : totalSecAnn - (_num(cumS[lastCumIdx]) || 0);
  const tailM = cumM && totalSecAnn !== null ? _num(cumM[last]) - (_num(cumM[lastCumIdx]) || 0) : null;

  return {
    ...base,
    ok: true,
    stopovers,
    dayCount: stopovers.length + 1,
    totalSecAnn,
    totalSecLegs,
    driftSec,
    driftRatio,
    tailMergedSec,
    tailMergedIntoDay,
    tailSec: tailSec > 0 ? tailSec : 0,
    tailM,
    edgeCount,
  };
}
