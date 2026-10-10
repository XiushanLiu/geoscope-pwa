/**
 * 源健康模型（横切）
 *
 * 职责：为每一路数据源维护一份内存态 SourceHealth —— 状态机、最近时延、最后成功时间、
 * 陈旧标记、自检取样样本，并聚合出「整体降级态」供此刻屏顶部横幅使用。
 * 此刻屏与自检页读同一份内存态，保证两页口径一致。
 *
 * 状态机：
 *   idle      未请求
 *   ok        新鲜成功
 *   stale     用旧数据（缓存过期仍上屏）
 *   degraded  非关键源失败，或关键源失败但有陈旧兜底
 *   failed    关键源彻底失败且无旧值
 *   offline   navigator.onLine === false
 *
 * 注意：本模块**不负责**记录健康，记录动作由调用方（ui/app.js、ui/selfcheck.js）
 * 在每次 request 返回后显式调用，以保持 core 层对 data 层的零依赖。
 */

import { SOURCE_LIST } from './sources.js';
import { isNoMapMode, mapMode, MAP_MODE } from './tiles.js';
import { isOnline } from '../core/http.js';

/**
 * 关键源集合：整体降级态判定中权重最高。
 *
 * **单一真相源**：从 sources.js 的 `critical` 字段推导，避免 health.js 里再写一份
 * `['weather','air']` 造成两处不一致（新增关键源时只改注册表即可）。
 *
 * @type {Object<string, boolean>}
 */
const CRITICAL = SOURCE_LIST.reduce((acc, spec) => {
  if (spec.critical) acc[spec.id] = true;
  return acc;
}, {});

/** @type {Map<string, Object>} sourceId → SourceHealth。 */
const _health = new Map();

/**
 * 生成空白健康记录。
 *
 * @param {Object} spec 源规格。
 * @returns {Object} SourceHealth。
 */
function _blank(spec) {
  return {
    sourceId: spec.id,
    label: spec.label,
    status: 'idle',
    latencyMs: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    attempts: 0,
    samples: [],
    isStale: false,
    staleAgeMs: 0,
    attribution: spec.attribution,
  };
}

/**
 * 初始化（幂等）：按 SOURCE_LIST 建槽位。
 *
 * @returns {void}
 */
function _ensure() {
  if (_health.size > 0) return;
  for (const spec of SOURCE_LIST) {
    _health.set(spec.id, _blank(spec));
  }
}

/**
 * 取指定源健康记录（不存在时返回 idle 占位，绝不抛异常）。
 *
 * @param {string} sourceId 源 id。
 * @returns {Object} SourceHealth。
 */
export function getHealth(sourceId) {
  _ensure();
  const h = _health.get(sourceId);
  if (h) return h;
  return {
    sourceId,
    label: sourceId,
    status: 'idle',
    latencyMs: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    attempts: 0,
    samples: [],
    isStale: false,
    staleAgeMs: 0,
    attribution: '',
  };
}

/**
 * 取全部健康记录（按 SOURCE_LIST 顺序）。
 *
 * @returns {Object[]} SourceHealth 数组。
 */
export function allHealth() {
  _ensure();
  return SOURCE_LIST.map((s) => _health.get(s.id)).filter(Boolean);
}

/**
 * 记录一次成功。
 *
 * @param {string} sourceId 源 id。
 * @param {Object} meta ResultMeta。
 * @returns {void}
 */
export function recordSuccess(sourceId, meta) {
  const h = getHealth(sourceId);
  const m = meta || {};
  const at = Number(m.finishedAt) || Date.now();
  h.attempts += 1;
  h.lastAttemptAt = at;
  h.lastSuccessAt = at;
  h.lastError = null;
  h.isStale = m.cacheState === 'stale';
  h.staleAgeMs = Number(m.staleAgeMs) || 0;
  h.status = h.isStale ? 'stale' : 'ok';
  if (!m.fromCache && Number.isFinite(Number(m.latencyMs))) {
    h.latencyMs = Number(m.latencyMs);
  }
}

