/**
 * 行程的本机持久化
 *
 * 职责：行程索引 + 单条读写 + 删除 + 当前行程 + **触摸时间戳**。所有落盘一律经
 * core/cache.js（全应用唯一允许直接触碰 localStorage 的模块），本模块不直接写 Storage。
 *
 * ★两条存储纪律（改本文件前先读，它们决定了本模块为什么长这样）：
 *   1) **几何绝不落盘**：`overview=full` 单次的几何是**百 KB 量级**（具体数字、出处与口径
 *      见 `src/data/osrm.js` 文件头的「体积口径」一节，那里是全仓唯一出处）。写进
 *      localStorage 的后果是「几趟长行程吃光 4.5 MB 预算」，而 `cache.prune()` /
 *      `evictOldest()` 会在配额满时按 `storedAt` 淘汰**最旧条目** —— 行程是用户数据，
 *      被当成缓存淘汰是灾难。所以 `saveTrip()` 一律先过 `migrateTrip()`（内含
 *      `slimRoute()`）再写盘，几何在这个口子上就被拦下了。
 *      ★唯一例外是 `route.shape`：用户显式点了「缓存此行程的路线几何」才有的简化几何
 *      （实测 1.4 KB），它是**用户主动要的**，保留。
 *   2) **每次读都 touch**：`readTrip()` 会顺手把 `storedAt` 刷新成当下，让常用行程
 *      在配额吃紧时排在淘汰队列末尾（不是万能药，但比不做强 —— 真要根治得靠
 *      「设置页提供清理旧行程入口」+ 写入失败**看得见**）。
 *
 * 分层：core 层，只 import 同层的 cache / roadtrip / store。**不 import i18n** ——
 *   失败一律给 `{ reasonKey, reasonParams }`，由 UI 层 tr() 成人话。
 */

import { get, set, makeKey, remove } from './cache.js';
import { log } from './store.js';
import { migrateTrip, slimTrip, SCHEMA_VERSION } from './roadtrip.js';

/** 索引键：存 id 数组。 */
const KEY_INDEX = makeKey('trip', 'index');

/** 当前行程键。 */
const KEY_ACTIVE = makeKey('trip', 'active');

/** 条目 TTL：十年（读用 get() 不做三态判定，TTL 无实际影响，仅与 store 同形状）。 */
const TRIP_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

/**
 * 单条行程的键。
 *
 * @param {string} id 行程 id。
 * @returns {string} 缓存键。
 */
function keyOf(id) {
  return makeKey('trip', id);
}

/**
 * 读索引（id 数组）。
 *
 * @returns {string[]} id 数组（坏数据归一成空数组）。
 */
function _readIndex() {
  const entry = get(KEY_INDEX);
  if (entry === null || entry === undefined) return [];
  const v = entry.value;
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const id of v) {
    if (typeof id === 'string' && id !== '' && out.indexOf(id) === -1) out.push(id);
  }
  return out;
}

/**
 * 写索引。
 *
 * @param {string[]} ids id 数组。
 * @returns {boolean} 是否成功。
 */
function _writeIndex(ids) {
  return set(KEY_INDEX, ids, TRIP_TTL_MS);
}

/**
 * 列出全部行程，并**如实带回被跳过的那些**（按 updatedAt 倒序：最近改过的在最前）。
 *
 * ★为什么不把「迁移失败的条目」悄悄丢掉（改这里之前先读）：
 *   原实现是 `continue` + 一句 `log()`。而 `store.log()` 在 debug 关闭时**完全静默** ——
 *   于是一条坏掉的 / 来自更高版本的行程会从列表里**凭空消失**，用户看到的是「我的行程
 *   不见了」，而没有任何解释。这就是「登记了就静默」那一类腐烂：有个记录动作，但没人看。
 *   所以失败条目必须**跟着返回值一起出来**，让界面能说「1 条行程打不开，原因：…」。
 *
 * @returns {{trips:Array<Object>, skipped:Array<{id:string, reasonKey:string, reasonParams:Object|undefined}>}} 结果。
 */
export function listTripsWithIssues() {
  const ids = _readIndex();
  /** @type {Array<Object>} */
  const trips = [];
  /** @type {Array<{id:string, reasonKey:string, reasonParams:Object|undefined}>} */
  const skipped = [];
  for (const id of ids) {
    const entry = get(keyOf(id));
    if (entry === null || entry === undefined) continue;
    const m = migrateTrip(entry.value);
    if (!m.ok) {
      log('trip-skip', id, m.reasonKey || '');
      skipped.push({ id, reasonKey: m.reasonKey, reasonParams: m.reasonParams });
      continue;
    }
    trips.push(m.trip);
  }
  trips.sort((a, b) => b.updatedAt - a.updatedAt);
  return { trips, skipped };
}

/**
 * 列出全部行程（按 updatedAt 倒序）。
 *
 * ⚠️ **新代码一律不要用本函数，用 `listTripsWithIssues()`。**
 *
 * 为什么：本函数把 `skipped` 算出来又丢掉 —— 数据一条不少，但「有 N 条打不开、为什么」
 *   这个信息**在调用方这一层重新变回静默**。也就是说，静默点只是从 tripstore 内部挪到了
 *   调用方，并没有消失。所以「界面能如实说『1 条打不开』」这件事，**只有在调用方改用
 *   `listTripsWithIssues()` 时才成立**；走本函数的界面，用户看到的仍然是「我的行程
 *   少了」，零解释。
 *
 * 保留它只为一个理由：架构 §4.2 的类图里 `+listTrips() Trip[]` 是既定签名，
 *   已有调用方不该被破坏。**它不是推荐入口。**
 *
 * @returns {Array<Object>} 行程列表（打不开的那些不在此列，且本函数不告诉你有哪些）。
 */
