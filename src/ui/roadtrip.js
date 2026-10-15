/**
 * 自驾页（roadtrip.html 入口）—— 规划主流程的编排
 *
 * 职责：把「求路 → 切段 → 候选 → 筛选 → 存盘」接成一条能用的链。**本模块只做编排与
 *   渲染**：切段与筛选是 `core/roadtrip.js` 的纯函数，求路 / 候选是 `data/roadsources.js`
 *   的两路源，持久化是 `core/tripstore.js`。这里一行算法都不写。
 *
 * ★四条不许回退的硬要求（改本文件前先读，它们决定了本页为什么长这样）：
 *   1) **几何与候选都不落盘**。路线（`overview=full`）是几百 KB 量级，几趟行程就能
 *      吃光 4.5 MB 预算，而 `cache.evictOldest()` 会按 storedAt 淘汰**最旧条目** ——
 *      行程是用户数据，被当缓存淘汰是灾难（架构 §4.3）。所以 `route` 只活在内存里，
 *      落盘一律过 `saveTrip()`（它内部过 `slimTrip()`）。候选（`PoiCandidate`）
 *      同样只活在这一页，点「采用」才变成 CheckIn 进入行程（架构 §4.6）。
 *   2) **两个时长口径不许混用**。每日时长出自 `Σ annotation.duration`（切段依据），
 *      全程总时长界面展示用 `Σ legs[].duration`；两者实测相差 <1 %，注脚如实写明，
 *      绝不拿一个冒充另一个（架构 §4.4.1 第 8 条）。
 *   3) **N 个锚点 × M 个类别 = N×M 次串行请求**，必须在按下去**之前**写明会发起几次、
 *      消耗几次配额，并提供「只搜住宿」这类收窄开关。并发恒为 1（http.js 的全局队列），
 *      这里**不**做任何并发 —— 并发会撞限流，也会让配额消耗变得不可预测。
 *   4) **缺 Key 只降级候选，不锁死整页**。降级矩阵 §8 第一行：没填高德 Key 时，
 *      求路 / 切段 / 保存**全部照常**，只有候选区给说明条 + 「手动添加」可用。
 *      最容易写坏的就是这条 —— 把整页锁成「请先填 Key」，等于拿一个可选能力
 *      绑架了全部能力。
 *
 * ★为什么不复用 `request()` 而一律走 `requestRoadSource()`：后者把 `build()` 抛出的
 *   失败也收敛成 SourceResult（没填 Key / 点数不足 2 都是在 build 阶段抛的），
 *   于是**任何失败都是同一个形状**，界面只需 `errorText()` 一处翻译；直接 `request()`
 *   会让这两种失败以裸 Promise 异常的形式冒出来，按钮点了没反应。
 *
 * 为什么这一页**不带底部 tabbar**：`.tabbar` 是 `position: fixed` 且没有 width
 * （shrink-to-fit，宽度由内容决定），四个 tab 在 320px 屏上已经贴着临界点（实测
 * 内容宽 294px），真机上出过「此刻」两字断成两行的 bug。加第五项必撑破。
 * 所以本页改用一个明确的「返回『我的』」入口，不进 tabbar。
 *
 * 依赖方向：ui ← data ← core。★必须 import '../data/sources.js' —— 源解析器是它在
 * **自己加载时**通过 setSourceResolver() 注入的，漏掉这一行两路源都拿 UNSUPPORTED，
 * 不发任何请求、每个按钮都点了没反应（compare.js:40 有同一条注释）。
 *
 * 顶层只做三件全站属性的引导（主题 / 字号 / 语言），其余 DOM 访问全在 init() 内。
 */

import { t, tr } from '../i18n/index.js';
import { applyLocale } from './locale.js';
import { getThemeMode, getFontScale, getLocale, log } from '../core/store.js';
import { h, applyI18n } from './now.js';
// 主题 / 字号是全站属性，本页作为入口之一必须各引导一次（实现见 ui/theme.js）。
import { applyThemeMode, applyFontScale } from './theme.js';
// 切段与筛选都是纯函数，本模块只拿来用，不重写
import {
  newTrip,
  newPlaceRef,
  splitStopovers,
  partitionByFilter,
  adoptCandidate,
  exportTrips,
  inspectTripFile,
  applyTripFile,
  roadtripFilename,
  DAILY_PRESETS,
  MAX_VIA,
  DEFAULT_FILTERS,
} from '../core/roadtrip.js';
// 路线图（投影与绘制都在 ui/roadmap.js，本模块只负责取数与编排）
import { renderRouteCard } from './roadmap.js';
// 导出落盘用既有下载助手，不自己拼 <a download>
import { downloadJson } from './download.js';
// 行程持久化（★列行程用带回 skipped 的那个入口 —— 简版入口会静默丢数据）
import { saveTrip, listTripsWithIssues } from '../core/tripstore.js';
// 两路源：求路走 osrmRoute、候选走 amapPoi
import { requestRoadSource } from '../data/roadsources.js';
import '../data/sources.js';
// 高德 Key 门禁（降级矩阵 §8 第一行的判定依据）
import { hasAmapKey } from '../core/apikeys.js';
// 地点搜索：复用既有能力，不自己造一套（placesearch.js 已含防抖 / 竞态守卫 / 五态）
import { createPlaceSearch, SEARCH_STATUS } from './placesearch.js';
// 候选列表卡（pass / fail / unknown 三分组）
import { renderPoiGroup } from './poilist.js';
// 错误文案：core 只给键，这里是唯一把键翻成人话的地方
import { errorText, reasonText } from './errtext.js';
import * as fmt from '../core/format.js';
import { AMAP_TYPES, AMAP_DEFAULT_RADIUS } from '../data/amap.js';

// ★主题引导（模块顶层，行首无缩进）：与 index/settings/compass/selfcheck/compare 同一时机。
applyThemeMode(getThemeMode());
// ★字号档位引导（与主题同一时机、同一理由）。放大乘数在 styles/tokens.css。
applyFontScale(getFontScale());
// 语言引导（同上）。三个都是行首无缩进 —— tools/check.mjs 第 15 节按这个形状断言。
applyLocale(getLocale());

/** 候选搜索半径（米）：沿用高德源的默认值，不另起一个口径。 */
const POI_RADIUS_M = AMAP_DEFAULT_RADIUS;

/** 三类候选（顺序即界面顺序）。 */
const POI_TYPES = ['stay', 'sight', 'food'];

/* ------------------------------------------------------------------ */
/* 状态（内存态：路线与候选**都不**落盘）                                */
/* ------------------------------------------------------------------ */

/**
 * 页面状态。
 *
 * ★`route` / `candidates` 为什么只放在这里而不进 store：它们是**不可持久**的大对象
 * （几何几百 KB、候选有配额成本且会过期）。放进 store 就迟早会被某个「顺手存一下」
 * 写进 localStorage，而 `cache.evictOldest()` 淘汰用户数据是灾难（架构 §4.3）。
 * 内存态是唯一正确的位置 —— 刷新页面就没了，这正是我们想要的。
 */
