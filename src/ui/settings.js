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
import { snapshotToCsv, CSV_MIME } from '../core/csv.js';
import { declinationDegAt } from '../data/wmm2025.js';
import {
  getState,
  getLastSnapshot,
  getThemeMode,
  setThemeMode,
  getFontScale,
  setFontScale,
  getLocale,
  getDefaultPlace,
  setDefaultPlace,
  getFavorites,
  removeFavorite,
  log,
} from '../core/store.js';
// 定位：本页「默认地点」卡的「用当前位置」按钮要自己问一次系统定位。
// ★`GEO_TIMEOUT_MS` 从 core 取而不是在本页另写一个 8000：两处各写一份必然漂移，
//   而「界面说超时了、core 其实还没到上限」是一句假话。
import { getCurrentPosition, GEO_TIMEOUT_MS } from '../core/geo.js';
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
// ★必须 import 源注册表（哪怕本页一个符号都不用它）：setSourceResolver() 是
//   data/sources.js 在**自己加载时**调用的，漏掉这一行任何按 id 取源的调用都会拿到
//   UNSUPPORTED —— 不发任何请求、按钮点了没反应（compare.js:40 有同一条注释）。
//   ★2026-10-17 自驾下线：这一行原本还兼着「给第三方 Key 校验用的源解析器」这个职责，
//   现在 Key 卡与自驾入口卡一起删除，它只剩纯粹的副作用导入用途。
import '../data/sources.js';

// 壳更新提示条：任何页面都要能看见「有新版本」（详见 shellupdate.js 文件头）。
// ★本页另有 _renderShellCard() 的「检查更新」按钮，两者是同一条链路的两段：
//   用户点「检查更新」→ 新壳 activate → 这里探测到 waiting → 出现提示条。
import { watchShellUpdate } from './shellupdate.js';

// 安装状态机：本页的「添加到桌面」卡只问它**事实**（装没装 / 能不能弹 / 弹的结果 /
//   当前环境是哪一类 / 该显示哪一档），可见文案一律留在本页走 t()（详见 install.js 文件头）。
import {
  initInstallPrompt,
  isInstalled,
  canPrompt,
  promptInstall,
  detectHostEnv,
  pickInstallMode,
} from './install.js';

// 默认地点卡的决策层：只回答「能不能用 / 造出什么值 / 是不是出厂那份」，
// 一个 DOM 都不建、一句文案都不出 —— 文案全在本页走 t()（详见 defaultplace.js 文件头）。
import {
  factoryDefault,
  canAdoptGps,
  adoptGps,
  adoptFavorite,
  isFactoryDefault,
  gpsSupported,
  queryGpsPermission,
  classifyGpsFailure,
} from './defaultplace.js';

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

/** @type {HTMLElement|null} 壳版本卡里那一行版本号（SW 回包后要填，留引用同 _favBox）。 */
let _shellVersionBox = null;

/** @type {HTMLElement|null} 壳版本卡里那一行资产指纹。 */
let _shellFingerprintBox = null;

/** @type {HTMLElement|null} 壳版本卡的「检查更新」结果行。 */
let _shellResultBox = null;

/**
 * 向 SW 问版本号的最长等待（毫秒）。
 *
 * 为什么要超时：SW 不回包的原因很多（旧版 SW 不认这个信封、controller 还没接管本页、
 * 消息通道被打断），而这些情况下页面**不会有任何反应**。不设上限就是那一行永远
 * 停在「查询中…」，用户看着像卡住了。1.5 s 足够一个健康的 SW 回一次消息。
 */
const SHELL_ASK_TIMEOUT_MS = 1500;

/**
 * 调 `registration.update()` 之后留给「新壳进 waiting」的观察窗（毫秒）。
 *
 * update() 只是**发起**检查，它 resolve 时新版可能还在 installing。不等这一下的话
 * 永远看不到 waiting，按钮会一直说「已是最新」——那是最误导人的一种假话。
 */
