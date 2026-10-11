/**
 * 底图瓦片（ArcGIS Online）
 *
 * 职责：构造三种样式的瓦片 URL、探测可用性、计算字节指纹、做「多瓦片去重判定」，
 * 并对整批失败做三态降级（map → grid → no-map，不重试、不转圈）。
 *
 * 瓦片缓存（2026-10-11 四轮真机实测后新增）：全瓦片 31 个采样点中位 693 ms、
 * 范围 247–3198 ms，波动 13 倍，已占 6 s 超时的 53%；而同一 z/x/y 的字节数与指纹**跨四轮完全一致**，
 * 说明瓦片内容确定不变，缓存不会拿到脏数据。故按 URL 做**纯内存** LRU 缓存（不落 localStorage：
 * 瓦片平均 20 KB，持久化会迅速撑爆配额，而收益主要在页面内的缩放平移）。
 *
 * ⚠️ 写缓存的唯一前提是该样式已被**授信**（`isStyleTrusted(styleId) === true`）：
 * 单块瓦片的指纹无法自证真假（占位图同样有指纹），必须「同一样式 + 多个位置」比对判为 real 之后才可信。
 * 授信入口只有自检页 —— 真机验明是真瓦片，日常使用才允许走缓存（详见 src/ui/selfcheck.js）。
 *
 * 指纹说明：Web Crypto 摘要算法里没有 128 位消息摘要，故用 **SHA-256 前 16 位 hex** 作指纹
 * （截短后去重语义等价）。导出 JSON 用 fpAlgo 字段标明算法；界面文案统一称「指纹 fp」。
 * 安全上下文缺失（crypto.subtle 不可用）时降级为「字节长度 + 首 64 字节 hex」（algo='size-head'）。
 *
 * 坐标系（2026-10-11 实测三个服务的 `?f=json` 取证，勿凭印象改）：
 * 三者 `spatialReference` 均为 **wkid 102100 / latestWkid 3857**，即 WGS_1984_Web_Mercator_
 * Auxiliary_Sphere（Web Mercator）；瓦片 256×256，lods 0–23。故内部 WGS84 坐标**直接**
 * 做 Web Mercator 换算即可，**不做 GCJ-02 纠偏** —— 先转 GCJ-02 反而与瓦片错位。
 *
 * ⚠️ 未确认点（只登记、不猜；本阶段**不实现**纠偏）：street 服务的 `serviceDescription`
 *   写有 "NGCC data for China"。瓦片金字塔是 WGS84 Web Mercator 无疑，但**中国境内矢量
 *   要素是否按 GCJ-02 生产**没有官方声明，未确认。若真机发现落点与路网错开数百米，
 *   再启用 `core/geo.js` 的 `wgs84ToGcj02()` 占位函数 —— 现在不要实现纠偏。
 *
 * 服务条款（同样来自实测响应，改动前先重读）：
 *   1) **必须署名**：每个服务都返回 `copyrightText`，且 Esri 要求同时显示
 *      "Powered by Esri"（见 `TILE_CREDITS` / `TILE_POWERED_BY` / `tileAttribution()`）。
 *      这是条款硬要求，不是可选项；地图卡上的署名必须随样式切换。
 *   2) 不得用 robots / 自动批量拉取 ArcGIS Online 地图。
 *      本项目的 3×3 探测与按需拉瓦片属正常浏览，合规；不得改成批量爬取。
 *   3) 三个服务的 `exportTilesAllowed` 均为 **false** —— 不许做离线批量导出 / MBTiles。
 *
 * 已被实测剔除、禁止再引用的源：nominatim.openstreetmap.org、basemaps.cartocdn.com、
 * tile.openstreetmap.org、overpass（本阶段不实现 POI）。
 */

import { requestRaw } from '../core/http.js';
import { makeKey, get as cacheGet, set as cacheSet, clearPrefix as cacheClearPrefix } from '../core/cache.js';
import { t } from '../i18n/zh.js';

/** 瓦片基址（三种样式共用）。 */
export const TILE_BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

