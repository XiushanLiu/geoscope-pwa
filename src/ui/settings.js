/**
 * 「我的」设置页（备份导出 / 备份导入 / 导出 CSV / 主题 / 字号）
 *
 * 职责：把 core 层已经备好的能力接成界面 ——
 *   1) 导出备份：core/backup.js 的 exportBackup() + ui/download.js 落地成 JSON 文件；
 *   2) 导入：**先看后写**（inspectBackup 预览 → 用户点头 → applyBackup 落地）；
 *   3) 导出 CSV：core/csv.js 的 snapshotToCsv() + ui/download.js 落地成表格文件；
 *   4) 外观两档：主题写 <html data-theme>、无障碍字号写 <html data-fs>，
 *      具体色值与放大乘数全在 styles/tokens.css，本页一个数字都不存。
 *
 * 为什么这一页是硬承诺而不是锦上添花：产品边界第 2 条写着「收藏与足迹留本机，
 * 靠导出 / 导入 JSON 搬家」，技术约束写着 iOS 上 PWA 存储可能被系统清理、
 * **导出备份是唯一退路**。core 层（backup.js）早已实现，但如果没有这个页面，
 * 用户拿不到那份文件 —— 退路仍然是断的。
 *
 * 三条不变量（勿回退）：
 *   1) **绝不选完文件就覆盖**：导入是覆盖性操作（默认地点与收藏整份替换），
 *      inspectBackup() 与 applyBackup() 必须是分开的两次调用，中间隔着一次人的确认。
 *   2) **导出前必须说明文件含位置信息**：settings.backupPrivacy 常驻在按钮下方，
 *      不是点完才闪一下的提示 —— 用户要在按下去之前就知道自己在导出什么。
 *   3) **文案零硬编码**：一切可见文字走 t()，缺键时 t() 会返回键名本身（不崩）。
 *
 * 依赖方向：ui ← data ← core（磁偏角要用到 data/wmm2025.js 那套系数，core 层不许
 * 反向 import data，所以在本页算好再作为参数传进 core/csv.js）。
 * 顶层只做一件事：把主题写到 <html data-theme>、把字号档位写到 <html data-fs>
 * （两者都是全站属性，详见 ui/theme.js），其余 DOM 访问全在 init() 内，
 * 便于 Node 侧检查与单测。
 */

import { t } from '../i18n/index.js';
import { errorText, reasonText } from './errtext.js';
import * as fmt from '../core/format.js';
import { decimalYearFromDate } from '../core/mag.js';
import { snapshotToCsv, CSV_MIME } from '../core/csv.js';
import { geomagneticDeclination } from '../data/wmm2025.js';
import {
  getState,
  getLastSnapshot,
  getThemeMode,
  setThemeMode,
  getFontScale,
  setFontScale,
  getLocale,
  getFavorites,
  removeFavorite,
  log,
} from '../core/store.js';
import { exportBackup, inspectBackup, applyBackup, backupFilename } from '../core/backup.js';
import { downloadJson, downloadText } from './download.js';
import { h, applyI18n } from './now.js';
// 写 <html data-theme> / <html data-fs> 的实现在 ui/theme.js：这两者都是全站属性，
// 四个入口都要各引导一次，不能只活在本页里（详见 theme.js 文件头）。
import { applyThemeMode, applyFontScale } from './theme.js';
// 语言引导：把 store.locale 落到 i18n 与 <html lang> 上（与主题 / 字号同构，见 ui/locale.js）。
import { applyLocale, switchLocale } from './locale.js';
// 地点显示名（出厂默认地点那个地名要跟着语言走，见 locale.js 的 JSDoc）
import { placeDisplayName } from './locale.js';
// 高德 Key 的「孤儿存储」：只依赖 core/cache.js，与 store 的 prefs 平级、互不影响。
// ★三条红线：不硬编码、不进 git、不写进 store 的 prefs（也就不会被备份文件带出去）。
import { getAmapKey, hasAmapKey, setAmapKey, clearAmapKey, maskKey, KEY_MAX_LEN } from '../core/apikeys.js';
// 自驾两路源：校验 Key 要真的发一次 POI 搜索 —— 不发请求证明不了「这个 Key 可用」，
// 而高德的业务失败是 HTTP 200 包着 status:"0"，只看网络通不通会得出假结论。
import { requestRoadSource } from '../data/roadsources.js';
// ★必须 import 源注册表（哪怕本页一个符号都不用它）：setSourceResolver() 是
//   data/sources.js 在**自己加载时**调用的，漏掉这一行 requestRoadSource() 会拿到
//   UNSUPPORTED —— 不发任何请求、按钮点了没反应（compare.js:40 有同一条注释）。
import '../data/sources.js';

/** 主题模式选项（顺序即界面顺序）。 */
export const THEME_MODES = ['system', 'light', 'dark'];

/** 无障碍字号档位选项（顺序即界面顺序：从小到大）。 */
export const FONT_SCALES = ['normal', 'large', 'xlarge'];

/** 界面语言选项（顺序即界面顺序）。 */
export const LOCALES = ['zh', 'en'];

/** @type {Object|null} 当前待确认的导入计划（inspectBackup 的产物，未经用户确认不许写）。 */
let _plan = null;

/** @type {string} 待确认备份的文件名（仅用于预览回放给用户看）。 */
let _fileName = '';

/**
 * 收藏列表容器（由 _renderPage 建好后留在这里）。
 *
 * 为什么不用 _el('fav-list')：这个节点是 JS 造的、不在静态 HTML 里，浏览器里
 * getElementById 拿得到，但测试台的假 DOM 只索引预置 id —— 留一个直接引用，
 * 两边都能拿到同一个节点，不必为测试改生产代码的取节点方式。
 *
 * @type {HTMLElement|null}
 */
let _favBox = null;

