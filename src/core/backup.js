/**
 * 备份与恢复（导出 / 导入 JSON）
 *
 * 职责：把本机偏好与收藏导出成一份可携带的 JSON，并把这份 JSON 还原回本机。
 *
 * 为什么必须有：产品边界第 2 条 —— 不做端到端加密同步，无账号、无云、无后端存储，
 * 收藏与足迹只留本机，**靠导出 / 导入 JSON 搬家**；iOS 上 PWA 存储可能被系统清理，
 * 导出备份是唯一退路（README「技术约束」）。本模块补的就是这条承诺过但缺失的能力。
 *
 * ⚠️ 明确**不导出**什么（两条硬排除，改本文件前先重读）：
 *   1) **不含瓦片缓存**：src/data/tiles.js:36 已登记，三个 Esri 服务的 `exportTilesAllowed`
 *      均为 **false**，离线批量导出瓦片违反其服务条款。
 *   2) **不含任何 API 响应原文**：天气 / 空气 / 地名 / 海拔 / 逆地理的原文一律不带，
 *      只带已解析的 NowSnapshot 对象（快照丢了可重建，不是关键数据）。
 *
 * 分层：本模块属 core 层，只依赖同层的 store 与 format。四层单向依赖是
 * core ← data ← ui，**严禁反向依赖 src/data/* 下的任何模块**。
 *
 * 失败语义：`inspectBackup()` / `applyBackup()` / `importBackup()` **皆永不抛异常**，
 * 一律返回 `{ ok:false, reasonKey, reasonParams? }`。其中 `inspectBackup()` 只读不写
 * （可反复预览），`applyBackup()` 才动本机状态 —— UI 侧若要「先预览确认再导入」就走
 * 这两步的组合。
 *
 * ★失败原因为什么是「键」而不是成品串：本模块在 core 层，**不许 import src/i18n/**
 * （core 是四层依赖的底下那层，反向依赖上层会让分层断言直接红）。可这些原因串是
 * 真的要上屏的（`settings.importFail` 把它塞进 {reason}），写死中文就等于英文界面里
 * 蹦出一句中文。故与 core/wmo.js 同一套做法：core 只产 `{ reasonKey, reasonParams }`，
 * 由 UI 层 tr() 成句。键缺失时 t() 会把键名原样显示 —— 漏翻当场可见，不会被静默兜住。
 */

import { getState, getLastSnapshot, replaceState, setLastSnapshot, isDebug } from './store.js';
// 文件名时间戳复用 core/format.js 的导出文件名时间戳（其导出名为 stamp：'YYYYMMDD-HHmm'，
// 本地时区）。这里用别名是为了让调用处读起来就是「导出文件名时间戳」，避免重复实现一份。
import { stamp as exportFilenameStamp } from './format.js';

/** 备份格式版本号（整数；未来格式变更时 +1，并在 importBackup 里加分支）。 */
export const SCHEMA_VERSION = 1;

/** 应用标识：用于拒绝别的应用的备份文件。 */
export const APP_ID = 'geoscope';

/** 收藏条数上限：超出一律截断（防止一个畸形备份把内存态撑爆）。 */
export const MAX_FAVORITES = 200;

/** 地点名长度上限（字符数）。 */
export const MAX_NAME_LEN = 60;

/** 允许的单位制。 */
const UNIT_SYSTEMS = ['metric', 'imperial'];

/** 允许的网络类型。 */
const NETWORK_TYPES = ['wifi', 'cellular', 'unknown'];

/**
 * 生成导出文件名。
 *
 * 时间戳直接复用 core/format.js 的 `stamp()`（'YYYYMMDD-HHmm'），不重复实现。
 * UI 层做 Blob 下载时用它取名，保证各处的备份文件名同一种格式。
 *
 * @param {number} [atMs=Date.now()] 导出时刻（ms epoch）。
 * @returns {string} 形如 'geoscope-backup-20250105-1423.json'。
 */
export function backupFilename(atMs = Date.now()) {
  return `${APP_ID}-backup-${exportFilenameStamp(atMs)}.json`;
}

/**
 * 判断一个值是不是「合法经纬度数字」。
 *
 * 为什么只认 number 类型、不做 Number() 宽容解析：宽容解析会把 `null` / `''` / `false`
 * 统统变成 0 —— 也就是「几内亚湾 0,0」这个真实存在但不该被静默接受的地点。
 * 用户会以为导入成功了，实际默认地点被改到了海上。宁可拒绝。
 *
 * @param {*} v 待判定的值。
 * @param {number} limit 绝对值上限（纬度 90 / 经度 180）。
 * @returns {boolean} 是否合法。
 */
