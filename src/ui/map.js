/**
 * 底图渲染（S57 街道样式 / S58 GRID 降级）
 *
 * 职责：把瓦片拼成一张地图卡。网络、探测、指纹、授信、三态裁决全在 `src/data/tiles.js`
 * 完成，本模块只做「瓦片号 + 字节 → 节点」，不自己发请求、不自己判降级。
 *
 * 四条不变量（勿回退）：
 *   1) **瓦片 URL 顺序是 `{z}/{y}/{x}`**（Esri，不是常见的 `{z}/{x}/{y}`）。本模块只调
 *      `tileUrl()`，绝不自己拼 URL —— 顺序写反不会报错，只会静默拉到地球另一侧的瓦片，
 *      而且「看起来像地图」，是最难发现的一类错。
 *   2) **内部坐标是 WGS84，不做 GCJ-02 纠偏**：三个服务的 `spatialReference` 实测为
 *      102100/3857（WGS84 Web Mercator），先转 GCJ-02 反而与瓦片错位。
 *      「中国境内要素是否按 GCJ-02 生产」是**未确认点**，登记在 tiles.js 文件头与
 *      docs/stage1-architecture.md，本阶段不实现纠偏。
 *   3) **署名必须显示且随样式切换**：`tileAttribution(styleId)` 返回该样式的实测
 *      `copyrightText` + "Powered by Esri"。这是 Esri 条款硬要求，不是可选项；
 *      设计稿里没画这一行，是设计稿漏了，代码必须补。
 *   4) **Blob URL 必须回收**：缓存命中走 `createObjectURL`，不 `revokeObjectURL` 会在
 *      96 块 LRU 之外再漏一份内存（每块约 20 KB，翻几次样式就上百块）。
 *
 * 另两条条款（写在这里是因为只有渲染侧会想做它们）：
 *   - 不得用 robots / 自动批量拉取 ArcGIS Online 地图。本模块的按需拉瓦片（视口内
 *     3×3 起）属正常浏览，合规；不得改成批量爬取。
 *   - 三个服务 `exportTilesAllowed` 均为 false，故**不做离线批量导出 / MBTiles**。
 *
 * 依赖方向：ui ← data（`tiles.js`）/ core（`format.js`）/ i18n。`h()` 复用 `now.js` 的实现。
 */

import { t } from '../i18n/index.js';
import * as fmt from '../core/format.js';
import { h } from './now.js';
import {
  TILE_STYLES,
  TILE_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  MAP_MODE,
  lonLatToTile,
  tileUrl,
  tileAttribution,
  tileCachedBytes,
  mapMode,
  isStyleTrusted,
} from '../data/tiles.js';

/**
 * 视口基准尺寸（px），取自 S57 设计稿的「地图」帧（`17:9`，350×260）。
 *
 * 用它而不是 `clientWidth`：渲染发生在布局之前，假 DOM 里更是恒为 0。
 * 350 / 256 → ceil = 2，+1 = 3；260 / 256 同理 —— 所以「3×3 起步」是按容器算出来的
 * 自然结果，不是拍脑袋写的常数。
 */
export const VIEW_W = 350;
export const VIEW_H = 260;

/**
 * ★2026-10-17 路线规划功能下线：这里原本有一个路线图专用的缩放下界常量（值为 3，
 *   可在 git 历史里找回），它**只**被已删除的路线图模块使用，随之一并删除 ——
 *   留着就是死代码。
 *
 *   它当年存在的理由（留档，供将来若要「装下整段行程」的视图参考）：
 *   1) 底图卡要街道级 —— 视野要细到能认出路口，下界是 `MIN_ZOOM = 10`（一屏约 48 km）。
 *   2) 路线图要装下整段行程 —— 自驾一天常跑 150–350 km，按街道级下界装不下。
 *   3) **z3–z6 实测有真瓦片**（沙箱直取 Esri World_Street_Map，中心成都
 *      [30.5728, 104.0665]，content-type 均为 image/jpeg）：
 *        z3 → 200 / 27.7 KB　z4 → 200 / 25.8 KB　z5 → 200 / 34.6 KB　z6 → 200 / 32.1 KB
 *        （对照 z10 → 200 / 2.4 KB）
 *      ★上面这 8 个数字是当年的沙箱实测值，今天**未重新验证** —— 引用前先重测。
 *
 * ★今天本模块所有调用方都用 `MIN_ZOOM`，`setMapView()` 的 `minZoom` 参数保留
 *   （默认值就是 `MIN_ZOOM`），但**已无调用方传值** —— 它是给将来的视图需求留的口子。
 */