/** @type {HTMLElement|null} 收藏条数那一行（同上，留引用而不是靠 getElementById）。 */
let _favCountBox = null;

/** @type {HTMLElement|null} 对比入口按钮（收藏为空时要禁用，留引用便于刷新）。 */
let _compareBtn = null;

/** @type {HTMLElement|null} 对比卡的条数那一行。 */
let _compareCountBox = null;

/** @type {HTMLElement|null} 对比卡的「先收藏地点」提示行。 */
let _compareNeedBox = null;

/** @type {HTMLElement|null} Key 卡的「当前值」那一行（存了就显示掩码，没存就写明未填）。 */
let _keyCurrentBox = null;

/** @type {HTMLElement|null} Key 卡的操作结果那一行。 */
let _keyResultBox = null;

/** @type {HTMLElement|null} Key 卡的「校验」按钮（没填 Key 时禁用 —— 发一次必然 10001 的请求是白花配额）。 */
let _keyCheckBtn = null;

/**
 * 校验 Key 用的搜索圆心（WGS84）。
 *
 * 只是一个**固定取样点**：校验的目的是「这个 Key 能不能用」，不是「那里有什么好吃的」，
 * 所以坐标写死、类别走 amap.js 的默认值。lat/lon 进 buildPoiRequest 后由 data 层转
 * GCJ-02（高德是 GCJ-02，本仓对外一律 WGS84）。
 *
 * @type {{lat:number, lon:number}}
 */
export const KEY_CHECK_ANCHOR = { lat: 39.9042, lon: 116.4074 };

/**
 * 取 DOM 元素（缺失返回 null，不抛）。
 *
 * @param {string} id 元素 id。
 * @returns {HTMLElement|null} 元素。
 */
function _el(id) {
  return typeof document !== 'undefined' && document ? document.getElementById(id) : null;
}

/* ------------------------------------------------------------------ */
/* 主题                                                                 */
/* ------------------------------------------------------------------ */

// ★主题引导：本页是四个入口之一，必须在**模块顶层**把 store 里的 themeMode 写到
// <html data-theme> 上，早于任何渲染。ES module 是 defer 的，此刻 documentElement 已存在；
// 挪进 init() 或任何 await 之后，用户会先看到一帧系统色的背景。
// 幂等：init() 里的那次调用与本句完全等价，重复调用无副作用。
// 实现与四组合语义见 ui/theme.js 文件头（**别在这里改色值、也别补 dark 规则块**）。
applyThemeMode(getThemeMode());
// ★字号档位引导（与主题同构、同一时机）：本页也是四个入口之一，必须在 module 求值
// 那一刻就把 store.fontScale 写到 <html data-fs>。默认的 'normal' 是**移除属性**
// （不是写成 "normal"），语义与 data-theme 的 'system' 一致 —— 见 theme.js 的 JSDoc。
// 放大乘数、以及英雄区那个更小的乘数都在 styles/tokens.css，这里不碰任何数字。
applyFontScale(getFontScale());
// ★语言引导（与主题 / 字号同构、同一时机）：本页是多个入口之一，必须在 module 求值
// 那一刻就把 store.locale 落到 i18n 与 <html lang> 上。慢一帧就会出现「先按中文画一遍
// 再跳成英文」—— 本页所有 t() 调用（含下面那几张卡的标题）都在这行之后才求值。
// 切到别的页面时，那边的入口模块各有同样的一行，不靠本页替它们写。
applyLocale(getLocale());

/**
 * 绑定分段控件（主题三档）。
 *
 * 写法照 ui/selfcheck.js 的 _bindSeg：事件委托到容器，命中 .seg-btn 才处理，
 * 顺手把同级的选中态清掉 —— 不依赖任何框架，也不需要给每个按钮单独挂监听。
 *
 * @param {string} id 容器 id。
 * @param {(value:string) => void} onPick 选中回调。
 * @returns {void}
 */
function _bindSeg(id, onPick) {
  const box = _el(id);
  if (!box) return;
  box.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.seg-btn') : null;
    if (!btn) return;
    Array.prototype.forEach.call(box.querySelectorAll('.seg-btn'), (b) => b.classList.remove('seg-btn--active'));
    btn.classList.add('seg-btn--active');
    onPick(btn.getAttribute('data-value'));
  });
}

/* ------------------------------------------------------------------ */
/* 页面渲染                                                             */
/* ------------------------------------------------------------------ */

/**
 * 当前可导出内容的概要文案（常态显示，用户点导出前就知道会导出什么）。
 *
 * @returns {string} 概要文案。
 */
function _exportSummaryText() {
  const state = getState();
  const place = state.defaultPlace && state.defaultPlace.name ? placeDisplayName(state.defaultPlace.name) : t('settings.previewNoPlace');
  // 快照不在 getState() 里（store 把它单独存在另一个缓存键下），必须走 getLastSnapshot()
  const hasSnapshot = !!getLastSnapshot();
  return t('settings.exportCurrent', {
    place,
    count: state.favorites.length,
    snapshot: hasSnapshot ? t('settings.snapshotYes') : t('settings.snapshotNo'),
  });
}

/**
 * 取导出卡的隐私说明文案。
 *
 * 有快照 / 无快照必须分两句说，不能合并成一句含糊的话：快照里嵌着**最近一次定位坐标**
 * （经纬度，能精确到社区）以及四条同样含经纬度的数据源请求链接，敏感度比 `defaultPlace`
 * 高一个量级 —— 后者通常是出厂默认值「北京 · 天安门」，根本不是用户的真实位置。
 * 曾用一句「……和最近一次天气快照」把最敏感的一项藏在最不起眼的四个字里。
 *
 * @returns {string} 隐私说明文案。
 */
