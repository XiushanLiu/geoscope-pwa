/**
 * QA 测试台（harness）
 *
 * 职责：为 `tests/*.test.mjs` 提供「可控的浏览器环境」—— 假 localStorage、假 navigator、
 * 可控 fetch（可模拟超时 / HTTP 状态 / 空响应 / 坏 JSON / 网络异常 / 字节响应），
 * 以及一个极简假 DOM（仅实现被测代码真正用到的那部分 API）。
 *
 * 设计原则：
 *   1) 零第三方依赖，只用 Node 内置能力；
 *   2) 所有全局必须在 `await import()` 被测模块**之前**安装（尤其 localStorage，
 *      因为 cache.js 在模块加载期就决定了走内存还是 localStorage）；
 *   3) 时钟可控：所有涉及 TTL / 陈旧的用例都通过 setNow() 精确打点，不依赖真实 sleep。
 *
 * 注意：本文件不是测试文件（不匹配 *.test.mjs），仅供其它测试文件 import。
 */

import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* 可控时钟                                                             */
/* ------------------------------------------------------------------ */

const REAL_NOW = Date.now;
let _now = REAL_NOW();

/** @returns {number} 当前虚拟时钟（ms epoch）。 */
export function now() {
  return _now;
}

/**
 * 设定虚拟时钟。
 *
 * @param {number} ms ms epoch。
 * @returns {void}
 */
export function setNow(ms) {
  _now = ms;
}

/**
 * 安装虚拟时钟（替换 Date.now）。
 *
 * @returns {() => void} 还原函数。
 */
export function installClock() {
  Date.now = () => _now;
  return () => {
    Date.now = REAL_NOW;
  };
}

/**
 * 虚拟时钟前进。
 *
 * @param {number} ms 毫秒。
 * @returns {void}
 */
export function advance(ms) {
  _now += ms;
}

/* ------------------------------------------------------------------ */
/* 假 localStorage                                                      */
/* ------------------------------------------------------------------ */

/**
 * 内存版 Storage 实现（对齐浏览器 Storage 的最小子集 + key()/length）。
 * failOn 用于模拟配额溢出：命中规则时抛 QuotaExceededError。
 */
export class FakeStorage {
  /**
   * @param {{failOn?:(key:string, value:string, store:FakeStorage)=>boolean}} [opts] 配额模拟。
   */
  constructor(opts = {}) {
    this._map = new Map();
    this.failOn = opts.failOn || null;
    /** @type {string[]} 写入尝试记录（含被拒绝的）。 */
    this.writes = [];
  }

  get length() {
    return this._map.size;
  }

  key(i) {
    const keys = Array.from(this._map.keys());
    return i >= 0 && i < keys.length ? keys[i] : null;
  }

  getItem(k) {
    return this._map.has(String(k)) ? this._map.get(String(k)) : null;
  }

  setItem(k, v) {
    const key = String(k);
    this.writes.push(key);
    if (this.failOn && this.failOn(key, String(v), this)) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this._map.set(key, String(v));
  }

  removeItem(k) {
    this._map.delete(String(k));
  }

  clear() {
    this._map.clear();
  }

  keys() {
    return Array.from(this._map.keys());
  }
}

/**
 * 强制覆盖全局属性（Node 22 的 navigator 是只读 getter，必须 defineProperty）。
 *
 * @param {string} name 属性名。
 * @param {*} value 值。
 * @returns {void}
 */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
}

/**
 * 删除全局属性。
 *
 * @param {string} name 属性名。
 * @returns {void}
 */
function undefine(name) {
  delete globalThis[name];
}

/**
 * 安装 localStorage 全局。
 *
 * @param {FakeStorage} store 存储实例。
 * @returns {FakeStorage} 同一个实例。
 */
export function installStorage(store) {
  define('localStorage', store);
  return store;
}

/** 卸载 localStorage 全局。 */
export function uninstallStorage() {
  undefine('localStorage');
}

