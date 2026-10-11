/**
 * 数据源自检页（真机复验）
 *
 * 职责：逐源串行取样并把结果实时增量上屏，输出可导出的 SelfCheckReport JSON。
 *
 * 关键口径（主理人拍板）：
 *   1) 网络类型：navigator.connection.type 在主流浏览器恒为 undefined，改为**页面上手动点选**
 *      （WiFi / 蜂窝 / 未知，默认未知），并自动附带记录 effectiveType 与 downlink 作为参考；
 *   2) 取样次数：页面可调 1 / 3 / 5，默认 3；先发 1 次预热（不计入统计）；
 *   3) 瓦片指纹：SHA-256 前 16 位 hex，界面统一称「指纹 fp」（不使用其它摘要命名）；
 *      dedupeTiles() 判定 real（各异）/ fake（全同，占位图）；
 *   4) 瓦片取样：3 种样式 × 3 个不同位置。
 *
 * 隐私红线：自检只请求六路数据源，不向任何第三方发请求；force=true 仅本页使用。
 */

import { t, APP_NAME, APP_VERSION } from '../i18n/zh.js';
import { request, makeError, isOnline, resetQueue } from '../core/http.js';
import { SOURCE_LIST, apiSources } from '../data/sources.js';
import { resetHealth, recordResult, addSample } from '../data/health.js';
import {
  probeTile,
  dedupeTiles,
  sampleTiles,
  TILE_STYLES,
  styleLabel,
  markStyleTrusted,
  degradeMapMode,
  mapMode,
} from '../data/tiles.js';
import { getNetworkType, setNetworkType as storeSetNetworkType, getThemeMode, getFontScale, log } from '../core/store.js';
import { stamp, latency as fmtLatency, bytes as fmtBytes } from '../core/format.js';
import { h, applyI18n } from './now.js';
import { downloadJson } from './download.js';
import { applyThemeMode, applyFontScale } from './theme.js';

// ★主题引导（模块顶层）：本页是四个入口之一，必须在 module 求值那一刻就把 store 里的
// themeMode 写到 <html data-theme> 上，不能等 init() —— 否则用户会先看到一帧系统色。
// 实现与四组合语义见 ui/theme.js 文件头。
applyThemeMode(getThemeMode());
// ★字号档位引导（模块顶层，与主题同一时机）：字号是全站属性，本页那一屏密集的
// 指标数字恰恰是最需要跟着放大档走的地方。乘数在 styles/tokens.css，这里只落属性。
applyFontScale(getFontScale());

/** 每源正式取样次数默认值。 */
export const DEFAULT_SAMPLES = 3;

/** 可选取样次数。 */
export const SAMPLE_OPTIONS = [1, 3, 5];

/** 网络类型选项。 */
export const NETWORK_OPTIONS = ['wifi', 'cellular', 'unknown'];

/** 自检探测用坐标（北京天安门，避免依赖定位权限）。 */
export const PROBE_COORD = { lat: 39.9087, lon: 116.3975 };

/** 探测用地名关键词（geocode 需要）。 */
export const PROBE_KEYWORD = '北京';

/** @type {number} 当前取样次数。 */
let _samples = DEFAULT_SAMPLES;

/** @type {'wifi'|'cellular'|'unknown'} 当前网络类型。 */
let _networkType = 'unknown';

/** @type {Object|null} 最近一份报告。 */
let _report = null;

/** @type {boolean} 是否正在自检（防重复点击）。 */
let _running = false;

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
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
 * 取 effectiveType（浏览器不支持时 'unknown'）。
 *
 * @returns {string} effectiveType。
 */
