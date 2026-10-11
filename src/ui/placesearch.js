/**
 * 地点搜索控制器（纯逻辑层，不碰 DOM）
 *
 * 职责：把「用户输入 → 地名候选 → 选中跳转」这条链路的状态机收在一处 —— 防抖、
 * 竞态守卫、五种结果态（有结果 / 无结果 / 请求失败 / 输入不足 / 未搜索）都在这里判定。
 * 渲染交给 ui/now.js：本模块不 import 任何 DOM，也不构造任何节点，因此可以在 Node 里
 * 不开假 DOM 直接单测。
 *
 * 为什么状态不能住在 now.js 的渲染里：`renderHeader()` 每次都是**整槽重建**（一次 boot
 * 至少三次：定位后 / weather 回来后 / reverse 回来后），面板 DOM 会被反复销毁。状态放
 * 在这里，DOM 怎么重建都能照着 `state` 重画回来，用户打了一半的字不会丢。
 *
 * ★竞态为什么不用「最后一个响应胜出」：拿 keyword 字符串去比会让「同一个词连发两次」
 * 的第二次响应被误判成陈旧而丢弃（字符串相等 ≠ 是同一个请求）。这里用**单调递增的
 * 令牌**（`seq`），与 ui/app.js 的 `_epoch` 守卫同一思路：每次发起前 `++seq` 并记下
 * 自己的号，响应回来后号对不上就整包丢弃。
 *
 * 依赖方向：ui → core（只 import http 的 request 与 i18n 的 t），不 import data 层 ——
 * geocode 源的解析器由 src/data/sources.js 在 app.js 里注入，本模块只认 'geocode' 这个
 * 源 id。测试里要跑真 `request` 时自己 import sources.js 装上解析器。
 */

import { request } from '../core/http.js';
import { t } from '../i18n/zh.js';

/**
 * 触发搜索的最小字符数。
 *
 * 取 2：Open-Meteo geocoding 对单字（尤其中文单字）返回的结果噪声极大 —— 搜「北」
 * 会混进大量不相干的条目，而用户真正想打的「北京」在第二个字落下时就已经能命中。
 * 1 个字就发请求等于用一次真实网络往返（6 s 超时预算）去换一堆要被划掉的候选。
 */
export const SEARCH_MIN_CHARS = 2;

/**
 * 输入防抖时长（毫秒）。
 *
 * 取 350：中文输入法上一个字的敲击间隔通常在 200–300 ms（含候选词上屏），350 足以让
 * 连续打字不触发中途请求；再往上（500+）用户会觉得「打完了还要等一下才出结果」。
 * 也与 geocode 源的 6 s 超时不成比例 —— 一次多余的请求比一次多余的等待贵得多。
 */
export const SEARCH_DEBOUNCE_MS = 350;

/**
 * 结果态。
 *
 * 五种**必须分开**，尤其 EMPTY 与 ERROR：把两者合成一句「没找到」会把网络故障伪装成
 * 「这地方不存在」，用户会以为自己打错了而不是断网了。
 */
export const SEARCH_STATUS = {
  /** 还没搜过（面板刚打开）。 */
  IDLE: 'idle',
  /** 输入不足最小字符数：不发请求。 */
  SHORT: 'short',
  /** 已发出请求（含防抖等待窗口）。 */
  LOADING: 'loading',
  /** 有结果。 */
  OK: 'ok',
  /** 请求成功但结果为空 —— 「真没这地方」。 */
  EMPTY: 'empty',
  /** 请求失败（超时 / 断网 / HTTP 错 / 解析错）—— 「没问成」。 */
  ERROR: 'error',
};

/**
 * 把坐标转成有限数字；不是「一个真正的数字」时返回 null。
 *
 * ★不能只写 `Number.isFinite(Number(v))`：`Number(null)` 是 0、`Number('')` 是 0、
 * `Number('  ')` 也是 0 —— 那会把「坐标坏了」静默变成「几内亚湾 0,0」这个真实存在的
 * 地点。与 app.js 的 `DECIMAL_LITERAL_RE` 严格解析是同一条顾虑。
 *
 * @param {*} v 待转换值。
 * @returns {number|null} 有限数字或 null。
 */