/**
 * 视图状态（模块级：样式与缩放是 UI 局部状态，跨重渲染存活）。
 *
 * 与 `tiles.js` 的 `_mapMode` 同款做法 —— 同一份状态只在一处存，编排层不缓存第二份。
 *
 * @type {{styleId:string, zoom:number, coord:{lat:number, lon:number}|null}}
 */
const _view = { styleId: 'street', zoom: DEFAULT_ZOOM, coord: null };

/**
 * 已创建但尚未回收的 Blob URL。
 *
 * 每次重渲染先把上一批全部 revoke（那时对应的 img 早已解码完），img 自己的 onload
 * 里再 revoke 自己一次（幂等，重复 revoke 同一个 URL 不会抛）。双向兜底，避免漏。
 *
 * @type {Set<string>}
 */
const _blobUrls = new Set();

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

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
 * 取（或创建）卡片槽位，保证增量渲染时位置稳定（与 now.js / compass.js 的 `_slot` 同款）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} id 槽位 id（不含 'card-' 前缀）。
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
 * 回收所有已创建的 Blob URL。
 *
 * @returns {void}
 */
function _revokeBlobs() {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  _blobUrls.forEach((u) => URL.revokeObjectURL(u));
  _blobUrls.clear();
}

/**
 * 设定视图状态（样式 / 缩放 / 坐标）。
 *
 * ★`minZoom` 是**可选**的下界覆盖：不传就是 `MIN_ZOOM`，行为与改动前**逐字一致**
 *   （零回归由构造保证，不是靠测试兜）。★2026-10-17 自驾下线后**已无调用方传它**
 *   —— 原来唯一传值的路线图随自驾删除了；这个参数按「将来可能还有非街道级取景」
 *   保留，不是死参数（默认值分支仍在被走）。
 *
 * @param {{styleId?:string, zoom?:number, coord?:{lat:number, lon:number}|null}} patch 增量。
 * @param {number} [minZoom] 缩放下界；缺省 `MIN_ZOOM`。非法值按缺省处理（防御性：宁可
 *   退回街道级，也不接受 `undefined` 之外的乱值把视图拖到 z0）。
 * @returns {{styleId:string, zoom:number, coord:{lat:number, lon:number}|null}} 合并后的视图。
 */
export function setMapView(patch = {}, minZoom = MIN_ZOOM) {
  if (typeof patch.styleId === 'string' && TILE_STYLES[patch.styleId]) {
    _view.styleId = patch.styleId;
  }
  const lo = Number.isFinite(Number(minZoom)) ? Math.round(Number(minZoom)) : MIN_ZOOM;
  const z = Number(patch.zoom);
  if (Number.isFinite(z)) {
    _view.zoom = Math.min(MAX_ZOOM, Math.max(lo, Math.round(z)));
  }
  if (patch.coord && Number.isFinite(Number(patch.coord.lat)) && Number.isFinite(Number(patch.coord.lon))) {
    _view.coord = { lat: Number(patch.coord.lat), lon: Number(patch.coord.lon) };
  }
  return { ..._view };
}

/**
 * 取当前视图状态（测试与编排层读它做断言）。
 *
 * @returns {{styleId:string, zoom:number, coord:{lat:number, lon:number}|null}} 视图状态。
 */
export function mapView() {
  return { ..._view };
}

/* ------------------------------------------------------------------ */
/* 瓦片网格                                                             */
/* ------------------------------------------------------------------ */

/**
 * 视口需要几行几列瓦片（3×3 起步）。
 *
 * @returns {{cols:number, rows:number}} 列数与行数。
 */
function _gridSize() {
  return {
    cols: Math.max(3, Math.ceil(VIEW_W / TILE_SIZE) + 1),
    rows: Math.max(3, Math.ceil(VIEW_H / TILE_SIZE) + 1),
  };
}

