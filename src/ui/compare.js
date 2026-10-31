/**
 * 多地点对比页（compare.html 入口）
 *
 * 职责：把「我的」页里收藏的地点逐个取一次天气与空气，用**同一套指标、同一顺序**
 * 并排列出来，让同一行的数字可以直接对读。
 *
 * ★三条硬规矩（改这个文件前先看懂，破了就是造假）：
 *   1) **数据只来自真实取到的量**：本页不推算、不插值、不拿别处的数据填空白；
 *      每个地点的每个指标都是那一次请求里带回来的原值，缺了就显示占位符「—」。
 *   2) **串行取数**：http.js 的全局并发恒为 1，本页绝不并发 —— `fetchAll()` 是
 *      `for … await` 的普通串行循环，不是 Promise.all。地点越多等得越久，这是
 *      刻意的选择（弱网下并发抢带宽会一起超时），界面上如实说明。
 *   3) **失败要看得见**：单个地点取不到就地标失败并写出原因；一个都取不到时给明确
 *      的空态说明（不是空白、也不是一直转圈）。绝不用静默吞掉错误来「显得正常」。
 *
 * 为什么这一页**不带底部 tabbar**：`.tabbar` 是 `position: fixed` 且没有 width
 * （shrink-to-fit，宽度由内容决定），四个 tab 在 320px 屏上已经贴着临界点（实测
 * 内容宽 294px），真机上出过「此刻」两字断成两行的 bug（fa1ec49）。加第五项必撑破。
 * 所以本页改用一个明确的「返回『我的』」入口（左上角那颗按钮），不进 tabbar。
 *
 * 依赖方向：ui ← data ← core。本页只 import core（store / http / format / wmo）
 * 与 ui（now.js 的 h / applyI18n、theme.js），不碰 data 层以外的东西。
 * 顶层只做两件全站属性的引导（主题 / 字号），其余 DOM 访问全在 init() / run() 内。
 */

import { t } from '../i18n/index.js';
import { errorText } from './errtext.js';
import { applyLocale } from './locale.js';
import * as fmt from '../core/format.js';
import { aqi } from '../core/wmo.js';
import {
  getFavorites,
  getThemeMode,
  getFontScale,
  getLocale,
  log,
} from '../core/store.js';
import { request, isOnline } from '../core/http.js';
import { h, applyI18n } from './now.js';
// ★必须 import 源注册表（哪怕本页一个符号都不用它）：core/http.js 不认识任何源 id，
// 源规格是 data/sources.js 在**自己加载时**通过 setSourceResolver() 注入进去的
// （core 不许反向 import data，所以只能走注入）。漏掉这一行，request('weather', …)
// 会拿到 UNSUPPORTED —— 不发任何请求、每行都判失败，而界面看不出「是没注册」还是
// 「网络坏了」。app.js 是 import { getSource } 顺带完成注册的，本页不用那个符号，
// 所以这行是纯副作用导入，**不能删**。
import '../data/sources.js';
// 主题 / 字号是全站属性，本页作为入口之一必须各引导一次（实现见 ui/theme.js）。
import { applyThemeMode, applyFontScale } from './theme.js';

// 壳更新提示条：任何页面都要能看见「有新版本」（详见 shellupdate.js 文件头）。
import { watchShellUpdate } from './shellupdate.js';
// 语言引导：与主题 / 字号同构，本页入口必须在 module 求值那一刻就切好 i18n
// （四个独立 HTML、靠 <a href> 跳转，没有共享 bootstrap，谁也不能替谁写）。

// ★主题引导（模块顶层，行首无缩进）：与 index/settings/compass/selfcheck 同一时机。
applyThemeMode(getThemeMode());
// ★字号档位引导（与主题同一时机、同一理由）。放大乘数在 styles/tokens.css。
applyFontScale(getFontScale());
applyLocale(getLocale());

/** 单页最多对比的地点数。 */
export const MAX_PLACES = 6;

/**
 * 行状态。
 *
 * @type {Object<string,string>}
 */
export const ROW_STATUS = {
  /** 还没取（或正在取）。 */
  PENDING: 'pending',
  /** 至少取到一路数据。 */
  OK: 'ok',
  /** 一路都没取到。 */
  FAILED: 'failed',
};