const _state = {
  /** @type {{origin:Object|null, destination:Object|null, via:Array<Object>, startDate:string|null, dailyTargetSec:number}} */
  plan: {
    origin: null,
    destination: null,
    via: [],
    startDate: null,
    dailyTargetSec: 14400,
  },
  /** @type {''|'routing'|'poi'} 正在跑的异步动作。 */
  busy: '',
  /** @type {Object|null} RouteInfo（内存）。 */
  route: null,
  /** @type {Object|null} SplitResult。 */
  split: null,
  /** @type {string} 求路 / 切段失败的人话（已翻译）。 */
  routeError: '',
  /** @type {Array<string>} 要搜的候选类别。 */
  poiTypes: POI_TYPES.slice(),
  /** @type {Object<string,{ok:boolean, items:Array<Object>, error:string}>} 候选，键 `${stopoverId}:${type}`。 */
  candidates: {},
  /** @type {Object<string,boolean>} 已采用的候选 id。 */
  adopted: {},
  /** @type {Array<Object>} 已采用的打卡（进行程）。 */
  adoptedList: [],
  /** @type {string} 手动添加的名字（重画后回填用，避免打了一半被清空）。 */
  manualName: '',
  /** @type {'stay'|'sight'|'food'} 手动添加的类别。 */
  manualType: 'stay',
  /** @type {string} 候选搜索失败的人话。 */
  poiError: '',
  /** @type {{done:number,total:number}|null} 候选搜索进度。 */
  poiProgress: null,
  /** @type {string} 行程名。 */
  tripName: '',
  /** @type {string} 保存结果提示。 */
  saveMsg: '',
  /** @type {string|null} 当前正在为哪个字段搜地点：'origin' | 'destination' | 'via:0'。 */
  searchTarget: null,
  /**
   * 地点搜索框里**还没选中**的输入草稿（键同 `searchTarget`）。
   *
   * ★为什么必须有它：`_renderPage()` 是**整槽重建**，输入框每次都是新节点。不带 value
   *   就等于把用户打了一半的字扔掉 —— 真机实测「点『算路线并分天』后地点全空」，
   *   根因正在这里：`_onPlan()` 先设 `busy='routing'` 再重画，输入框当场被重建。
   *   与 `manualName` 同一个理由，照它补，不要另发明一套。
   */
  drafts: {},
  /** @type {{list:Array<Object>, skipped:Array<Object>}} */
  trips: { list: [], skipped: [] },
  /** @type {'whole'|number} 路线图当前视图：'whole' 或第 N 天（1 起）。 */
  mapScope: 'whole',
  /**
   * 简化几何缓存（键：'whole' / `day:${n}`）。
   *
   * ★为什么是内存态：simplified 几何只有 1 KB 量级，但它**可再生**且会随路网变化，
   *   落盘就得跟着行程一起被备份 / 被淘汰（架构 §4.3.2），不值当。
   * @type {Object<string, {ok:boolean, points:Array<{lat:number,lon:number}>, error:string}>}
   */
  mapGeo: {},
  /** @type {string} 取几何时的人话状态。 */
  mapMsg: '',
  /** @type {string} 搬家（导出 / 导入）的结果提示。 */
  moveMsg: '',
  /** @type {Object|null} `inspectTripFile()` 的预览计划（用户确认后才落盘）。 */
  importPlan: null,
};

/** @type {Object<string,Object>} 渲染后需要再次取用的容器。 */
const _els = {};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/**
 * 取 DOM 元素（缺失返回 null，不抛）。
 *
 * @param {string} id 元素 id。
 * @returns {HTMLElement|null} 元素。
 */
function _el(id) {
  return typeof document !== 'undefined' && document ? document.getElementById(id) : null;
}

/**
 * 把秒数翻成人话（小时 / 分钟）。
 *
 * @param {number|null} sec 秒。
 * @returns {string} 文案；缺失返回 '—'（core/format.js 的 DASH，绝不成 0）。
 */
function _dur(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return fmt.DASH;
  return tr(fmt.duration(Number(sec) * 1000));
}

/**
 * 把米数翻成人话（km）。
 *
 * @param {number|null} m 米。
 * @returns {string} 文案；缺失返回 '—'。
 */
function _dist(m) {
  if (m === null || m === undefined || !Number.isFinite(Number(m))) return fmt.DASH;
  return fmt.num(Number(m) / 1000, 1, ' km');
}

/**
 * 取当前用于求路的点序列（出发地 + 必经点 + 目的地）。
 *
 * @returns {Array<{lat:number, lon:number, name:string}>} 点序列（不足 2 个时如实返回短数组）。
 */