const SHELL_UPDATE_SETTLE_MS = 800;

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
 * 渲染「添加到桌面 / 主屏幕」卡（三态，见 _fillInstallCard）。
 *
 * ★为什么压在最上面（页头之后、收藏卡之前）——位置本身就是这次修复的内容：
 *   真机反馈是「在哪里『添加到桌面或主屏幕』？我没找到」，manifest 与 SW 一直都在、
 *   浏览器菜单里也一直能装，缺的就是 App 内一个看得见的入口。藏进设置下半部分
 *   等于没做。
 *   会不会长期占地方？不会：这是一次性动作 —— 装完这一卡就折叠成一行
 *   （settings.installedNote），不再有按钮，也不再占视线。
 *   iOS 尤其不能藏：iOS Safari 永远不触发 `beforeinstallprompt`，那类环境**只能**
 *   靠这张卡里的手动步骤，藏深了等于这条路径根本不存在。
 *
 * @returns {HTMLElement} 卡片节点（id 稳定，供 _refreshInstallCard 原地重画）。
 */
function _renderInstallCard() {
  const card = h('div', { class: 'card', id: 'install-card' });
  _fillInstallCard(card);
  return card;
}

/**
 * 按**当前**状态重画「添加到桌面」卡的内部内容（原地替换，不换卡片节点本身）。
 *
 * ★为什么必须有这个函数：`beforeinstallprompt` 是**异步**到的 —— 典型情形是页面刚
 *   加载完那一小会儿事件才来，而 `_renderPage()` 早已画完。只画一次的话，用户看到的
 *   永远是「手动步骤」那一档，按钮**永远不会出现**，这次修复等于没做。
 *   所以 `initInstallPrompt()` 的 onChange 指向这里；切换语言会整页重画
 *   （`_renderPage()` → 新建卡片 → `_fillInstallCard()`），那条路径同样对。
 *
 * @returns {void}
 */
function _refreshInstallCard() {
  const card = _el('install-card');
  if (!card) return;  // 不在设置页（别的页面没有这张卡）→ 什么都不做
  _fillInstallCard(card);
}

/**
 * 填卡片内容（七档）。
 *
 * ★本页**不做任何档位判定**：三个信号照旧从 install.js 取，交给 `pickInstallMode()`
 *   裁决，本页只负责「mode → 文案 key → DOM」。理由同上个函数 —— 那一段 if/else 是
 *   **事实判定**（该给哪一档）而不是渲染，放进零 import 的 install.js 才能被 Node 单测
 *   钉住；留在渲染函数里，下次谁改这块就会悄悄退化。
 *
 * 七档与对应文案：
 *   installed → installedNote（一行，无按钮）；prompt → installHint + 真按钮 installBtn；
 *   blocked-wechat → installBlockedWechat；blocked-qq → installBlockedQq；
 *   manual-ios → installManualIos；manual-android → installManualAndroid；
 *   manual-other → installManual（判不出来，iOS / 安卓两条路都摆出来让用户对号入座）。
 *
 * ★为什么要分后面那几档（2026 真机反馈）：用户在微信里点「…」→「添加到桌面」试了几次
 *   都没有；换真浏览器打开后「右上角…」又没了（那个 ⋮ 只有 Chrome / Edge 有，
 *   三星 / 小米 / 华为 / UC / 夸克的菜单在**底栏**，iOS 必须用 Safari 且入口在底部中间）。
 *   所以只给一条通用手动步骤不够 —— 得先说清「当前这个环境为什么装不了」，再说出路在哪。
 *
 * @param {HTMLElement} card 卡片节点。
 * @returns {void}
 */