/**
 * 每行要取的数据源（顺序即串行取数顺序）。
 *
 * 只有 weather / air 两路：对比维度全部取自这两路的返回字段，没有第三路需要问。
 * 海拔 / 逆地理不在对比范围 —— 它们不随时刻变化，对比起来没有信息量，
 * 而每多一路就多一次串行等待（见文件头第 2 条）。
 *
 * @type {string[]}
 */
export const ROW_SOURCES = ['weather', 'air'];

/* ------------------------------------------------------------------ */
/* 数据层（可单测，不碰 DOM）                                            */
/* ------------------------------------------------------------------ */

/**
 * 由地点列表构造对比行（全部置为「待取」）。
 *
 * @param {Array<{lat:number, lon:number, name:string}>} places 地点列表。
 * @returns {Array<Object>} 行数组（每行持有自己的 place 副本）。
 */
export function buildRows(places) {
  const list = Array.isArray(places) ? places : [];
  return list.map((p) => {
    const src = p && typeof p === 'object' ? p : {};
    return {
      place: {
        lat: Number(src.lat),
        lon: Number(src.lon),
        name: String(src.name === null || src.name === undefined ? '' : src.name),
      },
      status: ROW_STATUS.PENDING,
      /** @type {Object|null} 天气数据。 */
      weather: null,
      /** @type {Object|null} 空气数据。 */
      air: null,
      /** @type {string|null} 整行都没取到时的失败原因（已本地化）。 */
      error: null,
      /** @type {boolean} 取到的值里是否含陈旧数据（缓存兜底）。 */
      stale: false,
    };
  });
}

/**
 * 取一个地点（串行跑完 ROW_SOURCES 里的每一路）。
 *
 * ★为什么「取到一路就算成功」：天气与空气是**两个独立数据源**，空气挂了不代表
 * 这个地点的天气不可信。整行判失败会把还能用的气温一起废掉，那是过度否决；
 * 缺的那一项在界面上显示占位符「—」，读者看得见「这一格没数据」。
 *
 * ★反过来，一路都没取到必须把 `error` 写出来：不写就成了「静默失败」，
 * 用户只看到一排「—」，无从判断是网络坏了还是这地方没数据。
 *
 * @param {Object} row 行（原地修改）。
 * @param {{sources?:string[]}} [opts] 选项（单测可注入替身源）。
 * @returns {Promise<Object>} 同一个行对象。
 */
export async function fetchRow(row, opts = {}) {
  const sources = Array.isArray(opts.sources) ? opts.sources : ROW_SOURCES;
  const ctx = { lat: row.place.lat, lon: row.place.lon };
  let gotAny = false;
  let lastErr = null;

  for (const id of sources) {
    try {
      const res = await request(id, ctx);
      // res.data 非 null 才算「拿到了东西」：失败且无陈旧缓存时 http.js 给的就是 null
      if (res && res.data !== null && res.data !== undefined) {
        row[id] = res.data;
        gotAny = true;
        // stale 是 http.js 的显式标记：值是缓存里的旧数据，不是这次新取的
        if (res.stale) row.stale = true;
      } else if (res && res.error) {
        lastErr = errorText(res.error);
      }
    } catch (err) {
      // request() 已经把网络/解析异常收成 SourceError 了，这里接的是兜底之外的意外
      lastErr = errorText(err);
    }
  }

  row.status = gotAny ? ROW_STATUS.OK : ROW_STATUS.FAILED;
  row.error = gotAny ? null : lastErr || t('app.unknown');
  return row;
}

/**
 * 串行取完所有行（★不是并发）。
 *
 * 为什么不用 Promise.all：http.js 的全局队列并发恒为 1（弱网稳定性的既有约定），
 * 并发发起也只是排队，反而拿不到「逐个上屏」的进度。这里用最朴素的 for 循环，
 * 一个取完再取下一个 —— 每取完一行就回调一次，界面立刻更新那一行。
 *
 * @param {Array<Object>} rows 行数组（原地修改）。
 * @param {{sources?:string[], onRow?:(row:Object, index:number) => void}} [opts] 选项。
 * @returns {Promise<Array<Object>>} 同一个行数组。
 */