/**
 * 三种样式定义。注意 dark 的路径层级不同（Canvas/World_Dark_Gray_Base/...），不可照抄 street。
 */
export const TILE_STYLES = {
  street: {
    id: 'street',
    labelKey: 'tile.street',
    path: 'World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    fmt: 'jpeg',
  },
  imagery: {
    id: 'imagery',
    labelKey: 'tile.imagery',
    path: 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
    fmt: 'jpeg',
  },
  dark: {
    id: 'dark',
    labelKey: 'tile.dark',
    path: 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    fmt: 'png',
  },
};

/** 许可署名（源级，不随样式变化；用于溯源气泡等「只标服务名」的场景）。 */
export const TILE_ATTRIBUTION = 'Esri ArcGIS Online World Tile Service';

/**
 * 各样式的**实测** `copyrightText`（2026-10-11 取自三个服务 `?f=json` 的返回，勿手改）。
 *
 * 这是条款硬要求：显示了哪一路底图，就必须把那一路的数据提供方名字显示出来。
 */
export const TILE_CREDITS = {
  street:
    'Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, ' +
    'Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, (c) OpenStreetMap contributors, ' +
    'and the GIS User Community',
  imagery: 'Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  dark: 'Esri, HERE, Garmin, (c) OpenStreetMap contributors, and the GIS User Community',
};

/** Esri 技术署名（与数据署名并列显示，同为条款要求）。 */
export const TILE_POWERED_BY = 'Powered by Esri';

/**
 * 取某样式的完整署名串（数据提供方 + Esri 技术署名）。
 *
 * @param {string} styleId 样式 id。
 * @returns {string} 署名串；未知样式回落到 street。
 */
export function tileAttribution(styleId) {
  const credit = TILE_CREDITS[styleId] || TILE_CREDITS.street;
  return `${credit} · ${TILE_POWERED_BY}`;
}

/** 瓦片像素尺寸（三个服务的 tileInfo 均为 256×256）。 */
export const TILE_SIZE = 256;

/** 缩放层级下限（z10：城市级视野）。 */
export const MIN_ZOOM = 10;

/** 缩放层级上限（z16：街区级视野；再往上 Esri 暗色样式已无覆盖）。 */
export const MAX_ZOOM = 16;

/** 起手缩放层级（z12）。 */
export const DEFAULT_ZOOM = 12;

/** 瓦片探测超时（毫秒），retry 恒为 0。 */
export const TILE_TIMEOUT_MS = 6000;

/** 瓦片缓存 TTL：7 天（毫秒）。 */
export const TILE_CACHE_TTL_MS = 604800000;

/** 瓦片缓存 LRU 上限：96 条（96 × 约 20 KB ≈ 2 MB，是移动端可接受的上界）。 */
export const TILE_CACHE_MAX = 96;

/**
 * 样式授信的有效期：30 天。
 *
 * 授信是「这台机器验过它是真瓦片」的结论，不是永久真理 —— 底图源会换、CDN 会切，
 * 30 天后回到未授信，逼下一次自检重新验一遍。
 */
export const TILE_TRUST_TTL_MS = 2592000000;

/**
 * 地图三态。
 *
 * - `map`：底图可用；
 * - `grid`：部分瓦片失败 —— 仅画网格 + 坐标，**先不宣布无地图**，给后续静默重试留余地；
 * - `no-map`：整批全部失败 —— 纯坐标模式。
 */
export const MAP_MODE = { MAP: 'map', GRID: 'grid', NO_MAP: 'no-map' };

/** @type {string} 当前地图模式（三态的唯一状态源在 tiles.js）。 */
let _mapMode = MAP_MODE.MAP;

/**
 * 瓦片缓存：key = 瓦片 URL，value = 缓存条目。
 * 纯内存，页面刷新即失效；不落 localStorage（理由见文件头）。
 *
 * @type {Map<string, {styleId:string, bytes:ArrayBuffer, length:number, fp:string,
 *                     fpAlgo:string, contentType:string|null, httpStatus:number|null,
 *                     latencyMs:number, storedAt:number, lastUsed:number}>}
 */
