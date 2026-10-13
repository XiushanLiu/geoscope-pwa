/**
 * 缓存层（localStorage 封装）
 *
 * 职责：统一读写本机缓存，提供 TTL 与 fresh / stale / miss 三态判定，并作为降级底座 ——
 * 只要存在陈旧数据就绝不显示空白。全应用**唯一**允许直接触碰 localStorage 的模块。
 *
 * 约定：
 *   - 命名空间固定 'gs:v1:'，键格式 'gs:v1:<sourceId>:<参数>'；坐标一律 toFixed(4)，关键词 encodeURIComponent；
 *   - 值序列化为 { v, t, ttl, stale }，其中 t = storedAt（ms epoch）；
 *   - 配额超限先淘汰最旧条目再重试一次，仍失败返回 false 且不抛异常；
 *   - Node / 非浏览器环境下降级为内存 Map（供 tools/smoke.mjs 无网冒烟使用）。
 */

/** 缓存键命名空间（版本号变更即整体失效）。 */
export const NS = 'gs:v1:';

/** 默认容量上限（字节，按 JSON 字符串长度估算）。 */
export const DEFAULT_MAX_BYTES = 4_500_000;

/** @type {Map<string, string>} 无 localStorage 时的内存兜底。 */
const _memory = new Map();

/** @type {boolean} 是否已确认使用内存兜底。 */
let _useMemory = !(typeof localStorage !== 'undefined' && localStorage !== null);

/**
 * 内存版存储适配器（接口与 Storage 对齐的最小子集）。
 */
const memoryStorage = {
  getItem: (k) => (_memory.has(k) ? _memory.get(k) : null),
  setItem: (k, v) => { _memory.set(k, String(v)); },
  removeItem: (k) => { _memory.delete(k); },
  keys: () => Array.from(_memory.keys()),
};

/**
 * 取当前可用存储。
 *
 * @returns {{getItem:Function, setItem:Function, removeItem:Function, keys:Function}} 存储适配器。
 */
function _store() {
  if (_useMemory) return memoryStorage;
  try {
    // 探测真实可用性（隐私模式 / 被禁用时会抛）
    const probeKey = `${NS}__probe__`;
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return {
      getItem: (k) => localStorage.getItem(k),
      setItem: (k, v) => localStorage.setItem(k, v),
      removeItem: (k) => localStorage.removeItem(k),
      keys: () => {
        const out = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  } catch (err) {
    _useMemory = true;
    return memoryStorage;
  }
}

/**
 * 构造缓存键。
 *
 * @param {string} sourceId 源 id（或 'store' 等伪源）。
 * @param {...(string|number)} parts 参数片段。
 * @returns {string} 'gs:v1:<sourceId>:<p1>:<p2>'。
 */
export function makeKey(sourceId, ...parts) {
  return `${NS}${sourceId}:${parts.join(':')}`;
}

/**
 * 读取条目（不做 TTL 判定）。
 *
 * @param {string} key 缓存键。
 * @returns {{value: *, storedAt: number, ttlMs: number}|null} 条目或 null。
 */
export function get(key) {
  const store = _store();
  const raw = store.getItem(key);
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      value: parsed.v,
      storedAt: Number(parsed.t) || 0,
      ttlMs: Number(parsed.ttl) || 0,
    };
  } catch (err) {
    // 坏数据直接丢弃，避免污染后续判定
    store.removeItem(key);
    return null;
  }
}

/**
 * 写入条目。
 *
 * @param {string} key 缓存键。
 * @param {*} value 任意可 JSON 序列化的值。
 * @param {number} ttlMs TTL 毫秒（0 = 不缓存语义，由调用方决定是否调用）。
 * @returns {boolean} 写入是否成功。
 */
export function set(key, value, ttlMs = 0) {
  const store = _store();
  const payload = JSON.stringify({ v: value, t: Date.now(), ttl: Number(ttlMs) || 0, stale: false });
  try {
    store.setItem(key, payload);
    return true;
  } catch (err) {
    // 配额满：淘汰最旧的一半后重试一次
    try {
      evictOldest(0.5);
      store.setItem(key, payload);
      return true;
    } catch (err2) {
      return false;
    }
  }
}

/**
 * 带三态判定读取。
 *
 * @param {string} key 缓存键。
 * @returns {{state:'fresh'|'stale'|'miss', value:*, ageMs:number, staleForMs:number}} 三态结果。
 */