function _privacyText() {
  const count = getState().favorites.length;
  return getLastSnapshot() ? t('settings.backupPrivacy', { count }) : t('settings.backupPrivacyNoSnap', { count });
}

/**
 * 取错误对象的可读消息（不抛）。
 *
 * @param {*} err 任意错误。
 * @returns {string} 消息串。
 */
function _errMsg(err) {
  // core/http.js 的 SourceError 只带 messageKey / messageParams（core 不许 import i18n），
  // 翻成话统一走 ui/errtext.js —— 那边也顺手处理了「catch 到的是个普通 Error」的情况。
  return errorText(err);
}

/**
 * 把 ISO 时间串格式化成本地可读时间（'YYYY-MM-DD HH:MM'）。
 *
 * 备份可能来自几个月前，年-月-日必须齐全 —— core/format.js 的 mdHm() 只给到月日，
 * 跨年的旧备份会显示得像「今天」，那正是「误以为这是最新备份」的诱因。
 *
 * 同一条理由对「当前可导出：xxx」那行也成立（快照可能是几天前联网取的那一份），
 * 所以本函数同时收 ms epoch 与 ISO 串，两处卡片共用一套口径 —— 不许一处带年份、
 * 一处不带。
 *
 * @param {number|string} at ms epoch 或 ISO 时间串。
 * @returns {string} 本地时间文本；无法解析时返回 i18n 的「未知」。
 */