export async function fetchAll(rows, opts = {}) {
  const onRow = typeof opts.onRow === 'function' ? opts.onRow : null;
  const list = Array.isArray(rows) ? rows : [];
  for (let i = 0; i < list.length; i += 1) {
    // 单行抛异常不让整批陪葬：它已经被 fetchRow 内部兜住了，这里再兜一层只为
    // 保证 onRow 回调的异常不会中断后续地点
    try {
      await fetchRow(list[i], opts);
    } catch (err) {
      log(`compare row ${i} failed`, err && err.message);
    }
    if (onRow) {
      try {
        onRow(list[i], i);
      } catch (err) {
        log(`compare onRow ${i} failed`, err && err.message);
      }
    }
  }
  return list;
}

/**
 * 统计成功 / 失败 / 待取的行数。
 *
 * @param {Array<Object>} rows 行数组。
 * @returns {{total:number, ok:number, failed:number, pending:number}} 统计。
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let ok = 0;
  let failed = 0;
  let pending = 0;
  for (const r of list) {
    if (r.status === ROW_STATUS.OK) ok += 1;
    else if (r.status === ROW_STATUS.FAILED) failed += 1;
    else pending += 1;
  }
  return { total: list.length, ok, failed, pending };
}

/* ------------------------------------------------------------------ */
/* DOM 引用                                                             */
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

/** @type {HTMLElement|null} 汇总行。 */
let _summaryBox = null;

/** @type {HTMLElement|null} 说明区（离线上限提示等）。 */
let _noteBox = null;

/** @type {HTMLElement|null} 行列表容器。 */
let _listBox = null;

/** @type {Array<Object>} 本轮的行。 */
let _rows = [];

/** @type {number} 本轮已取完的行数（汇总文案用）。 */
let _done = 0;

/** @type {boolean} 是否正在取数（防重入：连点刷新不该起两条队列）。 */
let _busy = false;

/* ------------------------------------------------------------------ */
/* 渲染                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 键值项（与 now.js 的 _kv 同形：上标签、下等宽值）。
 *
 * @param {string} key 标签文案。
 * @param {string} value 值文案（缺失请传 '—'）。
 * @returns {HTMLElement} kv-item。
 */
function _kv(key, value) {
  return h('div', { class: 'kv-item' }, [
    h('span', { class: 'kv-k', text: key }),
    h('span', { class: 'kv-v', text: value }),
  ]);
}

/**
 * 行状态徽标。
 *
 * 三态各自的语义：
 *   pending → 基础 chip + 「进行中」：它还没有任何数据，不该看起来像成功；
 *   ok      → 绿色 chip（陈旧时琥珀 chip）：真取到了；
 *   failed  → 告警 chip + 徽点：这一行没有数据，必须一眼看见。
 *
 * @param {Object} row 行。
 * @returns {HTMLElement} chip。
 */
function _statusChip(row) {
  if (row.status === ROW_STATUS.PENDING) {
    return h('span', { class: 'chip', text: t('status.running') });
  }
  if (row.status === ROW_STATUS.FAILED) {
    return h('span', { class: 'chip chip--failed' }, [
      h('span', { class: 'badge badge--failed' }),
      t('status.failed'),
    ]);
  }
  const kind = row.stale ? 'stale' : 'ok';
  return h('span', { class: `chip chip--${kind}` }, [
    h('span', { class: `badge badge--${kind}` }),
    t(`status.${kind}`),
  ]);
}

/**
 * 一行（一个地点）的卡片。
 *
 * ★指标顺序全站固定，这是「对比」成立的前提：每张卡的同一行是同一个量，
 * 竖着读下去就是对比。顺序改动会让老用户的读法失效，别随意调整。
 *
 * 失败与待取**都不画数字**：没有数据就不该有数字位，画一排「—」会把「失败」
 * 伪装成「有数据只是值空」，与本项目「缺失显示占位符、不填 0」的规矩相悖。
 *
 * @param {Object} row 行。
 * @returns {HTMLElement} 卡片节点。
 */
