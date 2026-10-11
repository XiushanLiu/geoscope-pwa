/**
 * 「我的」设置页（备份导出 / 备份导入 / 主题切换）
 *
 * 职责：把 core 层已经备好的能力接成界面 ——
 *   1) 导出：core/backup.js 的 exportBackup() + ui/download.js 落地成文件；
 *   2) 导入：**先看后写**（inspectBackup 预览 → 用户点头 → applyBackup 落地）；
 *   3) 主题：三档写 <html data-theme>，具体色值全在 styles/tokens.css。
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
 * 依赖方向：ui ← core。顶层不触碰 DOM（除下面一处紧急应用主题），便于 Node 侧检查与单测。
 */

import { t } from '../i18n/zh.js';
import { getState, getLastSnapshot, getThemeMode, setThemeMode, log } from '../core/store.js';
import { exportBackup, inspectBackup, applyBackup, backupFilename } from '../core/backup.js';
import { downloadJson } from './download.js';
import { h, applyI18n } from './now.js';

/** 主题模式选项（顺序即界面顺序）。 */
export const THEME_MODES = ['system', 'light', 'dark'];

/** @type {Object|null} 当前待确认的导入计划（inspectBackup 的产物，未经用户确认不许写）。 */
let _plan = null;

/** @type {string} 待确认备份的文件名（仅用于预览回放给用户看）。 */
let _fileName = '';

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

/**
 * 把主题模式落到 <html data-theme> 上。
 *
 * 为什么只有这一个改写点：深浅两种样式在 tokens.css 里由两组选择器唯一确定 ——
 * `:root[data-theme='light']` 属性块，以及 `@media (prefers-color-scheme: light)
 * :root:not([data-theme='dark'])` 媒体块。**没有 `[data-theme='dark']` 规则块**，
 * 属性值为 dark 时命中的是 `:root` 的默认（深色）值。于是三种模式的写法分别是：
 *   system → 移除属性（交给媒体查询跟着系统走）
 *   light  → 设为 'light'（命中属性块）
 *   dark   → 设为 'dark'（挡掉媒体查询，回落 :root 默认值）
 * 别在这里 add/remove CSS 规则块 —— tokens.css 里两个浅色块是手工重复的
 * （注释写着「改一处必须改两处」），动色值必然漏一处。
 *
 * 在非浏览器环境（Node 侧静态检查）下本函数是空操作。
 *
 * @param {'system'|'light'|'dark'} mode 主题模式。
 * @returns {'system'|'light'|'dark'} 实际应用的模式（非法值按 system 处理）。
 */
export function applyThemeMode(mode) {
  const root = typeof document !== 'undefined' && document ? document.documentElement : null;
  const applied = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (!root) return applied;
  if (applied === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', applied);
  return applied;
}

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
  const place = state.defaultPlace && state.defaultPlace.name ? state.defaultPlace.name : t('settings.previewNoPlace');
  // 快照不在 getState() 里（store 把它单独存在另一个缓存键下），必须走 getLastSnapshot()
  const hasSnapshot = !!getLastSnapshot();
  return t('settings.exportCurrent', {
    place,
    count: state.favorites.length,
    snapshot: hasSnapshot ? t('settings.snapshotYes') : t('settings.snapshotNo'),
  });
}

/**
 * 取错误对象的可读消息（不抛）。
 *
 * @param {*} err 任意错误。
 * @returns {string} 消息串。
 */
function _errMsg(err) {
  if (!err) return t('app.unknown');
  return err.message ? String(err.message) : String(err);
}

/**
 * 把 ISO 时间串格式化成本地可读时间（'YYYY-MM-DD HH:MM'）。
 *
 * 备份可能来自几个月前，年-月-日必须齐全 —— core/format.js 的 mdHm() 只给到月日，
 * 跨年的旧备份会显示得像「今天」，那正是「误以为这是最新备份」的诱因。
 *
 * @param {string} iso ISO 时间串。
 * @returns {string} 本地时间文本；无法解析时返回 i18n 的「未知」。
 */
function _fmtExportedAt(iso) {
  if (!iso) return t('app.unknown');
  const ms = Date.parse(iso);
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
  if (privacy) privacy.textContent = t('settings.backupPrivacy', { count: getState().favorites.length });
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
  const placeName = plan.defaultPlace && plan.defaultPlace.name ? plan.defaultPlace.name : t('settings.previewNoPlace');

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

  // (a) 备份导出
  app.appendChild(
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('settings.exportTitle') }),
      h('p', { class: 'card-note', id: 'export-current', text: _exportSummaryText() }),
      h('div', { class: 'field field--row' }, [
        h('button', { class: 'btn btn--primary', type: 'button', id: 'btn-export', text: t('settings.exportBtn') }),
      ]),
      // 隐私说明**常驻**在按钮下方：用户在按下之前就该知道这份文件里有什么
      h('p', { class: 'card-note', id: 'export-privacy', text: t('settings.backupPrivacy', { count: getState().favorites.length }) }),
      h('p', { class: 'card-note', id: 'export-result' }),
    ])
  );

  // (b) 备份导入（先预览，确认后才写）
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

  // (c) 主题
  app.appendChild(_renderThemeCard());
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
    // 校验失败：本机状态一个字节都没动，把 reason 原样给用户
    _setStatus('import-result', t('settings.importFail', { reason: inspected.reason }));
    log(`import inspect failed: ${inspected.reason}`);
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
    _setStatus('import-result', t('settings.importFail', { reason: res.reason }));
    log(`import apply failed: ${res.reason}`);
    return;
  }
  const placeName = res.applied.defaultPlace && res.applied.defaultPlace.name ? res.applied.defaultPlace.name : t('settings.previewNoPlace');
  _setStatus('import-result', t('settings.importOk', { name: placeName, count: res.applied.favorites.length }));

  // 写完之后必须把这一轮的一次性状态收干净：计划失效、按钮回到禁用、预览清空
  _plan = null;
  _fileName = '';
  if (confirmBtn) confirmBtn.disabled = true;
  const preview = _el('import-preview');
  if (preview) preview.textContent = '';
  _refreshExport();
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
 * 设置页初始化（DOM 就绪后调用）。
 *
 * @returns {void}
 */
export function init() {
  // ① 先把主题落上去：这一步必须早于任何渲染，否则用户上次选的主题会在这一页
  //    先闪一下系统的颜色，再被 JS 掰过来。init() 可能被多处调用，这里是幂等的。
  applyThemeMode(getThemeMode());

  // ② 静态外壳文案统一由 i18n 填充
  applyI18n(document);
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('settings.title')}`;
  }

  _renderPage();

  const exportBtn = _el('btn-export');
  if (exportBtn) exportBtn.addEventListener('click', _onExport);

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
}

// ★模块求值那一刻就把主题上好：<script type="module"> 是 defer 的，不等 DOMContentLoaded
// 的话，用户会看到一帧系统色的背景。这里顶层的守卫保证 Node 侧静态检查 import 本模块时安全。
if (typeof document !== 'undefined' && document !== null) {
  applyThemeMode(getThemeMode());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
