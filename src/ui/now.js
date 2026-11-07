/**
 * 此刻屏渲染（纯渲染层）
 *
 * 职责：把 NowSnapshot 转成 DOM。网络、缓存、健康判定全部在上游完成，本模块只做
 * 「数据 → 节点」，不发起任何请求，保证可离线单测。
 *
 * 渲染策略：骨架先上屏（不转圈等待网络），随后按 [weather → air → elevation] 顺序
 * 逐卡增量替换；reverse（地名）与瓦片探测在首屏渲染完成后后台补齐。
 * 降级原则：有任何陈旧数据就上屏并标注陈旧时长，**绝不显示空白**。
 */

import { t, tr } from '../i18n/index.js';
import * as fmt from '../core/format.js';
import { wmo, aqi, uv, windDir16, beaufort } from '../core/wmo.js';
import { isDaylight } from '../core/sun.js';
// ★本模块**不许** import `core/mag.js` / `data/wmm2025.js`。
//   原因（2026-10-16 打包报错实证）：`src/ui/selfcheck.js` 只从本模块取 `h` 与 `applyI18n`
//   两个工具函数，于是本模块被登记进「数据源自检页」单文件产物的依赖闭包（build-standalone
//   的 ORDER）。一旦本模块 import 了 WMM，mag.js 26.6 KB + wmm2025.js 9.5 KB 就变成那个诊断页
//   的**死重量**（自检页从不显示磁偏角）。与 `ui/map.js` 同口径：闭包里只留真用得上的东西。
//   磁偏角数值由调用方（此刻页入口 `app.js`，不在闭包内）算好传进来，本模块只负责读法。
// 收藏状态读写走 store（唯一真相源）。依赖方向 ui → core，与 settings.js 一致。
import { isFavorite, addFavorite, removeFavorite } from '../core/store.js';
// 地点搜索：状态机在 placesearch.js（纯逻辑），这里只负责把 state 画成 DOM。
import {
  createPlaceSearch,
  placeHref,
  SEARCH_MIN_CHARS,
  SEARCH_STATUS,
} from './placesearch.js';
// 指标释义（图例）：静态内容，不依赖任何数据源，所以骨架期就建槽上屏 ——
// 离线 / 取数失败时它也必须在，释义不是「有数据才配看」的东西。
import { renderLegend } from './legend.js';

/** 收藏反馈文案的停留时长（毫秒）：给一眼就够，不长驻、不挡内容。 */
const FAV_HINT_MS = 2000;

/**
 * 把静态 HTML 外壳里的占位替换成真实文案。
 *
 * 目的：HTML 不硬编码任何中文，文案统一由 i18n 提供（架构约定第 11 条）。
 * 三种占位，缺哪一种都会漏掉一类「界面上其实是中文」的地方：
 *
 *   - `data-i18n="key"`                → 元素**文本**（标题、按钮、tab、列表项）
 *   - `data-i18n-attr="content"`       → `content` **属性值**（<meta> 的 description /
 *                                        apple-mobile-web-app-title —— 它们没有子元素，
 *                                        文本替换够不着，而 iOS 主屏图标名是**看得见**的）
 *   - `data-i18n-aria="key"`           → `aria-label`（读屏软件念的导航名，同样看得见 ——
 *                                        只是用耳朵看）
 *
 * ★只认这三个显式属性，不去做「扫描所有属性找中文」那种聪明事：那会把 URL、
 *   CSS 类名、data-* 数据一起误伤，而且一旦误伤是静默的。
 *
 * @param {ParentNode} [root] 根节点，默认 document。
 * @returns {void}
 */
export function applyI18n(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const attr = el.getAttribute('data-i18n-attr');
    const key = el.getAttribute(`data-i18n-key`);
    if (attr && key) el.setAttribute(attr, t(key));
  });
  scope.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    if (key) el.setAttribute('aria-label', t(key));
  });
}

/**
 * 向读屏播报一条短消息（#live 是 role="status" 的视觉隐藏区）。
 *
 * 先清空再写入：读屏只在文本变化时播报，连续两次同一句话若不清空会被吞掉。
 * 页面没有 #live（例如自检页）时静默跳过，绝不抛异常。
 *
 * @param {string} text 播报文本。
 * @returns {void}
 */
export function announce(text) {
  if (!text || typeof document === 'undefined') return;
  const el = document.getElementById('live');
  if (!el) return;
  el.textContent = '';
  // rAF 让清空与写入分属两帧，确保辅助技术能感知到一次新的文本变化
  const write = () => { el.textContent = String(text); };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(write);
  else write();
}

/**
 * 极简 DOM 构造器（零依赖替代 JSX / 模板引擎）。
 *
 * @param {string} tag 标签名。
 * @param {Object} [props] 属性表；class / text 有专门处理。
 * @param {Array<Node|string>|string} [children] 子节点。
 * @returns {HTMLElement} 元素。
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  Object.keys(props || {}).forEach((k) => {
    const v = props[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  });
  const list = typeof children === 'string' ? [children] : children || [];
  list.forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

/**
 * 清空并写入容器。
 *
 * @param {HTMLElement} box 容器。
 * @param {Array<Node>} nodes 子节点。
 * @returns {void}
 */
function _fill(box, nodes) {
  if (!box) return;
  box.textContent = '';
  nodes.forEach((n) => n && box.appendChild(n));
}

/**
 * 取（或创建）卡片容器，保证增量渲染时位置稳定。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} id 卡片 id（不含 'card-' 前缀）。
 * @returns {HTMLElement} 容器元素。
 */
function _slot(root, id) {
  const domId = `card-${id}`;
  let box = root.querySelector(`#${domId}`);
  if (!box) {
    box = h('div', { class: 'card-slot', id: domId });
    root.appendChild(box);
  }
  return box;
}

/**
 * 键值项。
 *
 * @param {string} key 标签文案。
 * @param {string} value 值文案。
 * @param {string} [mod] 修饰类：'hot' | 'cold' | 'alert' | ''。
 * @returns {HTMLElement} kv-item。
 */
function _kv(key, value, mod = '') {
  return h('div', { class: 'kv-item' }, [
    h('span', { class: 'kv-k', text: key }),
    h('span', { class: mod ? `kv-v kv-v--${mod}` : 'kv-v', text: value }),
  ]);
}

/**
 * 状态徽标。
 *
 * @param {string} status 状态词：ok | stale | degraded | failed | offline | idle。
 * @returns {HTMLElement} chip。
 */
function _chip(status) {
  return h('span', { class: `chip chip--${status}` }, [
    h('span', { class: `badge badge--${status}` }),
    t(`status.${status}`),
  ]);
}