/**
 * 铺一层瓦片，并统计成败 / 缓存命中 / 耗时。
 *
 * 统计是**异步**收敛的：img 的 load / error 每到一个就刷新一次明细行，
 * 不等全部结束才上屏 —— 与自检页「每次完成即增量上屏」同一条原则。
 *
 * @param {string} styleId 样式 id。
 * @param {number} z 缩放层级。
 * @param {{z:number, x:number, y:number, fx:number, fy:number}} center 中心瓦片（含瓦片内偏移）。
 * @param {{node:HTMLElement, onDone:(stats:Object)=>void}} io 视口节点与统计回调。
 * @returns {{total:number}} 参与渲染的块数（越界块也计入 total，它们注定失败）。
 */
function _layTiles(styleId, z, center, io) {
  const { cols, rows } = _gridSize();
  const n = 2 ** z;
  // 让落点正好落在视口正中：中心瓦片左边缘 = 视口中点 − 落点在瓦片内的偏移
  const left0 = VIEW_W / 2 - center.fx * TILE_SIZE;
  const top0 = VIEW_H / 2 - center.fy * TILE_SIZE;
  const startX = center.x - Math.floor(cols / 2);
  const startY = center.y - Math.floor(rows / 2);

  const stats = { total: 0, ok: 0, fail: 0, cacheHit: 0, startedAt: Date.now(), elapsedMs: 0 };
  const cells = [];

  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const tx = startX + gx;
      const ty = startY + gy;
      const pos = {
        left: left0 + (tx - center.x) * TILE_SIZE,
        top: top0 + (ty - center.y) * TILE_SIZE,
      };
      stats.total += 1;
      // 越界块（跨过反子午线 / 越过极区）不配拥有 URL：直接判失败，避免把
      // `tile/12/-1/4096` 这种脏串发出去（与 probeTile 的 PARSE 分支同一条纪律）。
      if (tx < 0 || ty < 0 || tx >= n || ty >= n) {
        cells.push(_failedCell(pos));
        stats.fail += 1;
        continue;
      }
      cells.push(_tileCell(styleId, z, tx, ty, pos, stats, io));
    }
  }

  cells.forEach((c) => io.node.appendChild(c));
  return { total: stats.total };
}

/**
 * 单块瓦片：先出骨架，字节到了再换成 img。
 *
 * @param {string} styleId 样式 id。
 * @param {number} z 层级。
 * @param {number} tx 列号。
 * @param {number} ty 行号。
 * @param {{left:number, top:number}} pos 视口内像素位置。
 * @param {Object} stats 统计对象（原地累加）。
 * @param {{node:HTMLElement, onDone:(stats:Object)=>void}} io 视口节点与统计回调。
 * @returns {HTMLElement} 瓦片节点。
 */
function _tileCell(styleId, z, tx, ty, pos, stats, io) {
  const url = tileUrl(styleId, z, tx, ty);
  const cell = h('div', {
    class: 'map-cell map-cell--loading',
    style: `left:${pos.left}px;top:${pos.top}px;width:${TILE_SIZE}px;height:${TILE_SIZE}px`,
  });

  /**
   * 落定：成败计数 + 换 class（骨架 → 成/败）+ 刷新明细行。
   * 每块各自落定、各自刷新，不等整批结束 —— 与自检页「完成一块上一块」同一条原则。
   */
  const settle = (ok) => {
    cell.className = ok ? 'map-cell' : 'map-cell map-cell--fail';
    if (ok) {
      stats.ok += 1;
    } else {
      stats.fail += 1;
      cell.appendChild(h('span', { class: 'map-cell-x', 'aria-hidden': 'true', text: '×' }));
    }
    stats.elapsedMs = Date.now() - stats.startedAt;
    io.onDone(stats);
  };

  const cached = tileCachedBytes(url);
  const canBlob =
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof Blob !== 'undefined';

  if (cached && cached.bytes && canBlob) {
    // 命中缓存：走 Blob URL，省一次网络往返，也不必再等 6 s 超时。
    // ★必须 revoke：见文件头第 4 条不变量。
    const blobUrl = URL.createObjectURL(
      new Blob([cached.bytes], { type: cached.contentType || 'image/jpeg' })
    );
    _blobUrls.add(blobUrl);
    stats.cacheHit += 1;
    const blobImg = h('img', {
      class: 'map-cell-img',
      src: blobUrl,
      alt: '',
      decoding: 'async',
      'aria-hidden': 'true',
    });
    blobImg.addEventListener('load', () => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(blobUrl);
      _blobUrls.delete(blobUrl);
      settle(true);
    });
    blobImg.addEventListener('error', () => {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(blobUrl);
      _blobUrls.delete(blobUrl);
      settle(false);
    });
    cell.appendChild(blobImg);
    return cell;
  }

  // 未命中（或本环境没有 Blob）：直接指向瓦片 URL，让浏览器自己取。
  // 注意这里**不写缓存** —— 写缓存的唯一入口是 probeTile()，它带指纹与授信门；
  // 渲染侧绕过它写缓存等于把「占位图不得进缓存」这道门拆了。
  const img = h('img', {
    class: 'map-cell-img',
    src: url,
    alt: '',
    decoding: 'async',
    'aria-hidden': 'true',
  });
  img.addEventListener('load', () => settle(true));
  img.addEventListener('error', () => settle(false));
  cell.appendChild(img);
  return cell;
}