function _points() {
  const out = [];
  /**
   * 只接受**真的有坐标**的点。
   *
   * ★为什么不许写 `Number.isFinite(Number(p.lat))`：`Number(null)` 是 **0**，而
   *   `Number.isFinite(0)` 为真 —— 于是「点了『添加一个必经点』但还没选地点」留下的
   *   空槽位（`newPlaceRef()` 产出的 `{lat:null, lon:null}`）会被当成 **(0,0)** 放行，
   *   最后拼出 `0.000000,0.000000` 的 URL。实测 OSRM 对它是 **HTTP 400 InvalidUrl** ——
   *   这正是真机报障「数据源返回 HTTP 400」的根因。
   *   空槽位不是坐标：不许进点序列，也不许让「点数够不够」这个数跟着谎报。
   */
  const push = (p) => {
    if (!p) return;
    const lat = p.lat === null || p.lat === undefined ? NaN : Number(p.lat);
    const lon = p.lon === null || p.lon === undefined ? NaN : Number(p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    out.push({ lat, lon, name: String(p.name || '') });
  };
  push(_state.plan.origin);
  for (const v of _state.plan.via) push(v);
  push(_state.plan.destination);
  return out;
}

/**
 * 取当前筛选条件。
 *
 * 本轮一律用 `core/roadtrip.js` 的 `DEFAULT_FILTERS` —— 界面还没提供调条件的入口，
 * ★宁可让用户看见「未填」分组，也不自己编一套默认值（编出来的默认值就是推算值）。
 *
 * @returns {Object} 筛选条件。
 */
function _filters() {
  return DEFAULT_FILTERS;
}

/* ------------------------------------------------------------------ */
/* 地点搜索（复用 ui/placesearch.js）                                   */
/* ------------------------------------------------------------------ */

/**
 * 地点搜索控制器（整页共用**一个**）。
 *
 * 为什么不是一个输入框一个控制器：本页最多 2 + 6 = 8 个地点字段，各建一个控制器等于
 * 8 份防抖定时器与 8 份状态；而用户一次只会操作其中一个。共用一个、用 `_state.searchTarget`
 * 记住「这次是给谁搜的」，结果与 UI 都更简单，也不会出现「A 框的结果盖到 B 框」。
 */
const _ps = createPlaceSearch({
  onChange: () => {
    _renderPlaceResults();
  },
  onPick: (place) => {
    _applyPicked(place);
  },
});

/**
 * 把选中的地点写进对应的字段。
 *
 * @param {Object} place 地点（含 name / lat / lon）。
 * @returns {void}
 */
function _applyPicked(place) {
  const target = _state.searchTarget;
  if (!target) return;
  const ref = newPlaceRef({
    lat: place && place.lat,
    lon: place && place.lon,
    name: place && place.name,
    source: 'search',
  });
  if (ref.lat === null || ref.lon === null) {
    // ★坐标不合法就**不写入**：写入一个 lat/lon 为 null 的 PlaceRef，界面会显示
    //   「已选：」后面空白，而求路时它既不算进点数又求不出来 —— 两头都骗人。
    log('rt-pick-bad', String(target));
    return;
  }
  if (target === 'origin') _state.plan.origin = ref;
  else if (target === 'destination') _state.plan.destination = ref;
  else if (target.indexOf('via:') === 0) {
    const i = Number(target.slice(4));
    if (Number.isInteger(i) && i >= 0 && i < _state.plan.via.length) _state.plan.via[i] = ref;
  }
  // ★选中了就把搜索词清掉：留着它，重画后输入框里会停着一串旧搜索词，
  //   看起来像「已选」其实是残留（真正的已选值显示在这一行上方）。
  delete _state.drafts[target];
  // 旧的切段属于**旧的点序列**，留着就是假数据 —— 换点即作废。
  _state.route = null;
  _state.split = null;
  _state.routeError = '';
  _state.candidates = {};
  _state.poiError = '';
  _state.searchTarget = null;
  _ps.close();
  _renderPage();
}

/**
 * 把结果面板停到「正在搜的那一行」正下方。
 *
 * ★为什么必须挪：面板原本 append 在规划卡**最底部**（「算路线并分天」按钮之后）。
 *   真机实测：用户打字时结果渲染在**屏幕外**，看不见就等于没有结果 → 用户以为搜不到、
 *   于是从来没选中过任何地点 → 点算路线报「至少需要 2 个坐标点（现在 0 个）」。
 *   面板位置错了，「搜索地点」这条交互整体就是断的。
 *
 * 为什么不是「每个输入框一个面板」：那要 8 个面板 + 8 份状态，而用户一次只搜一处。
 * 挪动一个共享节点，与「共用一个搜索控制器」是同一个设计。
 *
 * @param {Object} box 结果面板节点。
 * @returns {void}
 */
function _parkResults(box) {
  const target = _state.searchTarget;
  if (!target) return;
  const row = _els.rows[target];
  const parent = row && row.parentNode;
  if (!parent) return;
  // 已经就位就别再动 —— 这个函数每次渲染都会被调用，而「面板已经贴在这一行后面」
  // 是常态（同一行连着搜几次）。少一次无谓的 DOM 操作，意图也更直白。
  if (row.nextSibling === box) return;
  // insertBefore(box, row.nextSibling) = 「插到这一行后面」；row 是最后一个子节点时
  // nextSibling 为 null，insertBefore 会正确地 append 到末尾。
  parent.insertBefore(box, row.nextSibling);
}

/**
 * 渲染地点搜索的结果面板（**只重画这一块**，不整页重画）。
 *
 * ★为什么单独一个容器：输入框在表单卡里，整页重画会**销毁输入框**，用户打了一半的字
 * 和焦点一起没了。所以结果面板独占 `#place-results`，搜索状态变化只重画它。
 *
 * @returns {void}
 */
function _renderPlaceResults() {
  const box = _els.placeResults;
  if (!box) return;
  box.textContent = '';
  _parkResults(box);

  if (!_state.searchTarget || !_ps.isOpen) return;

  const st = _ps.state;
  if (st.status === SEARCH_STATUS.LOADING) {
    box.appendChild(h('p', { class: 'card-note', text: t('rt.searching') }));
    return;
  }
  if (st.status === SEARCH_STATUS.ERROR) {
    box.appendChild(h('p', { class: 'card-note', text: st.errorMessage || t('app.unknown') }));
    return;
  }
  if (st.status === SEARCH_STATUS.EMPTY) {
    box.appendChild(h('p', { class: 'card-note', text: t('rt.searchEmpty') }));
    return;
  }
  if (st.status === SEARCH_STATUS.SHORT) return;

  for (const p of st.results) {
    const btn = h('button', {
      class: 'btn',
      type: 'button',
      text: `${p.name}${p.admin1 ? ` · ${p.admin1}` : ''}`,
    });
    btn.addEventListener('click', () => _ps.pick(p));
    box.appendChild(btn);
  }
}

/**
 * 画一行「地点字段」：标签 + 当前值 + 搜索输入框。
 *
 * @param {string} labelKey 标签文案键。
 * @param {Object|null} ref 当前 PlaceRef。
 * @param {string} target 搜索目标键。
 * @param {Object} [params] 标签文案的占位符（例如必经点的序号 `{n}`）。
 * @returns {Object} 行节点。
 */
function _placeRow(labelKey, ref, target, params) {
  const input = h('input', {
    class: 'btn',
    type: 'text',
    id: `ps-${target}`,
    placeholder: t('rt.pickPh'),
    autocomplete: 'off',
    spellcheck: 'false',
    // ★回填草稿：重画会把这个节点整个换掉，不带 value 就等于清空用户输入
    value: _state.drafts[target] || '',
  });
  input.addEventListener('focus', () => {
    _state.searchTarget = target;
    _ps.open();
    _renderPlaceResults();
  });
  input.addEventListener('input', () => {
    _state.searchTarget = target;
    // ★只记 searchTarget 不记值，重画后框里就是空的 —— 真机实测踩到这个
    _state.drafts[target] = input.value;
    _ps.open();
    _ps.input(input.value);
  });

  const has = ref && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lon));
  const row = h('div', { class: 'field', 'data-row-target': target }, [
    h('p', { class: 'card-note', text: t(labelKey, params) }),
    // 当前值：没选就写 '—'，绝不显示一个空行 —— 空行分不清「没填」和「填了空的」
    h('p', {
      class: 'card-note',
      text: has ? String(ref.name || fmt.coord(Number(ref.lat), Number(ref.lon))) : fmt.DASH,
    }),
    input,
  ]);
  // ★登记行节点：结果面板要贴到「正在搜的那一行」下面（见 _parkResults）
  if (!_els.rows) _els.rows = {};
  _els.rows[target] = row;
  return row;
}

/* ------------------------------------------------------------------ */
/* 表单卡                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画规划表单。
 *
 * @returns {Object} 卡片节点。
 */
function _renderPlanCard() {
  const btn = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    id: 'btn-plan',
    disabled: _state.busy !== '',
    text: _state.busy === 'routing' ? t('rt.planning') : t('rt.planBtn'),
  });

  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.planTitle') }),
    h('p', { class: 'card-note', text: t('rt.planHint') }),
    _placeRow('rt.origin', _state.plan.origin, 'origin'),
    _placeRow('rt.dest', _state.plan.destination, 'destination'),
  ]);

  // 必经点（可选）
  const viaBox = h('div', { class: 'field' }, [h('p', { class: 'card-note', text: t('rt.viaTitle') })]);
  _state.plan.via.forEach((v, i) => {
    // 每行带序号：三个「必经点（可选）」摞在一起，用户分不清哪个是哪个
    const row = h('div', { class: 'field field--row' }, [
      _placeRow('rt.viaItem', v, `via:${i}`, { n: i + 1 }),
    ]);
    const rm = h('button', { class: 'btn', type: 'button', text: t('rt.viaRemove') });
    rm.addEventListener('click', () => {
      _state.plan.via.splice(i, 1);
      // ★splice 之后后面的必经点索引整体前移，逐个迁移草稿极易错位；
      //   直接清掉所有 via 草稿 —— 丢掉的只是「还没选中的搜索词」，不是用户数据。
      Object.keys(_state.drafts).forEach((k) => {
        if (k.indexOf('via:') === 0) delete _state.drafts[k];
      });
      // 点序列变了 → 旧切段作废（它属于旧的点序列）
      _state.route = null;
      _state.split = null;
      _state.candidates = {};
      _renderPage();
    });
    row.appendChild(rm);
    viaBox.appendChild(row);
  });
  if (_state.plan.via.length < MAX_VIA) {
    viaBox.appendChild(h('button', { class: 'btn', type: 'button', id: 'btn-via-add', text: t('rt.viaAdd') }));
  }
  card.appendChild(viaBox);

  // 出发日期：如实可选 —— 不填也能规划（行程只有相对天数，没有绝对日期）
  card.appendChild(
    h('div', { class: 'field' }, [
      h('p', { class: 'card-note', text: t('rt.startDate') }),
      h('input', { class: 'btn', type: 'date', id: 'in-start-date', value: _state.plan.startDate || '' }),
    ])
  );

  // 每日目标时长档（3 / 4 / 5 小时 = 10800 / 14400 / 18000）
  const sel = h('select', { class: 'btn', id: 'sel-daily' });
  for (const sec of DAILY_PRESETS) {
    const opt = h('option', { value: String(sec), text: t('rt.dailyOpt', { h: String(sec / 3600) }) });
    if (sec === _state.plan.dailyTargetSec) opt.setAttribute('selected', '');
    sel.appendChild(opt);
  }
  card.appendChild(h('div', { class: 'field' }, [h('p', { class: 'card-note', text: t('rt.dailyTarget') }), sel]));

  card.appendChild(h('div', { class: 'field field--row' }, [btn]));

  // ★搜索结果的专属容器：只画这里，不动上面的输入框（保住焦点与已输入内容）
  const results = h('div', { class: 'field', id: 'place-results' });
  _els.placeResults = results;
  card.appendChild(results);

  return card;
}