const _tileCache = new Map();

/**
 * 样式授信表（内存镜像）：只有被判为 real（真瓦片）的样式才允许写缓存。
 * 默认「没有任何记录」= 未授信 —— 未经真机自检，一律不缓存，宁可每次都走网络。
 *
 * 授信要跨会话有效（否则用户关掉 App 再打开就不授信了，而没人会每次开 App 先跑一遍自检，
 * 缓存等于永不生效），故同时落 localStorage，键 `gs:v1:tile-trust:<styleId>`，值 `{ trusted, at }`。
 * localStorage 不可用（隐私模式 / 配额满 / 抛异常）时**静默降级为纯内存**，
 * 绝不能因为授信存不下就影响瓦片请求本身。
 *
 * @type {Map<string, {trusted:boolean, at:number}>}
 */
const _trusted = new Map();

/**
 * 构造瓦片 URL。
 *
 * @param {string} styleId 'street' | 'imagery' | 'dark'。
 * @param {number} z 缩放层级。
 * @param {number} x 瓦片列号。
 * @param {number} y 瓦片行号（ArcGIS 为 {z}/{y}/{x} 顺序）。
 * @returns {string} 完整 URL。
 */
export function tileUrl(styleId, z, x, y) {
  const style = TILE_STYLES[styleId] || TILE_STYLES.street;
  const path = style.path.replace('{z}', String(z)).replace('{y}', String(y)).replace('{x}', String(x));
  return `${TILE_BASE}${path}`;
}

/**
 * 取样式中文名。
 *
 * @param {string} styleId 样式 id。
 * @returns {string} 中文名。
 */
export function styleLabel(styleId) {
  const style = TILE_STYLES[styleId];
  return style ? t(style.labelKey) : String(styleId);
}

/**
 * Uint8Array → hex 串。
 *
 * @param {Uint8Array} u8 字节数组。
 * @returns {string} 十六进制串。
 */
function _hex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 计算瓦片字节指纹。
 *
 * @param {ArrayBuffer|Uint8Array} bytes 瓦片字节。
 * @returns {Promise<{fp:string, algo:'sha256-16'|'size-head'}>} 指纹与算法标识。
 */
export async function fingerprint(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0));
  const subtle =
    typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle
      ? globalThis.crypto.subtle
      : null;

  if (subtle && typeof subtle.digest === 'function' && typeof u8.buffer !== 'undefined') {
    try {
      // 只取 u8 的真实视图做摘要，避免整块底层 buffer 参与
      const view = new Uint8Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
      const digest = await subtle.digest('SHA-256', view);
      return { fp: _hex(new Uint8Array(digest)).slice(0, 16), algo: 'sha256-16' };
    } catch (err) {
      /* 摘要失败时走降级分支 */
    }
  }

  // 降级指纹：字节长度 + 首 64 字节 hex（非安全上下文 / crypto 不可用）
  const head = u8.slice(0, Math.min(64, u8.length));
  return { fp: `${u8.length}:${_hex(head)}`, algo: 'size-head' };
}

/* ------------------------------------------------------------------ */
/* 瓦片缓存（纯内存 LRU + TTL）                                        */
/* ------------------------------------------------------------------ */

/**
 * 取缓存条目（命中则刷新 lastUsed，过期则删除并返回 null）。
 *
 * @param {string} url 瓦片 URL（缓存键）。
 * @returns {Object|null} 缓存条目；未命中或已过期时 null。
 */
function _cacheGet(url) {
  const hit = _tileCache.get(url);
  if (!hit) return null;
  const now = Date.now();
  if (now - hit.storedAt >= TILE_CACHE_TTL_MS) {
    _tileCache.delete(url);
    return null;
  }
  hit.lastUsed = now;
  return hit;
}

