/**
 * 请求内核（HTTP）
 *
 * 职责：全应用**唯一**的网络出口。所有 fetch 必须经此模块，内置：
 *   1) 全局串行队列（并发恒为 1）——避免多源抢带宽，真机弱网下更稳；
 *   2) AbortController 超时中断（源只声明 timeoutMs，不自己 fetch）；
 *   3) 固定重试（仅在 error.retriable === true 时发生，且重试前不额外退避）；
 *   4) 缓存三态短路（fresh 命中不发请求）；
 *   5) 离线短路（navigator.onLine === false 且非 force 时直接返回 OFFLINE，不入队）；
 *   6) 统一 SourceResult / SourceError 形状，禁止裸抛 Error 穿越模块边界。
 *
 * 分层：core 层不允许 import data 层，因此源注册表通过 setSourceResolver() 注入
 * （由 data/sources.js 在模块加载时自行注册），保证依赖方向单向。
 */

import { getWithState, set } from './cache.js';
import { log } from './store.js';
import { t } from '../i18n/zh.js';

/* ------------------------------------------------------------------ */
/* 串行队列                                                             */
/* ------------------------------------------------------------------ */

/** @type {Promise<unknown>} 队列尾指针。 */
let _chain = Promise.resolve();
/** @type {number} 队列中（含正在执行）的任务数。 */
let _pending = 0;

/**
 * 入队执行（全局并发 1）。
 *
 * @template T
 * @param {() => Promise<T>|T} fn 任务函数。
 * @param {{name?:string}} [opts] 任务名（仅用于调试日志）。
 * @returns {Promise<T>} 任务结果（异常原样向上抛）。
 */
export function enqueue(fn, opts = {}) {
  const name = (opts && opts.name) || 'task';
  _pending += 1;
  log(`enqueue:${name}`, 'pending=' + _pending);

  const task = _chain.then(() => fn());
  // 队列本身不因单个任务失败而断裂
  _chain = task.then(
    () => undefined,
    () => undefined
  );

  return task.then(
    (value) => {
      _pending -= 1;
      return value;
    },
    (err) => {
      _pending -= 1;
      throw err;
    }
  );
}

/** @returns {number} 队列中（含执行中）的任务数。 */
export function queueLength() {
  return _pending;
}

/**
 * 重置队列（自检页开始新一轮取样前调用）。
 *
 * @returns {void}
 */
export function resetQueue() {
  _chain = Promise.resolve();
  _pending = 0;
}

/* ------------------------------------------------------------------ */
/* 源注册表注入                                                         */
/* ------------------------------------------------------------------ */

/** @type {null|((id:string)=>Object|null)} 源解析器。 */
let _resolver = null;

/**
 * 注入源解析器（由 data/sources.js 调用）。
 *
 * @param {(id:string)=>Object|null} fn 解析器。
 * @returns {void}
 */
export function setSourceResolver(fn) {
  _resolver = typeof fn === 'function' ? fn : null;
}

/** @returns {null|((id:string)=>Object|null)} 当前解析器。 */
export function getSourceResolver() {
  return _resolver;
}

/* ------------------------------------------------------------------ */
/* 错误与结果构造                                                       */
/* ------------------------------------------------------------------ */

/**
 * 构造统一 SourceError。
 *
 * @param {'OFFLINE'|'TIMEOUT'|'HTTP'|'NETWORK'|'PARSE'|'ABORT'|'EMPTY'|'UNSUPPORTED'} code 错误码。
 * @param {string} sourceId 源 id。
 * @param {{httpStatus?:number|null, params?:Object}} [extra] 附加信息。
 * @returns {{code:string, message:string, httpStatus:number|null, sourceId:string, retriable:boolean}} SourceError。
 */
export function makeError(code, sourceId, extra = {}) {
  const httpStatus = extra.httpStatus === undefined ? null : extra.httpStatus;
  const params = extra.params || {};
  // 可重试：超时 / 网络 / 5xx / 429；其余一律不可重试
  let retriable = false;
  if (code === 'TIMEOUT' || code === 'NETWORK') retriable = true;
  if (code === 'HTTP' && typeof httpStatus === 'number' && (httpStatus >= 500 || httpStatus === 429)) {
    retriable = true;
  }
  return {
    code,
    message: t(`error.${code}`, { ms: params.timeoutMs, status: httpStatus }),
    httpStatus,
    sourceId,
    retriable,
  };
}