/* ------------------------------------------------------------------ */
/* 结果卡（切段呈现）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 画结果卡（失败 / 全程 / 每天 / 两条注脚）。
 *
 * @returns {Object|null} 卡片节点；还没有结果且没失败时返回 null。
 */
function _renderResultCard() {
  if (_state.routeError) {
    return h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('rt.resultTitle') }),
      h('p', { class: 'card-note', text: _state.routeError }),
    ]);
  }
  const sp = _state.split;
  const route = _state.route;
  if (!sp || !sp.ok || !route) return null;

  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.resultTitle') }),
    // ★全程用 Σ legs[].duration（界面展示口径），不是 Σ annotation
    h('p', {
      class: 'card-note',
      text: `${t('rt.totalLabel')}：${_dist(route.distanceM)} · ${_dur(route.durationS)} · ${t('rt.daysLabel', { n: sp.dayCount })}`,
    }),
  ]);

  if (sp.stopovers.length === 0) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.noStopover') }));
  }

  // 每天：driveFromPrevS / driveFromPrevM 是**实测求和值**（不是直线距离 ÷ 假想速度）
  for (let d = 1; d <= sp.dayCount; d += 1) {
    const so = sp.stopovers[d - 1];
    const sec = so ? so.driveFromPrevS : sp.tailSec;
    const m = so ? so.driveFromPrevM : sp.tailM;
    // ★两个数都拿不到才写「未知」；只有其中一个就照实写，另一个显示 '—'。
    //   「0 分钟 · —」不算已知（0 不是实测出来的），所以要求 sec > 0 才算数。
    const secOk = Number.isFinite(Number(sec)) && Number(sec) > 0;
    const mOk = Number.isFinite(Number(m));
    const text = !secOk && !mOk ? t('rt.dayDriveUnknown') : t('rt.dayDrive', { dur: _dur(sec), dist: _dist(m) });
    card.appendChild(
      h('div', { class: 'field' }, [
        h('p', { class: 'card-note', text: t('rt.dayTitle', { n: d }) }),
        h('p', { class: 'card-note', text }),
      ])
    );
  }

  if (sp.tailMergedSec > 0 && sp.tailMergedIntoDay) {
    card.appendChild(
      h('p', {
        class: 'card-note',
        text: t('rt.tailMerged', { min: String(Math.round(sp.tailMergedSec / 60)), n: sp.tailMergedIntoDay }),
      })
    );
  }

  // 吸附警示（E8：途经点被挪了必须让用户知道，否则「途经点被吸附」是静默造假）
  if (route.snapMaxM !== null && route.snapMaxM !== undefined && route.snapMaxM > 2000) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.snapWarn', { km: fmt.num(route.snapMaxM / 1000, 1, ' km') }) }));
  }

  // ★两条注脚：口径差 + 自由流。少任何一条都是在拿估算冒充实测。
  if (sp.driftRatio !== null && sp.driftRatio !== undefined) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.driftNote', { pct: (sp.driftRatio * 100).toFixed(2) }) }));
  }
  card.appendChild(h('p', { class: 'card-note', text: t('rt.freeflowNote') }));
  return card;
}

/* ------------------------------------------------------------------ */
/* 候选卡                                                              */
/* ------------------------------------------------------------------ */

/**
 * 取当前要搜的锚点（= 停留点）列表。
 *
 * @returns {Array<Object>} Stopover[]。
 */
function _anchors() {
  const sp = _state.split;
  return sp && sp.ok ? sp.stopovers : [];
}

/**
 * 画候选区（说明条 / 配额提示 / 类别开关 / 按钮 / 三类列表）。
 *
 * @returns {Object} 卡片节点。
 */
