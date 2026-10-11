/**
 * 本机状态（Store）
 *
 * 职责：保存本机偏好与最近状态 —— 默认地点、单位制、最近一次快照、debug 开关、
 * 网络类型标记、收藏（阶段二启用，本阶段仅占位 schema）。所有持久化**必须**经 core/cache.js，
 * 本模块不直接触碰 localStorage。
 *
 * 设计：内存态 + 持久化双写；读优先内存，冷启动从缓存反序列化。
 * 日志：对外只暴露 log()，debug 关闭时完全静默，禁止 elsewhere 直写 console.log。
 */

import { get, set, makeKey } from './cache.js';

/** 持久化键（store 视作一个伪 sourceId）。 */
const KEY_PREFS = makeKey('store', 'prefs');
const KEY_SNAPSHOT = makeKey('store', 'snapshot');

/** store 条目 TTL：十年（等同长期有效；读用 get() 不做三态判定，故 TTL 无实际影响）。 */
const PREFS_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

/** 主题模式之一：跟随系统（等价于不设 data-theme，由 CSS 的 prefers-color-scheme 决定）。 */
const THEME_SYSTEM = 'system';

/** 默认状态。 */
const DEFAULT_STATE = {
  /** @type {{lat:number, lon:number, name:string}} 定位失败时的默认地点（北京天安门）。 */
  defaultPlace: { lat: 39.9087, lon: 116.3975, name: '北京 · 天安门' },
  /** @type {'metric'|'imperial'} 单位制（阶段一只有 metric 生效）。 */
  unitSystem: 'metric',
  /**
   * @type {'system'|'light'|'dark'} 主题模式。
   *
   * 默认必须是 'system'：CSS 侧（styles/tokens.css）「不设 data-theme」这条路径本就等于
   * 跟随系统偏好（prefers-color-scheme）。默认值若写成 'light' 或 'dark'，会出现
   * 「store 说 dark、CSS 实际浅色」的错位 —— 用户第一次进设置页，看到的选中项与眼中
   * 画面不一致。
   */
  themeMode: 'system',
  /** @type {'wifi'|'cellular'|'unknown'} 网络类型（手动点选，默认未知）。 */
  networkType: 'unknown',
  /** @type {boolean} 调试开关。 */
  debug: false,
  /** @type {Array<{lat:number, lon:number, name:string}>} 收藏（阶段二启用）。 */
  favorites: [],
};

/** @type {Object} 内存态。 */
let _state = { ...DEFAULT_STATE };

/** @type {boolean} 是否已从缓存载入。 */
let _loaded = false;

/**
 * 从缓存载入偏好（幂等）。
 *
 * @returns {void}
 */
function _load() {
  if (_loaded) return;
  _loaded = true;
  const entry = get(KEY_PREFS);
  if (entry && entry.value && typeof entry.value === 'object') {
    _state = { ...DEFAULT_STATE, ...entry.value };
    // 数组字段做一次防御性归一，避免坏数据导致渲染崩溃
    if (!Array.isArray(_state.favorites)) _state.favorites = [];
  }
  // URL 参数 ?debug=1 优先级最高
  try {
    const search = typeof location !== 'undefined' && location ? String(location.search || '') : '';
    if (search.indexOf('debug=1') !== -1) _state.debug = true;
  } catch (err) {
    /* 非浏览器环境忽略 */
  }
}

/**
 * 持久化偏好（失败静默）。
 *
 * @returns {void}
 */
function _persist() {
  set(KEY_PREFS, _state, PREFS_TTL_MS);
}

/**
 * 读取整份状态（副本）。
 *
 * @returns {Object} 状态副本。
 */
export function getState() {
  _load();
  return { ..._state, favorites: [..._state.favorites] };
}

/**
 * 归一地点对象（内部用）。
 *
 * 只认识五个字段里的 defaultPlace 形状；坐标必须是**有限数字**且在经纬度范围内，
 * 否则回落默认地点。为什么不做 Number() 宽容解析：`Number(null)` / `Number('')`
 * 都是 0，那会把「坏数据」静默变成「几内亚湾 0,0」这个真实存在的地点。
 * 名称长度不做截断 —— 截断规则归 core/backup.js 的 MAX_NAME_LEN 一处管。
 *
 * @param {*} p 任意值。
 * @returns {{lat:number, lon:number, name:string}} 归一后的地点。
 */
function _normPlace(p) {
  const d = DEFAULT_STATE.defaultPlace;
  if (!p || typeof p !== 'object') return { ...d };
  const lat = p.lat;
  const lon = p.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return { ...d };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ...d };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { ...d };
  return { lat, lon, name: String(p.name === null || p.name === undefined ? '' : p.name) };
}