/* ------------------------------------------------------------------ */
/* 骨架屏                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染骨架屏（立即出，不转圈等待网络）。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderSkeleton(root) {
  if (!root) return;
  root.textContent = '';

  root.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [h('h1', { class: 'hd-place', text: t('app.tagline') })]),
      h('div', { class: 'hd-time', text: t('app.loading') }),
    ])
  );
  // ★搜索槽必须在 weather / air / climate / prov **之前**建：槽位顺序由首次创建
  //   那一刻决定（appendChild 的先后），建晚了搜索面板会掉到页面最底下。
  root.appendChild(_slot(root, 'search'));
  root.appendChild(_slot(root, 'weather')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'air')).appendChild(h('div', { class: 'sk' }));
  // 气候常态槽（1991–2020 月平均）：紧跟 air 之后。
  //   理由（为什么不插在实时数据卡之间 / 为什么不放在最后）：它是**查阅物**
  //   （要点按钮才取 303 KB 的 30 年再分析），不是首屏数据；但它又是「这个地点 30 年的
  //   属性」，跟着地点与实时数据一起看才讲得通，压到页面最底下会让人以为它是附录。
  // ★顺序由首次创建那一刻决定（appendChild 的先后），建错位置就再也挪不回去。
  //
  // ★2026-10-17 导航重构：本骨架是**气候页**（index.html）的骨架，槽位从
  //   `search→weather→air→place→climate→map→bearing→prov→legend` 瘦身为
  //   `search→weather→air→climate→prov→legend` —— place / map / bearing 三块随
  //   「地理」主 tab 一起搬到 `ui/compass.js` 的骨架里（那里现在是
  //   `header→search→place→map→declination→model→convert→compass→prov`：
  //   bearing 槽已于 2026-10-26 连同「方位 · 磁偏角」概览卡一并删除 ——
  //   它与磁偏角详情卡在同一屏里把同一个数说两遍）。
  //   ⚠️ `renderPlaceCard` 这个导出**仍在**（地理页要 import），只是本骨架不再给它建槽
  //   —— 调用方必须先建槽（`compass.js` 自己建），否则渲染会静默落到页面末尾。
  root.appendChild(_slot(root, 'climate'));
  root.appendChild(_slot(root, 'prov'));
  // 指标释义入口放**最后**（页面底部）：它是查阅物，不该插在数据卡之间把首屏撑长。
  // 槽位顺序由首次创建那一刻决定，建在 prov 之后就再也挪不回去了。
  renderLegend(root);
}

/* ------------------------------------------------------------------ */
/* 降级横幅                                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染顶部降级横幅。
 *
 * @param {HTMLElement} bannerEl 横幅容器。
 * @param {'live'|'stale'|'partial'|'grid'|'offline'|'no-map'|'empty'} mode 整体降级态。
 * @param {{staleAgeMs?:number}} [extra] 附加信息。
 * @returns {void}
 */
export function renderBanner(bannerEl, mode, extra = {}) {
  if (!bannerEl) return;
  if (!mode || mode === 'live') {
    bannerEl.hidden = true;
    bannerEl.textContent = '';
    return;
  }
  bannerEl.hidden = false;
  // 变体名直接由 mode 拼出：grid → .banner--grid，因此 app.css 必须为
  // renderBanner 能拿到的每个 mode 都备一条 .banner--* 规则，否则样式会静默退回基础横幅。
  bannerEl.className = `banner banner--${mode}`;
  // 徽点只有 offline / stale 两色。grid 与 partial 都复用琥珀点（--c-state-stale）：
  // 三者同属「降级」语义，不必为每种降级配一个色值；真正区分它们的是横幅底色与文案。
  const nodes = [h('span', { class: `badge badge--${mode === 'offline' ? 'offline' : 'stale'}` })];
  nodes.push(h('span', { text: t(`mode.${mode}`) }));
  if (extra.staleAgeMs && extra.staleAgeMs > 0) {
    // 陈旧时长：format.staleFor() 给的是结构化量，tr() 才翻译成话（英文是 "3 min"）
    nodes.push(h('span', { class: 'num', text: `（${tr(fmt.staleFor(extra.staleAgeMs))}）` }));
  }
  _fill(bannerEl, nodes);
}

/* ------------------------------------------------------------------ */
/* 顶部标题                                                             */
/* ------------------------------------------------------------------ */

/**
 * 取「此刻该收藏的地点」——**点击时现算**，不在构造按钮时抓快照。
 *
 * 为什么必须现算：GPS 定位成功后、逆地理（Photon）还没回来的那一秒多里，
 * `snapshot.placeName` 与 `coord.name` 都是 null —— 那是**常态**，用户加载完顺手点 ☆
 * 比等一个网络往返快得多。若在按钮构造那一刻把地名抓进闭包，存进去的就是
 * `{lat, lon, name: ''}`，在「我的」页显示成「未命名地点」，跳回去只剩坐标。
 *
 * 兜底：名字为空（反查未回 / 反查失败 / 默认地点没名字）时用**坐标串**兜底，
 * 复用 core/format.js 的 coord()（'22.5431°N, 114.0579°E'），不另造一套格式化。
 * 理由：空串在列表里是「未命名」，坐标至少能让人认出是哪儿、跳回去也显示得出来。
 *
 * ★反过来**绝不**为了拿地名去等逆地理返回 —— 那会让收藏按钮卡住或延迟。
 * 宁可先存坐标串。
 *
 * @param {Object} snapshot NowSnapshot。
 * @returns {{lat:number, lon:number, name:string}|null} 可收藏的地点；
 *   无坐标或坐标非有限数字时返回 null（存不出能跳回去的收藏）。
 */