function _renderPoiCard() {
  const anchors = _anchors();
  const types = _state.poiTypes;
  const calls = anchors.length * types.length;

  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.poiTitle') }),
    h('p', { class: 'card-note', text: t('rt.poiHint') }),
  ]);

  // ★降级：没填 Key 只降级候选，求路 / 切段 / 保存照常（不许整页锁死）。
  //   注意这里**不 return** —— 下面三类列表照常画。
  if (!hasAmapKey()) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.poiNoKey') }));
    card.appendChild(
      h('div', { class: 'field field--row' }, [
        // ★只给「去填 Key」一条路，不给任何禁用态 —— 求路 / 切段 / 保存**照常可用**，
        //   把整页锁成「请先填 Key」等于拿一个可选能力绑架全部能力（文件头硬要求 4）。
        h('a', { class: 'btn', href: 'settings.html', text: t('rt.poiGoSettings') }),
      ])
    );
  }

  // ★配额提示：按下去**之前**就要写明几次、消耗几次
  if (anchors.length === 0) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.poiQuotaZero') }));
  } else {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.poiQuota', { a: anchors.length, t: types.length, n: calls }) }));
  }

  // 类别开关（收窄 = 直接减少配额消耗）
  const switchBox = h('div', { class: 'field field--row' });
  for (const type of POI_TYPES) {
    const on = types.indexOf(type) !== -1;
    const cb = h('input', { type: 'checkbox', id: `cb-${type}` });
    if (on) cb.setAttribute('checked', '');
    cb.addEventListener('change', () => {
      const next = on ? _state.poiTypes.filter((x) => x !== type) : _state.poiTypes.concat([type]);
      // ★绝不允许 0 个类别：那会「点一下搜 0 次」然后报搜完了 —— 是假成功
      _state.poiTypes = next.length > 0 ? next : [type];
      _renderPage();
    });
    switchBox.appendChild(h('label', { class: 'card-note' }, [cb, t(`rt.type.${type}`)]));
  }
  card.appendChild(switchBox);
  card.appendChild(
    h('div', { class: 'field field--row' }, [
      h('button', { class: 'btn', type: 'button', id: 'btn-only-stay', text: t('rt.poiOnlyStay') }),
      h('button', { class: 'btn', type: 'button', id: 'btn-all-types', text: t('rt.poiAllTypes') }),
    ])
  );
  card.appendChild(h('p', { class: 'card-note', text: t('rt.poiTypeHint') }));

  if (_state.poiProgress) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.poiSearching', { done: _state.poiProgress.done, n: _state.poiProgress.total }) }));
  }
  if (_state.poiError) {
    card.appendChild(h('p', { class: 'card-note', text: _state.poiError }));
  }

  const go = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    id: 'btn-poi',
    // ★没锚点 / 正在跑 / 没 Key → 禁用。禁用本身就是「不许点」的说明：
    //   报错是补救，禁用是不让错误发生。
    disabled: anchors.length === 0 || _state.busy !== '' || !hasAmapKey(),
    text: t('rt.poiBtn'),
  });
  card.appendChild(h('div', { class: 'field field--row' }, [go]));

  // ★手动添加：没 Key 时**必须**还能加（降级矩阵 §8），填了 Key 也照样能用。
  //   ★为什么不用「点了才提示没填名字」：那是补救；这里是**禁用**——
  //     名字为空时按钮不可点，用户根本撞不上那次失败（共享约定 §9 第 2 条）。
  //   ★三个控件都不绑整页重画：绑了会销毁输入框，焦点和光标一起没了。
  const manualInput = h('input', {
    class: 'btn',
    type: 'text',
    id: 'in-manual-name',
    placeholder: t('rt.poiManualPh'),
    value: _state.manualName,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const manualSel = h('select', { class: 'btn', id: 'sel-manual-type' });
  for (const type of POI_TYPES) {
    const opt = h('option', { value: type, text: t(`rt.type.${type}`) });
    if (type === _state.manualType) opt.setAttribute('selected', '');
    manualSel.appendChild(opt);
  }
  const manualBtn = h('button', {
    class: 'btn',
    type: 'button',
    text: t('rt.poiManualAdd'),
    disabled: String(_state.manualName || '').trim() === '',
  });
  manualInput.addEventListener('input', () => {
    const v = String(manualInput.value || '');
    _state.manualName = v;
    manualBtn.disabled = v.trim() === '';
  });
  manualBtn.addEventListener('click', () => {
    _state.manualType = manualSel && POI_TYPES.indexOf(manualSel.value) !== -1 ? manualSel.value : 'stay';
    _onManualAdd();
  });
  card.appendChild(h('div', { class: 'field field--row' }, [manualInput, manualSel, manualBtn]));

  // 三类列表：按 pass / fail / unknown 三分组
  const hasAnyBucket = Object.keys(_state.candidates).length > 0;
  for (const type of POI_TYPES) {
    const items = [];
    for (const a of anchors) {
      const bucket = _state.candidates[`${a.id}:${type}`];
      if (bucket && bucket.ok && Array.isArray(bucket.items)) items.push(...bucket.items);
    }
    // 一次都没搜过就先不画空列表 —— 画三张「没搜到」是噪音，不是信息
    if (items.length === 0 && !hasAnyBucket) continue;
    // ★喂给 `partitionByFilter()` 的必须是**带 type 的条目**：它按 `item.type` 取对应
    //   的筛选条件。高德候选本身没有这个字段（它的 `type` 是「住宿服务;宾馆酒店」这类
    //   原文），直接传进去会让 `type === null` 走到「没有筛选条件 = 原样通过」分支 ——
    //   界面表现为**全部落进「达标」、永远没有「未填」**，那正是把「看不清」伪装成
    //   「都挺好」，比报错还糟。所以这里补上 type，并把高德原文挪到 `category`
    //   （与 CheckIn 同字段），列表卡照 category 显示。
    //   ★房价 / 房型 / 等级这些**参与筛选的字段一律不补**：候选里没有就是没有，
    //   于是它们老老实实进 unknown 组并被计数。
    const filterable = items.map((c) => ({ ...c, type, category: c && c.type }));
    const groups = partitionByFilter(filterable, _filters());
    card.appendChild(
      renderPoiGroup({
        type,
        groups,
        adoptedIds: _state.adopted,
        onAdopt: (cand) => {
          _onAdopt(cand, type);
        },
      })
    );
  }

  if (_state.adoptedList.length > 0) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.checkedTitle', { n: _state.adoptedList.length }) }));
    for (const ck of _state.adoptedList) {
      card.appendChild(h('p', { class: 'card-note', text: `${ck.name || fmt.DASH}${ck.address ? ` · ${ck.address}` : ''}` }));
    }
  }
  return card;
}

/**
 * 找出一条候选属于哪个停留点（用于把 CheckIn 挂到对应那天）。
 *
 * @param {Object} cand 候选。
 * @returns {Object|null} Stopover 或 null。
 */
function _anchorOfCandidate(cand) {
  const id = String((cand && cand.id) || '');
  for (const a of _anchors()) {
    for (const type of POI_TYPES) {
      const bucket = _state.candidates[`${a.id}:${type}`];
      if (bucket && Array.isArray(bucket.items) && bucket.items.some((x) => String(x.id) === id)) return a;
    }
  }
  return null;
}

/**
 * 采用一条候选（转成 CheckIn，进内存里的行程）。
 *
 * ★候选本身**不落盘**：只有 `adoptCandidate()` 产出的 CheckIn 进 `adoptedList`，
 *   而 `adoptedList` 是在**保存**时才写进行程的。
 *
 * @param {Object} cand 候选。
 * @param {'stay'|'sight'|'food'} type 类别。
 * @returns {void}
 */
function _onAdopt(cand, type) {
  if (!cand || !cand.id) return;
  const anchor = _anchorOfCandidate(cand);
  const ck = adoptCandidate(cand, type, { stopoverId: anchor ? anchor.id : null });
  _state.adopted[String(cand.id)] = true;
  _state.adoptedList.push(ck);
  log('rt-adopt', type, String(cand.id));
  _renderPage();
}

/**
 * 手动添加一条打卡（没 Key 时的兜底路径，填了 Key 也照样能用）。
 *
 * ★手填的一条**没有** amapId / coord / rating，这些一律 null，绝不用假值补齐：
 *   编一个 0 分的评分，筛选时会把它判成「不达标」，那就是拿推算值冒充实测值。
 *   「未填」会被 `partitionByFilter()` 归进 unknown 组并计数 —— 这正是它该在的地方。
 *
 * @returns {void}
 */
function _onManualAdd() {
  const name = String(_state.manualName || '').trim();
  // 按钮在空名字时已禁用；这里是最后一道防线，不做提示（撞不上）
  if (name === '') return;
  const type = POI_TYPES.indexOf(_state.manualType) === -1 ? 'stay' : _state.manualType;
  const ck = adoptCandidate(
    {
      id: `manual:${Date.now()}`,
      name,
      coord: null,
      address: null,
      type: null,
      rating: null,
      raw: null,
      converted: false,
    },
    type,
    { stopoverId: null, coordSource: 'manual', source: 'manual' }
  );
  _state.adoptedList.push(ck);
  _state.manualName = '';
  log('rt-manual-add', type);
  _renderPage();
}

/**
 * 串行拉取全部候选（N×M 次，**一次一次来**）。
 *
 * ★为什么不并发：http.js 的全局队列并发恒为 1，硬并发只会排队，却让「还剩几次」这个
 *   进度变得不可预测；而并发还会撞高德的 QPS 限流（10004）。串行 + 实时进度是唯一
 *   诚实的写法 —— 用户看得见「第 3 次 / 共 12 次」。
 *
 * ★失败不整批作废：某个锚点的某次请求失败只记在它自己的桶里，其余继续。
 *   一次超时就把成功的那些全丢掉，是对用户配额的浪费。
 *
 * @returns {Promise<void>}
 */