/* ------------------------------------------------------------------ */
/* 假 navigator                                                         */
/* ------------------------------------------------------------------ */

/**
 * 安装可翻转 onLine 的 navigator。
 *
 * @param {{online?:boolean, connection?:Object|null, userAgent?:string}} [opts] 选项。
 * @returns {{navigator:Object, setOnline:(b:boolean)=>void}} 控制句柄。
 */
export function installNavigator(opts = {}) {
  const nav = {
    onLine: opts.online !== false,
    userAgent: opts.userAgent || 'Mozilla/5.0 (QA-FakeBrowser)',
    connection: opts.connection === undefined ? null : opts.connection,
    geolocation: null,
    serviceWorker: null,
  };
  define('navigator', nav);
  return {
    navigator: nav,
    setOnline: (b) => {
      nav.onLine = !!b;
    },
  };
}

/** 卸载 navigator。 */
export function uninstallNavigator() {
  undefine('navigator');
}

/* ------------------------------------------------------------------ */
/* 可控 fetch                                                           */
/* ------------------------------------------------------------------ */

/**
 * 构造一个「可编排」的 fetch mock。
 *
 * 用法：
 *   const f = installFetch();
 *   f.once({ status: 200, json: {...} });        // 下一次调用返回 JSON
 *   f.always({ status: 500, json: {} });          // 后续所有调用都返回 500
 *   f.handler = (url, init) => ({ hang: true });  // 自定义（挂起直到超时）
 *
 * 支持的行为：
 *   { json }           → 200 + JSON 文本
 *   { text }           → 200 + 原文
 *   { status, json|text|body }
 *   { arrayBuffer }    → 200 + 字节（ArrayBuffer/Uint8Array）
 *   { hang: true }     → 永不 resolve，直到 signal abort（用 AbortError 语义 reject）
 *   { throwNet: true } → 立即 reject TypeError（非 abort）
 */
export function installFetch() {
  const state = {
    /** @type {Array<Object>} 一次性队列。 */
    queue: [],
    /** @type {Object|null} 默认响应。 */
    fallback: { status: 200, json: { ok: true } },
    /** @type {null|((url:string, init:Object)=>Object)} 自定义处理器（优先级最高）。 */
    handler: null,
    /** @type {Array<string>} 调用过的 URL。 */
    calls: [],
    /** @type {Array<{url:string, signal:Object|null}>} 调用记录。 */
    meta: [],
  };

  const fetchMock = (url, init = {}) => {
    state.calls.push(String(url));
    state.meta.push({ url: String(url), signal: init.signal || null });
    const spec =
      state.handler && state.handler(String(url), init)
        ? state.handler(String(url), init)
        : state.queue.length > 0
          ? state.queue.shift()
          : state.fallback;
    const s = spec || {};

    if (s.hang) {
      // 挂起：只有 abort 才 reject（用于验证 AbortController 超时路径）
      return new Promise((resolve, reject) => {
        const sig = init.signal;
        if (sig) {
          if (sig.aborted) return reject(abortError());
          sig.addEventListener('abort', () => reject(abortError()), { once: true });
        }
      });
    }
    if (s.defer) {
      // 直接返回一个由调用方控制的 Promise<Response>（用于构造异步竞态场景）
      return s.defer;
    }
    if (s.throwNet) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    if (s.throwCustom) {
      return Promise.reject(s.throwCustom);
    }

    const status = Number(s.status) || 200;
    let body = '';
    if (s.body !== undefined) body = String(s.body);
    else if (s.json !== undefined) body = JSON.stringify(s.json);
    else if (s.text !== undefined) body = String(s.text);

    const headers = new Map(Object.entries(s.headers || { 'content-type': s.json !== undefined ? 'application/json' : 'text/plain' }));
    const resShape = {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => (headers.has(String(k).toLowerCase()) ? headers.get(String(k).toLowerCase()) : null) },
    };

    if (s.arrayBuffer !== undefined) {
      const ab = s.arrayBuffer instanceof ArrayBuffer ? s.arrayBuffer : new Uint8Array(s.arrayBuffer).buffer;
      resShape.bytes = new Uint8Array(ab);
      return Promise.resolve({ ...resShape, arrayBuffer: async () => ab });
    }
    return Promise.resolve({ ...resShape, text: async () => body });
  };

  define('fetch', fetchMock);

  return {
    /** 排一次响应。 */
    once: (s) => state.queue.push(s),
    /** 排多次同响应。 */
    times: (n, s) => {
      for (let i = 0; i < n; i += 1) state.queue.push(s);
    },
    setFallback: (s) => {
      state.fallback = s;
    },
    setHandler: (fn) => {
      state.handler = fn;
    },
    clearHandler: () => {
      state.handler = null;
    },
    reset: () => {
      state.queue = [];
      state.calls = [];
      state.meta = [];
    },
    get calls() {
      return state.calls;
    },
    get meta() {
      return state.meta;
    },
    get count() {
      return state.calls.length;
    },
    state,
  };
}