function _favPlaceOf(snapshot) {
  const c = snapshot && snapshot.coord ? snapshot.coord : null;
  if (!c) return null;
  const lat = Number(c.lat);
  const lon = Number(c.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const raw = snapshot.placeName || c.name || '';
  const name = String(raw).trim();
  return { lat, lon, name: name || fmt.coord(lat, lon) };
}

/**
 * 收藏按钮（toggle：已收藏再点一次就是取消）。
 *
 * 三件事必须同时成立，缺一个这颗按钮就是死的：
 *   1) **状态从 store 读**（isFavorite），不是从上次渲染的记忆里读 —— 标题区会被
 *      renderHeader 整槽重建多次，靠记忆会与 store 漂移；
 *   2) **点了就地翻转**（改文案 / 改配色 / 改 aria-pressed），用户立刻看得见；
 *   3) **aria-pressed** 跟着状态走，读屏软件才知道这是开关而不是普通按钮。
 *
 * ★第四条（缺陷 A 回改后固化，勿回退）：**名字在 click 那一刻才读**，不在构造时抓
 * 闭包 —— 这颗按钮出生时逆地理往往还没回来，抓闭包就会把「未命名地点」存进收藏。
 * 坐标（lat/lon）可以在构造时定下来：renderHeader 整槽重建就是换一颗新按钮，
 * 而同一颗按钮活着期间坐标不会变。
 *
 * 关于「反查到地名后把已存进来的坐标串补写回真实地名」：本轮**明确不做**，理由见
 * _favPlaceOf() 上方与 renderHeader() 的注释 —— 那需要「删旧条再插新条」以维持
 * store 的 lat+lon 去重口径（条目会被挪到列表末尾），还要靠正则去猜「这条 name 是
 * 不是坐标兜底串」，并且会让纯渲染层反过来写 store。收益只是把可读的坐标串换成
 * 更好看的真名，不值得付这个代价。
 *
 * 配色两态复用既有的 `.btn`（未收藏）与 `.btn--primary`（已收藏）—— 这两条规则的
 * 白字/实心底组合已经过 tools/contrast-audit.mjs，不新增任何 color 声明。
 *
 * @param {Object} snapshot NowSnapshot（持有**活跃引用**：后台反查把 placeName 改写
 *   之后，下一次点击读到的就是新值）。
 * @returns {HTMLElement|null} 按钮容器（按钮 + 行内反馈）；无可用坐标时 null。
 */
function _favButton(snapshot) {
  const place = _favPlaceOf(snapshot);
  if (!place) return null;
  const lat = place.lat;
  const lon = place.lon;

  const btn = h('button', { type: 'button', class: 'btn fav-btn' });
  // 反馈位用「有没有字」表示显隐，不用 hidden 属性：整槽重建后属性容易被落下，
  // 空 span 本来就不占版面，比一个可能卡住的 hidden 更省心。
  const hint = h('span', { class: 'hd-hint' });
  /** @type {any} 反馈计时器（浏览器给 number，Node 给 Timeout 对象）。 */
  let timer = null;

  /** 把按钮刷成当前收藏态。 */
  const sync = () => {
    const on = isFavorite(lat, lon);
    btn.className = on ? 'btn btn--primary fav-btn fav-btn--on' : 'btn fav-btn';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? `★ ${t('fav.added')}` : `☆ ${t('fav.add')}`;
  };
  sync();

  btn.addEventListener('click', () => {
    const was = isFavorite(lat, lon);
    // toggle：已收藏 → 取消；未收藏 → 存进来。removeFavorite 的返回值区分
    // 「删掉了」与「本来就没有」，但按钮只按**最新**状态刷新，所以两种情况
    // 都会收敛到「未收藏」，不需要分支。
    if (was) removeFavorite(lat, lon);
    // ★现读：不复用构造时算好的 place.name —— 那一刻逆地理常常还没回来。
    // 兜底逻辑（空名 → 坐标串）也在 _favPlaceOf 里，两处共用同一把尺子。
    else addFavorite(_favPlaceOf(snapshot) || place);
    sync();

    hint.textContent = was ? t('fav.removedHint') : t('fav.addedHint');
    if (timer) clearTimeout(timer);
    // 用完就清成空串 —— 反馈不该常驻，它只是确认「这次点击生效了」
    timer = setTimeout(() => {
      hint.textContent = '';
    }, FAV_HINT_MS);
    // Node 侧（测试）挂着这个定时器会把进程多吊 2 s；浏览器返回的是数字，没有 unref。
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  return h('div', { class: 'hd-fav' }, [btn, hint]);
}

/* ------------------------------------------------------------------ */
/* 地点搜索（放大镜入口 + 内联展开面板）                                 */
/* ------------------------------------------------------------------ */

/** @type {Object|null} 搜索控制器单例（状态必须活过整槽重建）。 */
let _placeSearch = null;

/** @type {HTMLElement|null} 当前面板里的「状态行 + 结果列表」容器。 */
let _searchBodyEl = null;

/**
 * 选中搜索结果后跳到**哪一页**（默认 `index.html` 气候页）。
 *
 * ★为什么是模块级变量而不是参数：每个 HTML 都是独立 JS 环境（四张页靠 `<a href>` 整页
 *   跳转，没有共享内存），所以一次赋值就是整页生效，不存在「两个页面同时用同一份模块
 *   实例」的情形。地理页在自己的入口里调一次 `setSearchTarget('compass.html')` 即可。
 *
 * ★不改 `placeHref()` 去猜当前页：`placeHref` 是纯函数且被测逐条钉住，让它去读
 *   `location` 会把「跳哪一页」这件事藏进一个看起来与页面无关的工具函数里。
 *
 * @param {string} page 目标页文件名（如 'compass.html'）。
 * @returns {void}
 */
let _searchTarget = 'index.html';
export function setSearchTarget(page) {
  if (typeof page === 'string' && page) _searchTarget = page;
}

/**
 * 搜索控制器单例（懒建）。
 *
 * 为什么必须是**模块级**：`renderHeader()` 每次都整槽 `_fill` 重建（一次 boot 至少三次：
 * 定位后 / weather 回来后 / reverse 回来后）。面板里的字与结果如果跟着 DOM 一起被重建，
 * 用户打了一半的关键词会被抹掉 —— 所以状态住在 `placesearch.js` 的控制器里，这里只是
 * 每次照着 `state` 重画一遍。
 *
 * @returns {Object} 控制器。
 */
function _search() {
  if (_placeSearch) return _placeSearch;
  _placeSearch = createPlaceSearch({
    onPick: (place) => {
      // 跳回本页所属的主页并带上坐标：入口模块的 parsePlaceParam 会解析它并**跳过定位**，
      // 与收藏跳转走的是同一条通路（source 都是 'explicit'）。
      // ★目标页由 `setSearchTarget()` 决定（地理页跳地理页、气候页跳气候页），见下面那条注释。
      const href = placeHref(place, _searchTarget);
      if (!href) return; // 坐标非法：宁可不跳，也不跳到一个会静默定位的页面
      if (typeof location === 'undefined' || !location) return; // Node 侧无 location
      location.href = href;
    },
    onChange: () => _renderSearchBody(),
  });
  return _placeSearch;
}

/**
 * 重画面板里的状态行与结果列表（**不动输入框**）。
 *
 * 为什么只画这一块：每敲一个字都会触发 `input()` → 状态变化 → 重画。若连输入框一起重画，
 * 每敲一下节点就被换掉，光标与焦点当场丢失，中文输入法的候选也会被打断。
 *
 * @returns {void}
 */
function _renderSearchBody() {
  if (!_searchBodyEl) return;
  _fill(_searchBodyEl, _searchBodyNodes());
}

/**
 * 按当前状态生成「状态行 / 结果列表」节点。
 *
 * 五种状态各自的文案都走 i18n。**失败与无结果必须是两句不同的话**：合成一句「没找到」
 * 会把超时 / 断网伪装成「这地方不存在」。
 *
 * @returns {Array<HTMLElement>} 节点列表。
 */
function _searchBodyNodes() {
  const ps = _search();
  const nodes = [];
  const st = ps.status;
  if (st === SEARCH_STATUS.SHORT) {
    nodes.push(h('p', { class: 'search-status', text: t('search.minChars', { n: SEARCH_MIN_CHARS }) }));
  } else if (st === SEARCH_STATUS.LOADING) {
    nodes.push(h('p', { class: 'search-status', text: t('search.loading') }));
  } else if (st === SEARCH_STATUS.EMPTY) {
    nodes.push(h('p', { class: 'search-status', text: t('search.empty') }));
  } else if (st === SEARCH_STATUS.ERROR) {
    nodes.push(h('p', { class: 'search-status', text: t('search.failed') }));
    // 第二行是 http.js 已经本地化好的具体原因（「请求超时（6000 ms 内未响应）」之类）
    if (ps.errorMessage) {
      nodes.push(h('p', { class: 'search-status', text: ps.errorMessage }));
    }
  } else if (st === SEARCH_STATUS.OK) {
    nodes.push(h('div', { class: 'search-list' }, ps.results.map((p) => _searchItem(p))));
  }
  return nodes;
}

/**
 * 渲染一条搜索结果。
 *
 * 次行的 `admin1 · country` 是**同名多地消歧的唯一凭据** —— 「北京 · 北京市 · 中国」
 * 与别处的同名地全靠它分开。两者都可能为 null（Open-Meteo 对小地方经常只给一半），
 * 那种情况整行不渲染，绝不能拼出 "null" 或孤零零的 " · "。
 *
 * @param {Object} place 地点（name/lat/lon/admin1/admin2/country）。
 * @returns {HTMLElement} 可点击的结果项。
 */
function _searchItem(place) {
  const p = place && typeof place === 'object' ? place : {};
  const name = String(p.name || '').trim();
  // ★admin2 也要带上：**省级相同、地级不同**的同名地靠 admin1 分不开 ——
  //   云南的丽江市 / 曲靖市 / 昆明市各有一个叫「上海」的村庄（真机实测截图的来源）。
  //   `admin1 === admin2` 时去重，否则直辖市会拼成「北京市 · 北京市 · 中国」。
  const sub = [p.admin1, p.admin2, p.country]
    .filter((v, i, arr) => v && arr.indexOf(v) === i)
    .join(' · ');
  const btn = h('button', { type: 'button', class: 'search-item' }, [
    h('span', { class: 'search-item-name', text: name || t('search.unnamed') }),
  ]);
  if (sub) btn.appendChild(h('span', { class: 'search-item-sub', text: fmt.placeTitle(sub) }));
  btn.addEventListener('click', () => _search().pick(p));
  return btn;
}

/**
 * 渲染（或收起）搜索面板。
 *
 * 面板挂在**独立槽位** `#card-search` 上，不在 `.hd` 里 —— `.hd` 会被 renderHeader
 * 整槽重建，放进去等于每次重画都把面板连根拔掉。槽位由 renderSkeleton 在 `.hd` 之后
 * 建好（顺序由首次创建那一刻决定，见 renderSkeleton 的注释）。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderSearchPanel(root) {
  const ps = _search();
  const slot = _slot(root, 'search');
  if (!ps.isOpen) {
    _searchBodyEl = null;
    slot.textContent = '';
    slot.hidden = true;
    return;
  }
  slot.hidden = false;

  // ★已经开着的面板不重建：整块重建会把正在输入的 <input> 换成新节点，
  //   焦点丢失、手机输入法被迫中断 —— 用户感受就是「打字打着就卡死」。
  //   标题区会随定位/取数反复重渲染（renderHeader → 这里），所以这条是必须的。
  const live = slot.querySelector('.search-panel');
  if (live) {
    const inp = live.querySelector('.search-input');
    if (inp) {
      inp.setAttribute('placeholder', t('search.placeholder'));
      inp.setAttribute('aria-label', t('search.open'));
    }
    _renderSearchBody();
    return;
  }

  const input = h('input', {
    class: 'search-input',
    type: 'search',
    placeholder: t('search.placeholder'),
    'aria-label': t('search.open'),
  });
  // value 是**属性**不是特性：h() 只管 setAttribute，值必须单独写进去
  input.value = ps.text;
  input.addEventListener('input', () => {
    const raw = input.value === null || input.value === undefined ? '' : input.value;
    ps.input(String(raw));
  });

  const body = h('div', { class: 'search-body' });
  _searchBodyEl = body;
  _fill(slot, [
    h('div', { class: 'search-panel' }, [
      h('div', { class: 'search-field' }, [input]),
      body,
    ]),
  ]);
  _renderSearchBody();
  if (typeof input.focus === 'function') input.focus();
}

/**
 * 放大镜入口按钮（点击才展开面板）。
 *
 * 不把搜索框常驻在标题那一排：那一排已经有地名 + 坐标 + 观测时刻 + 收藏按钮，
 * 再塞一个输入框会挤到断行。默认收起，用户想搜再点。
 *
 * @param {HTMLElement} root 根容器（展开后面板要挂到它的槽位上）。
 * @returns {HTMLElement} 按钮。
 */
export function searchButton(root) {
  const ps = _search();
  const label = ps.isOpen ? t('search.close') : t('search.open');
  const btn = h('button', {
    type: 'button',
    class: 'btn hd-search-btn',
    'aria-expanded': ps.isOpen ? 'true' : 'false',
    'aria-label': label,
    title: label,
  }, ['🔍']);
  btn.addEventListener('click', () => {
    ps.toggle();
    const next = ps.isOpen ? t('search.close') : t('search.open');
    btn.setAttribute('aria-expanded', ps.isOpen ? 'true' : 'false');
    btn.setAttribute('aria-label', next);
    btn.setAttribute('title', next);
    renderSearchPanel(root);
  });
  return btn;
}

/**
 * 渲染标题区（地点名 + 坐标 + 观测时刻 + 收藏按钮 + 搜索入口）。
 *
 * 整槽替换（_fill）会重建 .hd 里的全部节点，所以按钮上的 click 监听不会重复绑定 ——
 * 每次渲染都是一颗新按钮，状态也顺带从 store 重新读一遍。
 *
 * 无坐标（或坐标不是有限数字）时不给收藏按钮：store 的收藏以 lat+lon 为身份，
 * 没有坐标就存不出一条能跳回去的收藏，放一颗点了没反应的按钮比不放更糟。
 *
 * 为什么不做「反查到地名后回写已存条目的名字」：那要先把旧条目删掉再插新的
 * （store 以 lat+lon 去重，没有就地改名的 API），条目会因此被挪到列表末尾 ——
 * 一次后台网络回调悄悄改掉用户的列表顺序，是新的不可预期行为；判据又只能靠正则
 * 去猜「这条 name 是不是坐标兜底串」。纯渲染层也不该反过来写 store（见本文件头）。
 * 缺陷 A 的核心伤害（空串 → 「未命名地点」）已由 _favPlaceOf 的坐标兜底消除。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @param {{isDefaultPlace?:boolean}} [opts] 选项。
 * @returns {void}
 */
export function renderHeader(root, snapshot, opts = {}) {
  const hd = root.querySelector('.hd');
  if (!hd) return;
  const placeName = snapshot.placeName || (snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.unknown'));
  const right = snapshot.atMs ? t('now.observeAt', { time: fmt.hhmm(snapshot.atMs, snapshot.weather && snapshot.weather.tzOffsetSec ? snapshot.weather.tzOffsetSec : 0) }) : t('app.loading');

  // 缓存命中的年龄：取各源里**最旧**的一次命中（对用户最保守），只补一行，避免多源各报一遍
  let cachedAgeMs = 0;
  (snapshot.provenance || []).forEach((p) => {
    if (!p || !p.fromCache) return;
    const age = Number(p.cacheAgeMs);
    if (Number.isFinite(age) && age > cachedAgeMs) cachedAgeMs = age;
  });
  const freshLine = cachedAgeMs > 0
    ? h('p', { class: 'hd-fresh', text: t('prov.cachedAgo', { ago: tr(fmt.relativeTime(Date.now() - cachedAgeMs)) }) })
    : null;

  _fill(hd, [
    h('div', {}, [
      // 地名与搜索入口同一行：地名本身的位置与层级不变，只是在它右侧多一颗按钮
      h('div', { class: 'hd-place-row' }, [
        h('h1', { class: 'hd-place', text: fmt.placeTitle(placeName) }),
        searchButton(root),
      ]),
      h('p', { class: 'hd-coord num', text: snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.dash') }),
      // ★海拔进页头（2026-10-17）：地点卡搬去地理页之后，气候页不再有 place 槽，
      //   但海拔这个数不该凭空消失 —— 设计文档 §4.2 把 elevationM 在气候页的去处
      //   定成「页头显示」，所以这里补一行。
      //   ★只有真正拿到数字才显示：拿不到就整行缺席，绝不写 0 或占位符冒充实测值。
      Number.isFinite(Number(snapshot.elevationM))
        ? h('p', { class: 'hd-coord num', text: `${t('w.elevation')} ${fmt.elevationM(snapshot.elevationM)}` })
        : null,
      opts.isDefaultPlace ? h('p', { class: 'hd-coord', text: t('now.defaultPlaceNotice') }) : null,
      // 收藏的是**当前显示的地点**：坐标取 snapshot.coord，名字优先用反查出来的地名
      // （coord 自带的 name 只在收藏跳转 / 默认地点这类已知名字的场景下存在）。
      // 传整个 snapshot 而不是算好的 place —— 名字要留到 click 那一刻才读。
      _favButton(snapshot),
    ]),
    h('div', { class: 'hd-time' }, [right, freshLine]),
  ]);
  // 搜索面板不在 .hd 里：整槽重建会把它连根拔掉，所以挂到独立槽位上重画一次
  renderSearchPanel(root);
}

/* ------------------------------------------------------------------ */
/* 天气卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染天气卡（首屏第一张，出数即上屏）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderWeatherCard(root, snapshot) {
  const w = snapshot.weather;
  const box = _slot(root, 'weather');
  if (!w) {
    _fill(box, [_emptyCard(t('mode.empty'))]);
    return;
  }

  const tzOffset = Number(w.tzOffsetSec) || 0;
  const day = snapshot.atMs
    ? isDaylight(snapshot.atMs, snapshot.coord || { lat: 0, lon: 0 })
    : true;
  const desc = wmo(w.wmoCode, day);
  const wind = windDir16(w.windDeg);
  const bf = beaufort(w.windMs);
  const uvInfo = uv(w.uvMax);

  // 大数字走等宽数字，单位单独小字，避免「23°°C」重复单位
  // 读屏播报：天气每次上屏/刷新都播一次「温度 + 天气」短句
  announce(t('a11y.weather', { temp: fmt.tempC(w.tempC), desc: t(desc.key) }));

  const tempNode = h('div', { class: 'hero-temp' }, [
    fmt.num(w.tempC, 0),
    h('span', { class: 'unit', text: t('w.unitC') }),
  ]);

  const kvGrid = h('div', { class: 'kv' }, [
    _kv(t('w.feels'), fmt.tempC(w.feelsC)),
    _kv(t('w.humidity'), fmt.humidity(w.humidityPct)),
    // 降水量（mm）与降水概率（%）是**两个不同的量**，必须先后来、各用自己的标签。
    // 早先界面只有「降水」一项，说的其实是降水量；概率一直取到了（hourlyPopPct）却没上屏。
    // 两者都缺失时各显示占位符「—」，绝不把概率的空值显示成 0%（那会被读成「确定不下雨」）。
    _kv(t('w.precip'), fmt.precipMm(w.precipMm)),
    _kv(t('w.pop'), fmt.percent(w.popNowPct)),
    // 风向：core 只给键（core 不许读 locale 表），「风」这个字由 w.windFrom 一条模板补上
    // —— 中文是后缀（西北偏北风）、英文是介词（wind from NNW），语序不同，不能拼片段。
    _kv(t('w.wind'), `${fmt.num(w.windMs, 1, 'm/s')} · ${t('w.windFrom', { dir: t(wind.abbrKey) })}`),
    _kv(t('w.pressure'), fmt.pressure(w.pressureHpa)),
    _kv(t('w.visibility'), fmt.visibility(w.visibilityM)),
    _kv(t('w.sunrise'), fmt.hhmm(w.sunriseAt, tzOffset)),
    _kv(t('w.sunset'), fmt.hhmm(w.sunsetAt, tzOffset)),
    // 昼长：format.duration() 产出结构化量（中英语序不同），tr() 才翻译成话
    _kv(t('w.dayLength'), w.sunriseAt && w.sunsetAt ? tr(fmt.duration(w.sunsetAt - w.sunriseAt)) : t('app.dash')),
    // UV：缺失仍显示占位符「—」；有值时用 displayValue（钳制负值，避免显示「低 · -3」）
    _kv(
      t('w.uv'),
      w.uvMax === null || w.uvMax === undefined
        ? fmt.num(w.uvMax, 0)
        : `${fmt.num(uvInfo.displayValue, 0)}（${t(uvInfo.levelKey)}）`
    ),
    _kv(t('w.todayMax'), fmt.tempC(w.todayMaxC)),
    _kv(t('w.todayMin'), fmt.tempC(w.todayMinC)),
  ]);

  _fill(box, [
    h('div', { class: 'card card--hero' }, [
      h('p', { class: 'card-title', text: t('card.weather') }),
      h('div', { class: 'hero' }, [
        tempNode,
        h('div', { class: 'hero-desc' }, [
          h('span', { class: 'hero-wmo', text: `${desc.icon} ${t(desc.key)}` }),
          h('span', { class: 'hero-sub', text: `${t('w.feels')} ${fmt.tempC(w.feelsC)} · ${t('w.beaufortLevel', { name: t(bf.key), level: bf.level })}` }),
          h('span', { class: 'hero-sub', text: t(uvInfo.adviceKey) }),
        ]),
      ]),
      kvGrid,
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 逐时曲线卡（阶段二：今日 24 小时温度 + 降水概率）                        */
/* ------------------------------------------------------------------ */

/**
 * 创建 SVG 元素。
 *
 * ★必须走 createElementNS：h() 用的是 createElement，建 `svg` / `path` 只会得到
 *   HTMLUnknownElement，浏览器既不渲染也不报错（排查起来极费时间）。
 *
 * @param {string} tag 标签名。
 * @param {Object} [attrs] 属性表。
 * @param {Array<Node>} [children] 子节点。
 * @returns {SVGElement} 元素。
 */
function _svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.keys(attrs || {}).forEach((k) => {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) return;
    el.setAttribute(k, String(v));
  });
  (children || []).forEach((c) => c && el.appendChild(c));
  return el;
}

/**
 * 渲染「今日逐时」曲线卡：温度折线 + 降水概率柱 + 现在位置高亮。
 *
 * ★口径三条（破了就是造假）：
 *   1) 只画取回来的 `hourlyTempC` / `hourlyPopPct`（今日 0–23 点各 24 个），不插值、不外推；
 *   2) 某点为 null 就**断开**折线，绝不跨过空洞连成一条「看起来很连续」的假线；
 *   3) 降水那条是**概率（%）**，不是降水量（mm）—— 两者在天气卡里是两个不同的量。
 *
 * 横轴文字不放 SVG 里：`preserveAspectRatio="none"` 会连同文字一起横向压扁，
 * 所以刻度与提示行都用 HTML 画，SVG 只负责图形。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderHourlyCard(root, snapshot) {
  const box = _slot(root, 'hourly');
  if (!box) return;
  // 槽位默认被 append 到末尾，这里挪到天气卡正后方：曲线是天气卡的延伸读法，
  // 排到空气/溯源之后会让「温度走势」和「当前温度」隔好几屏。
  const wBox = root.querySelector('#card-weather');
  if (wBox && wBox.parentNode && wBox.nextSibling !== box) {
    wBox.parentNode.insertBefore(box, wBox.nextSibling);
  }
  const w = snapshot && snapshot.weather;
  const temps = w && Array.isArray(w.hourlyTempC) ? w.hourlyTempC : [];
  const pops = w && Array.isArray(w.hourlyPopPct) ? w.hourlyPopPct : [];

  /** 把任意值收敛成「有限数字或 null」—— null 是「不知道」，不是 0。 */
  const num = (v) => {
    const n = Number(v);
    return v === null || v === undefined || !Number.isFinite(n) ? null : n;
  };
  const pts = temps.map(num);
  const vals = pts.filter((v) => v !== null);

  // 少于 2 个有效点画不出线：如实说没取到，不画一条平线糊弄
  if (!w || vals.length < 2) {
    _fill(box, [
      h('div', { class: 'card card--hourly' }, [
        h('p', { class: 'card-title', text: t('card.hourly') }),
        h('p', { class: 'hourly-empty', text: t('hourly.empty') }),
      ]),
    ]);
    return;
  }

  // 画布几何（viewBox 固定，CSS 拉满宽度）
  const W = 320;
  const H = 104;
  const plotTop = 10;
  const plotBottom = 70; // 温度绘制区 10–70，下方 70–104 留给降水柱与留白
  const plotH = plotBottom - plotTop;

  // y 范围：真实极值上下各留 2℃；全天近乎等温时给 ±1℃，避免除零
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 0.5) {
    min -= 1;
    max += 1;
  } else {
    min -= 2;
    max += 2;
  }
  const xOf = (i) => (W * i) / Math.max(1, pts.length - 1);
  const yOf = (v) => plotTop + ((max - v) / (max - min)) * plotH;

  // 折线：null 处断开（重新起一段 M）
  let d = '';
  let open = false;
  pts.forEach((v, i) => {
    if (v === null) {
      open = false;
      return;
    }
    d += `${open ? ' L' : ' M'}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`;
    open = true;
  });

  // 面积只在**无断点**时填充：有空洞还填，等于把「不知道的那几小时」也涂成有数据
  const hasGap = pts.some((v) => v === null);
  const areaD = hasGap ? '' : `${d} L${xOf(pts.length - 1).toFixed(1)} ${plotBottom} L0 ${plotBottom} Z`;

  // 降水概率柱：只在有值且 >0 的小时出柱（0% 出 1.5px 细线会被误读成「有一点点」）
  const barBase = 98;
  const bars = pops
    .map((v, i) => {
      const p = num(v);
      if (p === null || p <= 0) return null;
      const hgt = Math.max(2, (Math.min(100, p) / 100) * 20);
      return _svg('rect', {
        x: (xOf(i) - 3).toFixed(1),
        y: (barBase - hgt).toFixed(1),
        width: 6,
        height: hgt.toFixed(1),
        rx: 1.5,
        class: 'hourly-bar',
      });
    })
    .filter(Boolean);

  // 「现在」落在今日哪一小时：atMs 是 UTC 毫秒，加时区偏移后取 UTC 小时 = 当地墙钟小时
  const tzOffset = Number(w.tzOffsetSec) || 0;
  const baseMs = Number(snapshot.atMs) || Number(w.atMs) || Date.now();
  const nowHour = Math.min(pts.length - 1, Math.max(0, new Date(baseMs + tzOffset * 1000).getUTCHours()));

  // 高亮组：一条竖虚线 + 一个圆点，交互时整体平移（只改 transform，不重绘）
  const hlLine = _svg('line', {
    x1: 0, y1: plotTop, x2: 0, y2: plotBottom, class: 'hourly-hl-line',
  });
  const hlDot = _svg('circle', { cx: 0, cy: 0, r: 3, class: 'hourly-hl-dot', hidden: 'hidden' });
  const hl = _svg('g', { class: 'hourly-hl' }, [hlLine, hlDot]);

  const svg = _svg(
    'svg',
    {
      class: 'hourly-svg',
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': t('hourly.a11y', { max: fmt.tempC(max - 2), min: fmt.tempC(min + 2) }),
    },
    [
      _svg('defs', {}, [
        _svg('linearGradient', { id: 'hourlyFill', x1: 0, y1: 0, x2: 0, y2: 1 }, [
          _svg('stop', { offset: '0', class: 'hourly-fill-top' }),
          _svg('stop', { offset: '1', class: 'hourly-fill-bottom' }),
        ]),
      ]),
      areaD ? _svg('path', { d: areaD, class: 'hourly-area' }) : null,
      _svg('path', { d, class: 'hourly-line' }),
      ...bars,
      hl,
      // 命中层：透明、铺满整张图，所有指针事件都落在它上面
      _svg('rect', { x: 0, y: 0, width: W, height: H, class: 'hourly-hit' }),
    ].filter(Boolean)
  );

  // 提示行：默认显示「现在」那一小时
  const tip = h('p', { class: 'hourly-tip' });

  /**
   * 把高亮移到第 i 小时，并刷新提示行。
   *
   * @param {number} i 小时下标 0–23。
   * @returns {void}
   */
  function pick(i) {
    const idx = Math.min(pts.length - 1, Math.max(0, i));
    const x = xOf(idx);
    hlLine.setAttribute('x1', x.toFixed(1));
    hlLine.setAttribute('x2', x.toFixed(1));
    const v = pts[idx];
    if (v === null) {
      hlDot.setAttribute('hidden', 'hidden');
    } else {
      hlDot.removeAttribute('hidden');
      hlDot.setAttribute('cx', x.toFixed(1));
      hlDot.setAttribute('cy', yOf(v).toFixed(1));
    }
    const hourLabel = idx === nowHour ? t('hourly.nowLabel') : t('hourly.at', { hour: idx });
    const parts = [hourLabel, v === null ? t('app.dash') : fmt.tempC(v)];
    const p = num(pops[idx]);
    // 概率缺失就不写这一段：写 0% 会被读成「确定不下雨」
    if (p !== null) parts.push(`${t('w.pop')} ${fmt.percent(p)}`);
    tip.textContent = parts.join(' · ');
  }

  // 指针交互：按下与拖动都跟随。用 offsetX/宽度换算，不依赖 SVG 的 preserveAspectRatio 缩放
  const onPoint = (ev) => {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    pick(Math.round(ratio * (pts.length - 1)));
  };
  svg.addEventListener('pointerdown', (ev) => {
    onPoint(ev);
    if (svg.setPointerCapture && ev.pointerId !== undefined) {
      try {
        svg.setPointerCapture(ev.pointerId);
      } catch (err) {
        /* 老浏览器不支持指针捕获：不影响拖动外的点击 */
      }
    }
  });
  svg.addEventListener('pointermove', (ev) => {
    if (ev.buttons) onPoint(ev); // 只有按住拖动才跟随，避免鼠标划过就乱跳
  });

  pick(nowHour);

  _fill(box, [
    h('div', { class: 'card card--hourly' }, [
      h('p', { class: 'card-title', text: t('card.hourly') }),
      svg,
      tip,
      h('div', { class: 'hourly-axis' }, [
        h('span', { text: t('hourly.at', { hour: 0 }) }),
        h('span', { text: t('hourly.at', { hour: 6 }) }),
        h('span', { text: t('hourly.at', { hour: 12 }) }),
        h('span', { text: t('hourly.at', { hour: 18 }) }),
        h('span', { text: t('hourly.at', { hour: pts.length - 1 }) }),
      ]),
      h('p', { class: 'hourly-hint', text: t('hourly.hint') }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 空气卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染空气质量卡。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderAirCard(root, snapshot) {
  const a = snapshot.air;
  const box = _slot(root, 'air');
  if (!a || a.europeanAqi === null) {
    _fill(box, [_emptyCard(t('app.na'))]);
    return;
  }
  const info = aqi(a.europeanAqi);
  _fill(box, [
    h('div', { class: 'card' }, [
      h('div', { class: 'card--row' }, [
        h('p', { class: 'card-title', text: t('card.air') }),
        // AQI 用 displayValue（钳制负值），避免出现「优 · AQI -10」这类自相矛盾文案。
        // ★2026-10 真机：这里原写「AQI 74」，中国用户会按国标读（51–100 = 良），
        //   而这个数取自 `european_aqi`、档位 20/40/60/80/100 是**欧洲 AQI** 的 ——
        //   数值没错，错在没说清这个数是**在哪把尺子上量的**。所以标签写 EAQI。
        //   ★只补标签，不补算法：wmo.js 的阈值与 aqi() 的判定式一个字都不动。
        h('span', { class: `chip chip--${info.level === 'good' || info.level === 'fair' ? 'ok' : info.level === 'extreme' ? 'failed' : 'stale'}`, text: `${t(info.levelKey)} · EAQI ${info.displayValue}` }),
      ]),
      h('div', { class: 'kv' }, [
        _kv(t('w.pm10'), fmt.pollutant(a.pm10)),
        _kv(t('w.pm25'), fmt.pollutant(a.pm25)),
        _kv(t('w.ozone'), fmt.pollutant(a.ozone)),
        _kv(t('w.no2'), fmt.pollutant(a.no2)),
      ]),
      // ★尺度说明放在数值与建议之间：先看清是哪个尺子，再看该不该减少户外活动
      h('p', { class: 'card-note', text: t('air.aqiScale') }),
      h('p', { class: 'card-title', text: t(info.adviceKey) }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 位置卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染位置卡（海拔 / 坐标 / 地名）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderPlaceCard(root, snapshot) {
  const box = _slot(root, 'place');
  const hasAny = snapshot.elevationM !== null || snapshot.placeName || snapshot.coord;
  if (!hasAny) {
    _fill(box, [_emptyCard(t('app.na'))]);
    return;
  }
  _fill(box, [
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('card.place') }),
      h('div', { class: 'kv' }, [
        _kv(t('w.elevation'), fmt.elevationM(snapshot.elevationM)),
        _kv(t('w.coord'), snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.dash')),
        snapshot.placeName ? _kv(t('card.place'), snapshot.placeName) : null,
      ].filter(Boolean)),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 气候常态卡（1991–2020 月平均 / 年平均，懒加载）                        */
/* ------------------------------------------------------------------ */

/**
 * 渲染气候常态卡（月平均 / 年平均）。
 *
 * ★本函数**不发起任何请求**：30 年再分析数据的取数在 `ui/app.js` 的 `_loadClimate()`
 *   （本模块不许 import `src/data/` 下的任何东西，见文件头闭包红线）。数据由调用方
 *   算好 / 取好后放进 `view.data` 传进来 —— 与已删除的 `renderBearingCard(root,
 *   snapshot, declinationDeg)`（2026-10-26 随磁偏角数值一屏重复两遍而删）当年用的是
 *   同一个「调用方算、渲染层画」的模式。
 *
 * ★上屏红线：`climate.entryNote` 那句「ERA5 再分析 1991–2020 自算月平均 · 非官方气候
 *   常态」必须**整句**上屏，不许简写成「气候常态」（那是说谎：它不是官方常态值）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {{status:'idle'|'loading'|'ready'|'error', data:Object|null, text:string}} view 视图状态。
 * @param {() => void} [onLoad] 点击回调（**必须是函数才绑**；本仓规矩：回调不许
 *   「取不到就退化成空函数」，那是静默断线的最爱 —— 没传就干脆不绑）。
 * @returns {void}
 */
export function renderClimateCard(root, view, onLoad) {
  const box = _slot(root, 'climate');
  const v = view && typeof view === 'object' ? view : {};
  const status = v.status === 'loading' || v.status === 'ready' || v.status === 'error' ? v.status : 'idle';
  const bind = typeof onLoad === 'function' ? onLoad : null;
  const title = h('p', { class: 'card-title', text: t('climate.title') });

  if (status === 'loading') {
    _fill(box, [
      h('div', { class: 'card' }, [
        title,
        h('div', { class: 'sk' }),
        h('p', { class: 'card-note', text: t('climate.loading') }),
      ]),
    ]);
    return;
  }

  if (status === 'error') {
    // 取数失败只废这一张卡：空态 + 重试按钮（不转圈）
    _fill(box, [
      h('div', { class: 'card' }, [
        title,
        // 第三参数给「重试」按钮的文案键：这一颗按钮重取的是 303 KB 的 30 年再分析，
        // 不是普通的一路源，文案单独一条（中英各一版），不借 app.retry。
        _emptyCard(String(v.text || t('climate.err')), bind, 'climate.retry'),
      ]),
    ]);
    return;
  }

  const data = v.data && typeof v.data === 'object' ? v.data : null;
  const months = data && Array.isArray(data.months) ? data.months : [];
  if (status === 'ready' && months.length > 0) {
    const summary = data.summary && typeof data.summary === 'object' ? data.summary : {};
    // 格点那一行：grid 或距离缺一个就**不产生节点**（见 _gridNoteLine）
    const gridLine = _gridNoteLine(data.grid);
    const readyNodes = [
      title,
      h('p', { class: 'card-title', text: t('climate.annual') }),
      h('div', { class: 'kv' }, [
        _kv(t('climate.annualHigh'), fmt.tempC(summary.tmaxC, 1)),
        _kv(t('climate.annualLow'), fmt.tempC(summary.tminC, 1)),
        _kv(t('climate.annualPrecip'), fmt.precipMm(summary.precipMm)),
      ]),
      _climateTable(months),
      // 样本量如实给：多少天、多少年。整句模板只插值数字（中英语序不同，不拼片段）
      h('p', { class: 'card-note', text: t('climate.sample', { n: _count(data.dayCount), years: _count(data.years) }) }),
      // ★红线文案，整句上屏，不许简写
      h('p', { class: 'card-note', text: t('climate.entryNote') }),
    ];
    // 格点说明排在如实标注**后面**：先说清「这不是官方常态」，再说清「数据来自哪个格点」
    if (gridLine) readyNodes.push(gridLine);
    _fill(box, [h('div', { class: 'card' }, readyNodes)]);
    return;
  }

  // idle：默认不上数（303 KB / 十几秒），用户点按钮才取。
  // ★拿不到回调就**不画按钮**：一颗点了没反应的按钮比没有按钮更糟（本仓「静默断线」
  //   的其中一种形态），没坐标时（bind 为 null）这张卡只留标题与如实标注。
  const idleNodes = [title, h('p', { class: 'card-note', text: t('climate.entryNote') })];
  if (bind) {
    const btn = h('button', { type: 'button', class: 'btn', text: t('climate.loadBtn') });
    btn.addEventListener('click', bind);
    idleNodes.push(h('div', { class: 'field field--row' }, [btn]));
  }
  _fill(box, [h('div', { class: 'card' }, idleNodes)]);
}

/**
 * 格点中心那一行（`climate.gridNote`）。
 *
 * 它回答的是用户看到月平均后的第一个疑问：「为什么跟我印象里的官方常态不一样？」
 * —— 因为数据是 ERA5 的 0.25° **格点中心**的值，不是台站观测，那个格点可能在
 * 十几公里外（北京查询点 39.9087,116.3975 → 格点 40,116.5，实测约 13.4 km）。
 *
 * ★「没算出来」就**整行没有**，绝不退化成「格点 —」或「约 0 km」：
 *   本仓被 `Number(null) === 0` 咬过四次 —— 空值一旦被当成 0，界面上就是一个
 *   看起来很有道理的假结果（「距查询点约 0 km」等于谎称数据就在你脚下）。
 *   所以先判 null/undefined，再判有限数，两步都不能省。
 *
 * 坐标不补小数位：响应给 `40` / `116.5` 就显示 `40` / `116.5`，补成 `40.00` 会给一个
 * ~31 km 的格点凭空添两位精度。
 *
 * @param {*} grid parseClimate 的 `grid` 字段。
 * @returns {HTMLElement|null} 那一行 <p>；数字缺任何一个时 null（调用方就不渲染）。
 */
function _gridNoteLine(grid) {
  if (!grid || typeof grid !== 'object') return null;
  const { lat, lon, distanceKm } = grid;
  if (lat === null || lat === undefined) return null;
  if (lon === null || lon === undefined) return null;
  if (distanceKm === null || distanceKm === undefined) return null;
  const nLat = Number(lat);
  const nLon = Number(lon);
  const nKm = Number(distanceKm);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLon) || !Number.isFinite(nKm)) return null;
  // 整句模板只插值数字（英文语序不同，不拼片段）
  return h('p', { class: 'card-note', text: t('climate.gridNote', { lat: nLat, lon: nLon, km: nKm }) });
}

/**
 * 取计数（非有限数字 → 0，仅用于「样本 N 天」这类展示）。
 *
 * @param {*} v 值。
 * @returns {number} 非负整数。
 */
function _count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * 月度表：4 列（月份 / 平均最高 / 平均最低 / 月降水）。
 *
 * ★中文语序陷阱：整句是**模板**、只插值数字（`fmt.tempC` / `fmt.precipMm` 产出的成品串），
 *   绝不拼「平均最高」+ 数字片段 —— 英文语序是另一套，拼片段必错。
 * 月份名走 i18n（`climate.m1`…`climate.m12`），不硬编码「1月」。
 *
 * @param {Array<{month:number, tmaxC:number|null, tminC:number|null, precipMm:number|null}>} months 12 个月。
 * @returns {HTMLElement} 表格节点。
 */
function _climateTable(months) {
  const cells = [
    h('span', { class: 'clim-h', text: t('climate.colMonth') }),
    h('span', { class: 'clim-h', text: t('climate.colHigh') }),
    h('span', { class: 'clim-h', text: t('climate.colLow') }),
    h('span', { class: 'clim-h', text: t('climate.colPrecip') }),
  ];
  for (const m of months) {
    const month = Number(m && m.month);
    if (!Number.isFinite(month) || month < 1 || month > 12) continue; // 越界月份直接跳过，不画
    cells.push(h('span', { text: t(`climate.m${Math.round(month)}`) }));
    cells.push(h('span', { class: 'clim-c', text: fmt.tempC(m.tmaxC, 1) }));
    cells.push(h('span', { class: 'clim-c', text: fmt.tempC(m.tminC, 1) }));
    cells.push(h('span', { class: 'clim-c', text: fmt.precipMm(m.precipMm) }));
  }
  return h('div', { class: 'clim' }, cells);
}

/* ------------------------------------------------------------------ */
/* 方位卡（此刻页的简化版）                                              */
/* ------------------------------------------------------------------ */

/** 磁偏角小于此值视为「正北（不偏）」（度）。 */
const DECLINATION_FLAT_EPS = 0.05;

/**
 * 把角度归一到 (−180, 180]。
 *
 * ★为什么在这里抄一遍而不 import `core/mag.js` 的 `normalizeSignedAngle`：见文件头的闭包红线，
 *   一次 import 就会把 26.6 KB 拖进自检页产物。抄的是 3 行取模算术（数学上不会漂移），
 *   真身仍在 `core/mag.js:normalizeSignedAngle` —— 改那边时**不必**改这里，但语义必须一致。
 *
 * @param {number} deg 角度（度）。
 * @returns {number} 归一后的角度。
 */
function _wrapSigned(deg) {
  let v = deg % 360;
  if (v > 180) v -= 360;
  else if (v <= -180) v += 360;
  return v;
}

/**
 * 磁偏角的**读法**（不是数字）：东偏为正，负数要读成「西偏 N°」。
 *
 * 全仓唯一实现 —— 罗盘页（大号数字）、设置页、此刻页方位卡共用这一份。
 * 住在 now.js 而不是 compass.js，是因为 now.js 在自检页闭包内、compass.js 不在，
 * 放在 compass.js 会逼着 now.js import 一个不在闭包里的模块。
 *
 * ★必须用**整句模板**（`compass.east` 是「东偏 {deg}°」），不能拼「磁偏角」+「东」+ 数字 ——
 *   英文语序是「{deg}° east」，拼片段必错。这与「体感 26°」是同一条约束。
 *
 * @param {number|null} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {string} 如「西偏 7.49°」；缺失返回占位符。
 */
export function declinationText(declinationDeg) {
  if (declinationDeg === null || declinationDeg === undefined || !Number.isFinite(Number(declinationDeg))) {
    return t('app.dash');
  }
  const d = _wrapSigned(Number(declinationDeg));
  if (Math.abs(d) < DECLINATION_FLAT_EPS) return t('compass.noDeclination');
  const abs = fmt.num(Math.abs(d), 2);
  return d > 0 ? t('compass.east', { deg: abs }) : t('compass.west', { deg: abs });
}

/* ------------------------------------------------------------------ */
/* 溯源气泡                                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染溯源气泡（每条来源一个胶囊：源名 / 时延 / URL）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderProvenance(root, snapshot) {
  const box = _slot(root, 'prov');
  const list = Array.isArray(snapshot.provenance) ? snapshot.provenance : [];
  if (list.length === 0) {
    box.textContent = '';
    return;
  }
  const chips = list.map((p) =>
    h('span', { class: 'prov-item', title: `${p.label} · ${p.attribution}` }, [
      h('span', { class: `badge badge--${p.state === 'stale' ? 'stale' : 'ok'}` }),
      h('span', { text: p.label }),
      // ★命中缓存那一路 latencyMs 是 0（没发请求），显示成 0 ms 就是把「没测」说成「测到 0」；
      //   命中说「缓存命中」，未命中才给实测时延（命中时 pull.js 已置 null，null 出「—」）。
      h('span', {
        class: 'num',
        text: p.fromCache === true ? t('prov.cacheHit') : fmt.latency(p.latencyMs),
      }),
      h('span', { class: 'prov-url', text: _shortUrl(p.url) }),
    ])
  );
  _fill(box, [h('p', { class: 'card-title', text: t('card.provenance') }), h('div', { class: 'prov' }, chips)]);
}

/**
 * URL 缩短（只保留协议+宿主+路径首段，避免溯源气泡撑破布局）。
 *
 * @param {string} url 完整 URL。
 * @returns {string} 短 URL。
 */
function _shortUrl(url) {
  try {
    const u = new URL(String(url));
    const seg = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return `${u.host}/${seg}`;
  } catch (err) {
    return String(url || '').slice(0, 48);
  }
}

/* ------------------------------------------------------------------ */
/* 空态 / 离线态                                                        */
/* ------------------------------------------------------------------ */

/**
 * 空态卡（文案 + 重试按钮，**不转圈**）。
 *
 * @param {string} text 提示文案。
 * @param {() => void} [onRetry] 重试回调。
 * @param {string} [retryLabelKey='app.retry'] 重试按钮的文案键（默认通用「重试」；
 *   气候常态卡传 'climate.retry' —— 那颗按钮重取的是 303 KB 的 30 年再分析，
 *   文案单独一条，中英各一版）。
 * @returns {HTMLElement} 空态节点。
 */
function _emptyCard(text, onRetry, retryLabelKey = 'app.retry') {
  const nodes = [h('span', { text })];
  if (typeof onRetry === 'function') {
    const btn = h('button', { class: 'btn btn--primary', type: 'button', text: t(retryLabelKey) });
    btn.addEventListener('click', onRetry);
    nodes.push(btn);
  }
  return h('div', { class: 'empty' }, nodes);
}

/**
 * 渲染整屏空态（离线且无缓存时）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} text 文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {void}
 */
export function renderEmptyState(root, text, onRetry) {
  if (!root) return;
  root.textContent = '';
  root.appendChild(_emptyCard(text, onRetry));
}

/**
 * 把指定卡片槽位渲染成「失败 / 空 + 重试」态。
 *
 * 用途：单路源抛异常时只废掉这一张卡，其余卡片继续渲染，用户不会看到永久骨架屏。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} slotId 槽位 id（'weather' | 'air' | 'place'）。
 * @param {string} text 提示文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {void}
 */
export function renderSlotEmpty(root, slotId, text, onRetry) {
  const box = _slot(root, slotId);
  _fill(box, [_emptyCard(text, onRetry)]);
}

/**
 * 一次性完整渲染（离线读缓存快照时走此路径）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @param {{isDefaultPlace?:boolean, staleAgeMs?:number}} [opts] 选项。
 *   ★2026-10-17：`declinationDeg` 参数已移除 —— 气候页不再显示磁偏角，
 *   磁偏角归地理页（`ui/compass.js`）独有，调用方不用再传。
 * @returns {void}
 */
export function renderSnapshot(root, snapshot, opts = {}) {
  renderSkeleton(root);
  renderHeader(root, snapshot, opts);
  renderWeatherCard(root, snapshot);
  renderAirCard(root, snapshot);
  // ★2026-10-17 导航重构：地点卡与方位卡都不再在气候页渲染 —— 它们随「地理」主 tab
  //   搬到了 `ui/compass.js`（那里有 place / bearing 两个槽，由它的骨架建好）。
  //   两个渲染函数本身**保留导出**，由地理页 import；这里删掉的只是调用。
  renderProvenance(root, snapshot);
}