export function getWithState(key) {
  const entry = get(key);
  if (entry === null) {
    return { state: 'miss', value: null, ageMs: 0, staleForMs: 0 };
  }
  const now = Date.now();
  const ageMs = Math.max(0, now - entry.storedAt);
  if (ageMs < entry.ttlMs) {
    return { state: 'fresh', value: entry.value, ageMs, staleForMs: 0 };
  }
  return { state: 'stale', value: entry.value, ageMs, staleForMs: ageMs - entry.ttlMs };
}

/**
 * 标记为陈旧：上游失败但存在旧数据时，保留值只改标记（ageMs 继续增长）。
 *
 * @param {string} key 缓存键。
 * @returns {void}
 */
export function markStale(key) {
  const entry = get(key);
  if (entry === null) return;
  const store = _store();
  try {
    store.setItem(key, JSON.stringify({ v: entry.value, t: entry.storedAt, ttl: entry.ttlMs, stale: true }));
  } catch (err) {
    /* 配额异常时静默：标记失败不影响主流程 */
  }
}

/**
 * 删除**单个**条目（精确匹配，不是前缀匹配）。
 *
 * ★为什么必须存在：删一条记录若用 `clearPrefix(key)` 代替，而另一个键恰好以它为前缀
 *   （行程 id 'abc' 与 'abcd' 就属于这种情况 —— 导入进来的 id 是别人生成的，撞前缀
 *   完全可能），结果就是**一次删除带走两条用户数据**，且没有任何提示。
 *   精确删除与前缀清理是两种语义，混用必然出事，所以各自有一个名字。
 *
 * @param {string} key 缓存键（精确）。
 * @returns {boolean} 是否真的删掉了（本来就不存在返回 false，不假称成功）。
 */
export function remove(key) {
  const store = _store();
  if (store.getItem(key) === null || store.getItem(key) === undefined) return false;
  store.removeItem(key);
  return true;
}

/**
 * 按前缀清理。
 *
 * @param {string} prefix 键前缀（通常传 NS 或 makeKey('weather')）。
 * @returns {number} 清除条数。
 */
export function clearPrefix(prefix) {
  const store = _store();
  let count = 0;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) {
      store.removeItem(k);
      count += 1;
    }
  }
  return count;
}

/**
 * 估算字符串占用字节数（UTF-8 近似：非 ASCII 按 3 字节计）。
 *
 * @param {string} s 字符串。
 * @returns {number} 估算字节数。
 */
export function byteSize(s) {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return n;
}

/**
 * 淘汰最旧条目。
 *
 * @param {number} [ratio=0.25] 淘汰比例（按条目数计）。
 * @returns {number} 实际淘汰条数。
 */
export function evictOldest(ratio = 0.25) {
  const store = _store();
  const items = [];
  for (const k of store.keys()) {
    if (!k.startsWith(NS)) continue;
    const raw = store.getItem(k);
    let t = 0;
    try {
      t = Number(JSON.parse(raw).t) || 0;
    } catch (err) {
      t = 0;
    }
    items.push({ k, t });
  }
  items.sort((a, b) => a.t - b.t);
  const drop = Math.max(1, Math.floor(items.length * ratio));
  let n = 0;
  for (let i = 0; i < drop && i < items.length; i += 1) {
    store.removeItem(items[i].k);
    n += 1;
  }
  return n;
}

/**
 * 容量回收：总字节超限时按 storedAt 升序淘汰，直到降到阈值以下。
 *
 * @param {number} [maxBytes=4500000] 容量上限（字节）。
 * @returns {number} 释放的条目数。
 */
export function prune(maxBytes = DEFAULT_MAX_BYTES) {
  const store = _store();
  let items = [];
  let total = 0;
  for (const k of store.keys()) {
    if (!k.startsWith(NS)) continue;
    const raw = store.getItem(k) || '';
    let t = 0;
    try {
      t = Number(JSON.parse(raw).t) || 0;
    } catch (err) {
      t = 0;
    }
    total += byteSize(raw);
    items.push({ k, t });
  }
  if (total <= maxBytes) return 0;
  items.sort((a, b) => a.t - b.t);
  let freed = 0;
  for (const item of items) {
    if (total <= maxBytes) break;
    const raw = store.getItem(item.k) || '';
    total -= byteSize(raw);
    store.removeItem(item.k);
    freed += 1;
  }
  return freed;
}

/**
 * 清空全部本应用缓存（设置项与快照一并清除，供「重置」使用）。
 *
 * @returns {number} 清除条数。
 */
export function clearAll() {
  return clearPrefix(NS);
}

/**
 * 测试用：切换为内存存储并清空（仅供 tools/smoke.mjs 使用）。
 *
 * @returns {void}
 */
export function __useMemory() {
  _memory.clear();
  _useMemory = true;
}