/**
 * 构造 AbortError（与浏览器语义对齐：name === 'AbortError'）。
 *
 * @returns {Error} AbortError。
 */
function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** 卸载 fetch。 */
export function uninstallFetch() {
  undefine('fetch');
}

/**
 * 安装 crypto.subtle（Node 22 自带；此函数便于「非安全上下文」降级用例临时摘除）。
 *
 * @returns {void}
 */
export function installCrypto() {
  define('crypto', webcrypto);
}

/** 摘除 crypto（模拟非安全上下文）。 */
export function uninstallCrypto() {
  undefine('crypto');
}

/* ------------------------------------------------------------------ */
/* 极简假 DOM                                                           */
/* ------------------------------------------------------------------ */

/**
 * 假 DOM 节点。只实现 src/ui/*.js 真正用到的那部分 API：
 * createElement / createTextNode / appendChild / removeChild / querySelector(All) /
 * getElementById / classList / hidden / disabled / textContent / setAttribute。
 */
class FakeNode {
  /**
   * @param {string} tag 标签名。
   */
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this._text = '';
    this.hidden = false;
    this.className = '';
    // ★`disabled` 必须与 `disabled` **属性**双向同步：真浏览器里 `el.disabled = false`
    //   会把属性一并去掉，两者永远一致。这里若只存一个普通字段，就会出现「渲染时
    //   `h({disabled:true})` 写了属性、之后代码 `el.disabled = false` 只改了字段」——
    //   于是 `hasAttribute('disabled')` 与 `.disabled` 给出**相反**的结论，
    //   「刷新后按钮该解锁」这类断言会变成「不加也绿」的假绿。所以直接以属性为准。
    Object.defineProperty(this, 'disabled', {
      get: () => this.attrs.has('disabled'),
      set: (v) => {
        if (v) this.attrs.set('disabled', '');
        else this.attrs.delete('disabled');
      },
      enumerable: true,
      configurable: true,
    });
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = new Map();
    const self = this;
    this.classList = {
      add: (c) => {
        const set = new Set(self._classList());
        set.add(c);
        self.className = Array.from(set).join(' ');
      },
      remove: (c) => {
        self.className = self._classList().filter((x) => x !== c).join(' ');
      },
      toggle: (c, on) => {
        if (on) self.classList.add(c);
        else self.classList.remove(c);
      },
      contains: (c) => self._classList().indexOf(c) !== -1,
    };
  }

  _classList() {
    return String(this.className || '')
      .split(/\s+/)
      .filter(Boolean);
  }

  get id() {
    return this.attrs.get('id') || '';
  }

  set id(v) {
    this.attrs.set('id', String(v));
  }

  setAttribute(k, v) {
    const key = String(k);
    this.attrs.set(key, String(v));
    // ★与真实 DOM 对齐：`value` 是「属性 ↔ 属性值」联动的键之一 —— 新建一个表单控件后
    //   `setAttribute('value', x)`，浏览器里 `input.value` 就是 x（`h()` 给输入框设初值
    //   走的正是这条路）。替身原来只写 attrs，于是「重画后回填草稿」这类修复在测试里
    //   **永远看不到效果**：不是业务没修好，是替身不真。
    //   ★同一个坑在 `disabled` 上踩过一次（那个已改成以属性为准的访问器）。
    if (key === 'value') {
      const tag = String(this.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION') {
        this.value = String(v);
      }
    }
  }

  getAttribute(k) {
    return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null;
  }

  hasAttribute(k) {
    return this.attrs.has(String(k));
  }

  removeAttribute(k) {
    this.attrs.delete(String(k));
  }

  get classList_() {
    return this.classList;
  }

  appendChild(node) {
    if (!node) return node;
    // 与真实 DOM 一致：同一个节点被再次 appendChild 时是「搬家」而不是复制
    if (node.parentNode && node.parentNode !== this) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (this.children.indexOf(node) === -1) this.children.push(node);
    return node;
  }

  removeChild(node) {
    this.children = this.children.filter((c) => c !== node);
    return node;
  }

  /**
   * 在 `ref` 之前插入节点（与真实 DOM 一致：`ref` 为 null 时追加到末尾）。
   *
   * ★为什么必须补这个方法：`ui/roadtrip.js` 的 `_parkResults()` 用
   *   `parent.insertBefore(box, row.nextSibling)` 把搜索结果面板挪到当前输入框下面，
   *   而 `row.nextSibling` 在「该行是最后一个子节点」时正是 **null** —— 只有替身也实现
   *   「null ⇒ append」才与真实浏览器等价。缺了它的表现是 `parent.insertBefore is not
   *   a function`，而且是在 `_renderPlaceResults()` 中途抛，**结果面板直接不再渲染** ——
   *   测试里表现为「搜不出结果」，很容易被误判成业务 bug。
   *
   * @param {Object} node 要插入的节点。
   * @param {Object|null} ref 参照节点；null / 找不到时插到末尾。
   * @returns {Object} 插入的节点。
   */
  insertBefore(node, ref) {
    if (!node) return node;
    // 与真实 DOM 一致：`insertBefore(node, node)` 是 **no-op**（把节点插到它自己前面 =
    // 位置不变）。缺这一条时重复调用会把节点误推到数组末尾 —— 而那个差异只在
    // 「同一个面板被反复 park」时才暴露，很容易被误当成业务 bug 去查。
    if (node === ref) return node;
    if (node.parentNode && node.parentNode !== this) node.parentNode.removeChild(node);
    node.parentNode = this;
    // 先把已经在册的 node 摘出来，再算 ref 的位置 —— 否则索引会错位
    const cur = this.children.indexOf(node);
    if (cur !== -1) this.children.splice(cur, 1);
    if (!ref) {
      this.children.push(node);
      return node;
    }
    const at = this.children.indexOf(ref);
    if (at === -1) this.children.push(node);
    else this.children.splice(at, 0, node);
    return node;
  }

  /** 下一个兄弟节点（无父节点或已是最后一个时返回 null，与真实 DOM 一致）。 */
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    if (i === -1) return null;
    return p.children[i + 1] || null;
  }

  addEventListener(type, fn) {
    const key = String(type);
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(fn);
  }

  /**
   * 触发绑定在该节点上的事件（测试驱动点击）。
   *
   * ★为什么必须**先快照再遍历**：`listeners.get(type)` 拿到的是**活数组**，而处理器里
   *   的「重画」往往会往同一个数组里再绑一个监听（例如 `ui/roadtrip.js` 的
   *   `_renderPage()` → `_bindControls()`）。直接 `for (const fn of list)` 会一边遍历
   *   一边被追加，变成**死循环** —— 实测一次点击刷出上百次求路请求，而且表现为「卡住」
   *   而不是「报错」，极难定位。这是测试台的形状（真浏览器每次重画都是新节点），
   *   所以修在这里：快照不改变语义，只保证这一轮遍历不会被自己触发的绑定接上。
   *
   * @param {string} type 事件类型。
   * @param {Object} [ev] 事件对象。
   * @returns {Promise<void>}
   */
  async fire(type, ev = {}) {
    const list = (this.listeners.get(String(type)) || []).slice();
    for (const fn of list) await fn(ev);
  }

  /**
   * 模拟点击：同步触发 click 监听（同样先快照，理由见 `fire()`）。
   *
   * @returns {void}
   */
  click() {
    const list = (this.listeners.get('click') || []).slice();
    list.forEach((fn) => fn({ target: this, preventDefault() {} }));
  }

  /**
   * 深度优先取所有后代。
   *
   * @returns {FakeNode[]} 后代列表。
   */
  descendants() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }

  /**
   * 深度遍历匹配选择器（仅支持 '#id' 与 '.class' 两种形态，够用即止）。
   *
   * @param {string} sel 选择器。
   * @returns {FakeNode|null} 首个匹配。
   */
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const all = this.descendants();
    if (sel.charAt(0) === '#') {
      const id = sel.slice(1);
      return all.filter((n) => n.attrs.get('id') === id);
    }
    if (sel.charAt(0) === '.') {
      const cls = sel.slice(1);
      return all.filter((n) => n.classList.contains(cls));
    }
    if (sel === '[data-i18n]') {
      return all.filter((n) => n.attrs.has('data-i18n'));
    }
    return [];
  }
}