/**
 * 整体替换状态（供 core/backup.js 导入备份使用）。
 *
 * 为什么需要它：导入备份如果逐字段 set，中途失败会留下「改了一半」的状态
 * （defaultPlace 已经换了、favorites 还是旧的）。调用方（backup.js）先把完整的
 * next state 算完并校验通过，再由本函数**一次性**写入内存 + 持久化，保证原子性。
 *
 * 本函数只做**形状归一**（store 自身不变量：绝不把坏地点 / 非数组收藏写进内存态），
 * 不做业务级「非法就整体拒绝」—— 那是 backup.js 的职责。两者是同一把尺子的两道防线：
 * backup.js 负责拒绝，本函数保证就算被绕过了，内存态也不会存进不可用的值。
 *
 * 不改变任何既有 API 的语义，也不删除任何既有导出。
 *
 * ⚠️ `themeMode` 的特殊处理（漏了这条就会把用户的主题抹回去）：本函数整体重建
 * `_state`，而**备份里没有 themeMode 字段**（主题是这台机器的属性，不是用户数据，
 * 理由同 backup.js 里「debug 不从备份带入」那条）。若照其它字段一律读 `src.themeMode`，
 * 那么 `src` 里根本没有这个字段 → 一律回落 'system' → 导入一次备份就把用户手选的主题
 * 静默清掉了。所以这里也走 「有明确值就用它，否则保持当前值」。
 *
 * @param {Object} next 新状态（{ defaultPlace, unitSystem, networkType, debug, favorites, themeMode? }）。
 * @returns {Object} 实际落地的状态副本（与 getState() 同形状）。
 */
export function replaceState(next) {
  _load();
  const src = next && typeof next === 'object' ? next : {};
  _state = {
    defaultPlace: _normPlace(src.defaultPlace),
    unitSystem: src.unitSystem === 'imperial' ? 'imperial' : DEFAULT_STATE.unitSystem,
    networkType: src.networkType === 'wifi' || src.networkType === 'cellular' ? src.networkType : DEFAULT_STATE.networkType,
    debug: !!src.debug,
    // themeMode 不在备份里（见本函数 JSDoc）：src 没带就保持当前值，不许回落默认。
    themeMode: src.themeMode === 'light' || src.themeMode === 'dark' ? src.themeMode : _state.themeMode,
    favorites: (Array.isArray(src.favorites) ? src.favorites : [])
      .filter((f) => f && typeof f === 'object' && typeof f.lat === 'number' && Number.isFinite(f.lat) && typeof f.lon === 'number' && Number.isFinite(f.lon))
      .map((f) => ({ lat: f.lat, lon: f.lon, name: String(f.name === null || f.name === undefined ? '' : f.name) })),
  };
  _persist();
  return getState();
}

/**
 * 设置默认地点。
 *
 * @param {{lat:number, lon:number, name:string}} place 地点对象。
 * @returns {void}
 */
export function setDefaultPlace(place) {
  _load();
  _state.defaultPlace = {
    lat: Number(place.lat),
    lon: Number(place.lon),
    name: String(place.name || ''),
  };
  _persist();
}

/**
 * 取默认地点（含 source 标记，便于上游直接当 coord 用）。
 *
 * @returns {{lat:number, lon:number, name:string, source:'default'}} 默认地点。
 */
export function getDefaultPlace() {
  _load();
  const p = _state.defaultPlace;
  return { lat: p.lat, lon: p.lon, name: p.name, source: 'default' };
}

/**
 * 设置单位制。
 *
 * @param {'metric'|'imperial'} unit 单位制。
 * @returns {void}
 */
export function setUnitSystem(unit) {
  _load();
  _state.unitSystem = unit === 'imperial' ? 'imperial' : 'metric';
  _persist();
}

/** @returns {'metric'|'imperial'} 当前单位制。 */
export function getUnitSystem() {
  _load();
  return _state.unitSystem;
}

/**
 * 设置主题模式。
 *
 * 白名单钳位：只认 'light' / 'dark'，其它任何值（含 undefined / 拼错的字符串）一律
 * 回落 'system' —— 宁可跟随系统，也不把一个 UI 认不出来的值写进 <html data-theme>。
 *
 * @param {'system'|'light'|'dark'} mode 主题模式。
 * @returns {void}
 */
export function setThemeMode(mode) {
  _load();
  _state.themeMode = mode === 'light' || mode === 'dark' ? mode : THEME_SYSTEM;
  _persist();
}