/**
 * 注定失败的块（越界）：直接留白 + ×，不发请求。
 *
 * @param {{left:number, top:number}} pos 视口内像素位置。
 * @returns {HTMLElement} 瓦片节点。
 */
function _failedCell(pos) {
  return h('div', {
    class: 'map-cell map-cell--fail',
    style: `left:${pos.left}px;top:${pos.top}px;width:${TILE_SIZE}px;height:${TILE_SIZE}px`,
  }, [h('span', { class: 'map-cell-x', 'aria-hidden': 'true', text: '×' })]);
}

/* ------------------------------------------------------------------ */
/* 覆盖物                                                               */
/* ------------------------------------------------------------------ */

/**
 * 落点标记（S57 `17:29`–`17:34`）：光环 + 实心点 + 四向准星。
 *
 * 位置恒在视口正中 —— 网格是按落点对齐铺的（见 `_layTiles()` 的 left0/top0），
 * 不做拖拽平移，所以落点不需要再算一次像素坐标。
 *
 * @returns {HTMLElement} 落点节点。
 */
function _pinNode() {
  return h('div', { class: 'map-pin', 'aria-hidden': 'true' }, [
    h('span', { class: 'map-pin-halo' }),
    h('span', { class: 'map-pin-dot' }),
    h('span', { class: 'map-pin-tick map-pin-tick--up' }),
    h('span', { class: 'map-pin-tick map-pin-tick--down' }),
    h('span', { class: 'map-pin-tick map-pin-tick--left' }),
    h('span', { class: 'map-pin-tick map-pin-tick--right' }),
  ]);
}

/**
 * 缩放控件（S57 `17:45`）：放大 / 缩小两个按钮，边界处禁用。
 *
 * @param {() => void} onChange 变化后重渲染。
 * @returns {HTMLElement} 缩放控件节点。
 */
function _zoomNode(onChange) {
  const mk = (labelKey, delta, disabled) => {
    const btn = h('button', {
      class: 'map-zoom-btn',
      type: 'button',
      'aria-label': t(labelKey),
      title: t(labelKey),
      disabled: disabled || null,
      text: delta > 0 ? '+' : '−',
    });
    if (!disabled) {
      btn.addEventListener('click', () => {
        setMapView({ zoom: _view.zoom + delta });
        onChange();
      });
    }
    return btn;
  };
  return h('div', { class: 'map-zoom' }, [
    mk('map.zoomIn', 1, _view.zoom >= MAX_ZOOM),
    h('span', { class: 'map-zoom-sep' }),
    mk('map.zoomOut', -1, _view.zoom <= MIN_ZOOM),
  ]);
}

/**
 * 样式切换三个 chip（S57 `17:36` / `17:38` / `17:40`）。
 *
 * @param {() => void} onChange 变化后重渲染。
 * @returns {HTMLElement} chip 行节点。
 */
function _styleChips(onChange) {
  const chips = Object.keys(TILE_STYLES).map((id) => {
    const active = id === _view.styleId;
    const btn = h('button', {
      class: active ? 'map-chip map-chip--active' : 'map-chip',
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      text: t(TILE_STYLES[id].labelKey),
    });
    btn.addEventListener('click', () => {
      setMapView({ styleId: id });
      onChange();
    });
    return btn;
  });
  return h('div', { class: 'map-chips', role: 'group', 'aria-label': t('card.map') }, chips);
}

/* ------------------------------------------------------------------ */
/* 文本行                                                               */
/* ------------------------------------------------------------------ */

