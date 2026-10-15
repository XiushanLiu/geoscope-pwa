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
import { DEFAULT_PLACE_NAME } from './geo.js';

/**
 * **应用标识（文件格式用，不是品牌名）** —— 全称 'geoscope'。
 *
 * ★与品牌名 `APP_NAME`（i18n/index.js，现在是 'WayScope'）是**两回事，不许混用**：
 *   · APP_ID   —— 写进导出文件、参与导入校验（`data.app !== APP_ID` 直接拒绝）。
 *                 **品牌改名时绝不许改它**，改了用户已有的备份 / 行程文件全部导不进来。
 *   · APP_NAME —— 界面上给人看的品牌名，改名时随品牌一起改。
 *   · 文件命名（备份 `geoscope-backup-*`、CSV `geoscope-now-*`、自检
 *     `geoscope-selfcheck-*`）一律派生自 APP_ID，因此改名不影响文件名。
 *
 * ★为什么住在这里而不是 backup.js：backup.js 不在单文件产物的模块闭包里
 *   （build-standalone 的 ORDER 只收录 selfcheck 闭包），而 store.js **在**。
 *   自检页要拿这个常量时，从 store 取不会给产物引入新依赖。
 *   （backup.js 本来就 import store.js，store.js 不 import backup.js —— 无循环。）
 */
export const APP_ID = 'geoscope';

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
  defaultPlace: { lat: 39.9087, lon: 116.3975, name: DEFAULT_PLACE_NAME },
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
  /**
   * @type {'normal'|'large'|'xlarge'} 无障碍字号档位。
   *
   * 默认 'normal'：CSS 侧（styles/tokens.css）默认档就是「`<html>` 上没有 data-fs」这条
   * 路径（--fs-scale: 1）。默认值若写成 'large'/'xlarge'，会出现「store 说放大、
   * 页面首帧却是默认字号」的错位 —— 与上面 themeMode 必须默认 'system' 是同一条道理。
   *
   * ★它和 themeMode 一样**不进备份**（见 core/backup.js 的 exportBackup：prefs 只有
   * 5 个字段），理由是「这台机器屏幕多大、用户眼睛舒不舒服」是本机属性，不是可搬家的
   * 用户数据 —— 从一台开了特大的旧手机导入备份，不该把新手机的字号也顶到特大。
   */
  fontScale: 'normal',
  /**
   * @type {'zh'|'en'} 界面语言。
   *
   * 默认 'zh'（中文界面为主，用户拍板）。与 themeMode / fontScale **同形状、同处理**：
   * 白名单钳位、读侧也钳、且**不进备份**（见 core/backup.js 的 exportBackup：prefs 只有
   * 5 个字段）—— 语言是这台机器前一个人的属性，不是可搬家的用户数据。
   *
   * ★store 只存 **'zh' / 'en' 这两个标记**，一个中文串都不存：翻译表住在
   * src/i18n/，core 不许读它（core ← data ← ui ← html 单向依赖）。把「当前界面说哪国话」
   * 落到 i18n 的是 ui/locale.js 的 applyLocale()。
   */
  locale: 'zh',
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
 * ⚠️ `themeMode` 与 `fontScale` 的特殊处理（漏了这条就会把用户的主题 / 字号抹回去）：
 * 本函数整体重建 `_state`，而**备份里没有这两个字段**（它们都是这台机器的属性，不是
 * 用户数据，理由同 backup.js 里「debug 不从备份带入」那条）。若照其它字段一律读
 * `src.themeMode`，那么 `src` 里根本没有这个字段 → 一律回落 'system' → 导入一次备份
 * 就把用户手选的主题静默清掉了。字号同理：从一台开了「特大」的旧手机导入备份，不该把
 * 新手机的字号也顶到「特大」。所以这两个字段都走「有明确值就用它，否则保持当前值」。
 *
 * @param {Object} next 新状态（{ defaultPlace, unitSystem, networkType, debug, favorites,
 *                             themeMode?, fontScale? }）。
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
    // fontScale 与 themeMode 同理（同为本机属性、不进备份）：src 没带就保持当前值。
    fontScale: src.fontScale === 'large' || src.fontScale === 'xlarge' ? src.fontScale : _state.fontScale,
    // locale 与上面两个同理（本机属性、不进备份）：src 没带就保持当前值 ——
    // 从一台用英文界面的旧手机导入备份，不该把新手机的界面也顶成英文。
    locale: src.locale === 'en' ? 'en' : _state.locale,
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
 * 设置无障碍字号档位。
 *
 * 白名单钳位：只认 'large' / 'xlarge'，其它任何值（含 undefined / 拼错的字符串）一律
 * 回落 'normal' —— 宁可回到默认字号，也不把一个 UI 认不出来的值写进 <html data-fs>。
 * 与 setThemeMode() 同构：两者都是「写全站属性 + 白名单钳位」这一件事的两个实例。
 *
 * @param {'normal'|'large'|'xlarge'} scale 字号档位。
 * @returns {void}
 */
export function setFontScale(scale) {
  _load();
  _state.fontScale = scale === 'large' || scale === 'xlarge' ? scale : 'normal';
  _persist();
}

/**
 * @returns {'normal'|'large'|'xlarge'} 当前字号档位。
 *
 * 读侧同样钳位（不直接返回 _state.fontScale）：内存态可能来自一份被外力改坏的缓存，
 * 一旦出去一个 '超大' 这样的值，ui/theme.js 会把它当 'normal' 处理，于是界面显示
 * 「默认」而设置页显示「特大」—— 两个页面各说各话。在这里收口，全站只会看到三档之一。
 */
export function getFontScale() {
  _load();
  const v = _state.fontScale;
  return v === 'large' || v === 'xlarge' ? v : 'normal';
}

/**
 * 设置界面语言。
 *
 * 白名单钳位：只认 'en'，其它任何值（含 undefined / 拼错的字符串）一律回落 'zh'
 * —— 与 setThemeMode() / setFontScale() 同构，三者都是「写一个全站属性 + 白名单钳位」。
 *
 * ★本函数只落**标记**，不碰文案：真正切语言的是 ui/locale.js 的 applyLocale()
 * （它会拿这里的值去调 i18n 的 setLocale）。这样 store（core 层）不需要知道
 * src/i18n/ 的存在，i18n 也不需要 import store，两边都不破坏单向依赖。
 *
 * @param {'zh'|'en'} locale 语言标记。
 * @returns {void}
 */
export function setLocale(locale) {
  _load();
  _state.locale = locale === 'en' ? 'en' : 'zh';
  _persist();
}

/**
 * @returns {'zh'|'en'} 当前界面语言标记。
 *
 * 读侧同样钳位（不直接返回 _state.locale）：内存态可能来自一份被外力改坏的缓存，
 * 一旦出去一个 'jp' 这样的值，i18n 会整站返回原始 key（界面变成一串键名）。
 * 与 getFontScale() 同一条理由，在这里收口，全站只会看到两档之一。
 */
export function getLocale() {
  _load();
  const v = _state.locale;
  return v === 'en' ? 'en' : 'zh';
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
    console.log('[WayScope]', ...args);
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