/**
 * 写入缓存并维护 LRU 上限（超限时淘汰 lastUsed 最久的条目）。
 *
 * @param {string} url 瓦片 URL（缓存键）。
 * @param {Object} entry 缓存条目（不含 storedAt/lastUsed，由本函数补齐）。
 * @returns {void}
 */
function _cacheSet(url, entry) {
  const now = Date.now();
  _tileCache.set(url, { ...entry, storedAt: now, lastUsed: now });
  if (_tileCache.size <= TILE_CACHE_MAX) return;
  // 淘汰 lastUsed 最久的：Map 保持插入序，但 lastUsed 会被命中刷新，故必须真比一遍
  let oldestKey = null;
  let oldestAt = Infinity;
  for (const [k, v] of _tileCache) {
    if (v.lastUsed < oldestAt) {
      oldestAt = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey !== null) _tileCache.delete(oldestKey);
}

/**
 * 清空瓦片缓存（自检页「强制刷新」与测试用）。
 *
 * @returns {void}
 */
export function clearTileCache() {
  _tileCache.clear();
}

/**
 * 取缓存里的瓦片**字节**（渲染层用）。
 *
 * 只暴露给 `ui/map.js` 拼 Blob URL：命中缓存就不必再走网络、也不必再等一次 6 s 超时。
 * 读侧**不判授信**是刻意的：能进缓存的条目必然是该样式授信后写入的（写侧判据见
 * `probeTile()`），而撤销授信时 `markStyleTrusted()` 已把该样式的缓存清空 ——
 * 读侧再判一次是重复劳动，还会在「刚授信」的边界上产生假阴性。
 *
 * @param {string} url 瓦片 URL（缓存键）。
 * @returns {{bytes:ArrayBuffer|Uint8Array, contentType:string|null, fp:string,
 *            httpStatus:number|null}|null} 缓存条目；未命中或已过期时 null。
 */
export function tileCachedBytes(url) {
  const hit = _cacheGet(url);
  if (!hit) return null;
  return {
    bytes: hit.bytes,
    contentType: hit.contentType,
    fp: hit.fp,
    httpStatus: hit.httpStatus,
  };
}

/**
 * 当前缓存条目数（测试与调试用）。
 *
 * @returns {number} 条目数。
 */
export function tileCacheSize() {
  return _tileCache.size;
}

/**
 * 授信记录的缓存键。
 *
 * @param {string} id 样式 id。
 * @returns {string} 'gs:v1:tile-trust:<styleId>'。
 */
function _trustKey(id) {
  return makeKey('tile-trust', id);
}

/**
 * 把授信结论落 localStorage（失败即静默降级为纯内存，绝不抛到调用方）。
 *
 * @param {string} id 样式 id。
 * @param {{trusted:boolean, at:number}} rec 授信记录。
 * @returns {boolean} 是否写盘成功。
 */
function _persistTrust(id, rec) {
  try {
    return cacheSet(_trustKey(id), rec, TILE_TRUST_TTL_MS);
  } catch (err) {
    return false; // 隐私模式 / 配额满：本次会话仍按内存态工作
  }
}

/**
 * 从 localStorage 读授信记录（跨会话）。
 *
 * @param {string} id 样式 id。
 * @returns {{trusted:boolean, at:number}|null} 记录；不存在 / 已过期 / 读失败时 null。
 */
function _loadTrust(id) {
  let entry = null;
  try {
    entry = cacheGet(_trustKey(id));
  } catch (err) {
    return null;
  }
  if (!entry) return null;
  const v = entry.value;
  if (!v || typeof v !== 'object') return null;
  const at = Number(v.at) || entry.storedAt || 0;
  if (!Number.isFinite(at) || at <= 0) return null;
  // 过期即视为未授信，并顺手清掉过期记录
  if (Date.now() - at >= TILE_TRUST_TTL_MS) {
    try {
      cacheClearPrefix(_trustKey(id));
    } catch (err) {
      /* 清理失败无所谓，读侧已判为过期 */
    }
    return null;
  }
  return { trusted: v.trusted === true, at };
}

/**
 * 标记某样式是否被授信（真瓦片）。
 *
 * 授信后才允许写缓存；**撤销授信会连带清空该样式的缓存**（否则旧缓存会绕过「占位图不得缓存」这道门）。
 * 授信依据只能是「同一样式 + 多个位置」的指纹比对判为 real，单块瓦片的指纹无法自证真假。
 *
 * @param {string} styleId 样式 id。
 * @param {boolean} trusted 是否授信。
 * @returns {void}
 */
export function markStyleTrusted(styleId, trusted) {
  const id = String(styleId);
  const rec = { trusted: !!trusted, at: Date.now() };
  _trusted.set(id, rec);
  _persistTrust(id, rec); // 写盘失败不影响本次会话的内存态
  if (!rec.trusted) {
    // 撤销即清除：把该样式已缓存的字节全部丢掉，并抹掉持久化记录
    for (const [url, entry] of _tileCache) {
      if (entry.styleId === id) _tileCache.delete(url);
    }
    try {
      cacheClearPrefix(_trustKey(id));
    } catch (err) {
      /* 静默 */
    }
  }
}

/**
 * 某样式是否已被授信（允许写缓存）。
 *
 * 先查内存镜像；没有记录再查 localStorage（冷启动路径）。两处都没有 → 未授信。
 *
 * @param {string} styleId 样式 id。
 * @returns {boolean} 已授信且在有效期内 true。
 */
export function isStyleTrusted(styleId) {
  const id = String(styleId);
  const mem = _trusted.get(id);
  if (mem) {
    return mem.trusted === true && Date.now() - mem.at < TILE_TRUST_TTL_MS;
  }
  const disk = _loadTrust(id);
  if (!disk) return false;
  _trusted.set(id, disk); // 只在读到有效记录时才回填内存，避免负缓存盖住后续写入
  return disk.trusted === true;
}

/**
 * 探测单个瓦片（经 http.requestRaw，retry = 0）。
 *
 * 入参校验：z / x / y 必须是有限整数，否则**直接返回失败、不发请求** ——
 * 避免把 undefined / NaN 拼进 URL 形成 `.../tile/undefined/undefined/undefined` 这类畸形请求
 * （既污染数据源，也会把「调用方传错参」伪装成「底图不可用」）。
 *
 * 成功时**复位**地图模式到 MAP：断网一次进入降级后，网络恢复且探测成功必须退出降级，
 * 否则横幅会一直谎称底图不可用。**失败分支不置位** —— 单块的成败不能决定全局模式，
 * 模式由调用方在整批探测结束后调 `degradeMapMode(probes)` 统一裁决（见该函数注释）。
 *
 * 缓存：默认读缓存（`opts.useCache !== false`）。能进缓存的条目必然是该样式已授信后写入的，
 * 所以读侧不需要再判授信；撤销授信时 `markStyleTrusted()` 会把该样式的缓存清空。
 *
 * @param {string} styleId 样式 id。
 * @param {{z:number, x:number, y:number}} tile 瓦片坐标。
 * @param {{useCache?:boolean, timeoutMs?:number}} [opts] 选项；`useCache:false` 表示强制走真实网络
 *   （自检页必须用，否则测的是缓存而不是链路质量，那一轮数据就白测了）。注意：该开关只管「读」，
 *   写仍受样式授信约束。`timeoutMs` 用于**收紧**单块超时（整批时间预算靠它落地），
 *   取值会被 `Math.min(timeoutMs, TILE_TIMEOUT_MS)` 钳住 —— 只能更短，不能更长。
 * @returns {Promise<Object>} TileProbe（命中缓存时 `fromCache:true`、`latencyMs:0`）。
 */
export async function probeTile(styleId, tile, opts = {}) {
  const z = Number(tile && tile.z);
  const x = Number(tile && tile.x);
  const y = Number(tile && tile.y);
  const useCache = !opts || opts.useCache !== false;
  // 单块超时：默认 TILE_TIMEOUT_MS，调用方可用 opts.timeoutMs **收紧**（整批时间预算靠它落地）。
  // ★只允许收紧、不允许放松：注册表里声明的源超时是契约上限，调用方无权加长，
  //   否则「某个页面自己把超时调到 30 s」会把全局串行队列占死。
  const timeoutOverride = Number(opts && opts.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutOverride) && timeoutOverride > 0
      ? Math.min(timeoutOverride, TILE_TIMEOUT_MS)
      : TILE_TIMEOUT_MS;

  // 非法坐标：零请求失败，错误码 PARSE（不可重试），明确指向「调用方入参有问题」。
  // ★url 一律给 null：拼接出来的会是 `.../tile/NaN/NaN/NaN` 这种脏串，它不对应任何真实请求，
  //   却会写进自检导出的 JSON —— 用户看到会以为真请求过，将来若有人拿 probe.url 去发请求就是事故。
  //   坐标非法这件事已由 error.code/message 完整表达，信息不丢。
  if (!Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      styleId,
      label: styleLabel(styleId),
      url: null,
      z: Number.isFinite(z) ? z : null,
      x: Number.isFinite(x) ? x : null,
      y: Number.isFinite(y) ? y : null,
      ok: false,
      httpStatus: null,
      latencyMs: 0,
      bytes: null,
      contentType: null,
      fp: null,
      fpAlgo: null,
      fromCache: false,
      cachedAt: null,
      error: {
        code: 'PARSE',
        message: `瓦片坐标非法（z=${tile && tile.z}, x=${tile && tile.x}, y=${tile && tile.y}），未发起请求`,
        httpStatus: null,
        sourceId: 'tile',
        retriable: false,
      },
    };
  }

  // 坐标合法后才拼 URL：脏坐标不配拥有 URL（见上方 PARSE 分支注释）
  const url = tileUrl(styleId, z, x, y);

  // 缓存命中：零请求、零时延，其余字段照实回填（调用方可以此区分「这次真的打了网络」）
  if (useCache) {
    const hit = _cacheGet(url);
    if (hit) {
      setMapMode(MAP_MODE.MAP);
      return {
        styleId,
        label: styleLabel(styleId),
        url,
        z,
        x,
        y,
        ok: true,
        httpStatus: hit.httpStatus,
        latencyMs: 0,
        bytes: hit.length,
        contentType: hit.contentType,
        fp: hit.fp,
        fpAlgo: hit.fpAlgo,
        fromCache: true,
        cachedAt: hit.storedAt,
        error: null,
      };
    }
  }

  const res = await requestRaw(
    { url, responseType: 'bytes', sourceId: 'tile' },
    { timeoutMs, retry: 0 }
  );

  const probe = {
    styleId,
    label: styleLabel(styleId),
    url,
    z,
    x,
    y,
    ok: !!res.ok,
    httpStatus: res.meta.httpStatus,
    latencyMs: res.meta.latencyMs,
    bytes: res.meta.bytes,
    contentType: null,
    fp: null,
    fpAlgo: null,
    fromCache: false,
    cachedAt: null,
    error: res.error || null,
  };

  if (res.ok && res.data) {
    const fp = await fingerprint(res.data);
    probe.fp = fp.fp;
    probe.fpAlgo = fp.algo;
    // 写缓存的唯一前提：该样式已授信（真机自检判 real 过）。
    // 未授信时宁可每次走网络 —— 占位图一旦进缓存就是永久中毒。
    if (isStyleTrusted(styleId)) {
      _cacheSet(url, {
        styleId,
        bytes: res.data,
        length: typeof res.data.byteLength === 'number' ? res.data.byteLength : probe.bytes,
        fp: fp.fp,
        fpAlgo: fp.algo,
        contentType: probe.contentType,
        httpStatus: probe.httpStatus,
        latencyMs: probe.latencyMs,
      });
    }
    // 成功即退出降级（双向置位，不可 sticky）
    setMapMode(MAP_MODE.MAP);
  }
  // 失败分支刻意不置位：9 块里坏 2 块不代表底图全废，交给 degradeMapMode 按整批裁决

  return probe;
}