function _fillInstallCard(card) {
  card.textContent = '';
  card.appendChild(h('p', { class: 'card-title', text: t('settings.installTitle') }));

  const mode = pickInstallMode({
    installed: isInstalled(),
    canPrompt: canPrompt(),
    env: detectHostEnv(),
  });

  // installed：已经装好了 —— 一行说明收尾，不再给任何按钮（一次性动作，装完就该安静）
  if (mode === 'installed') {
    card.appendChild(h('p', { class: 'card-note', id: 'install-note', text: t('settings.installedNote') }));
    card.appendChild(h('p', { class: 'card-note', id: 'install-result', text: '' }));
    return;
  }

  // prompt：手里真有事件对象 —— 这一档的按钮才点了有反应
  if (mode === 'prompt') {
    const btn = h('button', { class: 'btn', type: 'button', id: 'btn-install', text: t('settings.installBtn') });
    btn.addEventListener('click', _onInstallClick);
    card.appendChild(h('p', { class: 'card-note', id: 'install-note', text: t('settings.installHint') }));
    card.appendChild(h('div', { class: 'field field--row' }, [btn]));
    card.appendChild(h('p', { class: 'card-note', id: 'install-result', text: '' }));
    return;
  }

  // 余下五档都没有按钮（没事件对象就不许显示按钮）。
  // ★i18n key **必须保持字面量**：拼成变量的键会绕过 tools/check.mjs 第 9 节与
  //   tests/sources.test.mjs 的 i18n 反查，缺了哪个 key 就再也查不出来 —— 所以五档
  //   宁可各写一遍。全部复用现成 .card-note，**零新增 CSS**（不许加任何 color: 声明）。
  let note = t('settings.installManual');
  if (mode === 'blocked-wechat') note = t('settings.installBlockedWechat');
  else if (mode === 'blocked-qq') note = t('settings.installBlockedQq');
  else if (mode === 'manual-ios') note = t('settings.installManualIos');
  else if (mode === 'manual-android') note = t('settings.installManualAndroid');

  card.appendChild(h('p', { class: 'card-note', id: 'install-note', text: note }));
  card.appendChild(h('p', { class: 'card-note', id: 'install-result', text: '' }));
}

/**
 * 「添加到桌面」按钮点击：弹系统安装提示，把结果写进结果位。
 *
 * ★点击期间把按钮 disabled：事件对象只能用一次，连点第二次会直接抛（真浏览器行为），
 *   而抛出来只是界面上多一句「安装没能完成」，看不出是被自己连点搞坏的。
 *
 * @returns {Promise<void>} 永不 reject（promptInstall() 自己吞异常）。
 */