function _fmtExportedAt(at) {
  if (at === null || at === undefined || at === '') return t('app.unknown');
  const ms = typeof at === 'number' ? at : Date.parse(String(at));
  if (!Number.isFinite(ms)) return t('app.unknown');
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 把一段状态文案写进容器（缺失 / 成功 / 失败共用）。
 *
 * @param {string} id 容器 id。
 * @param {string} text 文案；空串表示清空。
 * @returns {void}
 */
function _setStatus(id, text) {
  const box = _el(id);
  if (!box) return;
  box.textContent = text || '';
}

/**
 * 补齐/刷新导出卡的概要与隐私说明（导入完成后必须重算，否则还显示旧条数）。
 *
 * @returns {void}
 */
function _refreshExport() {
  const cur = _el('export-current');
  if (cur) cur.textContent = _exportSummaryText();
  const privacy = _el('export-privacy');
  if (privacy) privacy.textContent = _privacyText();
}

/**
 * 刷新导出 CSV 卡的概要与按钮可用态。
 *
 * 必须跟着导入一起刷：applyBackup() 会**整体覆盖**快照（备份里没带快照时还会把旧的
 * 清成 null，见 core/backup.js），导入完这张卡还写着上一次的地点就是假话。
 *
 * @returns {void}
 */
function _refreshCsv() {
  const cur = _el('csv-current');
  if (cur) cur.textContent = _csvSummaryText();
  const btn = _el('btn-csv');
  if (btn) btn.disabled = !getLastSnapshot();
}

/**
 * 收藏项的跳转链接（跨页传参）。
 *
 * 无 SPA 路由，页面之间只有 URL 这一条通路，所以目的地写成
 * `index.html?lat=…&lon=…&name=…` 这个完整链接（app.js 的 parsePlaceParam 接）。
 * ★中文名必须 encodeURIComponent：直接拼进查询串，非 ASCII 字节在部分浏览器上
 * 会被按 Latin-1 解释成乱码，跳过去显示成一串问号。
 *
 * @param {{lat:number, lon:number, name:string}} f 收藏项。
 * @returns {string} 跳转链接。
 */
function _favHref(f) {
  const lat = encodeURIComponent(String(f.lat));
  const lon = encodeURIComponent(String(f.lon));
  const name = encodeURIComponent(String(f.name || ''));
  return `index.html?lat=${lat}&lon=${lon}&name=${name}`;
}

/**
 * 渲染一条收藏（地点名 + 经纬度 + 跳转链接 + 删除按钮）。
 *
 * @param {{lat:number, lon:number, name:string}} f 收藏项。
 * @returns {HTMLElement} 行节点。
 */
function _renderFavoriteRow(f) {
  const label = f.name ? String(f.name) : t('fav.unnamed');
  const link = h(
    'a',
    { class: 'fav-link', href: _favHref(f), title: t('fav.go') },
    [
      h('span', { class: 'fav-name', text: label }),
      // 经纬度走 .num（等宽 + tabular-nums），与位置卡 / 溯源气泡的写法一致
      h('span', { class: 'fav-coord num', text: fmt.coord(f.lat, f.lon) }),
    ]
  );
  const del = h('button', {
    class: 'btn',
    type: 'button',
    'aria-label': t('fav.deleteOf', { name: label }),
    text: t('fav.delete'),
  });
  del.addEventListener('click', () => {
    removeFavorite(f.lat, f.lon);
    // 删完必须整段重画：条数、空态、导出卡概要三处都要跟着变
    _refreshFavorites();
  });
  return h('div', { class: 'fav-item' }, [link, del]);
}

/**
 * 重画收藏列表（含空态），并同步导出卡。
 *
 * ★末尾必须调 _refreshExport()：导出卡概要与隐私文案里的 {count} 就是收藏条数，
 * 漏掉这一步，删完收藏导出卡还写着旧数字 —— 用户会以为备份里还有那些地点。
 *
 * @returns {void}
 */
function _refreshFavorites() {
  const box = _favBox;
  if (!box) return;
  const list = getFavorites();
  box.textContent = '';
  if (list.length === 0) {
    box.appendChild(h('p', { class: 'card-note', text: t('fav.empty') }));
  } else {
    list.forEach((f) => box.appendChild(_renderFavoriteRow(f)));
  }
  if (_favCountBox) _favCountBox.textContent = t('fav.count', { count: list.length });
  // 对比入口的可用态直接由收藏条数决定：删光了必须跟着灰掉
  _refreshCompare();
  _refreshExport();
  // 删除收藏不影响快照，但导入会（见 _refreshCsv 的注释）—— 两条路径都过这里，统一刷
  _refreshCsv();
}

/**
 * 跳转对比页（本页唯一的跨页入口）。
 *
 * 为什么不用 `<a href="compare.html">`：入口在收藏为空时必须是**禁用**态，
 * 而 `<a>` 没有 disabled 语义（写 `disabled` 属性对它无效，点了照样跳）。
 * 用 `<button disabled>` 才能得到「灰掉 + 点不动」，禁用这件事才真的成立 ——
 * 代价是要自己写一句 `location.href`，换来的是按钮状态与提示文案同步。
 *
 * @returns {void}
 */
function _goCompare() {
  if (typeof location === 'undefined' || !location) return; // Node 侧无 location
  location.href = 'compare.html';
}

/**
 * 刷新对比卡的条数 / 按钮可用态 / 提示行。
 *
 * 必须跟着收藏一起刷：删光收藏之后按钮还亮着，用户点进去只会看到一个空态，
 * 不如在这里就灰掉并说明「先收藏地点」。
 *
 * @returns {void}
 */
function _refreshCompare() {
  const count = getFavorites().length;
  if (_compareCountBox) _compareCountBox.textContent = t('compare.current', { count });
  if (_compareBtn) _compareBtn.disabled = count === 0;
  if (_compareNeedBox) _compareNeedBox.textContent = count === 0 ? t('compare.needFav') : '';
}

/**
 * 渲染多地点对比入口卡。
 *
 * 放在收藏卡**正下方**：对比的对象就是收藏，两张卡挨着才看得出「先有收藏、
 * 再谈对比」这层关系；收藏为空时按钮禁用，同行写明该去哪儿收藏。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderCompareCard() {
  const count = getFavorites().length;
  const btn = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    id: 'btn-compare',
    disabled: count === 0,
    text: t('compare.entryBtn'),
  });
  btn.addEventListener('click', _goCompare);

  const countBox = h('p', { class: 'card-note', id: 'compare-current' });
  const needBox = h('p', { class: 'card-note', id: 'compare-need' });
  _compareBtn = btn;
  _compareCountBox = countBox;
  _compareNeedBox = needBox;

  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('compare.entry') }),
    h('p', { class: 'card-note', text: t('compare.hint') }),
    countBox,
    h('div', { class: 'field field--row' }, [btn]),
    needBox,
  ]);
}

/**
 * 渲染收藏卡（列表容器先建好，内容由 _refreshFavorites 填）。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderFavoriteCard() {
  const list = h('div', { class: 'fav-list', id: 'fav-list' });
  const count = h('p', { class: 'card-note', id: 'fav-count' });
  _favBox = list;
  _favCountBox = count;
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('fav.title') }),
    count,
    list,
    h('p', { class: 'card-note', text: t('fav.hint') }),
  ]);
}

/**
 * 渲染主题卡。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderThemeCard() {
  const current = getThemeMode();
  const buttons = THEME_MODES.map((m) =>
    h('button', {
      type: 'button',
      class: m === current ? 'seg-btn seg-btn--active' : 'seg-btn',
      'data-value': m,
      text: t(`settings.theme.${m}`),
    })
  );
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('settings.themeTitle') }),
    h('p', { class: 'card-note', text: t('settings.themeHint') }),
    h('div', { class: 'seg', id: 'theme-mode', role: 'group' }, buttons),
    h('p', { class: 'card-note', id: 'theme-result' }),
  ]);
}

/**
 * 渲染界面语言卡（中文 / English）。
 *
 * 与主题卡、字号卡完全同构（同一套 .seg / .seg-btn 结构、同一个 data-value 协议），
 * 三档外观放一起，用户不必学第二种交互。
 *
 * ★两个选项的显示名一律用**各自语言自己的写法**（中文界面里写「English」而不是
 *   「英文」）—— 用户看不懂当前界面语言时，唯一能救他的正是那个用他母语写着的选项名。
 *   这也是这张卡唯一一处「故意不翻译」的地方，不是漏翻。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderLocaleCard() {
  const current = getLocale();
  const buttons = LOCALES.map((s) =>
    h('button', {
      type: 'button',
      class: s === current ? 'seg-btn seg-btn--active' : 'seg-btn',
      'data-value': s,
      text: t(`settings.lang.${s}`),
    })
  );
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('settings.langTitle') }),
    h('p', { class: 'card-note', text: t('settings.langHint') }),
    h('div', { class: 'seg', id: 'locale-mode', role: 'group' }, buttons),
    h('p', { class: 'card-note', id: 'locale-result' }),
  ]);
}

/**
 * 渲染无障碍字号卡（三档）。
 *
 * 与主题卡完全同构（同一套 .seg / .seg-btn 结构、同一个 data-value 协议），
 * 两档外观放一起，用户不必学两种交互。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderFontCard() {
  const current = getFontScale();
  const buttons = FONT_SCALES.map((s) =>
    h('button', {
      type: 'button',
      class: s === current ? 'seg-btn seg-btn--active' : 'seg-btn',
      'data-value': s,
      text: t(`settings.font.${s}`),
    })
  );
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('settings.fontTitle') }),
    h('p', { class: 'card-note', text: t('settings.fontHint') }),
    h('div', { class: 'seg', id: 'font-scale', role: 'group' }, buttons),
    h('p', { class: 'card-note', id: 'font-result' }),
  ]);
}

/**
 * 当前可导出的 CSV 概要（常态显示，点导出前就知道会导出哪一份）。
 *
 * 取的是 `getLastSnapshot()` —— 与备份 JSON 里那份快照同源：它由此刻屏在**首屏三源
 * 全部取完之后**才写入（src/ui/app.js 的 setLastSnapshot），所以这里的快照天然是
 * 「完整的一份」，不会出现「导出一半空数据」。
 *
 * @returns {string} 概要文案。
 */
function _csvSummaryText() {
  const snap = getLastSnapshot();
  if (!snap) return t('settings.csvNone');
  const atMs = snap && snap.weather && snap.weather.atMs ? snap.weather.atMs : snap.atMs;
  const place =
    snap.placeName ||
    (snap.coord && Number.isFinite(Number(snap.coord.lat)) ? fmt.coord(snap.coord.lat, snap.coord.lon) : t('settings.previewNoPlace'));
  return t('settings.csvCurrent', { time: _fmtExportedAt(atMs), place });
}

/**
 * 为导出算一次磁偏角（度，东偏为正）。
 *
 * 为什么在本页算而不是放进 core/csv.js：磁偏角要用 data/wmm2025.js 那套模型系数，
 * 而四层单向依赖规定 `core` 不得 import `data`（tools/check.mjs 静态断言）。
 * 本页是 ui 层，import data 完全合法 —— 与 src/ui/compass.js 同一条路径。
 *
 * 失败（坐标缺失 / 纬度越界 / 模型抛 RangeError）一律返回 null：CSV 里那一列留空，
 * 绝不让一个算不出来的数把整份导出搞挂（口径同 compass.js 的 computeAt）。
 *
 * @param {Object} snapshot NowSnapshot。
 * @returns {number|null} 磁偏角（度）或 null。
 */
function _declinationFor(snapshot) {
  const coord = snapshot && snapshot.coord ? snapshot.coord : null;
  const lat = coord ? Number(coord.lat) : NaN;
  const lon = coord ? Number(coord.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const altM = Number(snapshot.elevationM);
    const deg = geomagneticDeclination({
      latitude: lat,
      longitude: lon,
      // WMM 要**千米**且是椭球高，项目通用单位是米 —— 与 compass.js 的 altitudeKmFromM 同口径
      altitudeKm: Number.isFinite(altM) ? altM / 1000 : 0,
      // 不传会按历元 2025.0 算而不是今天（2029 年打开就会拿到 2025 年的值）
      decimalYear: decimalYearFromDate(new Date()),
    });
    return Number.isFinite(deg) ? deg : null;
  } catch (err) {
    log('csv declination failed', err && err.message);
    return null;
  }
}

/**
 * 渲染导出 CSV 卡。
 *
 * 放在备份导入之后、主题之前：三张「把数据带出本机」的卡（备份导出 / 备份导入 /
 * CSV）连成一片，外观两档跟在后面。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderCsvCard() {
  const hasSnapshot = !!getLastSnapshot();
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('settings.csvTitle') }),
    h('p', { class: 'card-note', text: t('settings.csvHint') }),
    h('p', { class: 'card-note', id: 'csv-current', text: _csvSummaryText() }),
    h('div', { class: 'field field--row' }, [
      h('button', {
        class: 'btn btn--primary',
        type: 'button',
        id: 'btn-csv',
        disabled: !hasSnapshot,
        text: t('settings.csvBtn'),
      }),
    ]),
    hasSnapshot ? null : h('p', { class: 'card-note', text: t('settings.csvEmpty') }),
    h('p', { class: 'card-note', id: 'csv-result' }),
  ].filter(Boolean));
}

/**
 * 渲染导入预览面板（先看清楚，再决定要不要写）。
 *
 * @param {Object} plan inspectBackup 的产物。
 * @param {string} fileName 备份文件名。
 * @returns {void}
 */
function _renderPreview(plan, fileName) {
  const box = _el('import-preview');
  if (!box) return;
  const favorites = Array.isArray(plan.favorites) ? plan.favorites : [];
  const dropped = Number(plan.favoritesDropped) || 0;
  const placeName = plan.defaultPlace && plan.defaultPlace.name ? placeDisplayName(plan.defaultPlace.name) : t('settings.previewNoPlace');

  const lines = [
    t('settings.importReady', { name: fileName || t('app.unknown') }),
    t('settings.previewExportedAt', { time: _fmtExportedAt(plan.exportedAt) }),
    t('settings.previewPlace', { name: placeName }),
    t('settings.previewFavorites', { count: favorites.length }),
  ];
  if (dropped > 0) lines.push(t('settings.previewDropped', { count: dropped }));

  box.textContent = '';
  box.appendChild(h('p', { class: 'card-title', text: t('settings.previewTitle') }));
  lines.forEach((line) => box.appendChild(h('p', { class: 'card-note', text: line })));
}

/**
 * 渲染「自驾」入口卡。
 *
 * 只是一条跳 roadtrip.html 的链接（不是按钮 + JS 跳转）：本仓没有 SPA 路由，
 * 页面之间一律 `<a href>`，这样离线时 SW 也能直接命中预缓存的页面。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderRoadtripCard() {
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.entry') }),
    h('p', { class: 'card-note', text: t('rt.entryHint') }),
    h('div', { class: 'field field--row' }, [
      h('a', { class: 'btn btn--primary', href: 'roadtrip.html', text: t('rt.entryBtn') }),
    ]),
  ]);
}

/**
 * 渲染「高德 Key」卡（输入 + 保存 / 清除 / 校验 + 当前值）。
 *
 * ★两个刻意的取舍：
 *   1) **回显只给掩码**。整串回显等于把密钥摆在一块可能被截图、被投屏的屏幕上；
 *      而完全不显示，用户又无从知道自己填的是哪一个。maskKey() 首尾各留 4 位。
 *   2) **「校验」按钮明写消耗 1 次配额**。个人实名认证有免费额度，但额度是限量的，
 *      用户要在按下去之前就知道这一下的代价。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderAmapKeyCard() {
  const input = h('input', {
    class: 'btn',
    type: 'password',
    id: 'input-amap-key',
    placeholder: t('rt.keyPlaceholder'),
    autocomplete: 'off',
    spellcheck: 'false',
  });

  const current = h('p', { class: 'card-note', id: 'key-current' });
  const result = h('p', { class: 'card-note', id: 'key-result' });
  const checkBtn = h('button', {
    class: 'btn',
    type: 'button',
    id: 'btn-key-check',
    disabled: !hasAmapKey(),
    text: t('rt.keyCheck'),
  });

  _keyCurrentBox = current;
  _keyResultBox = result;
  _keyCheckBtn = checkBtn;

  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('rt.keyTitle') }),
    h('p', { class: 'card-note', text: t('rt.keyHint') }),
    input,
    current,
    h('div', { class: 'field field--row' }, [
      h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-key-save', text: t('rt.keySave') }),
      h('button', { class: 'btn', type: 'button', id: 'btn-key-clear', text: t('rt.keyClear') }),
      checkBtn,
    ]),
    result,
    // 隐私说明**常驻**：与导出备份那张卡同一个道理 —— 用户在填之前就该知道 Key 去哪了
    h('p', { class: 'card-note', text: t('rt.keyStored') }),
  ]);
}

/**
 * 刷新 Key 卡的「当前值」与「校验」按钮可用性。
 *
 * @returns {void}
 */
function _refreshKeyState() {
  if (_keyCurrentBox) {
    _keyCurrentBox.textContent = hasAmapKey()
      ? t('rt.keyCurrent', { mask: maskKey(getAmapKey()) })
      : t('rt.keyNone');
  }
  if (_keyCheckBtn) _keyCheckBtn.disabled = !hasAmapKey();
}

/**
 * 保存 Key。
 *
 * ★失败必须是看得见的：setAmapKey() 返回 false 就原样报出来，不许静默当成功
 * （core/apikeys.js 文件头对这条有交代）。
 *
 * @returns {void}
 */
function _onKeySave() {
  const input = _el('input-amap-key');
  const ok = setAmapKey(input ? input.value : '');
  if (!ok) {
    _setStatus('key-result', t('rt.keyBad', { max: KEY_MAX_LEN }));
    return;
  }
  // 存进去之后把输入框清空：框里再留着明文，等于把刚藏起来的密钥又摊开一次。
  if (input) input.value = '';
  _refreshKeyState();
  _setStatus('key-result', t('rt.keySaved', { mask: maskKey(getAmapKey()) }));
}

/**
 * 清除 Key。
 *
 * @returns {void}
 */
function _onKeyClear() {
  const ok = clearAmapKey();
  _refreshKeyState();
  _setStatus('key-result', ok ? t('rt.keyCleared') : t('rt.keyClearFail'));
}

/**
 * 校验 Key：真的发一次 POI 搜索。
 *
 * 用 `force: true` 绕开缓存 —— 命中缓存的「成功」证明不了这个 Key 现在可用。
 * 失败文案不自己编：走 errorText()，它会把 `rt.amap.invalidKey`（10001）／
 * `rt.amap.quota`（10003）这类**具体桶**原样上屏，用户才知道该换 Key 还是等明天。
 *
 * @returns {Promise<void>}
 */
async function _onKeyCheck() {
  if (_keyCheckBtn) _keyCheckBtn.disabled = true;
  _setStatus('key-result', t('rt.keyChecking'));
  let res;
  try {
    res = await requestRoadSource('amapPoi', KEY_CHECK_ANCHOR, { force: true });
  } catch (err) {
    // requestRoadSource 已经把 build/parse 的抛错收敛成 SourceResult，这里只兜
    // 「它自己也没兜住」的极端情况 —— 不能让一个未处理的 Promise 异常变成点了没反应。
    _setStatus('key-result', errorText(err));
    if (_keyCheckBtn) _keyCheckBtn.disabled = false;
    return;
  }
  if (_keyCheckBtn) _keyCheckBtn.disabled = !hasAmapKey();
  if (!res || !res.ok) {
    _setStatus('key-result', errorText(res ? res.error : null));
    return;
  }
  const count = res.data && Array.isArray(res.data.items) ? res.data.items.length : 0;
  _setStatus('key-result', count > 0 ? t('rt.keyOk', { count }) : t('rt.keyOkZero'));
}

/**
 * 渲染整页（替换 #app 里的骨架内容）。
 *
 * @returns {void}
 */
function _renderPage() {
  const app = _el('app');
  if (!app) return;
  app.textContent = '';
  app.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [
        h('h1', { class: 'hd-place', text: t('settings.title') }),
        h('p', { class: 'hd-coord', text: t('settings.subtitle') }),
      ]),
    ])
  );

  // (a) 收藏地点（放在备份之前：先让用户有东西可收藏，再说怎么把它们带走）
  app.appendChild(_renderFavoriteCard());

  // (a2) 多地点对比入口（紧跟收藏卡：对比的对象就是收藏，挨着才看得出先后关系）
  app.appendChild(_renderCompareCard());

  // (a3) 自驾入口 + 高德 Key（两张卡必须挨着：Key 是自驾的候选搜索凭据，
  //      分开摆用户会不知道那串 Key 填了是给谁用的）
  app.appendChild(_renderRoadtripCard());
  app.appendChild(_renderAmapKeyCard());

  // (b) 备份导出
  app.appendChild(
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('settings.exportTitle') }),
      h('p', { class: 'card-note', id: 'export-current', text: _exportSummaryText() }),
      h('div', { class: 'field field--row' }, [
        h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-export', text: t('settings.exportBtn') }),
      ]),
      // 隐私说明**常驻**在按钮下方：用户在按下之前就该知道这份文件里有什么
      h('p', { class: 'card-note', id: 'export-privacy', text: _privacyText() }),
      h('p', { class: 'card-note', id: 'export-result' }),
    ])
  );

  // (c) 备份导入（先预览，确认后才写）
  app.appendChild(
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('settings.importTitle') }),
      h('p', { class: 'card-note', text: t('settings.importHint') }),
      h('p', { class: 'card-note', text: t('settings.importPick') }),
      h('input', { class: 'btn', type: 'file', id: 'file-backup', accept: 'application/json,.json' }),
      h('div', { id: 'import-preview' }),
      h('div', { class: 'field field--row' }, [
        h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-confirm', disabled: true, text: t('settings.confirmBtn') }),
      ]),
      h('p', { class: 'card-note', text: t('settings.confirmHint') }),
      h('p', { class: 'card-note', id: 'import-result' }),
    ])
  );

  // (d) 导出 CSV（紧跟备份两张卡：三张都是「把数据带出本机」，连成一片更好找）
  app.appendChild(_renderCsvCard());

  // (e) 主题
  app.appendChild(_renderThemeCard());

  // (f) 字号（外观两档放一起）
  app.appendChild(_renderFontCard());

  // (g) 语言。**压在最后**：它是这一页唯一一个「点了之后整页文案都要变」的开关，
  // 后面必须紧跟一次 _renderPage() 重画（见 _bindSeg('locale-mode')），
  // 把它放在末尾，重画时用户视线落点离它最近，不会莫名其妙跳到页面顶部去了。
  app.appendChild(_renderLocaleCard());

  // 收藏列表内容最后填：卡片刚建好时 _favBox / _favCountBox 才指向真实节点，
  // 这一步顺带把导出卡的 {count} 也算对。
  _refreshFavorites();

  // Key 卡的当前值同上：_keyCurrentBox / _keyCheckBtn 也是刚建的引用，得等重画之后填。
  _refreshKeyState();
}