/**
 * 多瓦片指纹去重判定。
 *
 * 判定口径：参与样本 ≥ 3 时，指纹全各异 → 'real'（真实瓦片）；指纹全同 → 'fake'（占位图）；
 * 否则 'unknown'（样本不足或结论不明确）。
 *
 * @param {Array<Object>} probes TileProbe 数组。
 * @returns {{total:number, unique:number, fps:string[], verdict:'real'|'fake'|'unknown'}} 判定结果。
 */
export function dedupeTiles(probes) {
  const list = (Array.isArray(probes) ? probes : []).filter((p) => p && p.ok && typeof p.fp === 'string' && p.fp);
  const fps = list.map((p) => p.fp);
  const total = fps.length;
  const unique = new Set(fps).size;
  let verdict = 'unknown';
  if (total >= 3) {
    if (unique === total) verdict = 'real';
    else if (unique === 1) verdict = 'fake';
  }
  return { total, unique, fps, verdict };
}

/**
 * 取当前地图模式。
 *
 * @returns {'map'|'grid'|'no-map'} 模式。
 */
export function mapMode() {
  return _mapMode;
}

/**
 * 设置地图模式（非法值忽略，保持原值 —— 模式是全局状态，不能被脏入参打歪）。
 *
 * @param {'map'|'grid'|'no-map'} mode 模式。
 * @returns {void}
 */