function isFiniteCoord(v, limit) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  return v >= -limit && v <= limit;
}

/**
 * 归一地点名：强制转字符串并截断到 60 字符。
 *
 * @param {*} v 原始值。
 * @returns {string} 归一后的名称（'undefined' / 'null' 一律归为空串）。
 */
function normalizeName(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return s.length > MAX_NAME_LEN ? s.slice(0, MAX_NAME_LEN) : s;
}

/**
 * 校验并归一一个地点（defaultPlace 与 favorites 逐项共用同一把尺子）。
 *
 * @param {*} p 原始值。
 * @returns {{lat:number, lon:number, name:string}|null} 合法地点，或 null（非法）。
 */
function normalizePlace(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (!isFiniteCoord(p.lat, 90) || !isFiniteCoord(p.lon, 180)) return null;
  return { lat: p.lat, lon: p.lon, name: normalizeName(p.name) };
}

/**
 * 判断快照是否值得保留。
 *
 * 只做「是不是对象」这一层判断，不深入校验 NowSnapshot 的字段：快照是**可重建**的
 * 派生数据（联网一次就有了），一旦把字段级校验写死在这里，将来 NowSnapshot 演进
 * （新增字段）就会导致老备份的快照被误判为非法而丢弃。丢了不致命，所以宁宽勿严。
 *
 * @param {*} s 原始值。
 * @returns {boolean} 是否保留。
 */
function isUsableSnapshot(s) {
  return !!s && typeof s === 'object' && !Array.isArray(s);
}

/**
 * 导出备份。
 *
 * ⚠️ 隐私：导出内容含 `defaultPlace`（用户常去地点）与 `favorites`（收藏地点），
 * 属**敏感个人信息**。本函数**不联网、不上传**，只是把内存里的状态组装成普通对象，
 * 由调用方（UI 层）用 Blob 在本地触发下载 —— 全程不出设备。
 *
 * ⚠️ UI 层必须在导出前告知用户「这份文件含你的位置信息（常去地点与收藏）」，
 * 别让用户稀里糊涂地把它发给别人。
 *
 * 不含瓦片缓存（Esri exportTilesAllowed=false）、不含任何 API 响应原文。
 *
 * ⚠️ `themeMode` **不在这里导出**（prefs 保持 5 个字段，SCHEMA_VERSION 保持 1）：
 * 主题是「这台机器的属性」而不是「用户数据」—— 把一台偏好深色的 Mac 上的备份导到
 * 一台常开浅色的手机上，顺手把人家的主题改掉是没有道理的。这条与下面 `debug`
 * 不看齐的地方在于：debug 照实写进 prefs（便于排障时看清来源机器），导入时不生效；
 * themeMode 干脆不进来，避免 reader 误以为它是可搬家数据。
 *
 * @returns {{schema:number, app:string, exportedAt:string, prefs:Object, snapshot:Object|null}} 备份载荷。
 */
export function exportBackup() {
  const state = getState();
  return {
    schema: SCHEMA_VERSION,
    app: APP_ID,
    exportedAt: new Date().toISOString(),
    prefs: {
      defaultPlace: { ...state.defaultPlace },
      unitSystem: state.unitSystem,
      networkType: state.networkType,
      // debug 照实导出（它就是 getState() 的一部分，便于排障时看清来源机器的状态），
      // 但 importBackup 不会把它写回去 —— 见 importBackup 的 JSDoc。
      debug: !!state.debug,
      favorites: state.favorites.map((f) => ({ ...f })),
    },
    snapshot: getLastSnapshot(),
  };
}

/**
 * 【只校验、不写入】解析一份备份，产出可预览的「导入计划」。
 *
 * 存在理由：导入是**覆盖性**操作（本机 defaultPlace 与 favorites 会被整份替换），
 * 让用户选完文件就直接覆盖，等于把「误选一个月前的旧备份」做成不可逆事故。
 * 所以 UI 侧必须先拿到这份计划给人看一眼，用户点头才调 `applyBackup()` 落盘。
 *
 * 本函数**不触碰任何本机状态**（除读取当前 debug 值用于填计划），可以放心反复调用 ——
 * 同一个文件调两次，得到的计划完全一致。
 *
 * @param {string|Object} input JSON 字符串或已解析对象。
 * @returns {{ok:boolean, plan?:Object, reasonKey?:string, reasonParams?:Object}} 校验结果；plan 含写入所需的全部字段。
 */