/* ------------------------------------------------------------------ */
/* 交互                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 读取用户选中的文件文本。
 *
 * @param {Object} file File 对象。
 * @returns {Promise<string>} 文件内容；读取失败 reject。
 */
function _readFileAsText(file) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('FileReader unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsText(file);
  });
}

/**
 * 选完文件：读取 → 只校验不写入 → 列出预览，等用户点头。
 *
 * @returns {Promise<void>} 无返回值。
 */
async function _onFilePicked() {
  const input = _el('file-backup');
  const confirmBtn = _el('btn-confirm');
  _plan = null;
  _fileName = '';
  _setStatus('import-result', '');
  const preview = _el('import-preview');
  if (preview) preview.textContent = '';
  if (confirmBtn) confirmBtn.disabled = true;

  const file = input && input.files && input.files.length > 0 ? input.files[0] : null;
  if (!file) {
    _setStatus('import-result', t('settings.pickFirst'));
    return;
  }
  // 清空 input：否则再次选同一个文件不会触发 change，预览/导入会卡在「没反应」
  const fileName = file.name || '';
  try {
    input.value = '';
  } catch (err) {
    /* 少数浏览器不允许清空，忽略（不影响本次读取） */
  }

  let text = '';
  try {
    text = await _readFileAsText(file);
  } catch (err) {
    _setStatus('import-result', t('settings.readFail', { message: _errMsg(err) }));
    return;
  }
  if (!String(text).trim()) {
    _setStatus('import-result', t('settings.readEmpty'));
    return;
  }

  const inspected = inspectBackup(text);
  if (!inspected.ok) {
    // 校验失败：本机状态一个字节都没动。★reason 是 core 给的**键**，必须过一遍 i18n
    // （core 不许 import i18n，写死中文的话英文界面里就会蹦出一句中文）。
    const why = reasonText(inspected);
    _setStatus('import-result', t('settings.importFail', { reason: why }));
    log(`import inspect failed: ${inspected.reasonKey}`);
    return;
  }

  _plan = inspected.plan;
  _fileName = fileName;
  _renderPreview(_plan, _fileName);
  if (confirmBtn) confirmBtn.disabled = false;
}