/**
 * 创建一棵假 DOM 树（含 document）。
 *
 * @param {Array<{id:string, tag?:string}>} [ids] 预置元素。
 * @returns {{document:FakeNode, html:FakeNode, body:FakeNode, byId:Object}} 文档句柄
 *   （html 即 document.documentElement，主题属性写在它上面）。
 */
export function createFakeDom(ids = []) {
  const document = new FakeNode('document');
  document.readyState = 'loading';
  // 真实的 <html> 元素：主题模式就是写在它上面的（document.documentElement.dataset/属性）。
  // 层级保持 document → html → body，querySelectorAll 走 descendants()，不影响既有用例。
  const html = new FakeNode('html');
  const body = new FakeNode('body');
  document.documentElement = html;
  document.body = body;
  document.appendChild(html);
  html.appendChild(body);

  const byId = {};
  for (const item of ids) {
    const el = new FakeNode(item.tag || 'div');
    el.id = item.id;
    body.appendChild(el);
    byId[item.id] = el;
    (document.__index || (document.__index = new Map())).set(item.id, el);
  }

  document.createElement = (tag) => new FakeNode(tag);
  document.createTextNode = (txt) => {
    const n = new FakeNode('#text');
    n._text = String(txt);
    return n;
  };
  document.getElementById = (id) => document.__index.get(String(id)) || null;
  document.title = '';

  define('document', document);

  return { document, html, body, byId };
}

/** 卸载 document/window。 */
export function uninstallDom() {
  undefine('document');
  undefine('window');
}

/**
 * 取出某节点子树里的纯文本（含后代），用于断言渲染结果。
 *
 * @param {FakeNode} node 节点。
 * @returns {string} 文本。
 */
export function text(node) {
  return node ? node.textContent : '';
}

/**
 * 断言「不会显示成 0」的通用检查：占位符必须是 '—'。
 *
 * @param {*} actual 实际值。
 * @param {string} label 用例说明。
 * @returns {void}
 */
export function assertPlaceholder(actual, label) {
  assert.equal(actual, '—', `${label}：缺失值必须显示占位符 '—'，实际 '${actual}'`);
}

/**
 * 断言「不得显示成 0」。
 *
 * @param {*} actual 实际值。
 * @param {string} label 用例说明。
 * @returns {void}
 */
export function assertNotZeroish(actual, label) {
  assert.ok(!/^[\s-]*0(\.0+)?\s*(°|%|m|km|ms|mm|hPa|B|KB|MB)?$/.test(String(actual)), `${label}：不得显示成 0，实际 '${actual}'`);
}