export function inspectBackup(input) {
  /* ---------- 1. 解析 ---------- */
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (err) {
      return { ok: false, reasonKey: 'backup.badJson' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reasonKey: 'backup.notObject' };
  }

  /* ---------- 2. 格式版本 ---------- */
  if (!Number.isInteger(data.schema) || data.schema !== SCHEMA_VERSION) {
    return { ok: false, reasonKey: 'backup.badSchema', reasonParams: { schema: String(data.schema) } };
  }

  /* ---------- 3. 是不是地候的备份 ---------- */
  if (data.app !== APP_ID) {
    return { ok: false, reasonKey: 'backup.notGeoscope' };
  }

  /* ---------- 4. prefs 必须在 ---------- */
  const prefs = data.prefs;
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
    return { ok: false, reasonKey: 'backup.noPrefs' };
  }

  /* ---------- 5. defaultPlace：非法就整体拒绝 ---------- */
  const defaultPlace = normalizePlace(prefs.defaultPlace);
  if (defaultPlace === null) {
    return {
      ok: false,
      reasonKey: 'backup.badDefaultPlace',
    };
  }

  /* ---------- 6~8. 枚举值：非法回退默认值；debug 保持当前值 ---------- */
  const unitSystem = UNIT_SYSTEMS.indexOf(prefs.unitSystem) === -1 ? 'metric' : prefs.unitSystem;
  const networkType = NETWORK_TYPES.indexOf(prefs.networkType) === -1 ? 'unknown' : prefs.networkType;
  const debug = !!isDebug();

  /* ---------- 9. favorites：逐项校验，非法项跳过；去重；截断 ---------- */
  const rawFavorites = Array.isArray(prefs.favorites) ? prefs.favorites : [];
  const favorites = [];
  const seen = new Set();
  for (const item of rawFavorites) {
    const place = normalizePlace(item);
    if (place === null) continue; // 非法项跳过，不整体拒绝
    const key = `${place.lat},${place.lon}`;
    if (seen.has(key)) continue; // 按 lat+lon 去重
    seen.add(key);
    favorites.push(place);
    if (favorites.length >= MAX_FAVORITES) break; // 上限 200，超出截断
  }
  const favoritesDropped = rawFavorites.length - favorites.length;

  /* ---------- 10. snapshot：不合法就当 null ---------- */
  const snapshot = isUsableSnapshot(data.snapshot) ? data.snapshot : null;

  return {
    ok: true,
    plan: {
      defaultPlace: { ...defaultPlace },
      unitSystem,
      networkType,
      debug,
      favorites: favorites.map((f) => ({ ...f })),
      /** 因坐标非法 / 重复 / 超出 200 上限而未被导入的条数（UI 预览时据此提示）。 */
      favoritesDropped,
      snapshot,
      /** 备份本身的导出时刻（预览用；不是本机写入时刻）。 */
      exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    },
  };
}

/**
 * 【真正写入】把 `inspectBackup()` 产出的计划落到本机状态。
 *
 * 原子性：先把完整的 next state 算出来、全部校验通过，再**一次性**经
 * `store.replaceState()` 写入；中途任何一步失败都不落任何状态，本机状态保持原样。
 *
 * 为什么把「算」和「写」拆成两个函数：设置页要先把这份计划列给人看（导出时间、
 * 默认地点、收藏条数、会被丢弃的条数），人确认后才允许调用本函数。拆分前后
 * `importBackup()` 的对外行为完全一致 —— 它就是这两步的串接。
 *
 * ⚠️ plan 完整性：本函数是为「plan 由 `inspectBackup()` 产出」这条正常路径写的，
 * 但它是**导出符号**，可能被跨版本搬运或手工构造（同第 2 步注释的口径）。因此对
 * plan 的要求是**缺关键字段就整体拒绝**，而不是静默走默认值：
 *   - 缺 `favorites` 数组 → 拒绝。若照 `Array.isArray(...) ? ... : []` 宽容处理，
 *     结果是把用户的收藏**静默清空**并返回 ok —— 用户数据没了还以为导入成功了，
 *     这是本模块能造成的最坏后果，宁可拒绝。
 *   - `defaultPlace` 缺失/非法 → 原本就整体拒绝（坐标正确性，绝不静默拿默认值糊过去）。
 * 正常路径下这两项 `inspectBackup()` 必然给出，所以收紧不影响任何既有行为。
 *
 * @param {Object} plan `inspectBackup()` 返回的计划对象。
 * @returns {{ok:boolean, applied?:Object, reasonKey?:string, reasonParams?:Object}} 导入结果。
 */