/**
 * 确认导入：这一步才真正写入本机。
 *
 * @returns {void}
 */
function _onConfirm() {
  const confirmBtn = _el('btn-confirm');
  if (!_plan) {
    _setStatus('import-result', t('settings.pickFirst'));
    return;
  }
  const res = applyBackup(_plan);
  if (!res.ok) {
    const why = reasonText(res);
    _setStatus('import-result', t('settings.importFail', { reason: why }));
    log(`import apply failed: ${res.reasonKey}`);
    return;
  }
  const placeName = res.applied.defaultPlace && res.applied.defaultPlace.name ? placeDisplayName(res.applied.defaultPlace.name) : t('settings.previewNoPlace');
  _setStatus('import-result', t('settings.importOk', { name: placeName, count: res.applied.favorites.length }));

  // 写完之后必须把这一轮的一次性状态收干净：计划失效、按钮回到禁用、预览清空
  _plan = null;
  _fileName = '';
  if (confirmBtn) confirmBtn.disabled = true;
  const preview = _el('import-preview');
  if (preview) preview.textContent = '';
  // 导入是覆盖性写入，收藏也被整份换掉 —— 列表必须重画（_refreshFavorites 内部会调 _refreshExport）
  _refreshFavorites();
  // 主题不受导入影响（themeMode 不在备份里），这里不需要重新应用，也不需要重画
}