function _effectiveType() {
  try {
    const c = typeof navigator !== 'undefined' ? navigator.connection || navigator.mozConnection || navigator.webkitConnection : null;
    return c && c.effectiveType ? String(c.effectiveType) : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

/**
 * 取 downlink（Mb/s；不支持时 null）。
 *
 * @returns {number|null} downlink。
 */
function _downlink() {
  try {
    const c = typeof navigator !== 'undefined' ? navigator.connection || navigator.mozConnection || navigator.webkitConnection : null;
    const v = c && c.downlink !== undefined ? Number(c.downlink) : NaN;
    return Number.isFinite(v) ? v : null;
  } catch (err) {
    return null;
  }
}

/**
 * 取 User-Agent。
 *
 * @returns {string} UA 串。
 */
function _userAgent() {
  try {
    return typeof navigator !== 'undefined' && navigator.userAgent ? String(navigator.userAgent) : 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

/**
 * 中位数。
 *
 * @param {number[]} arr 数值数组（升序或无序）。
 * @returns {number|null} 中位数或 null。
 */
function _p50(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 追加一行日志到页面（debug 与自检过程可见）。
 *
 * @param {string} line 日志行。
 * @returns {void}
 */
function _pageLog(line) {
  const box = _el('log');
  if (!box) return;
  box.textContent = `${box.textContent}${box.textContent ? '\n' : ''}${line}`;
  box.scrollTop = box.scrollHeight;
  log(line);
}

/* ------------------------------------------------------------------ */
/* 行渲染                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染（或更新）一行数据源结果。
 *
 * @param {Object} item SelfCheckItem。
 * @param {{progress?:string}} [opts] 进度提示。
 * @returns {void}
 */
function _renderItem(item, opts = {}) {
  const list = _el('src-list');
  if (!list) return;
  const domId = `row-${item.sourceId}`;
  let row = list.querySelector(`#${domId}`);

  // 还没跑完（有进度提示且尚未取样）时显示「进行中」
  const status = opts.progress && item.attemptCount === 0 ? 'running' : item.status;

  const metrics = [];
  if (item.samplesMs.length > 0) {
    metrics.push(t('sc.latencyRange', { min: Math.round(Math.min(...item.samplesMs)), max: Math.round(Math.max(...item.samplesMs)) }));
    const p50 = _p50(item.samplesMs);
    if (p50 !== null) metrics.push(t('sc.latencyP50', { ms: Math.round(p50) }));
    const avg = item.samplesMs.reduce((a, b) => a + b, 0) / item.samplesMs.length;
    metrics.push(t('sc.latencyAvg', { ms: Math.round(avg) }));
  }
  if (item.httpStatus !== null) metrics.push(t('sc.httpStatus', { status: item.httpStatus }));
  metrics.push(`${t('sc.samples')} ${item.successCount}/${item.attemptCount}`);
  if (opts.progress) metrics.push(opts.progress);
  if (item.error) metrics.push(`[${item.error.code}] ${item.error.message}`);

  const nodes = [
    h('div', { class: 'sc-row-head' }, [
      h('span', { class: 'sc-row-name', text: item.label }),
      h('span', { class: `chip chip--${status === 'running' ? 'idle' : status}`, text: t(`status.${status}`) }),
    ]),
    h('div', { class: 'sc-row-metrics' }, metrics.map((m) => h('span', { text: m }))),
    h('div', { class: 'sc-row-url', text: item.url || t('app.dash') }),
  ];

  if (!row) {
    row = h('div', { class: 'sc-row', id: domId });
    list.appendChild(row);
  }
  row.textContent = '';
  nodes.forEach((n) => row.appendChild(n));
}

/**
 * 渲染（或更新）一行瓦片探测结果。
 *
 * @param {Object} probe TileProbe。
 * @returns {void}
 */
function _renderTile(probe) {
  const list = _el('tile-list');
  if (!list) return;
  const domId = `tile-${probe.styleId}-${probe.z}-${probe.x}-${probe.y}`;
  const nodes = [
    h('div', { class: 'sc-row-head' }, [
      h('span', { class: 'sc-row-name', text: `${probe.label} · z${probe.z}/${probe.x}/${probe.y}` }),
      h('span', { class: `chip chip--${probe.ok ? 'ok' : 'failed'}`, text: probe.ok ? t('status.ok') : t('status.failed') }),
    ]),
    h('div', { class: 'sc-row-metrics' }, [
      h('span', { text: fmtLatency(probe.latencyMs) }),
      h('span', { text: fmtBytes(probe.bytes) }),
      h('span', { text: probe.httpStatus !== null ? t('sc.httpStatus', { status: probe.httpStatus }) : t('app.dash') }),
      h('span', { text: `${t('sc.fpShort')} ${probe.fp ? probe.fp.slice(0, 12) : t('app.dash')}` }),
      h('span', { text: probe.fpAlgo ? t('sc.fpAlgo', { algo: probe.fpAlgo }) : t('app.dash') }),
    ]),
    // 非法坐标时 probe.url 为 null（tiles.js 刻意不给脏 URL），这里回落到占位符
    h('div', { class: 'sc-row-url', text: probe.url || t('app.dash') }),
  ];
  let row = list.querySelector(`#${domId}`);
  if (!row) {
    row = h('div', { class: 'sc-row', id: domId });
    list.appendChild(row);
  }
  row.textContent = '';
  nodes.forEach((n) => row.appendChild(n));
}

/**
 * 把各样式的去重判定收敛成整轮结论。
 *
 * 为什么不能直接拿 9 块瓦片一起比：不同样式本来就是不同底图，跨样式比指纹没有意义 ——
 * 全相异只能证明「街道图和影像图不是同一张图」，证明不了「这是真瓦片」；
 * 反过来，若取样位置在三种样式下重合，跨样式的 unique 还会被人为压低。
 * 真正有效的证据是「同一样式、三个远离位置」内部的指纹关系，所以整轮结论取各样式的共识：
 * 全部 fake → fake；全部 real → real；只要有 unknown 或结论打架 → unknown（保守）。
 *
 * @param {Object<string, Object>} byStyle 样式 id → DedupeVerdict。
 * @returns {'real'|'fake'|'unknown'} 整轮去重结论。
 */
function _dedupeOverall(byStyle) {
  const ids = Object.keys(byStyle || {});
  if (ids.length === 0) return 'unknown';
  const verdicts = ids.map((id) => (byStyle[id] && byStyle[id].verdict) || 'unknown');
  if (verdicts.every((v) => v === 'fake')) return 'fake';
  if (verdicts.every((v) => v === 'real')) return 'real';
  return 'unknown';
}

/**
 * 渲染去重判定汇总。
 *
 * @param {Object} dedupe DedupeVerdict（含 byStyle）。
 * @returns {void}
 */
function _renderDedupe(dedupe) {
  const box = _el('tile-dedupe');
  if (!box || !dedupe) return;
  const lines = [];
  const key = dedupe.verdict === 'real' ? 'sc.dedupeReal' : dedupe.verdict === 'fake' ? 'sc.dedupeFake' : 'sc.dedupeUnknown';
  const byStyle = dedupe.byStyle || {};
  lines.push(t(key, { unique: dedupe.unique, total: dedupe.total, styles: Object.keys(byStyle).length }));
  Object.keys(byStyle).forEach((styleId) => {
    const d = byStyle[styleId];
    lines.push(t('sc.dedupeByStyle', { label: styleLabel(styleId), unique: d.unique, total: d.total, verdict: d.verdict }));
  });
  box.textContent = lines.join('\n');
}

/**
 * 渲染顶部汇总条。
 *
 * @param {Object} report SelfCheckReport。
 * @returns {void}
 */
function _renderSummary(report) {
  const box = _el('summary');
  if (!box) return;
  box.hidden = false;
  const passCount = report.results.filter((r) => r.status === 'ok').length;
  const tileOk = report.tiles.filter((x) => x.ok).length;
  box.textContent = '';
  box.appendChild(
    h('span', { text: `${t('sc.summary.pass', { pass: passCount, total: report.results.length })} · ${t('sc.tiles')} ${tileOk}/${report.tiles.length}` })
  );
  box.appendChild(
    h('span', { class: `chip chip--${report.verdict === 'all-ok' ? 'ok' : report.verdict === 'offline' ? 'offline' : 'stale'}`, text: t(`sc.verdict.${report.verdict}`) })
  );
  const btn = _el('btn-export');
  if (btn) btn.disabled = false;
  const copyBtn = _el('btn-copy');
  if (copyBtn) copyBtn.disabled = false;
  const slimBtn = _el('btn-copy-compact');
  if (slimBtn) slimBtn.disabled = false;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

/**
 * 生成探测上下文。
 *
 * @returns {{lat:number, lon:number, keyword:string, lang:string}} 上下文。
 */
function _probeCtx() {
  return { lat: PROBE_COORD.lat, lon: PROBE_COORD.lon, keyword: PROBE_KEYWORD, lang: 'zh' };
}

/**
 * 运行一轮自检。
 *
 * @param {{samples?:number, networkType?:'wifi'|'cellular'|'unknown'}} [opts] 选项。
 * @returns {Promise<Object>} SelfCheckReport。
 */
export async function runSelfCheck(opts = {}) {
  const samples = SAMPLE_OPTIONS.indexOf(Number(opts.samples)) !== -1 ? Number(opts.samples) : DEFAULT_SAMPLES;
  const networkType = NETWORK_OPTIONS.indexOf(opts.networkType) !== -1 ? opts.networkType : _networkType;
  _samples = samples;
  _networkType = networkType;

  resetQueue();
  resetHealth();

  const online = isOnline();
  const ctx = _probeCtx();

  const report = {
    app: APP_NAME,
    version: APP_VERSION,
    generatedAt: Date.now(),
    networkType,
    effectiveType: _effectiveType(),
    downlink: _downlink(),
    online,
    samples,
    warmup: true,
    userAgent: _userAgent(),
    results: [],
    tiles: [],
    tileDedupe: null,
    verdict: 'partial',
  };

  _pageLog(`${t('sc.networkType')}：${t(`sc.net.${networkType}`)} · ${t('sc.samples')} ${samples} · ${t('sc.warmup')}`);
  _pageLog(t('sc.effectiveType', { value: report.effectiveType }));
  _pageLog(t('sc.downlink', { value: report.downlink === null ? t('app.unknown') : report.downlink }));
  _pageLog(t('sc.userAgent', { value: report.userAgent }));

  // 【必修 1】取样分组必须用 kind 判定，不能用「源 id 不在样式 id 列表里」这种间接条件：
  // TILE_STYLES 的键是 street/imagery/dark，源 id 是 'tile'，两者永远不相等 ——
  // 旧写法等价于「不过滤」，于是 tile 被塞进 API 结果表，而 ctx 里没有 styleId/z/x/y，
  // tileUrl 会把 undefined 拼进路径发出 `.../tile/undefined/undefined/undefined` 畸形请求。
  const tileIds = Object.keys(TILE_STYLES);
  const apiList = apiSources();

  // ---- 五路 API 源：预热 1 次 + 正式取样 samples 次 ----
  for (const spec of apiList) {
    const item = {
      sourceId: spec.id,
      label: spec.label,
      url: '',
      status: 'failed',
      latencyMin: null,
      latencyMax: null,
      latencyP50: null,
      latencyAvg: null,
      samplesMs: [],
      successCount: 0,
      attemptCount: 0,
      httpStatus: null,
      error: null,
    };
    _renderItem(item, { progress: t('app.loading') });

    if (!online) {
      // 离线：一律不发请求（隐私与性能硬约束）
      item.status = 'offline';
      item.error = makeError('OFFLINE', spec.id);
      _renderItem(item);
      report.results.push(item);
      continue;
    }

    // 预热（结果丢弃，不计入统计）
    const warm = await request(spec.id, ctx, { force: true });
    item.url = warm.meta.requestUrl;
    _pageLog(`warmup ${spec.id} → ${warm.ok ? 'ok' : warm.error.code} ${Math.round(warm.meta.latencyMs)} ms`);

    for (let i = 0; i < samples; i += 1) {
      const r = await request(spec.id, ctx, { force: true });
      item.attemptCount += 1;
      addSample(spec.id, r.meta.latencyMs);
      recordResult(r);
      if (r.ok) {
        item.successCount += 1;
        item.samplesMs.push(Math.round(r.meta.latencyMs));
        item.httpStatus = r.meta.httpStatus;
      } else {
        item.error = r.error;
        item.httpStatus = r.meta.httpStatus;
      }
      _renderItem(item, { progress: t('sc.sampleDone', { i: i + 1, n: samples }) });
    }

    if (item.samplesMs.length > 0) {
      item.latencyMin = Math.round(Math.min(...item.samplesMs));
      item.latencyMax = Math.round(Math.max(...item.samplesMs));
      item.latencyP50 = _p50(item.samplesMs);
      item.latencyAvg = Math.round(item.samplesMs.reduce((a, b) => a + b, 0) / item.samplesMs.length);
    }
    item.status = item.successCount > 0 ? 'ok' : 'failed';
    _renderItem(item);
    report.results.push(item);
  }

  // ---- 瓦片：3 样式 × 3 位置 ----
  if (online) {
    const tiles = sampleTiles(PROBE_COORD);
    for (const styleId of tileIds) {
      for (const tile of tiles) {
        // ★必须 useCache:false：自检测的是真实链路质量，命中缓存会让这一轮数据全废
        // （时延恒为 0、还测不出网络抖动）。写缓存与否另由「样式授信」决定，与这个开关无关。
        const probe = await probeTile(styleId, tile, { useCache: false });
        report.tiles.push(probe);
        _renderTile(probe);
      }
    }
    const byStyle = {};
    for (const styleId of tileIds) {
      byStyle[styleId] = dedupeTiles(report.tiles.filter((x) => x.styleId === styleId));
    }
    // unique/total 仍是 9 块瓦片的原始统计（便于人工核对），
    // 但 verdict 一律走 byStyle 共识 —— 跨样式比指纹得不出可信结论，见 _dedupeOverall 注释。
    const overall = dedupeTiles(report.tiles);
    report.tileDedupe = { ...overall, verdict: _dedupeOverall(byStyle), byStyle };
    _renderDedupe(report.tileDedupe);

    // ---- 样式授信：自检页既是「体检」也是「授信」入口 ----
    // 只有真机验明是真瓦片（同一样式多位置指纹各异 → real），日常使用（此刻屏）才允许走缓存；
    // 判 fake 是「确诊占位图」的正面证据，必须立刻撤销授信并清空该样式的缓存。
    // unknown 只是样本不足，不足以推翻既有结论，故不动。
    for (const styleId of tileIds) {
      const verdict = byStyle[styleId] && byStyle[styleId].verdict;
      if (verdict === 'real') markStyleTrusted(styleId, true);
      else if (verdict === 'fake') markStyleTrusted(styleId, false);
    }

    // ---- 整批裁决地图模式 ----
    // 单块的成败不决定全局：9 块里坏 2 块不代表底图全废（真机瓦片时延波动 13 倍）。
    // 全成 → map；全败 → no-map；部分失败 → grid（仅网格 + 坐标，先不宣布无地图）。
    degradeMapMode(report.tiles);
    _pageLog(t('sc.mapMode', { mode: t(`sc.mapMode.${mapMode()}`) }));
  } else {
    report.tileDedupe = { total: 0, unique: 0, fps: [], verdict: 'unknown', byStyle: {} };
    _pageLog(t('sc.offlineSkip'));
  }
  report.mapMode = mapMode();

  // ---- 汇总判定 ----
  // verdict 回答「这一轮能不能放心用」：五路 API 全通 + 九块瓦片都拿到字节 + 瓦片不是占位图。
  // 前两条只证明「可达」（200 也可能是占位图），第三条由 tileDedupe.verdict 兜住：
  // 只要整轮去重判定为 fake，就不许判 all-ok —— 否则「假成功源」会被当成健康源放行。
  // 口径细节与真机复验读法见 README「真机复验怎么读」。
  if (!online) {
    report.verdict = 'offline';
  } else {
    const allApiOk = report.results.length > 0 && report.results.every((r) => r.status === 'ok');
    const allTilesOk = report.tiles.length > 0 && report.tiles.every((x) => x.ok);
    const tilesNotFake = !report.tileDedupe || report.tileDedupe.verdict !== 'fake';
    report.verdict = allApiOk && allTilesOk && tilesNotFake ? 'all-ok' : 'partial';
  }
  report.generatedAt = Date.now();
  _renderSummary(report);
  _report = report;
  return report;
}

/**
 * 导出报告 JSON（文件名 geoscope-selfcheck-<YYYYMMDD-HHmm>.json）。
 *
 * @param {Object} [report] 报告；缺省用最近一份。
 * @returns {void}
 */
export function exportReport(report) {
  const data = report || _report;
  if (!data) return;
  const name = t('sc.exportName', { stamp: stamp(data.generatedAt) });
  // 下载手法统一走 ui/download.js（含「延后释放 objectURL」那条不可删的细节），
  // 这里只负责取名与结果反馈，导出签名与产物格式均不变。
  if (downloadJson(name, data)) {
    _pageLog(`export → ${name}`);
  } else {
    _pageLog(t('sc.exportFail'));
  }
}

/**
 * 把文本复制到剪贴板，三级降级。
 *
 * 三级降级：Clipboard API（需安全上下文，file:// 通常算）→ 隐藏 textarea +
 * execCommand → 把文本显示在页面上供长按选中。
 *
 * 抽出来给「复制结果」与「复制精简版」共用。
 *
 * @param {string} text 要复制的文本。
 * @param {string} [okKey] 成功提示的文案键。
 * @param {string} [failKey] 落到最后一级时的提示文案键。
 * @returns {void}
 */
function _copyText(text, okKey, failKey) {
  const ok = okKey || 'sc.copyOk';
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const done = document.execCommand('copy');
      document.body.removeChild(ta);
      if (done) {
        _pageLog(t(ok));
        return;
      }
    } catch (err) {
      /* 落到最后一级 */
    }
    const pre = _el('log');
    if (pre) {
      pre.textContent = text;
      _pageLog(t(failKey || 'sc.copyFail'));
    }
  };

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(() => _pageLog(t(ok)), fallback);
      return;
    }
  } catch (err) {
    /* 落到下一级 */
  }
  fallback();
}

/**
 * 生成精简版报告：剔掉超长字段（各源 URL、UA、label），只留判定要用的数字。
 *
 * 存在意义：完整 JSON 约 4.5 KB —— 各源 URL 与 UA 就占去一大半。
 * 在微信里粘贴这种长度，会超出单条消息上限或被输入框截断
 * （真机两轮实测各被截断一次，两次都丢在瓦片区）。精简后约 1.5 KB。
 *
 * 注意：byStyle 里只保留体量统计与判定，不重复罗列 fps —— 指纹本身
 * 已经逐块记在 tiles 里，重复一遍纯属浪费通道。
 *
 * @param {Object} [data] 完整报告；缺省用最近一份。
 * @returns {Object|null} 精简报告；无报告时返回 null。
 */
export function compactReport(data) {
  const d = data || _report;
  if (!d) return null;
  const src = (d.tileDedupe && d.tileDedupe.byStyle) || {};
  const byStyle = {};
  for (const key of Object.keys(src)) {
    byStyle[key] = { total: src[key].total, unique: src[key].unique, verdict: src[key].verdict };
  }
  return {
    app: d.app,
    version: d.version,
    generatedAt: d.generatedAt,
    networkType: d.networkType,
    effectiveType: d.effectiveType,
    downlink: d.downlink,
    online: d.online,
    samples: d.samples,
    warmup: d.warmup,
    results: (d.results || []).map((r) => ({
      sourceId: r.sourceId,
      status: r.status,
      latencyP50: r.latencyP50,
      latencyMin: r.latencyMin,
      latencyMax: r.latencyMax,
      samplesMs: r.samplesMs,
      successCount: r.successCount,
      httpStatus: r.httpStatus,
    })),
    tiles: (d.tiles || []).map((x) => ({
      styleId: x.styleId,
      z: x.z,
      x: x.x,
      y: x.y,
      ok: x.ok,
      latencyMs: x.latencyMs,
      bytes: x.bytes,
      fp: x.fp,
    })),
    tileDedupe: d.tileDedupe
      ? { total: d.tileDedupe.total, unique: d.tileDedupe.unique, verdict: d.tileDedupe.verdict, byStyle }
      : null,
    verdict: d.verdict,
  };
}

/**
 * 把完整报告 JSON 复制到剪贴板。
 *
 * @param {Object} [report] 报告；缺省用最近一份。
 * @returns {void}
 */
export function copyReport(report) {
  const data = report || _report;
  if (!data) return;
  _copyText(JSON.stringify(data, null, 2));
}

/**
 * 把精简版报告 JSON 复制到剪贴板（无缩进，约 1.5 KB）。
 *
 * 手机端取数首选这条路径：短到不会被任何输入框截断。
 *
 * @param {Object} [report] 报告；缺省用最近一份。
 * @returns {void}
 */
export function copyCompact(report) {
  const data = report || _report;
  if (!data) return;
  const slim = compactReport(data);
  if (!slim) return;
  _copyText(JSON.stringify(slim), 'sc.copyCompactOk', 'sc.copyCompactFail');
}

/**
 * 设置网络类型（手动点选，写入 store）。
 *
 * @param {'wifi'|'cellular'|'unknown'} type 网络类型。
 * @returns {void}
 */
export function setNetworkType(type) {
  _networkType = NETWORK_OPTIONS.indexOf(type) !== -1 ? type : 'unknown';
  storeSetNetworkType(_networkType);
  if (_report) _report.networkType = _networkType;
}

/**
 * 设置取样次数。
 *
 * @param {number} n 次数（1/3/5）。
 * @returns {void}
 */
export function setSamples(n) {
  _samples = SAMPLE_OPTIONS.indexOf(Number(n)) !== -1 ? Number(n) : DEFAULT_SAMPLES;
}

/* ------------------------------------------------------------------ */
/* 页面装配                                                             */
/* ------------------------------------------------------------------ */

/**
 * 绑定分段控件（网络类型 / 取样次数）。
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

/**
 * 渲染六源占位行（未自检时先列出源名与宿主）。
 *
 * @returns {void}
 */
function _renderPlaceholders() {
  const list = _el('src-list');
  if (!list) return;
  list.textContent = '';
  SOURCE_LIST.forEach((spec) => {
    list.appendChild(
      h('div', { class: 'sc-row' }, [
        h('div', { class: 'sc-row-head' }, [
          h('span', { class: 'sc-row-name', text: spec.label }),
          h('span', { class: 'chip chip--idle', text: t('status.idle') }),
        ]),
        h('div', { class: 'sc-row-url', text: spec.host }),
      ])
    );
  });
}

/**
 * 自检页初始化（DOM 就绪后调用）。
 *
 * @returns {void}
 */
export function init() {
  // 静态 HTML 外壳的文案统一由 i18n 填充（HTML 内不硬编码中文）
  applyI18n(document);
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('sc.title')}`;
  }

  _networkType = getNetworkType() || 'unknown';

  // 同步分段控件初始选中态
  const ntBox = _el('network-type');
  if (ntBox) {
    Array.prototype.forEach.call(ntBox.querySelectorAll('.seg-btn'), (b) => {
      b.classList.toggle('seg-btn--active', b.getAttribute('data-value') === _networkType);
    });
  }

  _bindSeg('network-type', (v) => {
    setNetworkType(v);
    _pageLog(`${t('sc.networkType')} → ${t(`sc.net.${v}`)}`);
  });
  _bindSeg('sample-count', (v) => {
    setSamples(Number(v));
    _pageLog(`${t('sc.samples')} → ${v}`);
  });

  const runBtn = _el('btn-run');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      if (_running) return;
      _running = true;
      runBtn.disabled = true;
      runBtn.textContent = t('sc.running');
      const list = _el('src-list');
      if (list) list.textContent = '';
      const tiles = _el('tile-list');
      if (tiles) tiles.textContent = '';
      try {
        await runSelfCheck({ samples: _samples, networkType: _networkType });
      } catch (err) {
        _pageLog(`run failed: ${err && err.message}`);
      } finally {
        _running = false;
        runBtn.disabled = false;
        runBtn.textContent = t('sc.run');
      }
    });
  }

  const exportBtn = _el('btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportReport(_report));
  }

  const copyBtn = _el('btn-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => copyReport(_report));
  }

  const slimBtn = _el('btn-copy-compact');
  if (slimBtn) {
    slimBtn.addEventListener('click', () => copyCompact(_report));
  }

  _renderPlaceholders();
}

if (typeof document !== 'undefined' && document !== null) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