export function listTrips() {
  return listTripsWithIssues().trips;
}

/**
 * 读一条行程（**顺带 touch**，刷新它的 storedAt）。
 *
 * @param {string} id 行程 id。
 * @returns {{ok:boolean, trip?:Object, reasonKey?:string, reasonParams?:Object}} 结果；
 *          不存在返回 `{ok:false, reasonKey:'trip.notFound'}`；
 *          来自更高版本返回 `{ok:false, reasonKey:'trip.newerSchema', reasonParams:{schema}}`。
 */
export function readTrip(id) {
  if (typeof id !== 'string' || id === '') return { ok: false, reasonKey: 'trip.notFound' };
  const entry = get(keyOf(id));
  if (entry === null || entry === undefined) return { ok: false, reasonKey: 'trip.notFound' };
  const m = migrateTrip(entry.value);
  if (!m.ok) return m;
  touch(id);
  return { ok: true, trip: m.trip };
}

/**
 * 保存一条行程（新建或覆盖同名 id）。
 *
 * ★两件事在这里被强制：① 先过 `migrateTrip()` —— schema 不是当前版本（含更高版本）
 *   一律拒绝，绝不把看不懂的数据写进去；② 写盘前过 `slimRoute()` —— 几何不落盘。
 * ★返回 false 表示**写入失败**，调用方必须提示用户，不许静默丢弃。
 *
 * @param {Object} trip 行程（可以带内存里的几何，会被自动压掉）。
 * @returns {boolean} 是否成功。
 */
export function saveTrip(trip) {
  const m = migrateTrip(trip);
  if (!m.ok) {
    log('trip-save-reject', m.reasonKey || '', String(trip && trip.id));
    return false;
  }
  const slim = slimTrip(m.trip);
  if (slim === null) return false;

  const now = Date.now();
  const payload = { ...slim, updatedAt: now };
  const ok = set(keyOf(payload.id), payload, TRIP_TTL_MS);
  if (!ok) return false;

  const ids = _readIndex();
  if (ids.indexOf(payload.id) === -1) {
    ids.push(payload.id);
    if (!_writeIndex(ids)) return false;
  }
  return true;
}

/**
 * 删除一条行程（同时从索引里摘掉；若它是当前行程，当前行程一并清空）。
 *
 * @param {string} id 行程 id。
 * @returns {boolean} 是否真的删掉了（本来就没有则返回 false，不假称成功）。
 */
export function deleteTrip(id) {
  if (typeof id !== 'string' || id === '') return false;
  // ★必须**精确**删除：用 clearPrefix(key) 会把「以本 id 为前缀」的另一条行程一并带走
  //   （导入进来的行程 id 是别的设备生成的，撞前缀完全可能）—— 那是静默的用户数据丢失。
  if (!remove(keyOf(id))) return false;

  const ids = _readIndex().filter((x) => x !== id);
  _writeIndex(ids);
  if (getActiveTripId() === id) clearActiveTrip();
  return true;
}

/**
 * 触摸：把条目带着当下的 storedAt 重写一遍。
 *
 * 用途：降低被 `cache.prune()` / `evictOldest()` 当成「最旧缓存」淘汰的概率。
 * 注意它是**尽力而为** —— 配额真满了照样会被淘汰，真正的防线是「别把大对象写进去」。
 *
 * @param {string} id 行程 id。
 * @returns {boolean} 是否成功。
 */
export function touch(id) {
  if (typeof id !== 'string' || id === '') return false;
  const key = keyOf(id);
  const entry = get(key);
  if (entry === null || entry === undefined) return false;
  return set(key, entry.value, TRIP_TTL_MS);
}

/**
 * 设置当前行程。
 *
 * @param {string} id 行程 id。
 * @returns {boolean} 是否成功（行程不存在则失败）。
 */
export function setActiveTrip(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (get(keyOf(id)) === null) return false;
  return set(KEY_ACTIVE, id, TRIP_TTL_MS);
}

/**
 * 取当前行程 id。
 *
 * @returns {string|null} id 或 null。
 */
export function getActiveTripId() {
  const entry = get(KEY_ACTIVE);
  if (entry === null || entry === undefined) return null;
  const v = entry.value;
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * 清空当前行程标记。
 *
 * @returns {boolean} 是否成功。
 */
export function clearActiveTrip() {
  remove(KEY_ACTIVE);
  return getActiveTripId() === null;
}

/**
 * 行程条数。
 *
 * @returns {number} 条数。
 */
export function tripCount() {
  return _readIndex().length;
}

/**
 * 清空全部行程（设置页「清理旧行程」入口用）。
 *
 * ⚠️ 这是**不可逆**的用户数据删除，UI 必须二次确认后再调。
 *
 * @returns {number} 清掉的条数。
 */
export function clearAllTrips() {
  const ids = _readIndex();
  for (const id of ids) remove(keyOf(id));
  remove(KEY_INDEX);
  remove(KEY_ACTIVE);
  return ids.length;
}

/** @returns {number} 当前行程 schema 版本（供 UI 展示与排障）。 */
export function schemaVersion() {
  return SCHEMA_VERSION;
}