/**
 * 导出备份 JSON。
 *
 * @returns {void}
 */
function _onExport() {
  const name = backupFilename();
  const data = exportBackup();
  if (downloadJson(name, data)) {
    _setStatus('export-result', t('settings.exportDone', { name }));
  } else {
    _setStatus('export-result', t('settings.exportFail'));
  }
}

/**
 * 导出「此刻」数据 CSV。
 *
 * 数据源是 store 里的**最近一次快照**（getLastSnapshot），不是现取一份新的：
 *   ① 此刻屏首屏三源取完才会写快照（app.js），所以这份必然是完整的一份；
 *   ② 导出是「把已经看到的东西拿走」，不该在离线时再发一轮请求去撞网络；
 *   ③ 与备份 JSON 里那份快照同源，两份导出说的是同一件事。
 * 没有快照时按钮本来就是禁用的；这里再挡一道（按钮状态可能被别处改写）。
 *
 * @returns {void}
 */
function _onExportCsv() {
  const snap = getLastSnapshot();
  if (!snap) {
    _setStatus('csv-result', t('settings.csvNoSnapshot'));
    _refreshCsv();
    return;
  }
  // ★tr: t —— CSV 的列名与分档名都是人类语言，而 core/csv.js 不许 import i18n
  // （core ← data ← ui ← html 单向依赖）。翻译回调由本页（ui 层）注入，
  // core 那个模块仍然只做序列化。不传的话列名会落成原始 key（可见的失败）。
  const built = snapshotToCsv(snap, {
    atMs: Date.now(),
    declinationDeg: _declinationFor(snap),
    tr: t,
  });
  if (downloadText(built.name, built.text, CSV_MIME)) {
    _setStatus('csv-result', t('settings.csvDone', { name: built.name }));
  } else {
    _setStatus('csv-result', t('settings.csvFail'));
  }
}