async function _onSearchPoi() {
  const anchors = _anchors();
  const types = _state.poiTypes.slice();
  if (anchors.length === 0 || types.length === 0) return;

  _state.busy = 'poi';
  _state.poiError = '';
  _state.poiProgress = { done: 0, total: anchors.length * types.length };
  _renderPage();

  let firstError = '';
  for (const a of anchors) {
    if (!a.coord) continue;
    for (const type of types) {
      const res = await requestRoadSource('amapPoi', {
        lat: a.coord.lat,
        lon: a.coord.lon,
        typecode: AMAP_TYPES[type],
        radius: POI_RADIUS_M,
        keyword: '',
      });
      _state.poiProgress.done += 1;
      const key = `${a.id}:${type}`;
      if (!res || !res.ok) {
        const msg = errorText(res && res.error);
        if (firstError === '') firstError = msg;
        _state.candidates[key] = { ok: false, items: [], error: msg };
      } else {
        const items = res.data && Array.isArray(res.data.items) ? res.data.items : [];
        _state.candidates[key] = { ok: true, items, error: '' };
      }
      // 每完成一次就重画一次，让进度真的在动（并发 1 的前提下这一次重画是免费的）
      _renderPage();
    }
  }

  _state.poiProgress = null;
  _state.poiError = firstError;
  _state.busy = '';
  _renderPage();
}

/* ------------------------------------------------------------------ */
/* 存盘卡                                                              */
/* ------------------------------------------------------------------ */

/**
 * 画存盘卡 + 已保存行程列表。
 *
 * @returns {Object} 卡片节点。
 */
function _renderSaveCard() {
  const canSave = !!(_state.split && _state.split.ok);
  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.saveTitle') }),
    h('div', { class: 'field' }, [
      h('p', { class: 'card-note', text: t('rt.tripName') }),
      h('input', {
        class: 'btn',
        type: 'text',
        id: 'in-trip-name',
        placeholder: t('rt.tripNamePh'),
        value: _state.tripName,
        autocomplete: 'off',
      }),
    ]),
  ]);
  card.appendChild(
    h('div', { class: 'field field--row' }, [
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        id: 'btn-save',
        // 没切段结果就没有可存的行程：留着可点会存出一条空行程
        disabled: !canSave,
        text: t('rt.saveBtn'),
      }),
    ])
  );
  if (_state.saveMsg) card.appendChild(h('p', { class: 'card-note', text: _state.saveMsg }));

  // 已保存行程：★用「带回 skipped 的那个入口」—— 简版入口会静默丢数据，
  //   界面上表现为用户的行程凭空消失（理由见 core/tripstore.js 的 JSDoc）。
  //   ★字段名是 `trips` 不是 `list`：与 core 的返回形状对齐，写错就是 undefined.length。
  const { trips: list, skipped } = _state.trips;
  card.appendChild(h('p', { class: 'card-note', text: t('rt.tripListTitle', { n: list.length }) }));
  if (list.length === 0) card.appendChild(h('p', { class: 'card-note', text: t('rt.tripListEmpty') }));
  for (const trip of list) {
    card.appendChild(
      h('p', {
        class: 'card-note',
        text: t('rt.tripItem', { name: trip.name || fmt.DASH, days: trip.stopovers ? trip.stopovers.length + 1 : 1 }),
      })
    );
  }
  if (skipped.length > 0) {
    // ★打不开的必须**说出来**：静默丢掉就是「我的行程不见了」那类最难受的 bug
    card.appendChild(h('p', { class: 'card-note', text: t('rt.tripSkipped', { n: skipped.length }) }));
  }
  return card;
}

/**
 * 保存当前行程。
 *
 * ★`saveTrip()` 返回 false 是**真失败信号**（配额满 / schema 不认识），界面必须提示，
 *   不许静默 —— 静默的表现是「用户以为存好了，刷新之后什么都没有」。
 *
 * @returns {void}
 */
function _onSave() {
  const sp = _state.split;
  if (!sp || !sp.ok) return;
  const nameInput = _el('in-trip-name');
  if (nameInput) _state.tripName = String(nameInput.value || '');

  const trip = newTrip({ ..._state.plan, dailyTargetSec: _state.plan.dailyTargetSec });
  trip.name = _state.tripName;
  // ★不在这里压几何：`saveTrip()` 内部过 `slimTrip()`，几何在那道口子上被拦下。
  //   本模块**不**调用 slimRoute —— 落盘纪律只该有一个执行点，多了就会有一处被绕开。
  trip.route = _state.route || trip.route;
  trip.stopovers = sp.stopovers.slice();
  trip.checkIns = _state.adoptedList.slice();

  const ok = saveTrip(trip);
  _state.saveMsg = ok ? t('rt.saveOk', { name: trip.name || fmt.DASH }) : t('rt.saveFail');
  if (!ok) log('rt-save-fail', String(trip.id));
  // 保存完重读一次：存失败时列表不该多出一条 —— 列表必须反映**真实落盘结果**
  _state.trips = listTripsWithIssues();
  _renderPage();
}

/* ------------------------------------------------------------------ */
/* 求路（编排）                                                         */
/* ------------------------------------------------------------------ */

/**
 * 算路线并切段。
 *
 * @returns {Promise<void>}
 */
async function _onPlan() {
  const dateInput = _el('in-start-date');
  if (dateInput) _state.plan.startDate = String(dateInput.value || '') || null;
  const sel = _el('sel-daily');
  if (sel && Number.isFinite(Number(sel.value))) _state.plan.dailyTargetSec = Number(sel.value);

  const points = _points();
  if (points.length < 2) {
    // 不足 2 个点：用**已有的键**如实说，不自己编一句
    _state.routeError = tr({ key: 'rt.err.needMorePoints', params: { n: points.length } });
    _state.route = null;
    _state.split = null;
    _renderPage();
    return;
  }

  _state.busy = 'routing';
  _state.routeError = '';
  _renderPage();

  // ★走 requestRoadSource，不是 request：任何失败都是 SourceResult 形状
  const res = await requestRoadSource('osrmRoute', {
    points,
    overview: 'full',
    annotations: true,
  });

  _state.busy = '';
  if (!res || !res.ok) {
    _state.routeError = errorText(res && res.error);
    _state.route = null;
    _state.split = null;
    _state.candidates = {};
    _renderPage();
    return;
  }

  _state.route = res.data;
  const sp = splitStopovers(res.data, { dailyTargetSec: _state.plan.dailyTargetSec });
  if (!sp.ok) {
    // 切段失败：`reasonKey` 是 core 给的键，这里翻成人话（不自己编）
    _state.routeError = reasonText(sp);
    _state.split = null;
    _state.candidates = {};
  } else {
    _state.split = sp;
  }
  _renderPage();
}

/* ------------------------------------------------------------------ */
/* 路线图（T05）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 取第 n 天的起终点（用于「按天」再请求一次简化几何）。
 *
 * @param {number} day 第几天（1 起）。
 * @returns {Array<{lat:number, lon:number, name:string}>} 该段的起终点；凑不齐就返回短数组。
 */
function _dayEndpoints(day) {
  const sp = _state.split;
  const pts = _points();
  if (!sp || !sp.ok || pts.length < 2) return [];
  const startIdx = day - 2; // 第 1 天从上一个停留点（没有就是起点）开始
  const from = startIdx >= 0 && sp.stopovers[startIdx] ? sp.stopovers[startIdx].coord : pts[0];
  const to = sp.stopovers[day - 1] ? sp.stopovers[day - 1].coord : pts[pts.length - 1];
  const out = [];
  for (const c of [from, to]) {
    if (c && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lon))) {
      out.push({ lat: Number(c.lat), lon: Number(c.lon), name: String(c.name || '') });
    }
  }
  return out;
}