export function applyBackup(plan) {
  const src = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : {};

  /* ---------- 1. defaultPlace：非法就整体拒绝 ---------- */
  const defaultPlace = normalizePlace(src.defaultPlace);
  if (defaultPlace === null) {
    return { ok: false, reasonKey: 'backup.planNoDefaultPlace' };
  }

  /* ---------- 2. 枚举值再钳一次（plan 可能被人手工构造 / 跨版本搬运） ---------- */
  const unitSystem = UNIT_SYSTEMS.indexOf(src.unitSystem) === -1 ? 'metric' : src.unitSystem;
  const networkType = NETWORK_TYPES.indexOf(src.networkType) === -1 ? 'unknown' : src.networkType;
  const debug = !!isDebug();

  /* ---------- 3. favorites：没有数组就整体拒绝（绝不静默清空收藏） ---------- */
  // 宽容成 `[]` 会得到一个 ok:true + 收藏被清空的写入 —— 用户数据没了还不知道。
  // plan 由 inspectBackup() 产出时必然带 favorites，缺了只可能是手工构造 / 跨版本搬运。
  if (!Array.isArray(src.favorites)) {
    return { ok: false, reasonKey: 'backup.planNoFavorites' };
  }
  const favorites = [];
  const seen = new Set();
  for (const item of src.favorites) {
    const place = normalizePlace(item);
    if (place === null) continue;
    const key = `${place.lat},${place.lon}`;
    if (seen.has(key)) continue;
    seen.add(key);
    favorites.push(place);
    if (favorites.length >= MAX_FAVORITES) break;
  }

  /* ---------- 4. snapshot：不合法就当 null ---------- */
  const snapshot = isUsableSnapshot(src.snapshot) ? src.snapshot : null;
  const favoritesDropped = Number.isInteger(src.favoritesDropped) && src.favoritesDropped > 0 ? src.favoritesDropped : 0;

  /* ---------- 一次性写入（原子） ---------- */
  try {
    replaceState({ defaultPlace, unitSystem, networkType, debug, favorites });
    // 快照整体覆盖：备份里没有快照时也要把旧的清掉，否则会残留「上一台机器」的天气数据，
    // 用户看到的是一份自己从没去过的地点的天气 —— 比没有更糟。
    setLastSnapshot(snapshot);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { ok: false, reasonKey: 'backup.writeFailed', reasonParams: { msg } };
  }

  return {
    ok: true,
    applied: {
      defaultPlace: { ...defaultPlace },
      unitSystem,
      networkType,
      debug,
      favorites: favorites.map((f) => ({ ...f })),
      /** 因坐标非法 / 重复 / 超出 200 上限而未被导入的条数（UI 可据此提示）。 */
      favoritesDropped,
      snapshot,
    },
  };
}

/**
 * 导入备份（校验 + 写入一步到位）。
 *
 * 入参既可以是 JSON 字符串，也可以是已解析的对象，两种形态行为完全一致。
 * **永不抛异常**：任何失败都返回 `{ ok:false, reasonKey, reasonParams? }`。
 *
 * ⚠️ 需要「先预览再写入」的 UI（设置页）请用 `inspectBackup()` → 给人看 → `applyBackup()`。
 * 本函数是这两步的严格串接，行为与拆分前一致，保留它为了不让既有调用方改造。
 *
 * ⚠️ `debug` **不从备份带入**，导入后保持当前值。理由：debug 是排障开关，从别处
 * 导入一个 `debug:true` 会让用户莫名其妙看到一堆日志（甚至以为应用坏了）。
 * 它是「这台机器的临时开关」，不是「用户数据」，不该跟着备份搬家。
 * `themeMode` 同理（根本不进备份，见 exportBackup 的 JSDoc），
 * 所以导入**不会**改主题 —— store.replaceState() 里也按这条口径处理。
 *
 * 宽容度是分层的：涉及位置正确性的（defaultPlace）**非法就整体拒绝**，绝不静默拿
 * 默认值糊过去 —— 那会让用户以为导入成功了；不涉及位置隐私的枚举值（unitSystem /
 * networkType）非法就回退默认值；可重建的派生数据（snapshot）不合法就当 null。
 *
 * @param {string|Object} input JSON 字符串或已解析对象。
 * @returns {{ok:boolean, applied?:Object, reasonKey?:string, reasonParams?:Object}} 导入结果。
 */
export function importBackup(input) {
  const inspected = inspectBackup(input);
  if (!inspected.ok) return inspected;
  return applyBackup(inspected.plan);
}