export function setMapMode(mode) {
  const valid = mode === MAP_MODE.MAP || mode === MAP_MODE.GRID || mode === MAP_MODE.NO_MAP;
  if (!valid) return;
  _mapMode = mode;
}

/**
 * 按**整批**探测结果裁决地图模式（三态降级梯度）。
 *
 * 为什么不让单块成败决定全局：真机实测里瓦片时延波动 13 倍（247–3198 ms），
 * 一次慢/失败就把整张地图打没，代价比任何 API 失败都大。故：
 * - 全部 ok → `map`；
 * - 全部失败 → `no-map`（纯坐标）；
 * - 部分失败 → `grid`（仅网格 + 坐标）—— 先不宣布无地图，给后续静默重试留余地；
 * - 空批（没有任何探测结果）→ **保持当前模式不动**：没有证据时不猜。
 *
 * @param {Array<Object>} probes TileProbe 数组（未探测成功的也计入「失败」）。
 * @returns {'map'|'grid'|'no-map'} 裁决后的模式（同时写入模块状态）。
 */
export function degradeMapMode(probes) {
  const list = Array.isArray(probes) ? probes : [];
  if (list.length === 0) return _mapMode;
  let ok = 0;
  for (const p of list) {
    if (p && p.ok) ok += 1;
  }
  if (ok === list.length) setMapMode(MAP_MODE.MAP);
  else if (ok === 0) setMapMode(MAP_MODE.NO_MAP);
  else setMapMode(MAP_MODE.GRID);
  return _mapMode;
}