/**
 * 设置页初始化（DOM 就绪后调用）。
 *
 * @returns {void}
 */
export function init() {
  // ① 先把主题落上去：这一步必须早于任何渲染，否则用户上次选的主题会在这一页
  //    先闪一下系统的颜色，再被 JS 掰过来。init() 可能被多处调用，这里是幂等的。
  applyThemeMode(getThemeMode());
  // ①b 字号档位：与主题完全同一时机、同一理由（全站属性，慢一帧就会先显示默认字号
  //    再跳到放大档）。每个页面 HTML 的 <head> 里那段同步脚本已经在首帧之前预置过，
  //    这里只是把「store → 属性」这条链路再走一遍，保证 JS 改完档位立刻生效。
  applyFontScale(getFontScale());

  // ② 静态外壳文案统一由 i18n 填充
  applyI18n(document);
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('settings.title')}`;
  }

  _renderPage();
  _bindControls();
}

/**
 * 绑定整页控件（按钮 + 三个分段控件）。
 *
 * ★为什么单独抽出来：`_renderPage()` 会**整槽重建** #app，里头所有节点（含分段控件
 * 的容器）都是新对象，旧监听随之消失。语言切换是唯一一个切完必须重画的开关，
 * 所以重画之后要能再调一次本函数把监听装回来。绑定的是**新节点**，不会重复叠加
 * （旧节点连同旧监听已经不在文档里了）。
 *
 * @returns {void}
 */
function _bindControls() {
  const exportBtn = _el('btn-export');
  if (exportBtn) exportBtn.addEventListener('click', _onExport);

  const csvBtn = _el('btn-csv');
  if (csvBtn) csvBtn.addEventListener('click', _onExportCsv);

  const fileInput = _el('file-backup');
  if (fileInput) fileInput.addEventListener('change', () => _onFilePicked());

  const confirmBtn = _el('btn-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', _onConfirm);

  // 高德 Key 卡的三个按钮。★重画之后全是新节点，这里要重新装一遍（理由见本函数 JSDoc）。
  const keySaveBtn = _el('btn-key-save');
  if (keySaveBtn) keySaveBtn.addEventListener('click', _onKeySave);

  const keyClearBtn = _el('btn-key-clear');
  if (keyClearBtn) keyClearBtn.addEventListener('click', _onKeyClear);

  const keyCheckBtn = _el('btn-key-check');
  if (keyCheckBtn) keyCheckBtn.addEventListener('click', _onKeyCheck);

  _bindSeg('theme-mode', (v) => {
    setThemeMode(v);
    const applied = applyThemeMode(getThemeMode());
    log(`theme mode → ${applied}`);
    _setStatus('theme-result', t('settings.themeDone', { mode: t(`settings.theme.${applied}`) }));
  });

  // 字号三档：写 store → 立刻落到 <html data-fs>（全站属性，与主题同一套路）。
  // 改完**不需要重渲染**：放大是靠 CSS 变量乘数实现的，浏览器自己会重排整个页面。
  _bindSeg('font-scale', (v) => {
    setFontScale(v);
    const applied = applyFontScale(getFontScale());
    log(`font scale → ${applied}`);
    _setStatus('font-result', t('settings.fontDone', { mode: t(`settings.font.${applied}`) }));
  });

  // 语言两档：写 store → 立刻切 i18n 与 <html lang>。
  // ★与主题 / 字号唯一的不同：**必须整页重画**。那两个是靠 CSS 变量实现的，浏览器
  // 自己会重排；而文案是 t() 在渲染那一刻求值出来的字符串，不重画就还是旧语言。
  // 重画之后 #locale-result 会被 _renderPage() 清空，所以提示语在重画**之后**才写。
  _bindSeg('locale-mode', (v) => {
    const before = getLocale();
    const applied = switchLocale(v);
    log(`locale → ${applied}`);
    if (applied === before) {
      _setStatus('locale-result', t('settings.langDone', { name: t(`settings.lang.${applied}`) }));
      return;
    }
    _renderPage();
    // 重画后控件全是新节点，监听要重新装一遍（理由见 _bindControls 的 JSDoc）
    _bindControls();
    _setStatus('locale-result', t('settings.langDone', { name: t(`settings.lang.${applied}`) }));
  });
}

// 主题已在上面的模块顶层引导过（不在这里重复）。其余装配仍需守卫：Node 侧静态检查
// import 本模块时没有 document，不能注册事件、不能渲染。
if (typeof document !== 'undefined' && document !== null) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