/**
 * 当前视图要用的求路点。
 *
 * @returns {Array<{lat:number, lon:number, name:string}>} 点序列。
 */
function _scopePoints() {
  return _state.mapScope === 'whole' ? _points() : _dayEndpoints(Number(_state.mapScope));
}

/**
 * 取当前视图的简化几何。
 *
 * ★为什么这里**只**用 `overview:'simplified'`：full 几何是百 KB 量级（体积口径见
 *   `src/data/osrm.js` 文件头，全仓唯一出处），而这张卡只有 350×260 px —— 726 km 的
 *   full 几何在这种尺寸下和 simplified 看不出区别，却要多传两个数量级的字节。
 *   ★两级策略（架构 §4.3.2）：整段一次；切到某天再用该段起终点请求一次。
 *
 * @returns {Promise<void>}
 */
async function _onLoadGeometry() {
  const pts = _scopePoints();
  if (pts.length < 2) return;
  const key = _state.mapScope === 'whole' ? 'whole' : `day:${_state.mapScope}`;
  _state.mapMsg = t('rt.mapFetching');
  _renderPage();

  const res = await requestRoadSource('osrmRoute', {
    points: pts,
    overview: 'simplified',
    annotations: false,
  });
  if (!res || !res.ok) {
    _state.mapGeo[key] = { ok: false, points: [], error: errorText(res && res.error) };
    _state.mapMsg = t('rt.mapGeoFail', { msg: errorText(res && res.error) });
  } else {
    const geo = Array.isArray(res.data && res.data.geometry) ? res.data.geometry : [];
    // OSRM 的几何是 [lon, lat]；★逐个判有限值 —— 缺分量的一律丢，不补 0（补 0 就是
    // 把「没画出来」画成几内亚湾上的一段线）
    const points = [];
    for (const g of geo) {
      if (Array.isArray(g) && Number.isFinite(Number(g[0])) && Number.isFinite(Number(g[1]))) {
        points.push({ lat: Number(g[1]), lon: Number(g[0]) });
      }
    }
    _state.mapGeo[key] = { ok: true, points, error: '' };
    _state.mapMsg = '';
  }
  _renderPage();
}

/**
 * 画路线图卡。
 *
 * @returns {Object} 卡片节点。
 */
function _renderRouteCard() {
  const sp = _state.split;
  const key = _state.mapScope === 'whole' ? 'whole' : `day:${_state.mapScope}`;
  const geo = _state.mapGeo[key];
  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.mapTitle') }),
    h('p', { class: 'card-note', text: t('rt.mapHint') }),
  ]);

  if (!sp || !sp.ok) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.mapEmpty') }));
    return card;
  }

  // 视图 chip：整段 / 第 N 天
  const chips = h('div', { class: 'field field--row' });
  const mkChip = (label, value) => {
    const on = _state.mapScope === value;
    const b = h('button', {
      class: on ? 'btn btn--primary' : 'btn',
      type: 'button',
      'data-scope': String(value),
      text: label,
    });
    b.addEventListener('click', () => {
      _state.mapScope = value;
      _state.mapMsg = '';
      _renderPage();
    });
    chips.appendChild(b);
  };
  mkChip(t('rt.mapWhole'), 'whole');
  for (let d = 1; d <= sp.dayCount; d += 1) mkChip(t('rt.dayTitle', { n: d }), d);
  card.appendChild(chips);

  card.appendChild(
    h('div', { class: 'field field--row' }, [
      h('button', { class: 'btn', type: 'button', id: 'btn-geo', text: t('rt.mapLoad') }),
    ])
  );

  if (_state.mapMsg) card.appendChild(h('p', { class: 'card-note', text: _state.mapMsg }));

  // 标记：停留点 + 已定位的打卡。★`coord` 为空的打卡**不传** —— roadmap.js 只画收到的点，
  //   但本层也不许把缺坐标的项塞进去（它们归「实录」列表里的「未定位」管）。
  const markers = [];
  for (const so of sp.stopovers) {
    if (so && so.coord && Number.isFinite(Number(so.coord.lat)) && Number.isFinite(Number(so.coord.lon))) {
      markers.push({ lat: so.coord.lat, lon: so.coord.lon, name: so.placeName || '', kind: 'stay' });
    }
  }
  for (const ck of _state.adoptedList) {
    if (ck && ck.coord && Number.isFinite(Number(ck.coord.lat)) && Number.isFinite(Number(ck.coord.lon))) {
      markers.push({ lat: ck.coord.lat, lon: ck.coord.lon, name: ck.name || '', kind: 'check' });
    }
  }

  const points = geo && geo.ok ? geo.points : [];
  const holder = h('div', { class: 'field' });
  card.appendChild(holder);
  renderRouteCard(holder, {
    points,
    markers: markers.length > 0 ? markers : _points(),
    schematic: !(geo && geo.ok && points.length >= 2),
    note: t('rt.mapGeo', { src: geo && geo.ok ? t('rt.mapGeoSimplified') : t('rt.mapGeoNone') }),
  });
  return card;
}

/* ------------------------------------------------------------------ */
/* 实录（T05）                                                          */
/* ------------------------------------------------------------------ */

/**
 * 画实录卡（已采用的打卡）。
 *
 * ★`coord` 为空的一条**只写在列表里、不上图**，并标注「未定位」：给它编一个坐标画上去，
 *   用户会以为自己真的在那儿停过 —— 那是把「没记录」伪装成「有记录」。
 *
 * @returns {Object} 卡片节点。
 */
function _renderRecordCard() {
  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.recordTitle') }),
    h('p', { class: 'card-note', text: t('rt.recordHint') }),
  ]);
  const list = _state.adoptedList;
  if (list.length === 0) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.recordEmpty') }));
    return card;
  }
  let noCoord = 0;
  for (const ck of list) {
    const located = !!(ck.coord && Number.isFinite(Number(ck.coord.lat)) && Number.isFinite(Number(ck.coord.lon)));
    if (!located) noCoord += 1;
    const addr = ck.address ? ` · ${ck.address}` : '';
    card.appendChild(
      h('p', {
        class: 'card-note',
        text: `${t('rt.recordItem', { name: ck.name || fmt.DASH, addr })}${located ? '' : ` · ${t('rt.mapNoCoord')}`}`,
      })
    );
  }
  if (noCoord > 0) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.recordNoLocated', { n: noCoord }) }));
  }
  return card;
}

/* ------------------------------------------------------------------ */
/* 搬家（导出 / 导入，T05）                                              */
/* ------------------------------------------------------------------ */

/**
 * 导出全部行程。
 *
 * ★导出的文件里含用户去过的地方（行程名、停留点、打卡坐标），与备份 JSON 同级敏感 ——
 *   所以提示语里必须写明「别发到公开场合」，且导出走 `exportTrips()`（内部过
 *   `slimTrip()`，几何在那道口子上被拦下）。
 *
 * @returns {void}
 */
function _onExport() {
  const { trips: list } = _state.trips;
  if (list.length === 0) {
    _state.moveMsg = t('rt.exportEmpty');
    _renderPage();
    return;
  }
  const name = roadtripFilename();
  downloadJson(name, exportTrips(list));
  _state.moveMsg = t('rt.exportOk', { n: list.length, file: name });
  _renderPage();
}