function _rowCard(row) {
  const name = row.place.name ? String(row.place.name) : t('fav.unnamed');
  const head = [
    h('div', { class: 'card--row' }, [
      h('p', { class: 'card-title', text: name }),
      _statusChip(row),
    ]),
    h('p', { class: 'card-note num', text: fmt.coord(row.place.lat, row.place.lon) }),
  ];

  if (row.status === ROW_STATUS.PENDING) {
    head.push(h('p', { class: 'card-note', text: t('compare.loading') }));
    return h('div', { class: 'card' }, head);
  }
  if (row.status === ROW_STATUS.FAILED) {
    head.push(
      h('p', {
        class: 'card-note',
        text: t('compare.rowFailed', { reason: row.error || t('app.unknown') }),
      })
    );
    return h('div', { class: 'card' }, head);
  }

  const w = row.weather;
  const a = row.air;
  const tz = w ? Number(w.tzOffsetSec) || 0 : 0;
  // AQI 走 wmo.aqi() 的 displayValue（钳制负值），与此刻屏同一把尺子，
  // 不另写一套取整 —— 否则两处会对同一个数给出两种显示。
  const aqiText = a && Number.isFinite(Number(a.europeanAqi))
    ? fmt.num(aqi(a.europeanAqi).displayValue, 0)
    : t('app.dash');

  head.push(
    h('div', { class: 'kv' }, [
      _kv(t('w.temp'), fmt.tempC(w ? w.tempC : null)),
      _kv(t('w.feels'), fmt.tempC(w ? w.feelsC : null)),
      _kv(t('w.humidity'), fmt.humidity(w ? w.humidityPct : null)),
      _kv(t('w.wind'), w ? fmt.num(w.windMs, 1, 'm/s') : t('app.dash')),
      // 降水量（mm）与降水概率（%）挨着放，但标签各自点明，不许混成一个「降水」
      _kv(t('w.precip'), fmt.precipMm(w ? w.precipMm : null)),
      _kv(t('w.pop'), fmt.percent(w ? w.popNowPct : null)),
      _kv(t('w.sunrise'), fmt.hhmm(w ? w.sunriseAt : null, tz)),
      _kv(t('w.sunset'), fmt.hhmm(w ? w.sunsetAt : null, tz)),
      _kv(t('w.air'), aqiText),
    ])
  );
  return h('div', { class: 'card' }, head);
}

/**
 * 整屏空态（文案 + 重试按钮，**不转圈**）。
 *
 * @param {string} text 文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {HTMLElement} 空态节点。
 */
function _emptyCard(text, onRetry) {
  const nodes = [h('span', { text })];
  if (typeof onRetry === 'function') {
    const btn = h('button', { class: 'btn btn--primary', type: 'button', text: t('app.retry') });
    btn.addEventListener('click', onRetry);
    nodes.push(btn);
  }
  return h('div', { class: 'empty' }, nodes);
}

/**
 * 渲染页面外壳（标题 + 返回 / 刷新 + 汇总 + 说明 + 列表容器）。
 *
 * 只画一次骨架并留下三个容器引用，后续刷新只重画容器内容 —— 与 settings.js
 * 留 `_favBox` 引用同一个理由：这些节点是 JS 造的，测试台的假 DOM 只索引预置 id。
 *
 * @returns {void}
 */
function _renderShell() {
  const app = _el('app');
  if (!app) return;
  app.textContent = '';

  app.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [
        h('h1', { class: 'hd-place', text: t('compare.title') }),
        h('p', { class: 'hd-coord', text: t('compare.subtitle') }),
      ]),
    ])
  );
  // 返回入口：本页不进 tabbar，必须给一条明确的回「我的」的路，否则用户要靠
  // 浏览器返回键，而 PWA 全屏模式下那个键不一定存在。
  app.appendChild(
    h('div', { class: 'field field--row' }, [
      h('a', { class: 'btn', href: 'settings.html', text: t('compare.back') }),
      h('button', { class: 'btn', type: 'button', id: 'btn-compare-refresh', text: t('compare.refresh') }),
    ])
  );

  const summary = h('p', { class: 'card-note', id: 'compare-summary' });
  const note = h('div', { id: 'compare-note' });
  const list = h('div', { id: 'compare-list' });
  _summaryBox = summary;
  _noteBox = note;
  _listBox = list;
  app.appendChild(summary);
  app.appendChild(note);
  app.appendChild(list);
}

/**
 * 刷新汇总行。
 *
 * @returns {void}
 */
function _renderSummary() {
  if (!_summaryBox) return;
  const s = summarize(_rows);
  _summaryBox.textContent =
    s.pending > 0
      ? t('compare.summaryRunning', { total: s.total, done: Math.min(_done + 1, s.total) })
      : t('compare.summary', { total: s.total, ok: s.ok, failed: s.failed });
}