async function _onInstallClick() {
  const btn = _el('btn-install');
  if (btn) btn.disabled = true;

  const res = await promptInstall();
  const outcome = res && res.outcome;
  let msg = t('settings.installFailed');
  if (outcome === 'accepted') msg = t('settings.installAccepted');
  else if (outcome === 'dismissed') msg = t('settings.installDismissed');

  // ★弹完之后事件对象必定已经消耗掉（canPrompt() 变 false），按钮留着就是个死按钮
  //   → 重画到「没有事件对象」那一档（手动步骤），再把结果写回去。
  //   顺序不能反：重画会重建结果位，写在重画之前会被清掉。
  _refreshInstallCard();
  _setStatus('install-result', msg);
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
 * 渲染「默认地点」卡。
 *
 * 定位拿不到的时候（拒绝 / 超时 / 没信号 / 环境不支持），此刻屏与地理页显示的**就是
 * 这里设的地点**。它是「我的」页里唯一一个会影响其它两页读数的设置，所以必须能在
 * 界面上改 —— 之前只能靠导入备份改，等于没有。
 *
 * ★为什么放在安装卡**之后**、收藏卡**之前**（位置本身就是本单的内容之一）：
 *   两条都属于「开始用之前先设好」的一次性设置，挨在一起才好找；而收藏卡是
 *   「先有数据、再谈备份」这条动线的开头，不该被顶掉。
 *   ★不放在整页最前面：上一轮的安装卡占了第一位，那是**可发现性缺陷**（真机反馈
 *   「没找到」）；默认地点从来不是找不到，不享受这个待遇。
 *
 * @returns {HTMLElement} 卡片节点（id 稳定，供 _refreshDefaultPlaceCard 原地重画）。
 */
function _renderDefaultPlaceCard() {
  const card = h('div', { class: 'card', id: 'default-place-card' });
  _fillDefaultPlaceCard(card);
  return card;
}

/**
 * 按**当前**状态重画「默认地点」卡的内容（原地替换，不换卡片节点本身）。
 *
 * ★为什么写完之后必须重画：这张卡的第一行就是「现在是：xx · 坐标」。写完不重画，
 *   用户点了「从收藏选」而第一行纹丝不动 —— 他会以为没生效，再点一次、再来一次，
 *   而实际上每次点击都真的写进去了。位置没变、状态已变，这就是假话。
 *
 * @returns {void}
 */
function _refreshDefaultPlaceCard() {
  const card = _el('default-place-card');
  if (!card) return;  // 不在设置页（别的页面没有这张卡）→ 什么都不做
  _fillDefaultPlaceCard(card);
}

/**
 * 填「默认地点」卡的内容（现状行 + 三种改法 + 结果位）。
 *
 * 三条不许退化的规矩：
 *   1) **出厂默认必须标注出来**：第一行写着「北京 · 天安门」却不说它是出厂那份，
 *      用户会以为自己什么时候设过它（isFactoryDefault 的判据在 defaultplace.js）；
 *   2) **收藏为空时不给死按钮**：只给一句空态文案，让用户知道该去哪儿收藏；
 *   3) **定位失败如实报原因**，且不写入 —— 见 _onUseGps 的注释。
 *
 * @param {HTMLElement} card 卡片节点。
 * @returns {void}
 */
function _fillDefaultPlaceCard(card) {
  card.textContent = '';
  card.appendChild(h('p', { class: 'card-title', text: t('settings.defaultPlaceTitle') }));
  card.appendChild(h('p', { class: 'card-note', text: t('settings.defaultPlaceHint') }));

  const place = getDefaultPlace();
  const shown = placeDisplayName(place.name);
  card.appendChild(
    h('p', {
      class: 'card-note',
      id: 'dp-current',
      text: t('settings.defaultPlaceCurrent', { name: shown, coord: fmt.coord(place.lat, place.lon) }),
    })
  );
  // ★出厂默认必须额外标注：不写这一行，「北京 · 天安门」看着就像用户自己设的位置
  if (isFactoryDefault(place)) {
    card.appendChild(h('p', { class: 'card-note', id: 'dp-factory', text: t('settings.defaultPlaceFactoryNote') }));
  }

  // ① 用当前位置
  const gpsBtn = h('button', {
    class: 'btn',
    type: 'button',
    id: 'btn-dp-gps',
    text: t('settings.defaultPlaceGpsBtn'),
  });
  gpsBtn.addEventListener('click', _onUseGps);
  card.appendChild(h('div', { class: 'field field--row' }, [gpsBtn]));

  // ② 从收藏选：每条收藏一个按钮；★收藏为空时只给空态文案，不给点了没用的死按钮
  const favorites = getFavorites();
  card.appendChild(h('p', { class: 'card-note', text: t('settings.defaultPlaceFavTitle') }));
  if (favorites.length === 0) {
    card.appendChild(h('p', { class: 'card-note', id: 'dp-fav-empty', text: t('settings.defaultPlaceFavEmpty') }));
  } else {
    const picks = favorites.map((f, i) => {
      const btn = h('button', {
        class: 'btn',
        type: 'button',
        'data-idx': String(i),
        text: f.name ? String(f.name) : fmt.coord(f.lat, f.lon),
      });
      btn.addEventListener('click', () => {
        // 点击期间禁用，防连点（重画之后是新按钮，可用态自然恢复）
        btn.disabled = true;
        _onPickFavorite(String(i));
      });
      return btn;
    });
    card.appendChild(h('div', { class: 'field field--row', id: 'dp-fav-list' }, picks));
  }

  // ③ 恢复出厂默认
  const resetBtn = h('button', {
    class: 'btn',
    type: 'button',
    id: 'btn-dp-reset',
    text: t('settings.defaultPlaceResetBtn'),
  });
  resetBtn.addEventListener('click', _onResetFactory);
  card.appendChild(h('div', { class: 'field field--row' }, [resetBtn]));

  card.appendChild(h('p', { class: 'card-note', id: 'dp-result', text: '' }));
}

/**
 * 「用当前位置」：问一次系统定位，拿到了才写入，拿不到如实报原因。
 *
 * ★★拿不到时**绝不写**。定位兜底出来的北京天安门是 `core/geo.js` 的占位坐标，
 *   不是用户的位置；把它写进默认地点，等于把一句假话持久化进备份 JSON，还会随
 *   导出 / 导入带到别的设备上继续冒充「你的位置」（纪律见 defaultplace.js 文件头）。
 *
 * ★失败要分三类说（拒绝 / 超时 / 环境不支持），落在哪一档由 `classifyGpsFailure()`
 *   判定 —— 本页不自己推断，也不把三种并成一句含糊的「定位失败」。
 *
 * @returns {Promise<void>} 永不 reject（异常也只落到结果位）。
 */
async function _onUseGps() {
  const btn = _el('btn-dp-gps');
  if (btn) btn.disabled = true;  // 点击期间禁用，防连点

  const started = Date.now();
  const supported = gpsSupported();
  // 权限裁决是**可选能力**：问不到就是 null，由 classifyGpsFailure 落到「原因不明」
  const permission = supported ? await queryGpsPermission() : null;

  let coord = null;
  try {
    coord = await getCurrentPosition({ timeoutMs: GEO_TIMEOUT_MS });
  } catch (err) {
    // getCurrentPosition 本身永不 reject（内部已兜底），这里只是双保险：
    // 真抛了也不能让卡片停在一个永远 disabled 的按钮上。
    coord = null;
  }
  const elapsedMs = Date.now() - started;

  if (canAdoptGps(coord)) {
    const place = adoptGps(coord);
    if (place) {
      setDefaultPlace(place);
      _refreshDefaultPlaceCard();
      _setStatus('dp-result', t('settings.defaultPlaceGpsDone', { name: placeDisplayName(place.name) }));
      // 导出卡概要里也写着默认地点，一并刷新（否则那一行立刻变成假话）
      _refreshExport();
      return;
    }
  }

  // ★顺序不能反：重画会重建结果位，写在重画之前会被清掉
  _refreshDefaultPlaceCard();
  const why = classifyGpsFailure({ supported, permission, elapsedMs, timeoutMs: GEO_TIMEOUT_MS });
  if (why === 'unsupported') _setStatus('dp-result', t('settings.defaultPlaceGpsUnsupported'));
  else if (why === 'denied') _setStatus('dp-result', t('settings.defaultPlaceGpsDenied'));
  else if (why === 'timeout') _setStatus('dp-result', t('settings.defaultPlaceGpsTimeout'));
  else _setStatus('dp-result', t('settings.defaultPlaceGpsOther'));
}

/**
 * 「从收藏选」：把选中的收藏写成默认地点。
 *
 * ★`adoptFavorite()` 找不到时返回 null（不回退出厂默认），那种情况只写一句结果、
 *   一个字节都不动 —— 「没找到」不是「用默认值」。
 *
 * @param {string} index 收藏在列表里的下标（adoptFavorite 只认下标：收藏项没有 id 字段）。
 * @returns {void}
 */
function _onPickFavorite(index) {
  const place = adoptFavorite(getFavorites(), index);
  if (!place) {
    _setStatus('dp-result', t('settings.defaultPlaceFavMissing'));
    return;
  }
  setDefaultPlace(place);
  // ★写完必须重画：第一行「现在是：…」要立刻变，不能等下次进页面
  _refreshDefaultPlaceCard();
  _setStatus('dp-result', t('settings.defaultPlaceFavDone', { name: placeDisplayName(place.name) }));
  _refreshExport();
}

/**
 * 「恢复出厂默认」：写回出厂那份（副本），并重画。
 *
 * @returns {void}
 */
function _onResetFactory() {
  const btn = _el('btn-dp-reset');
  if (btn) btn.disabled = true;  // 点击期间禁用，防连点（重画后是新按钮）
  const place = factoryDefault();
  setDefaultPlace(place);
  _refreshDefaultPlaceCard();
  _setStatus('dp-result', t('settings.defaultPlaceResetDone', { name: placeDisplayName(place.name) }));
  _refreshExport();
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
  // 单位换算（米→千米）、decimalYear、异常兜底统一由 data 层的 declinationDegAt 管 ——
  // 与 compass.js、此刻页共用同一份，避免三处各写一遍 WMM 的单位坑。
  return declinationDegAt(coord, { altitudeM: snapshot ? snapshot.elevationM : null });
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
 * 渲染「离线壳版本」卡。
 *
 * ★为什么要在界面上摆版本号（不是洁癖，是一次真机事故的产物）：
 *   有用户报「搜泉州没找到、空气卡还是 AQI」，而线上 index.html 与 src/ui/*.js 核过
 *   **都是新的** —— 设备上跑的是一份两周前的旧壳副本（底部 tab 还是导航重构之前的
 *   三个）。同一台设备的另一个页面却是新的。也就是说：发布成功了，但用户没换过来，
 *   而这个 App 当时**没有任何地方**能告诉他这件事，也不会自己去拿新壳。
 *   这张卡就是那个「能看见」的地方：版本号由**正在运行的 SW 自己报回来**，
 *   不是页面读常量拼出来的 —— 后者永远显示仓库里的最新值，等于什么也没说。
 *
 * ★三条不许退化的规矩：
 *   1) 拿不到版本号就如实写「未知 / 本环境不支持」，**绝不编一个填上去**；
 *   2) 问 SW 必须带超时，不能让那一行永远停在「查询中…」；
 *   3) 检查更新失败必须报失败，**不许吞成「已是最新」**。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderShellCard() {
  const versionBox = h('p', { class: 'card-note', id: 'shell-version', text: t('shell.querying') });
  const fpBox = h('p', { class: 'card-note', id: 'shell-fingerprint', text: '' });
  const resultBox = h('p', { class: 'card-note', id: 'shell-check-result', text: '' });
  const btn = h('button', { class: 'btn', type: 'button', id: 'btn-check-update', text: t('shell.checkBtn') });
  btn.addEventListener('click', _onCheckUpdate);

  _shellVersionBox = versionBox;
  _shellFingerprintBox = fpBox;
  _shellResultBox = resultBox;

  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('shell.title') }),
    versionBox,
    fpBox,
    h('div', { class: 'field field--row' }, [btn]),
    h('p', { class: 'card-note', text: t('shell.hint') }),
    resultBox,
  ]);
}

/**
 * 向正在运行的 SW 问一句「你是哪一份」，把版本号与指纹填进卡片。
 *
 * 只在 SW 存在时才发消息并挂超时；`navigator.serviceWorker` 不存在（file:// 或
 * 非安全上下文）时**同步**落一句「本环境不支持」—— 那种环境里连问都没处问，
 * 挂一个注定超时的定时器只会让卡片多 blank 一秒半。
 *
 * @returns {void}
 */
function _askShellVersion() {
  const versionBox = _shellVersionBox;
  const fpBox = _shellFingerprintBox;
  if (!versionBox) return;

  const nav = typeof navigator !== 'undefined' && navigator ? navigator : null;
  if (!nav || !nav.serviceWorker) {
    // ★如实说不支持，不许拿 SHELL_CACHE 之类的常量拼一个版本号出来（见本卡 JSDoc 第 1 条）
    versionBox.textContent = t('shell.unsupported');
    if (fpBox) fpBox.textContent = '';
    return;
  }

  const sw = nav.serviceWorker;
  const controller = sw.controller;

  // 首次访问（本页还没被任何 SW 接管）时 controller 为 null：问了也没有人回，
  // 直接判未知，不必白等满超时。
  if (!controller || typeof controller.postMessage !== 'function') {
    versionBox.textContent = t('shell.unknown');
    if (fpBox) fpBox.textContent = '';
    return;
  }

  let settled = false;
  let timer = null;

  /**
   * 收尾：先落值，再把监听与定时器都摘掉。
   *
   * @param {string} versionText 版本号那一行要显示的文案。
   * @param {string} fpText 指纹那一行要显示的文案。
   * @returns {void}
   */
  const finish = (versionText, fpText) => {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (typeof sw.removeEventListener === 'function') sw.removeEventListener('message', onMessage);
    versionBox.textContent = versionText;
    if (fpBox) fpBox.textContent = fpText || '';
  };

  /**
   * SW 回包处理：只认 shell-version 信封，其余消息（别的页面也可能在广播）不碰。
   *
   * @param {Object} event MessageEvent。
   * @returns {void}
   */
  function onMessage(event) {
    const data = event && event.data;
    if (!data || typeof data !== 'object' || data.type !== 'shell-version') return;
    // ★回包里没有版本号（比如跑的是一个不认这个信封的旧 SW）就判未知，不编。
    const v = typeof data.version === 'string' && data.version ? data.version : t('shell.unknown');
    const fp = typeof data.fingerprint === 'string' && data.fingerprint ? t('shell.fingerprint', { fp: data.fingerprint }) : '';
    finish(v, fp);
  }

  if (typeof sw.addEventListener === 'function') sw.addEventListener('message', onMessage);
  timer = setTimeout(() => finish(t('shell.unknown'), ''), SHELL_ASK_TIMEOUT_MS);
  controller.postMessage({ type: 'shell-version' });
}

/**
 * 「检查更新」：手动催一次 SW 更新，并让等待中的新壳立刻接管。
 *
 * ★为什么这里**不自动 reload()**：页面重载会把用户正在输入的搜索词冲掉，
 *   风险大于收益。本单只做到「让新壳尽快接管，下次进入即是新版」，
 *   并把结果如实写在按钮下面，由用户自己决定要不要刷新。
 *
 * @returns {Promise<void>} 永不 reject（异常已写进结果行）。
 */
async function _onCheckUpdate() {
  const box = _shellResultBox;

  /**
   * 写结果行。
   *
   * @param {string} s 文案。
   * @returns {void}
   */
  const set = (s) => {
    if (box) box.textContent = s;
  };

  const nav = typeof navigator !== 'undefined' && navigator ? navigator : null;
  if (!nav || !nav.serviceWorker) {
    set(t('shell.unsupported'));
    return;
  }

  set(t('shell.querying'));
  try {
    const reg = await nav.serviceWorker.getRegistration();
    if (!reg) {
      set(t('shell.unknown'));
      return;
    }
    await reg.update();
    // update() resolve 时新版可能还在 installing，等这一下才看得到 waiting（见常量注释）
    await new Promise((resolve) => setTimeout(resolve, SHELL_UPDATE_SETTLE_MS));
    const pending = reg.waiting || reg.installing;
    if (pending && typeof pending.postMessage === 'function') {
      set(t('shell.checking'));
      pending.postMessage({ type: 'skip-waiting' });
      return;
    }
    set(t('shell.upToDate'));
  } catch (err) {
    // ★失败必须报失败：吞成「已是最新」会让用户以为自己拿到新版了（见本卡 JSDoc 第 3 条）
    set(t('shell.checkFailed', { msg: (err && err.message) || t('app.unknown') }));
  }
}

/**
 * 渲染「数据源自检」入口卡。
 *
 * 2026-10-16 导航重构：自检**从底部 tabbar 移进「我的」页**（主导航砍到三个：
 * 此刻 / 自驾 / 我的）。2026-10-17 自驾下线后三个主 tab 是地理 / 气候 / 我的，
 * 自检仍是「我的」页里的入口，位置不变。
 *
 * 它不是日常要看的东西，占一个 tab 位不划算；
 * 但它的价值不只在调试 —— **换网络环境**（出境、换运营商）时要靠它看清
 * 哪一路还通，**数据看着不对**时也要靠它判断是上游挂了还是 App 的问题。
 * 所以入口必须留着，只是从常驻挪到了收纳处。
 *
 * 同样只是一条 `<a href>`：离线时 SW 才能命中预缓存的页面。
 *
 * @returns {HTMLElement} 卡片节点。
 */
function _renderSelfcheckCard() {
  return h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t('sc.entryTitle') }),
    h('p', { class: 'card-note', text: t('sc.entryHint') }),
    h('div', { class: 'field field--row' }, [
      h('a', { class: 'btn', href: 'selfcheck.html', text: t('sc.entryBtn') }),
    ]),
  ]);
}