/**
 * 瓦片进度的**尾缀**（「已加载」/「N 块失败」/「缓存命中」/「瓦片加载中」）。
 *
 * ★2026-10 真机缺陷：原来 `_statusText()` 与 `_coordRow()` 各写一份分支，且**终态没有
 *   自己的词** —— 9 块全部从网络取回成功后两个分支都掉进 `map.loading`，界面读到的是
 *   「9/9 块 · 9 ms · 瓦片加载中」（都加载完了还在说加载中）。修的时候顺手把两份分支
 *   收成一个函数：同一段判定抄两遍，将来只改一处就会再咬一次（见 `ui/pull.js` 文件头）。
 *
 * 四态边界（**顺序不许调**）：
 *   1) 一块都还没发起（`total === 0`）→ 加载中；
 *   2) 有失败 → `failKey`（两张卡用词不同：坐标行说「留白」、状态标记说「失败」）；
 *   3) 发起了但一块都还没回来（`ok === 0`）→ **仍是加载中** ——
 *      ★少这一条就会在「刚发起、还没回来」时说「已加载」，是同一个谎言换个方向；
 *   4) 有缓存命中 → 缓存命中；
 *   5) 其余（全部成功且非缓存）→ **已加载**。
 *
 * ★入参一律先过 `Number(...) || 0`：stats 缺失或字段是 undefined 时，直接比大小会
 *   全走「否则」分支而说成「已加载」（undefined > 0 是 false）—— 又是拿终态的话
 *   去描述「还没开始」，与本次要修的缺陷是同一个谎。没数据就该说「加载中」。
 *
 * @param {Object} stats 瓦片统计。
 * @param {'map.tailBlank'|'map.tailFailed'} failKey 失败态用的文案键。
 * @returns {string} 尾缀文案。
 */
export function tileTail(stats, failKey) {
  const s = stats || {};
  const total = Number(s.total) || 0;
  const ok = Number(s.ok) || 0;
  const fail = Number(s.fail) || 0;
  const cacheHit = Number(s.cacheHit) || 0;

  if (total === 0) return t('map.loading');
  if (fail > 0) return t(failKey, { n: fail });
  if (ok === 0) return t('map.loading');
  return cacheHit > 0 ? t('map.cacheHit') : t('map.loaded');
}

/**
 * 状态标记（S57 `17:4`）：「z12 · 已授信 · 缓存命中」。
 *
 * @param {Object} stats 瓦片统计。
 * @returns {string} 状态串。
 */
function _statusText(stats) {
  const trust = isStyleTrusted(_view.styleId) ? t('map.trusted') : t('map.untrusted');
  return `${t('map.zoom', { zoom: _view.zoom })} · ${trust} · ${tileTail(stats, 'map.tailFailed')}`;
}

/**
 * 坐标行（S57 `17:42`–`17:44`）：坐标（等宽字体）+ 瓦片明细。
 *
 * @param {{lat:number, lon:number}|null} coord 坐标。
 * @param {Object} stats 瓦片统计。
 * @returns {HTMLElement} 坐标行节点。
 */
function _coordRow(coord, stats) {
  const blocks = t('map.blocks', { ok: stats.ok, total: stats.total });
  // 与状态标记同一份判定（见 tileTail 的注释），只是失败态的用词不同
  const tail = tileTail(stats, 'map.tailBlank');
  return h('div', { class: 'map-coord' }, [
    h('span', {
      class: 'map-coord-v',
      text: coord ? fmt.coord(coord.lat, coord.lon) : t('app.dash'),
    }),
    h('span', {
      class: 'map-coord-d',
      text: t('map.detail', { blocks, elapsed: fmt.latency(stats.elapsedMs), tail }),
    }),
  ]);
}

/**
 * 署名行（**条款硬要求**，设计稿漏画的一行）。
 *
 * 随样式切换：影像与街道的数据提供方不同，署名串也不同。
 *
 * @returns {HTMLElement} 署名节点。
 */