/**
 * 构造统一 SourceResult。
 *
 * 显式携带 `stale` 字段的原因：`ok === false` 时 `data` 可能是**陈旧兜底值**（上游失败但有旧缓存），
 * 调用方不能只看 `ok` 就把 `data` 当成功数据用。判定规则统一为 `meta.cacheState === 'stale'`。
 *
 * @param {boolean} ok 是否成功。
 * @param {string} sourceId 源 id。
 * @param {*} data 数据（失败时可能是陈旧兜底值）。
 * @param {Object|null} error SourceError。
 * @param {Object} meta ResultMeta。
 * @returns {{ok:boolean, sourceId:string, data:*, error:Object|null, meta:Object, stale:boolean}} SourceResult。
 */
function _result(ok, sourceId, data, error, meta) {
  return {
    ok: !!ok,
    sourceId,
    data: data === undefined ? null : data,
    error: error || null,
    meta,
    stale: meta.cacheState === 'stale',
  };
}

/**
 * 构造统一 ResultMeta。
 *
 * @returns {{attempts:number, latencyMs:number, queuedMs:number, startedAt:number, finishedAt:number,
 *            fromCache:boolean, cacheState:'fresh'|'stale'|'miss'|'n/a', staleAgeMs:number,
 *            requestUrl:string, httpStatus:number|null, bytes:number|null}} ResultMeta。
 */
function _blankMeta() {
  const now = Date.now();
  return {
    attempts: 0,
    latencyMs: 0,
    queuedMs: 0,
    startedAt: now,
    finishedAt: now,
    fromCache: false,
    cacheState: 'miss',
    staleAgeMs: 0,
    requestUrl: '',
    httpStatus: null,
    bytes: null,
  };
}

/**
 * 取 navigator.onLine（非浏览器环境视为在线）。
 *
 * @returns {boolean} 是否在线。
 */
export function isOnline() {
  if (typeof navigator === 'undefined' || navigator === null) return true;
  return navigator.onLine !== false;
}

/**
 * 拼接最终 URL（params 为空或 url 已带 '?' 时按既定规则处理）。
 *
 * @param {{url:string, params?:Object<string,string|number>}} req RequestSpec。
 * @returns {string} 最终 URL。
 */
export function buildUrl(req) {
  const url = String((req && req.url) || '');
  const params = (req && req.params) || null;
  if (!params) return url;
  const keys = Object.keys(params);
  if (keys.length === 0) return url;
  const qs = keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
  return url.indexOf('?') === -1 ? `${url}?${qs}` : `${url}&${qs}`;
}

/**
 * 估算文本字节数（用于 meta.bytes，容忍无 Blob 环境）。
 *
 * @param {string} text 文本。
 * @returns {number} 字节数。
 */
function _textBytes(text) {
  if (typeof Blob !== 'undefined') {
    try {
      return new Blob([text]).size;
    } catch (err) {
      /* 退化到字符数 */
    }
  }
  return text.length;
}

/**
 * 取响应 Content-Type（容忍 mock）。
 *
 * @param {Object} res 响应对象。
 * @returns {string|null} MIME 或 null。
 */
function _contentType(res) {
  try {
    if (res && res.headers && typeof res.headers.get === 'function') {
      return res.headers.get('content-type') || null;
    }
  } catch (err) {
    /* ignore */
  }
  return null;
}

/**
 * 单次尝试（不含重试与排队）。
 *
 * @param {string} url 最终 URL。
 * @param {number} timeoutMs 超时毫秒。
 * @param {'json'|'bytes'} responseType 响应类型。
 * @returns {Promise<{ok:boolean, json?:*, data?:ArrayBuffer, latencyMs:number,
 *            httpStatus:number|null, bytes:number|null, contentType:string|null, error?:Object}>} 尝试结果。
 */