/**
 * 重画行列表。
 *
 * @returns {void}
 */
function _renderList() {
  const box = _listBox;
  if (!box) return;
  box.textContent = '';
  _rows.forEach((row) => box.appendChild(_rowCard(row)));
}

/**
 * 把整块列表换成空态（一个地点都没取到时）。
 *
 * @param {string} text 文案。
 * @returns {void}
 */
function _renderListEmpty(text) {
  const box = _listBox;
  if (!box) return;
  box.textContent = '';
  box.appendChild(
    _emptyCard(text, () => {
      run().catch((err) => log('compare retry failed', err && err.message));
    })
  );
}

/* ------------------------------------------------------------------ */
/* 流程                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 跑一轮对比（外壳已画好后调用）。
 *
 * @returns {Promise<void>}
 */
async function _run() {
  if (!_listBox) return;

  const favs = getFavorites();
  if (favs.length === 0) {
    _rows = [];
    if (_summaryBox) _summaryBox.textContent = '';
    if (_noteBox) _noteBox.textContent = '';
    // 收藏为空：给明确的空态 + 回「我的」的路，不是空白也不是转圈
    _renderListEmpty(t('compare.needFav'));
    return;
  }

  const picked = favs.slice(0, MAX_PLACES);
  _rows = buildRows(picked);
  _done = 0;

  if (_noteBox) {
    _noteBox.textContent = '';
    if (favs.length > MAX_PLACES) {
      _noteBox.appendChild(
        h('p', { class: 'card-note', text: t('compare.maxNote', { max: MAX_PLACES }) })
      );
    }
  }
  _renderList();
  _renderSummary();

  // 离线：一个请求都不发（http.js 的离线短路也会失败，但那样要为每个地点各等一次
  // 判定、并在每一行重复同一句「设备离线」）。这里一次说清楚，行里不再逐个报。
  if (!isOnline()) {
    _rows.forEach((row) => {
      row.status = ROW_STATUS.FAILED;
      row.error = t('compare.offline');
    });
    // 空态直接说「离线未发起请求」：比「一个都没取到数据」更具体 —— 后者会让用户
    // 去怀疑数据源，而真实原因在网络这一侧。
    _renderListEmpty(t('compare.offline'));
    _renderSummary();
    return;
  }

  await fetchAll(_rows, {
    onRow: () => {
      _done += 1;
      _renderSummary();
      _renderList();
    },
  });

  const s = summarize(_rows);
  _renderSummary();
  // 一个都没取到 → 明确的空态 + 重试；部分失败 → 保留全部卡片，失败的那张单独标红
  if (s.ok === 0) {
    _renderListEmpty(t('compare.allFailed', { total: s.total }));
  } else {
    _renderList();
  }
}

/**
 * 跑一轮对比（对外入口，带重入保护）。
 *
 * @returns {Promise<void>}
 */
export function run() {
  if (_busy) return Promise.resolve();
  _busy = true;
  return _run().finally(() => {
    _busy = false;
  });
}

/**
 * 对比页初始化（DOM 就绪后调用）。
 *
 * 返回值是**本轮取数的 Promise**（不是 void）：页面一进就开始取数，调用方
 * （浏览器里的 DOMContentLoaded 分支）可以不管它，但测试要能 await 住这一轮，
 * 否则断言会在取数完成之前跑完、拿到一排「进行中」。
 *
 * @returns {Promise<void>} 本轮取数完成。
 */
export function init() {
  applyThemeMode(getThemeMode());
  applyFontScale(getFontScale());

  applyI18n(document);
  watchShellUpdate();  // 任何页面都要能看见「有新版本」，见 shellupdate.js
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('compare.title')}`;
  }

  _renderShell();

  const refreshBtn = _el('btn-compare-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      run().catch((err) => log('compare refresh failed', err && err.message));
    });
  }

  return run().catch((err) => log('compare boot failed', err && err.message));
}

// 主题 / 字号已在模块顶层引导过。其余装配仍需守卫：Node 侧静态检查 import 本模块时
// 没有 document，不能注册事件、不能渲染。
if (typeof document !== 'undefined' && document !== null) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