function _finiteCoord(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 构造跳转到指定地点的链接（跨页传参）。
 *
 * ★中文名必须 encodeURIComponent：直接拼进查询串，非 ASCII 字节在部分浏览器上会被按
 * Latin-1 解释成乱码，跳过去显示成一串问号（与 settings.js 的 _favHref 同一条理由）。
 *
 * ★坐标不是有限数字时返回空串：一个跳不过去的链接比没有链接更糟 —— 用户点下去会停在
 * 原页面而毫无反馈。调用方拿到空串就不做导航。
 *
 * @param {{lat:number, lon:number, name?:string|null}} place 地点。
 * @returns {string} `index.html?lat=…&lon=…&name=…`；坐标非法时 ''。
 */
export function placeHref(place) {
  const p = place && typeof place === 'object' ? place : {};
  const lat = _finiteCoord(p.lat);
  const lon = _finiteCoord(p.lon);
  if (lat === null || lon === null) return '';
  const sName = encodeURIComponent(String(p.name === null || p.name === undefined ? '' : p.name));
  return `index.html?lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lon))}&name=${sName}`;
}

/**
 * 创建一个地点搜索控制器。
 *
 * @param {Object} [opts] 选项。
 * @param {(sourceId:string, ctx:Object) => Promise<Object>} [opts.fetch] 取数函数，默认
 *   `request`（core/http.js）。**可注入是测试的前提**：http.js 有全局串行队列（并发恒为
 *   1），用真 `request` 根本构造不出「先发的慢响应晚于后发的快响应」这个重叠场景。
 * @param {string} [opts.lang] 语言，默认 'zh'。
 * @param {number} [opts.debounceMs] 防抖时长，默认 SEARCH_DEBOUNCE_MS。
 * @param {number} [opts.minChars] 最小字符数，默认 SEARCH_MIN_CHARS。
 * @param {(place:Object) => void} [opts.onPick] 选中回调。
 * @param {() => void} [opts.onChange] 状态变化回调（等价于建好后立刻调 onChange(fn)）。
 * @returns {Object} 控制器。
 */
export function createPlaceSearch(opts = {}) {
  const conf = opts && typeof opts === 'object' ? opts : {};
  const fetchFn = typeof conf.fetch === 'function' ? conf.fetch : (sourceId, ctx) => request(sourceId, ctx);
  const lang = conf.lang || 'zh';
  const debounceMs = Number.isFinite(Number(conf.debounceMs)) ? Number(conf.debounceMs) : SEARCH_DEBOUNCE_MS;
  const minChars = Number.isFinite(Number(conf.minChars)) ? Number(conf.minChars) : SEARCH_MIN_CHARS;
  const onPick = typeof conf.onPick === 'function' ? conf.onPick : null;

  /**
   * 订阅者（渲染层）。
   *
   * `opts.onChange` 与 `onChange(fn)` 是同一份列表的两条入口：渲染层建控制器时顺手
   * 传进来的那个回调也必须真的进去，否则「状态变了但界面不重画」这种哑火现象
   * 在测试里表现为「面板永远空着」，很难一眼看出是订阅没注册。
   */
  const listeners = [];
  if (typeof conf.onChange === 'function') listeners.push(conf.onChange);

  /** 控制器状态：渲染层只读它，所有变更都经 _commit()。 */
  const state = {
    status: SEARCH_STATUS.IDLE,
    text: '',
    results: [],
    errorMessage: '',
    open: false,
  };

  /** @type {any} 防抖定时器（浏览器给 number，Node 给 Timeout 对象）。 */
  let timer = null;

  /**
   * 请求令牌：每次发起搜索前自增。
   *
   * 响应回来后拿「发起时记下的号」与当前号比对，不等即说明期间又发起了新请求，
   * 本轮结果整包丢弃 —— 等价于 ui/app.js 里 `shouldStop: () => epoch !== _epoch`。
   */
  let seq = 0;

  /**
   * 通知渲染层重画。
   *
   * 单个订阅者抛异常不该把 `run()` 的 await 链打断（与 app.js 的 _safePull 同口径：
   * 渲染失败最多是这一帧没画出来，不该影响状态机继续跑）。
   *
   * @returns {void}
   */
  function _emit() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        /* 渲染层自己的事，状态机不为此中断 */
      }
    }
  }

  /**
   * 写入状态并通知。
   *
   * @param {Object} patch 变更。
   * @returns {void}
   */
  function _commit(patch) {
    Object.assign(state, patch);
    _emit();
  }

  /**
   * 取消尚未触发的防抖定时器。
   *
   * @returns {void}
   */
  function _cancelTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * 只保留「跳得过去」的候选。
   *
   * `parseGeocode()` 遇到缺坐标的条目会给 `lat: null`（它内部走 `_n()`），那种条目渲染
   * 出来就是一颗点了没反应的按钮 —— 一颗死按钮比不放更糟，所以在这里就滤掉。
   *
   * @param {Array<Object>} list 原始结果。
   * @returns {Array<Object>} 坐标可用的结果。
   */
  function _navigable(list) {
    return list.filter((p) => {
      const c = p && typeof p === 'object' ? p : {};
      // ★同样不能用 Number.isFinite(Number(v))：Number(null) 是 0，会把「没坐标」
      // 判成「在几内亚湾」，于是一颗点不动的死按钮会被当成合法候选放进来。
      return _finiteCoord(c.lat) !== null && _finiteCoord(c.lon) !== null;
    });
  }

  return {
    /** @returns {string} 当前结果态。 */
    get status() {
      return state.status;
    },

    /** @returns {string} 输入框里的原文。 */
    get text() {
      return state.text;
    },

    /** @returns {Array<Object>} 当前结果（副本，防外部就地改）。 */
    get results() {
      return state.results.slice();
    },

    /** @returns {string} 失败原因（已本地化）；非失败态为空串。 */
    get errorMessage() {
      return state.errorMessage;
    },

    /**
     * 面板是否展开。
     *
     * ★为什么叫 `isOpen` 而不是 `open`：控制器同时要有 `open()` 这个**方法**，而在对象
     * 字面量里后出现的同名成员会**静默覆盖**先出现的那个 —— 写成 `get open()` + `open()`
     * 的话，`ps.open` 拿到的是那个函数（永远 truthy），于是「面板是不是开着」这个判断
     * 恒为真，界面表现为「收不起来」。这个坑踩过一次，名字就此错开。
     *
     * @returns {boolean} 是否展开。
     */
    get isOpen() {
      return state.open;
    },

    /**
     * 整份状态（副本）。
     *
     * @returns {Object} 状态快照。
     */
    get state() {
      return { ...state, results: state.results.slice() };
    },

    /**
     * 订阅状态变化。
     *
     * @param {() => void} fn 回调。
     * @returns {() => void} 退订函数。
     */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },

    /**
     * 展开面板。
     *
     * @returns {void}
     */
    open() {
      if (state.open) return;
      _commit({ open: true });
    },

    /**
     * 收起面板。**不清结果**：再展开时上次的候选还在，用户不用重打一遍。
     *
     * @returns {void}
     */
    close() {
      if (!state.open) return;
      _cancelTimer();
      _commit({ open: false });
    },

    /**
     * 开合切换。
     *
     * @returns {void}
     */
    toggle() {
      if (state.open) this.close();
      else this.open();
    },

    /**
     * 用户输入（走防抖）。
     *
     * 每次调用都先取消上一个待发请求 —— 连打三个字只会有最后一次真正发出去。
     *
     * @param {string} value 输入框当前值。
     * @returns {void}
     */
    input(value) {
      const text = String(value === null || value === undefined ? '' : value);
      _cancelTimer();
      const kw = text.trim();
      if (kw.length < minChars) {
        // 输入不足：不发请求，也不留着上一次的候选误导用户
        _commit({
          text,
          status: SEARCH_STATUS.SHORT,
          results: [],
          errorMessage: '',
        });
        return;
      }
      state.text = text;
      state.status = SEARCH_STATUS.LOADING;
      state.errorMessage = '';
      _emit();
      timer = setTimeout(() => {
        timer = null;
        this.run(kw);
      }, debounceMs);
      // Node 侧（测试）挂着这个定时器会把进程多吊一会儿；浏览器返回的是数字，没有 unref
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    /**
     * 立即执行一次搜索（跳过防抖）。
     *
     * @param {string} keyword 关键词。
     * @returns {Promise<Object|null>} SourceResult；被判为陈旧时返回 null。
     */
    async run(keyword) {
      const kw = String(keyword === null || keyword === undefined ? '' : keyword).trim();
      if (kw.length < minChars) {
        _commit({ status: SEARCH_STATUS.SHORT, results: [], errorMessage: '' });
        return null;
      }

      const mySeq = (seq += 1);
      /** 本轮是否已被更新的请求接管（等价于 app.js 的 shouldStop）。 */
      const isStale = () => mySeq !== seq;

      state.status = SEARCH_STATUS.LOADING;
      state.results = [];
      state.errorMessage = '';
      _emit();

      let res = null;
      try {
        res = await fetchFn('geocode', { keyword: kw, lang });
      } catch (err) {
        if (isStale()) return null;
        // 取数层直接抛异常（不是 SourceResult）：失败照样要如实说，不能落回「无结果」
        _commit({
          status: SEARCH_STATUS.ERROR,
          results: [],
          errorMessage: err && err.message ? String(err.message) : t('error.NETWORK'),
        });
        return null;
      }

      // ★竞态守卫：慢的旧响应不得覆盖快的新响应
      if (isStale()) return null;

      if (!res || !res.ok) {
        _commit({
          status: SEARCH_STATUS.ERROR,
          results: [],
          errorMessage: res && res.error && res.error.message ? String(res.error.message) : t('error.NETWORK'),
        });
        return res || null;
      }

      const list = _navigable(Array.isArray(res.data) ? res.data : []);
      _commit({
        status: list.length > 0 ? SEARCH_STATUS.OK : SEARCH_STATUS.EMPTY,
        results: list,
        errorMessage: '',
      });
      return res;
    },

    /**
     * 选中一条结果。
     *
     * @param {Object} place 选中的地点（含 name / lat / lon / admin1 / country）。
     * @returns {void}
     */
    pick(place) {
      if (onPick) onPick(place);
    },

    /**
     * 释放资源（清定时器、退订全部）。
     *
     * @returns {void}
     */
    dispose() {
      _cancelTimer();
      listeners.length = 0;
    },
  };
}