function _creditRow() {
  return h('p', { class: 'map-credit' }, [
    h('span', { class: 'map-credit-k', text: `${t('map.credit')}：` }),
    h('span', { class: 'map-credit-v', text: tileAttribution(_view.styleId) }),
  ]);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染底图卡（整槽替换）。
 *
 * 三态呈现：
 * - `map`：正常铺瓦片；
 * - `grid`：照样铺，但失败的块留白 + ×（S58），**不宣布无地图**；
 * - `no-map`：一块都不请求，视口内给纯坐标提示（S58 的 no-map 语义）。
 *
 * 纯坐标模式不重试、不转圈 —— 与 tiles.js 的「不重试、不转圈」同一条纪律。
 *
 * @param {HTMLElement} root 根容器。
 * @param {{coord?:{lat:number, lon:number}|null, styleId?:string, zoom?:number,
 *          minZoom?:number, onStats?:(stats:Object)=>void}} [opts] 选项。
 *   `minZoom` 是缩放下界覆盖；★2026-10-17 自驾下线后**已无调用方传它**
 *   （原唯一的路线图调用方已删除）。不传 = 街道级下界 `MIN_ZOOM`，即既有行为，零回归。
 * @returns {HTMLElement} 卡片槽位节点。
 */
export function renderMapCard(root, opts = {}) {
  if (!root) return null;
  setMapView(
    {
      styleId: opts.styleId,
      zoom: opts.zoom,
      coord: opts.coord || null,
    },
    opts.minZoom
  );

  const box = _slot(root, 'map');
  // ★minZoom 必须跟着重渲染一起传下去：chip / 缩放按钮触发的重渲染若丢了这个值，
  //   底图会在下一次重画时被钳回 MIN_ZOOM —— fitBounds 算出来的低层级活不过一次点击。
  const rerender = () => renderMapCard(root, { onStats: opts.onStats, minZoom: opts.minZoom });

  // 重渲染前先把上一批 Blob URL 收回（对应 img 早已解码完）
  _revokeBlobs();

  const coord = _view.coord;
  const mode = mapMode();
  const stats = { total: 0, ok: 0, fail: 0, cacheHit: 0, startedAt: Date.now(), elapsedMs: 0 };

  // 明细行的刷新：只改文本，不重建网格（否则每块瓦片都会重新解码一次）
  const detailBox = h('div', { class: 'map-coord' });
  const statusBox = h('span', { class: 'map-status', text: _statusText(stats) });
  const onDone = (s) => {
    statusBox.textContent = _statusText(s);
    _fill(detailBox, Array.from(_coordRow(coord, s).children));
    if (typeof opts.onStats === 'function') opts.onStats(s);
  };

  const viewport = h('div', {
    class: 'map-viewport',
    style: `width:${VIEW_W}px;height:${VIEW_H}px`,
    role: 'img',
    'aria-label': coord ? `${t('card.map')} · ${fmt.coord(coord.lat, coord.lon)}` : t('card.map'),
  });

  if (mode === MAP_MODE.NO_MAP || !coord) {
    // 纯坐标模式：一块都不请求。坐标与数值不受影响，这句话要对用户说清楚。
    viewport.className = 'map-viewport map-viewport--nomap';
    viewport.appendChild(
      h('div', { class: 'map-nomap' }, [
        h('span', { class: 'map-nomap-t', text: t('map.noMap') }),
        h('span', { class: 'map-nomap-d', text: t('map.noMapNote') }),
      ])
    );
  } else {
    const center = lonLatToTile(coord.lat, coord.lon, _view.zoom);
    _layTiles(_view.styleId, _view.zoom, center, { node: viewport, onDone });
    viewport.appendChild(_pinNode());
    viewport.appendChild(_zoomNode(rerender));
    _fill(detailBox, Array.from(_coordRow(coord, stats).children));
  }

  const footKey = mode === MAP_MODE.GRID ? 'map.gridFootnote' : 'map.footnote';

  _fill(box, [
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('card.map') }),
      h('div', { class: 'map-sub' }, [
        h('span', { class: 'map-sub-t', text: t('map.subtitle') }),
        statusBox,
      ]),
      _styleChips(rerender),
      viewport,
      detailBox,
      _creditRow(),
      h('p', { class: 'map-foot', text: t(footKey) }),
    ]),
  ]);

  return box;
}

/**
 * 渲染底图骨架（瓦片未到先占位，不转圈）。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderMapSkeleton(root) {
  if (!root) return;
  const box = _slot(root, 'map');
  _fill(box, [
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('card.map') }),
      h('div', { class: 'map-viewport map-viewport--sk', style: `width:${VIEW_W}px;height:${VIEW_H}px` }, [
        h('span', { class: 'map-sk-note', text: t('map.skeletonNote') }),
      ]),
      h('div', { class: 'sk' }),
    ]),
  ]);
}