/**
 * 导入一份行程文件（先 inspect 预览，用户确认才 apply）。
 *
 * ★为什么不选完文件就写：导入是**覆盖性**操作（同 id 会被替换）。让用户先看见
 *   「将导入 N 条」再按确认，是把「误选一个月前的旧文件」从不可逆事故变成可撤销动作
 *   （照 `core/backup.js` 的「先 inspect 后 apply」两步法）。
 *
 * @param {string} text 文件内容。
 * @returns {void}
 */
function _onImportFile(text) {
  const ins = inspectTripFile(text);
  if (!ins.ok) {
    _state.importPlan = null;
    _state.moveMsg = t('rt.importFail', { msg: tr({ key: ins.reasonKey, params: ins.reasonParams }) });
    _renderPage();
    return;
  }
  _state.importPlan = ins.plan;
  _state.moveMsg = t('rt.importPreview', { n: ins.plan.trips.length, d: ins.plan.dropped });
  _renderPage();
}

/**
 * 真正落盘导入（`saveTrip()` 逐条写；返回 false 的条数要如实说）。
 *
 * @returns {void}
 */
function _onApplyImport() {
  const plan = _state.importPlan;
  if (!plan) return;
  const applied = applyTripFile(plan);
  if (!applied.ok) {
    _state.moveMsg = t('rt.importFail', { msg: tr({ key: applied.reasonKey }) });
    _renderPage();
    return;
  }
  let ok = 0;
  for (const trip of applied.trips) if (saveTrip(trip)) ok += 1;
  const failed = applied.trips.length - ok;
  _state.moveMsg =
    failed === 0
      ? t('rt.importOk', { n: ok })
      : `${t('rt.importOk', { n: ok })} · ${t('rt.saveFail')}`;
  _state.importPlan = null;
  _state.trips = listTripsWithIssues();
  _renderPage();
}

/**
 * 画搬家卡。
 *
 * @returns {Object} 卡片节点。
 */
function _renderMoveCard() {
  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.moveTitle') }),
    h('p', { class: 'card-note', text: t('rt.moveHint') }),
  ]);
  card.appendChild(
    h('div', { class: 'field field--row' }, [
      h('button', { class: 'btn', type: 'button', id: 'btn-export', text: t('rt.exportBtn') }),
      // 文件选择用原生 <input type="file">：本仓没有打包器，也不引第三方选择库
      h('input', { class: 'btn', type: 'file', id: 'in-trip-file', accept: 'application/json,.json' }),
    ])
  );
  if (_state.importPlan) {
    card.appendChild(
      h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-import-apply', text: t('rt.importApply') })
    );
  }
  if (_state.moveMsg) card.appendChild(h('p', { class: 'card-note', text: _state.moveMsg }));
  return card;
}

/* ------------------------------------------------------------------ */
/* 整页渲染与事件绑定                                                   */
/* ------------------------------------------------------------------ */

/**
 * 渲染整页（每次状态变化都整槽重建）。
 *
 * @returns {void}
 */
function _renderPage() {
  const app = _el('app');
  if (!app) return;
  app.textContent = '';
  _els.placeResults = null;
  // ★行节点登记表同样要清：旧节点已随 textContent='' 脱离文档，
  //   留着引用会让 _parkResults 把面板插进一个不在页面里的节点。
  _els.rows = {};

  app.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [
        h('h1', { class: 'hd-place', text: t('rt.title') }),
        h('p', { class: 'hd-coord', text: t('rt.subtitle') }),
      ]),
    ])
  );

  // 返回入口：本页不进 tabbar，必须给一条明确的回「我的」的路
  app.appendChild(
    h('div', { class: 'field field--row' }, [h('a', { class: 'btn', href: 'settings.html', text: t('rt.back') })])
  );

  app.appendChild(_renderPlanCard());
  const result = _renderResultCard();
  if (result) app.appendChild(result);
  app.appendChild(_renderPoiCard());
  app.appendChild(_renderRecordCard());
  app.appendChild(_renderRouteCard());
  app.appendChild(_renderSaveCard());
  app.appendChild(_renderMoveCard());

  _bindControls();
  _renderPlaceResults();
}

/**
 * 绑定事件。
 *
 * ★为什么每次重画都要重新绑：重画是**整槽重建**，控件全是新节点，旧监听随旧节点一起
 * 没了（settings.js 的 _bindControls 同一条理由）。漏掉这一步的表现是「按钮点了没反应」。
 *
 * @returns {void}
 */
function _bindControls() {
  const plan = _el('btn-plan');
  if (plan) plan.addEventListener('click', () => _onPlan());

  const addVia = _el('btn-via-add');
  if (addVia) {
    addVia.addEventListener('click', () => {
      if (_state.plan.via.length >= MAX_VIA) return;
      // 新槽位先占一个**空** PlaceRef：用户还没选地点，就是还没有 —— 不许给假坐标
      _state.plan.via.push(newPlaceRef({ source: 'search' }));
      _renderPage();
    });
  }

  const poi = _el('btn-poi');
  if (poi) poi.addEventListener('click', () => _onSearchPoi());

  const onlyStay = _el('btn-only-stay');
  if (onlyStay) {
    onlyStay.addEventListener('click', () => {
      _state.poiTypes = ['stay'];
      _renderPage();
    });
  }
  const allTypes = _el('btn-all-types');
  if (allTypes) {
    allTypes.addEventListener('click', () => {
      _state.poiTypes = POI_TYPES.slice();
      _renderPage();
    });
  }

  const save = _el('btn-save');
  if (save) save.addEventListener('click', () => _onSave());

  const geo = _el('btn-geo');
  if (geo) geo.addEventListener('click', () => _onLoadGeometry());

  const exp = _el('btn-export');
  if (exp) exp.addEventListener('click', () => _onExport());

  const applyImp = _el('btn-import-apply');
  if (applyImp) applyImp.addEventListener('click', () => _onApplyImport());

  const file = _el('in-trip-file');
  if (file) {
    file.addEventListener('change', () => {
      const f = file.files && file.files[0] ? file.files[0] : null;
      // ★没有 FileReader（测试台 / 老环境）就如实说读不了，不许静默当成功
      if (!f || typeof FileReader !== 'function') return;
      const reader = new FileReader();
      reader.onload = () => _onImportFile(String(reader.result || ''));
      reader.onerror = () => {
        _state.moveMsg = t('rt.importFail', { msg: t('app.unknown') });
        _renderPage();
      };
      reader.readAsText(f);
    });
  }

  // 表单里两个非受控输入（出发日期 / 行程名）**只在用的时候读**，不绑 input 事件：
  // 绑了就会每敲一下重画整页，输入框被销毁，焦点和光标一起没了。
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 页面入口。
 *
 * @returns {void}
 */
export function init() {
  // 已保存行程：进来就读一次（★用带回 skipped 的那个入口，不用会静默丢数据的简版）
  _state.trips = listTripsWithIssues();
  _renderPage();
  // 静态 HTML 里的 data-i18n 属性（title / meta）在渲染之后统一翻译一次。
  applyI18n(document);
  // ★再显式设一次 document.title：applyI18n 只会把 <title> 翻成页名（「自驾」），
  //   而 compare / selfcheck / settings 三页用的是「地候 GeoScope · 页名」——
  //   切到别的标签页 / 加书签时，带 App 名的那个标题才认得出来是哪一页。
  //   HTML 里那个简短 <title> 保留着：它是无 JS 时的兜底，不是死代码。
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('rt.title')}`;
  }
}

// 三个全站属性已在上面的模块顶层引导过（不在这里重复）。其余装配仍需守卫：Node 侧
// 静态检查 import 本模块时没有 document，不能渲染。
if (typeof document !== 'undefined' && document !== null) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