/**
 * 渲染整页（替换 #app 里的骨架内容）。
 *
 * ★2026-10-17 路线规划功能下线：原「路线规划入口卡」与「第三方 Key 卡」已整块删除
 *   （连同它们依赖的 Key 存储与自驾源表两个模块，三者都一并下线了；本注释刻意不写
 *   那两个模块的文件名 —— 它们已不存在，写完整路径会被 check.mjs 第 21 节判为断链）。
 *   删 Key 卡不是顺手 —— 它存的那个 Key 是自驾 POI 搜索的凭据，自驾没了它就没有
 *   存在理由；留着只会让用户填一串永远不会被使用的密钥。
 *   注：本段刻意用「缩写路径」写，不写完整仓库相对路径 —— `tools/check.mjs` 第 21 节
 *   会校验注释里的完整路径是否指向真实文件，那两个文件已不存在。
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

  // (0) 添加到桌面 / 主屏幕（压在收藏卡之前：真机反馈「没找到」，位置本身就是修复内容；
  //     装完这一卡折叠成一行，不会长期占地方。位置理由见 _renderInstallCard 的 JSDoc）
  app.appendChild(_renderInstallCard());

  // (0b) 默认地点（紧跟安装卡：两条都是「开始用之前先设好」的一次性设置；
  //      ★不占整页第一位 —— 安装卡占第一位是因为用户「没找到」，那是可发现性缺陷，
  //      默认地点不享受这个待遇。位置理由见 _renderDefaultPlaceCard 的 JSDoc）
  app.appendChild(_renderDefaultPlaceCard());

  // (a) 收藏地点（放在备份之前：先让用户有东西可收藏，再说怎么把它们带走）
  app.appendChild(_renderFavoriteCard());

  // (a2) 多地点对比入口（紧跟收藏卡：对比的对象就是收藏，挨着才看得出先后关系）
  app.appendChild(_renderCompareCard());

  // (a3) 2026-10-17 自驾下线：原「自驾入口卡 + 第三方 Key 卡」占用的位置已移除。
  //      收藏 → 对比 → 备份，是一条「先有数据、再带出去」的完整动线，不再被 Key 打断。

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

  // (d2) 离线壳版本 —— 它和自检一样是**诊断工具**而不是外观设置，所以挨着自检入口放，
  //      放在数据类卡片末尾、外观类之前。语言卡必须仍压在整页最后（见下面 (g) 的注释），
  //      不要抢它的位置。
  app.appendChild(_renderShellCard());

  // (d3) 数据源自检 —— 2026-10-16 从底部 tabbar 搬进来（主导航只剩三个，见 MAIN_TABS）。
  //      位置：数据类卡片末尾、外观类之前 —— 它是诊断工具而不是外观设置；
  //      语言卡必须压在整页最后（点完要整页重画，见下面 (g) 的注释），不能抢它的位置。
  app.appendChild(_renderSelfcheckCard());

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

  // 壳版本号同理：_renderShellCard() 刚把两个文案位挂上来（_shellVersionBox /
  // _shellFingerprintBox），现在才指得到真实节点。问 SW 是异步的，不影响渲染。
  _askShellVersion();
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
  watchShellUpdate();  // 任何页面都要能看见「有新版本」，见 shellupdate.js
  // 安装状态机：事件是**异步**到的（页面刚加载完那一小会儿才来），所以这里只挂监听，
  // 由 onChange → _refreshInstallCard() 把那一卡原地重画（理由见它的 JSDoc）。
  initInstallPrompt(_refreshInstallCard);
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