/**
 * 切换「无地图纯坐标模式」（兼容旧的两态接口）。
 *
 * `true` → `no-map`；`false` → `map`（注意不会停在 `grid`，因为本接口的语义是「彻底没有底图吗」）。
 *
 * @param {boolean} on 是否进入无地图模式。
 * @returns {void}
 */
export function setNoMapMode(on) {
  setMapMode(on ? MAP_MODE.NO_MAP : MAP_MODE.MAP);
}

/**
 * 是否处于「无地图纯坐标模式」（兼容旧的两态接口）。
 *
 * 语义等价于 `mapMode() === 'no-map'`；`grid` 状态下返回 false（网格仍算有底图）。
 *
 * @returns {boolean} true = 只显示坐标卡。
 */
export function isNoMapMode() {
  return _mapMode === MAP_MODE.NO_MAP;
}

/**
 * 经纬度 → 瓦片号（Web Mercator，与 Esri 三服务的 102100/3857 一致）。
 *
 * **全仓唯一一份换算实现**：`sampleTiles()` 与渲染层 `ui/map.js` 都走它，
 * 避免两份实现漂移（瓦片号算错不会报错，只会静默错位几百公里，最难查）。
 *
 * 两处防御缺一不可：
 * - 纬度必须先钳到 ±85.0511° 再算 —— Web Mercator 在此之外发散，
 *   `Math.log(Math.tan())` 会得到 NaN/Infinity，NaN 会一路泄漏进 URL；
 * - 算完再做一次有限性校验 —— 任何一步出非有限值都退回 0，保证输出永远合法。
 *
 * @param {number} lat 纬度（WGS84，度）。非法时按 0 处理。
 * @param {number} lon 经度（WGS84，度）。非法时按 0 处理。
 * @param {number} z 缩放层级。非法时按 DEFAULT_ZOOM 处理。
 * @returns {{z:number, x:number, y:number, fx:number, fy:number}} 瓦片号（x/y 已钳进
 *   [0, 2^z-1]）；`fx` / `fy` 是落点在该瓦片内的**归一化偏移**（[0,1)），渲染层靠它把
 *   落点对齐到视口正中 —— 同一份换算同时给出两块信息，避免渲染层再写一份然后漂移。
 */