async function _attempt(url, timeoutMs, responseType) {
  const t0 = Date.now();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  let abortedByTimeout = false;

  if (controller) {
    timer = setTimeout(() => {
      abortedByTimeout = true;
      try {
        controller.abort();
      } catch (err) {
        /* ignore */
      }
    }, timeoutMs);
  }

  try {
    const fetchFn = typeof globalThis !== 'undefined' ? globalThis.fetch : undefined;
    if (typeof fetchFn !== 'function') {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        httpStatus: null,
        bytes: null,
        contentType: null,
        error: makeError('NETWORK', 'raw'),
      };
    }

    const init = {
      method: 'GET',
      headers: { Accept: responseType === 'bytes' ? 'image/*,*/*' : 'application/json' },
      credentials: 'omit', // 不携带任何凭据，避免向数据源泄漏身份
      cache: 'no-store',
    };
    if (controller) init.signal = controller.signal;

    const res = await fetchFn(url, init);
    const status = typeof res.status === 'number' ? res.status : 0;

    if (status < 200 || status >= 300) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        httpStatus: status,
        bytes: null,
        contentType: _contentType(res),
        error: makeError('HTTP', 'raw', { httpStatus: status }),
      };
    }

    if (responseType === 'bytes') {
      const buf = await res.arrayBuffer();
      return {
        ok: true,
        data: buf,
        latencyMs: Date.now() - t0,
        httpStatus: status,
        bytes: buf && typeof buf.byteLength === 'number' ? buf.byteLength : null,
        contentType: _contentType(res),
      };
    }

    const text = await res.text();
    if (!text || text.trim() === '') {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        httpStatus: status,
        bytes: 0,
        contentType: _contentType(res),
        error: makeError('EMPTY', 'raw', { httpStatus: status }),
      };
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - t0,
        httpStatus: status,
        bytes: _textBytes(text),
        contentType: _contentType(res),
        error: makeError('PARSE', 'raw', { httpStatus: status }),
      };
    }
    return {
      ok: true,
      json,
      latencyMs: Date.now() - t0,
      httpStatus: status,
      bytes: _textBytes(text),
      contentType: _contentType(res),
    };
  } catch (err) {
    const name = err && err.name ? err.name : '';
    const code = abortedByTimeout || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      httpStatus: null,
      bytes: null,
      contentType: null,
      error: makeError(code, 'raw', { params: { timeoutMs } }),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 执行「尝试 + 重试」循环（不含缓存与离线判定）。
 *
 * @param {string} url 最终 URL。
 * @param {number} timeoutMs 单次超时。
 * @param {number} retry 重试次数（0 = 不重试）。
 * @param {'json'|'bytes'} responseType 响应类型。
 * @param {string} sourceId 源 id（用于错误信息）。
 * @returns {Promise<{ok:boolean, json?:*, data?:ArrayBuffer, attempts:number, latencyMs:number,
 *            httpStatus:number|null, bytes:number|null, contentType:string|null, error?:Object}>} 结果。
 */
async function _tryWithRetry(url, timeoutMs, retry, responseType, sourceId) {
  const maxAttempts = (Number.isFinite(Number(retry)) ? Number(retry) : 0) + 1;
  let attempts = 0;
  let last = null;

  for (let i = 0; i < maxAttempts; i += 1) {
    attempts += 1;
    last = await _attempt(url, timeoutMs, responseType);
    if (last.ok) break;
    // 覆写 error.sourceId（_attempt 阶段尚不知具体源）
    last.error.sourceId = sourceId;
    if (!last.error.retriable) break;
    log('retry', sourceId, 'attempt=' + attempts, last.error.code);
  }

  if (last && last.error) last.error.sourceId = sourceId;
  return { ...last, attempts };
}

/* ------------------------------------------------------------------ */
/* 对外主入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * 按源 id 发起请求（走缓存三态 + 离线短路 + 串行队列 + 重试 + 解析）。
 *
 * @param {string} sourceId 源 id。
 * @param {Object} ctx 上下文（至少含 lat/lon；geocode 需 keyword）。
 * @param {{force?:boolean}} [opts] force=true 跳过缓存与离线短路（仅自检页使用）。
 * @returns {Promise<{ok:boolean, sourceId:string, data:*, error:Object|null, meta:Object, stale:boolean}>} SourceResult。
 */
export async function request(sourceId, ctx = {}, opts = {}) {
  const spec = _resolver ? _resolver(sourceId) : null;
  const force = !!(opts && opts.force);

  if (!spec) {
    const meta = _blankMeta();
    meta.cacheState = 'n/a';
    return _result(false, sourceId, null, makeError('UNSUPPORTED', sourceId), meta);
  }

  const cacheable = !!spec.cacheable;
  const key = spec.cacheKey(ctx);
  const reqSpec = spec.build(ctx);
  const url = buildUrl(reqSpec);
  const responseType = reqSpec.responseType || 'json';

  const meta = _blankMeta();
  meta.requestUrl = url;
  if (!cacheable) meta.cacheState = 'n/a';

  // 1) 离线短路：不进队列、不发请求
  if (!force && !isOnline()) {
    const cached = cacheable ? getWithState(key) : { state: 'n/a', value: null, ageMs: 0 };
    meta.cacheState = cacheable ? cached.state : 'n/a';
    meta.staleAgeMs = cached.state === 'stale' ? cached.ageMs : 0;
    meta.finishedAt = Date.now();
    log('offline-shortcircuit', sourceId, cached.state);
    return _result(false, sourceId, null, makeError('OFFLINE', sourceId), meta);
  }

  // 2) fresh 缓存命中：不发请求
  if (!force && cacheable) {
    const cached = getWithState(key);
    if (cached.state === 'fresh') {
      meta.fromCache = true;
      meta.cacheState = 'fresh';
      meta.attempts = 0;
      meta.latencyMs = 0;
      meta.finishedAt = Date.now();
      log('cache-fresh', sourceId);
      return _result(true, sourceId, cached.value, null, meta);
    }
  }

  // 3) 串行队列内执行
  const enqueuedAt = Date.now();
  return enqueue(async () => {
    const startedAt = Date.now();
    meta.queuedMs = startedAt - enqueuedAt;
    meta.startedAt = startedAt;

    const res = await _tryWithRetry(url, spec.timeoutMs, spec.retry, responseType, sourceId);
    meta.attempts = res.attempts;
    meta.latencyMs = res.latencyMs || 0;
    meta.httpStatus = res.httpStatus === undefined ? null : res.httpStatus;
    meta.bytes = res.bytes === undefined ? null : res.bytes;
    meta.finishedAt = Date.now();

    if (res.ok) {
      let parsed = null;
      try {
        parsed = spec.parse(res.json !== undefined ? res.json : res.data, ctx);
      } catch (err) {
        const error = makeError('PARSE', sourceId, { httpStatus: meta.httpStatus });
        meta.cacheState = cacheable ? 'miss' : 'n/a';
        return _result(false, sourceId, null, error, meta);
      }
      if (cacheable) {
        set(key, parsed, spec.ttlMs);
      }
      meta.cacheState = cacheable ? 'miss' : 'n/a';
      return _result(true, sourceId, parsed, null, meta);
    }

    // 4) 失败：有陈旧值就带出去（绝不显示空白）
    let staleValue = null;
    if (cacheable) {
      const cached = getWithState(key);
      if (cached.state === 'stale' && cached.value !== null && cached.value !== undefined) {
        staleValue = cached.value;
        meta.cacheState = 'stale';
        meta.staleAgeMs = cached.ageMs;
      } else {
        meta.cacheState = 'miss';
      }
    }
    return _result(false, sourceId, staleValue, res.error, meta);
  }, { name: sourceId });
}

/**
 * 原始请求（自检页 / 瓦片探测专用）：不走缓存、不做源解析，但仍走全局串行队列。
 *
 * @param {{url:string, params?:Object, responseType?:'json'|'bytes', sourceId?:string}|string} spec RequestSpec 或裸 URL。
 * @param {{timeoutMs?:number, retry?:number, responseType?:'json'|'bytes'}} [opts] 参数。
 * @returns {Promise<{ok:boolean, sourceId:string, data:*, error:Object|null, meta:Object, stale:boolean}>} SourceResult。
 */
export async function requestRaw(spec, opts = {}) {
  const isString = typeof spec === 'string';
  const url = isString ? spec : buildUrl(spec);
  const responseType = (opts && opts.responseType) || (!isString && spec.responseType) || 'json';
  const timeoutMs = Number(opts && opts.timeoutMs) || 6000;
  const retry = Number.isFinite(Number(opts && opts.retry)) ? Number(opts.retry) : 0;
  const sourceId = (!isString && spec && spec.sourceId) || 'raw';

  const meta = _blankMeta();
  meta.requestUrl = url;
  meta.cacheState = 'n/a';

  const enqueuedAt = Date.now();
  return enqueue(async () => {
    const startedAt = Date.now();
    meta.queuedMs = startedAt - enqueuedAt;
    meta.startedAt = startedAt;

    const res = await _tryWithRetry(url, timeoutMs, retry, responseType, sourceId);
    meta.attempts = res.attempts;
    meta.latencyMs = res.latencyMs || 0;
    meta.httpStatus = res.httpStatus === undefined ? null : res.httpStatus;
    meta.bytes = res.bytes === undefined ? null : res.bytes;
    meta.finishedAt = Date.now();

    if (res.ok) {
      return _result(true, sourceId, res.json !== undefined ? res.json : res.data, null, meta);
    }
    return _result(false, sourceId, null, res.error, meta);
  }, { name: sourceId });
}