/**
 * 记录一次失败。
 *
 * @param {string} sourceId 源 id。
 * @param {Object} meta ResultMeta。
 * @param {Object} error SourceError。
 * @returns {void}
 */
export function recordFailure(sourceId, meta, error) {
  const h = getHealth(sourceId);
  const m = meta || {};
  h.attempts += 1;
  h.lastAttemptAt = Number(m.finishedAt) || Date.now();
  h.lastError = error || null;
  h.isStale = m.cacheState === 'stale';
  h.staleAgeMs = Number(m.staleAgeMs) || 0;

  if (error && error.code === 'OFFLINE') {
    h.status = 'offline';
  } else if (h.isStale) {
    // 失败但有陈旧兜底：仍上屏，只标陈旧
    h.status = 'stale';
  } else if (CRITICAL[sourceId]) {
    h.status = 'failed';
  } else {
    h.status = 'degraded';
  }
}

/**
 * 便捷入口：按 SourceResult 记录（成功/失败分流）。
 *
 * @param {{ok:boolean, sourceId:string, error:Object|null, meta:Object}} result SourceResult。
 * @returns {void}
 */
export function recordResult(result) {
  if (!result) return;
  if (result.ok) recordSuccess(result.sourceId, result.meta);
  else recordFailure(result.sourceId, result.meta, result.error);
}

/**
 * 追加一条自检取样时延（仅自检页调用，避免日常请求污染样本）。
 *
 * @param {string} sourceId 源 id。
 * @param {number} ms 时延毫秒。
 * @returns {void}
 */
export function addSample(sourceId, ms) {
  const h = getHealth(sourceId);
  const v = Number(ms);
  if (Number.isFinite(v)) h.samples.push(v);
}

/**
 * 重置全部健康（自检页开始新一轮前调用）。
 *
 * @returns {void}
 */
export function resetHealth() {
  _health.clear();
  _ensure();
}

/**
 * 整体降级态（此刻屏顶部横幅用）。
 *
 * 判定顺序：offline > empty（关键源全失败且无缓存）> stale（任一关键源陈旧）>
 *          partial（非关键 API 源失败 **或底图半残 grid**）> no-map（仅瓦片失败）> live。
 *
 * @returns {'live'|'stale'|'partial'|'offline'|'no-map'|'empty'} 整体状态。
 */
export function overallMode() {
  if (!isOnline()) return 'offline';

  const items = allHealth();
  const requested = items.filter((h) => h.attempts > 0);
  const critical = items.filter((h) => CRITICAL[h.sourceId]);

  // empty：关键源全部彻底失败（无陈旧兜底）
  if (critical.length > 0 && critical.every((h) => h.status === 'failed') && requested.length > 0) {
    return 'empty';
  }
  // stale：任一源处于陈旧态
  if (requested.some((h) => h.status === 'stale')) return 'stale';
  // partial：非关键 API 源失败（瓦片单独走 no-map，不在此列）
  const apiNonCritical = requested.filter((h) => h.sourceId !== 'tile' && !CRITICAL[h.sourceId]);
  if (apiNonCritical.some((h) => h.status === 'failed' || h.status === 'degraded')) return 'partial';
  // grid（部分瓦片失败）：底图半残，但还没到「完全没有底图」。
  // 必须在这里接住 —— 否则 isNoMapMode() 为 false 会一路落到 'live'，
  // 出现「9 块坏 8 块，用户却看到『一切正常』」的静默降级。
  // 复用 'partial' 而不新增状态：横幅语义本就是「部分不可用」，
  // 新增一个枚举要连带改 i18n、CSS 变体与所有分支断言，收益不抵成本。
  if (mapMode() === MAP_MODE.GRID) return 'partial';
  if (isNoMapMode()) return 'no-map';
  return 'live';
}

/**
 * 是否处于「无地图纯坐标模式」（转发 tiles 模块状态，保证单一状态源）。
 *
 * @returns {boolean} true = 无地图。
 */
export function isMapDisabled() {
  return isNoMapMode();
}

/**
 * 关键源 id 列表。
 *
 * @returns {string[]} 关键源 id。
 */
export function criticalIds() {
  return Object.keys(CRITICAL);
}