export function lonLatToTile(lat, lon, z) {
  const rawLat = Number(lat);
  const rawLon = Number(lon);
  const rawZ = Number(z);
  const lv = Number.isFinite(rawZ) ? Math.round(rawZ) : DEFAULT_ZOOM;
  // 层级也要钳：负数 / 超大 z 会让 2 ** z 变成 0 或 Infinity，同样会污染 URL
  const zc = Math.min(23, Math.max(0, lv));
  const n = 2 ** zc;

  const latIn = Number.isFinite(rawLat) ? Math.max(-85.0511, Math.min(85.0511, rawLat)) : 0;
  const lonIn = Number.isFinite(rawLon) ? rawLon : 0;
  const latRad = (latIn * Math.PI) / 180;
  // 先算浮点列/行号：整数部分就是瓦片号，小数部分就是瓦片内偏移
  const fx0 = ((lonIn + 180) / 360) * n;
  const fy0 = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(fx0);
  const y = Math.floor(fy0);

  return {
    z: zc,
    x: Number.isFinite(x) ? Math.min(n - 1, Math.max(0, x)) : 0,
    y: Number.isFinite(y) ? Math.min(n - 1, Math.max(0, y)) : 0,
    fx: Number.isFinite(fx0) ? fx0 - Math.floor(fx0) : 0.5,
    fy: Number.isFinite(fy0) ? fy0 - Math.floor(fy0) : 0.5,
  };
}

/**
 * 生成自检用的瓦片取样坐标：同一缩放层级下 3 个彼此远离的位置，用于识破「假成功源」。
 *
 * 换算与渲染层共用 `lonLatToTile()`（见该函数注释），这里只负责挑位置。
 *
 * @param {{lat:number, lon:number}} [coord] 参考坐标（默认北京天安门）。
 * @returns {Array<{z:number, x:number, y:number}>} 3 个瓦片坐标。
 */
export function sampleTiles(coord) {
  const rawLat = Number(coord && coord.lat);
  const rawLon = Number(coord && coord.lon);
  // 坐标缺失/非法时回落到默认地点（北京天安门）
  const lat = Number.isFinite(rawLat) ? Math.max(-85.0511, Math.min(85.0511, rawLat)) : 39.9087;
  const lon = Number.isFinite(rawLon) ? rawLon : 116.3975;

  const centers = [
    { lat, lon },
    { lat: lat + 0.15, lon: lon + 0.15 },
    { lat: lat - 0.15, lon: lon - 0.15 },
  ];

  return centers.map((c) => {
    const tl = lonLatToTile(c.lat, c.lon, DEFAULT_ZOOM);
    // 自检只认瓦片号；fx/fy 是渲染层对齐落点用的，不外带（保持本函数输出形状不变）
    return { z: tl.z, x: tl.x, y: tl.y };
  });
}