/** @returns {'system'|'light'|'dark'} 当前主题模式。 */
export function getThemeMode() {
  _load();
  return _state.themeMode;
}

/**
 * 设置网络类型（自检页手动点选）。
 *
 * @param {'wifi'|'cellular'|'unknown'} t 网络类型。
 * @returns {void}
 */
export function setNetworkType(t) {
  _load();
  _state.networkType = t === 'wifi' || t === 'cellular' ? t : 'unknown';
  _persist();
}

/** @returns {'wifi'|'cellular'|'unknown'} 网络类型。 */
export function getNetworkType() {
  _load();
  return _state.networkType;
}

/**
 * 写入最近一次快照（离线冷启动的降级底座）。
 *
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function setLastSnapshot(snapshot) {
  _load();
  set(KEY_SNAPSHOT, snapshot, PREFS_TTL_MS);
}

/**
 * 读取最近一次快照。
 *
 * @returns {Object|null} NowSnapshot 或 null。
 */
export function getLastSnapshot() {
  const entry = get(KEY_SNAPSHOT);
  return entry && entry.value ? entry.value : null;
}

/** @returns {boolean} debug 是否开启。 */
export function isDebug() {
  _load();
  return !!_state.debug;
}

/**
 * 设置 debug 开关（同时写入缓存，等价于 localStorage['gs:v1:debug']='1' 的效果）。
 *
 * @param {boolean} on 是否开启。
 * @returns {void}
 */
export function setDebug(on) {
  _load();
  _state.debug = !!on;
  _persist();
}

/**
 * 调试日志：debug 关闭时完全静默（禁止 elsewhere 直写 console.log）。
 *
 * @param {...*} args 日志内容。
 * @returns {void}
 */
export function log(...args) {
  if (!isDebug()) return;
  try {
    console.log('[GeoScope]', ...args);
  } catch (err) {
    /* 环境无 console 时静默 */
  }
}

/** @returns {Array<{lat:number, lon:number, name:string}>} 收藏列表副本（阶段二启用）。 */
export function getFavorites() {
  _load();
  return [..._state.favorites];
}

/**
 * 追加收藏。
 *
 * @param {{lat:number, lon:number, name:string}} place 地点。
 * @returns {void}
 */
export function addFavorite(place) {
  _load();
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (_state.favorites.some((f) => f.lat === lat && f.lon === lon)) return;
  _state.favorites.push({ lat, lon, name: String(place.name || '') });
  _persist();
}

/**
 * 判断某个坐标是否已收藏（口径与 addFavorite 的去重一致：lat + lon 精确相等）。
 *
 * 为什么单独给一个：now.js 的收藏按钮每次渲染都要问一次「现在是不是已收藏」，
 * 让 UI 层自己 `getFavorites().some(...)` 等于把去重口径抄一份到界面层 ——
 * 哪天去重规则从「精确相等」改成「四舍五入到 4 位」，界面就会和 store 判出两种结论。
 *
 * @param {number} lat 纬度。
 * @param {number} lon 经度。
 * @returns {boolean} 是否已收藏。
 */
export function isFavorite(lat, lon) {
  _load();
  const la = Number(lat);
  const lo = Number(lon);
  return _state.favorites.some((f) => f.lat === la && f.lon === lo);
}

/**
 * 删除收藏（按 lat + lon 精确匹配，口径与 addFavorite 的去重一致）。
 *
 * 返回值必须区分「删掉了」和「本来就没有」：UI 要用它区分成功反馈与无效点击，
 * 若一律返回 undefined，取消收藏按钮在「条目已被另一处删掉」时会假报成功。
 *
 * 未命中时**不写盘**：无意义的 _persist() 会给 localStorage 增加一次写入，
 * 在配额紧张的 iOS 上是不必要的消耗。
 *
 * @param {number} lat 纬度。
 * @param {number} lon 经度。
 * @returns {boolean} 是否真的删掉了（false = 本来就没有这一条）。
 */
export function removeFavorite(lat, lon) {
  _load();
  const la = Number(lat);
  const lo = Number(lon);
  const before = _state.favorites.length;
  const next = _state.favorites.filter((f) => !(f.lat === la && f.lon === lo));
  if (next.length === before) return false;
  _state.favorites = next;
  _persist();
  return true;
}

/**
 * 重置本机状态（仅供自检/排障使用）。
 *
 * @returns {void}
 */
export function resetStore() {
  _loaded = true;
  _state = { ...DEFAULT_STATE, favorites: [] };
  _persist();
}
