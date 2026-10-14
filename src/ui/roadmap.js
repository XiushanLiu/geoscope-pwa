/**
 * 自驾路线图（架构 §7 T05）
 *
 * 职责：把一条行程的**轮廓**画出来 —— 整段概览 / 按天切换两级视图，外加停留点与打卡的
 *   标记。★本模块**不改 `ui/map.js` 的既有行为**（零回归面）：底图照旧复用
 *   `renderMapCard()`，本模块只在它铺好的瓦片之上叠一层**路线覆盖层**。
 *   （唯一一次动 map.js 是给它加**可选**的缩放下界参数：不传 = 逐字等价于从前，
 *     只有本卡传 `ROADMAP_MIN_ZOOM` —— 零回归由构造保证。）
 *
 * ★四条不许回退的硬要求（改本文件前先读）：
 *   1) **fitBounds 用 `data/tiles.js` 的 `lonLatToTile()` 反算 zoom**，不自己写第二份
 *      墨卡托。两处各写一份投影必然会漂 —— 底图按 A 投影铺、路线按 B 投影画，
 *      表现就是「路画在河上、标记落在隔壁街区」，而且**没有任何报错**。
 *   2) **任何时候都不请求 `overview=full`**。full 几何是百 KB 量级（体积口径见
 *      `src/data/osrm.js` 文件头，全仓唯一出处 —— 数字只许在那里出现一次）；
 *      两级视图一律 `simplified`：整段一次、切到某天再用该段起终点请求一次（架构 §4.3.2）。
 *   3) **Esri 署名行必须留着**，且随样式切换。那是底图条款的硬要求，删掉一行字
 *      就是违约 —— 所以本模块**只**隐藏 `.map-pin` / `.map-zoom`，绝不动 `.map-credit`。
 *   4) **`coord: null` 的打卡不上图**。给它编一个坐标画上去，用户会以为自己真的
 *      在那儿停过 —— 那是把「没记录」伪装成「有记录」。列表里如实写「未定位」。
 *
 * ★为什么隐藏 `.map-pin` / `.map-zoom` 而要写注释：`.map-pin` 是「**我**在哪儿」的针，
 *   路线图讲的是「行程走过哪儿」，把定位自身的针画在路线正中，读者会先去找自己的位置而
 *   不是看路线；`.map-zoom` 是给固定视口做的缩放控件，而本卡的 zoom 是 **fitBounds 算
 *   出来的**，让人手动改会和「刚好装下全程」这个结果打架（放大后路线被裁掉，用户会当成
 *   bug）。两者都不是坏功能，只是不属于这一张卡 —— 所以隐藏而不是删除，并在此说明理由。
 *
 * 依赖方向：ui ← data ← core。本模块不发请求（求路由 `ui/roadtrip.js` 编排后把几何
 *   传进来），只做投影与绘制 —— 「画图的不取数」让投影可以单测。
 */

import { t } from '../i18n/index.js';
import { h } from './now.js';
import { renderMapCard, VIEW_W, VIEW_H, ROADMAP_MIN_ZOOM } from './map.js';
// ★不 import MIN_ZOOM：本卡的层级下界是 `ROADMAP_MIN_ZOOM`（见 `fitBoundsZoom()`）。
//   在这里留一个未使用的 MIN_ZOOM 是隐患 —— 下一位读者会以为街道级下界对本卡也生效。
import { lonLatToTile, MAX_ZOOM, TILE_SIZE } from '../data/tiles.js';

/*
 * ★视口尺寸直接从 `ui/map.js` import，不抄一份。
 *
 * 抄一份的代价是**静默错位**：底图按 map.js 的 VIEW_W 铺瓦片、路线按这里的副本画，
 *   两个数只要哪天有一个被改而另一个没跟上，路线就整体偏移 —— 没有报错，只是画错地方。
 *   所以这里 import 同一个数，并由单测「中心点必须投影到视口正中」钉住。
 *
 * ★缩放**下界**也同理取自 `map.js` 的 `ROADMAP_MIN_ZOOM`（在那里，理由与实测数据同在）。
 *   本卡的 fitBounds 要能降到街道级以下（整程数百公里），但**不许**把此刻屏一起拉下去 ——
 *   所以下界是「传进来的」而不是「全局改小的」，见 `fitBoundsZoom()` 的 `minZoom` 参数。
 */

/**
 * fitBounds 的留边比例。
 *
 * ★为什么不是 1：贴着视口边缘装上，路线的最外侧一段会被裁掉半截，用户会以为路只到那儿。
 */
const FIT_MARGIN = 0.88;

/** SVG 命名空间（真实浏览器必须用它，`document.createElement('svg')` 画不出图形）。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------ */
/* 投影                                                                */
/* ------------------------------------------------------------------ */

/**
 * 纬度 → 墨卡托归一化 y（[0,1)，与 `lonLatToTile()` 内部同一条公式）。
 *
 * @param {number} lat 纬度（度）。
 * @returns {number} 归一化 y。
 */
function _mercY(lat) {
  const lv = Number.isFinite(Number(lat)) ? Math.max(-85.0511, Math.min(85.0511, Number(lat))) : 0;
  const rad = (lv * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * 墨卡托归一化 y → 纬度（`_mercY()` 的逆变换）。
 *
 * 推回过程：`ln(tan φ + sec φ) = asinh(tan φ)`，故 `tan φ = sinh(π(1 − 2y))`。
 *
 * @param {number} y 归一化 y。
 * @returns {number} 纬度（度）。
 */
function _invMercY(y) {
  const yy = Number.isFinite(Number(y)) ? Math.max(0, Math.min(1, Number(y))) : 0.5;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180) / Math.PI;
}

/**
 * 判断一个坐标分量是不是**真的有值**。
 *
 * ★为什么不能直接 `Number.isFinite(Number(v))`：`Number(null)` 是 **0**、「几内亚湾」
 *   （0°N 0°E）会被当成合法坐标画上去。缺坐标的打卡于是凭空出现在非洲外海 ——
 *   那正是「不许替没记录的东西编一个位置」最容易被绕过的地方（本仓踩过同一类坑：
 *   `ui/placesearch.js` 的 `_finiteCoord`）。
 *
 * @param {*} v 坐标分量。
 * @returns {boolean} 是否可用。
 */
function _isFiniteCoord(v) {
  return v !== null && v !== undefined && typeof v !== 'boolean' && Number.isFinite(Number(v));
}

/**
 * 取一批坐标的包围盒。
 *
 * @param {Array<{lat:number, lon:number}>} points 坐标点。
 * @returns {{minLat:number, maxLat:number, minLon:number, maxLon:number}|null} 包围盒；无有效点时 null。
 */
function _bboxOf(points) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let seen = 0;
  for (const p of points) {
    if (!_isFiniteCoord(p && p.lat) || !_isFiniteCoord(p && p.lon)) continue;
    const la = Number(p.lat);
    const lo = Number(p.lon);
    seen += 1;
    if (la < minLat) minLat = la;
    if (la > maxLat) maxLat = la;
    if (lo < minLon) minLon = lo;
    if (lo > maxLon) maxLon = lo;
  }
  if (seen === 0) return null;
  return { minLat, maxLat, minLon, maxLon };
}

/**
 * fitBounds：反算「刚好装得下这个包围盒」的 zoom 与中心。
 *
 * ★为什么用 `lonLatToTile()` 反算而不是写一份 `(360 / 2^z)` 的除法：底图是**按那份
 *   换算**铺的瓦片。自己再写一份，两者的墨卡托只要有一处常数不同（钳位 / 舍入），
 *   路线就会相对底图整体偏移，而且是**静默**的 —— 没有报错，只是画错地方。
 *   这里逐层试：从 `MAX_ZOOM` 往下找到第一个装得下的层级，装不下就退到下界
 *   并把 `covers` 置 false，由调用方明说「可能看不全」。
 *
 * ★下界为什么是 `ROADMAP_MIN_ZOOM`（3）而不是 `tiles.js` 的 `MIN_ZOOM`（10）：一屏
 *   350 px 在 z10 只看得到约 48 km，而自驾整程常是数百 km —— 按街道级下界，这张卡
 *   几乎永远装不下全程，「路线图」就名不副实。低层级有真瓦片的实测见 `map.js`
 *   的 `ROADMAP_MIN_ZOOM` 注释；★下界是**参数传进来**的，不是把全局下界改小 ——
 *   此刻屏一个字都不传，行为与从前逐字一致。
 *
 * @param {{minLat:number, maxLat:number, minLon:number, maxLon:number}|null} bbox 包围盒。
 * @param {number} [minZoom] 层级下界；缺省 `ROADMAP_MIN_ZOOM`。
 * @returns {{z:number, center:{lat:number, lon:number}, covers:boolean, bbox:Object|null}}
 *   层级、中心、是否真的装得下。
 */
export function fitBoundsZoom(bbox, minZoom = ROADMAP_MIN_ZOOM) {
  const lo = Number.isFinite(Number(minZoom)) ? Math.round(Number(minZoom)) : ROADMAP_MIN_ZOOM;
  const b = bbox && typeof bbox === 'object' ? bbox : null;
  if (!b || !Number.isFinite(Number(b.minLat))) {
    return { z: lo, center: { lat: 0, lon: 0 }, covers: false, bbox: null };
  }

  // 中心取**墨卡托空间**的中点。★为什么不是纬度算术平均：墨卡托在高纬度被拉伸，
  //   等像素间距的中点比算术中点更靠北（60°–70° 段实测：算术中点 65°，墨卡托中点
  //   65.47°）。视口是**按像素**等分上下留白的，用算术中点会让下边距不够、下半截被裁。
  const cy = (_mercY(b.minLat) + _mercY(b.maxLat)) / 2;
  const center = {
    lat: _invMercY(cy),
    lon: (Number(b.minLon) + Number(b.maxLon)) / 2,
  };

  const limitW = VIEW_W * FIT_MARGIN;
  const limitH = VIEW_H * FIT_MARGIN;

  for (let z = MAX_ZOOM; z >= lo; z -= 1) {
    const a = lonLatToTile(b.minLat, b.minLon, z);
    const c = lonLatToTile(b.maxLat, b.maxLon, z);
    // 用**瓦片号 + 瓦片内偏移**拼出连续坐标：只比整数瓦片号会低估跨度（最多差 1 块）
    const spanX = Math.abs(c.x + c.fx - (a.x + a.fx)) * TILE_SIZE;
    const spanY = Math.abs(c.y + c.fy - (a.y + a.fy)) * TILE_SIZE;
    if (spanX <= limitW && spanY <= limitH) return { z, center, covers: true, bbox: b };
  }
  // ★装不下也**如实返回**下界层级 + covers:false：硬抬层级会把路线裁掉，
  //   那比「看不全但说明了」糟 —— 后者用户看得懂，前者会被当成 bug。
  //   （z3 一屏约 6800 km 仍装不下的极端跨度才会走到这里，界面须写明「可能看不全」。）
  return { z: lo, center, covers: false, bbox: b };
}

/**
 * 把一批坐标投影到视口像素坐标。
 *
 * 原点在视口左上角，视口正中 = 中心点 —— 与 `map.js::_layTiles()` 的对齐方式一致
 *   （`left0 = VIEW_W/2 − fx*TILE_SIZE`）。
 *
 * @param {Array<{lat:number, lon:number}>} points 坐标点（缺坐标的项被跳过）。
 * @param {{lat:number, lon:number}} center 中心（来自 `fitBoundsZoom()`）。
 * @param {number} z 缩放层级。
 * @returns {Array<{lat:number, lon:number, x:number, y:number}>} 带像素坐标的点。
 */
export function projectRoute(points, center, z) {
  const list = Array.isArray(points) ? points : [];
  const c = center && typeof center === 'object' ? center : { lat: 0, lon: 0 };
  const ct = lonLatToTile(c.lat, c.lon, z);
  const cx = ct.x + ct.fx;
  const cy = ct.y + ct.fy;
  const out = [];
  for (const p of list) {
    if (!_isFiniteCoord(p && p.lat) || !_isFiniteCoord(p && p.lon)) continue;
    const la = Number(p.lat);
    const lo = Number(p.lon);
    const tp = lonLatToTile(la, lo, z);
    out.push({
      lat: la,
      lon: lo,
      x: VIEW_W / 2 + (tp.x + tp.fx - cx) * TILE_SIZE,
      y: VIEW_H / 2 + (tp.y + tp.fy - cy) * TILE_SIZE,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 覆盖层（SVG）                                                        */
/* ------------------------------------------------------------------ */

/**
 * 建一个 SVG 元素。
 *
 * ★为什么不用 `h()`：`document.createElement('svg')` 建出来的是**未知 HTML 元素**，
 *   浏览器不会按 SVG 渲染（画不出任何东西，且不报错 —— 又一种静默失败）。必须走
 *   `createElementNS`。假 DOM 没有这个 API，退回 `createElement`：属性形状完全一致，
 *   单测断言的属性照旧可查，只是不真的画出来。
 *
 * @param {string} tag 标签名。
 * @param {Object} [attrs] 属性表。
 * @param {Array<Object>} [children] 子节点。
 * @returns {Object} 元素。
 */
function _svg(tag, attrs = {}, children = []) {
  const el =
    typeof document !== 'undefined' && typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children || []) if (c) el.appendChild(c);
  return el;
}

/**
 * 画路线覆盖层（折线 + 标记）。
 *
 * @param {Array<{x:number, y:number}>} line 折线点（视口像素）。
 * @param {Array<{x:number, y:number, kind:string, label:string}>} marks 标记点。
 * @param {boolean} schematic 是否示意直线（真：虚线，视觉上就不该被当成真实路径）。
 * @returns {Object} SVG 节点。
 */
function _overlay(line, marks, schematic) {
  const svg = _svg('svg', {
    class: 'rt-route',
    width: VIEW_W,
    height: VIEW_H,
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    'aria-hidden': 'true',
  });

  if (line.length >= 2) {
    svg.appendChild(
      _svg('polyline', {
        class: schematic ? 'rt-route-line rt-route-line--schematic' : 'rt-route-line',
        points: line.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
        fill: 'none',
        stroke: schematic ? '#8A8F98' : '#C8461F',
        'stroke-width': 3,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        // ★示意直线画成虚线：实线会被当成真实路径。形状本身就在说话。
        'stroke-dasharray': schematic ? '6 5' : null,
      })
    );
  }

  for (const m of marks) {
    svg.appendChild(
      _svg('circle', {
        class: `rt-route-dot rt-route-dot--${m.kind}`,
        cx: m.x.toFixed(2),
        cy: m.y.toFixed(2),
        r: m.kind === 'stay' ? 5 : 4,
        fill: m.kind === 'stay' ? '#1B6FD6' : '#2E7D4F',
        stroke: '#FFFFFF',
        'stroke-width': 1.5,
      })
    );
    svg.appendChild(
      _svg('title', {}, [
        typeof document !== 'undefined' && typeof document.createTextNode === 'function'
          ? document.createTextNode(String(m.label || ''))
          : null,
      ])
    );
  }
  return svg;
}

/* ------------------------------------------------------------------ */
/* 卡片                                                                */
/* ------------------------------------------------------------------ */

/**
 * 隐藏底图卡里不属于这张卡的两个控件。
 *
 * @param {Object} box `renderMapCard()` 返回的槽位节点。
 * @returns {void}
 */
function _hideOwnPositionUi(box) {
  if (!box || typeof box.querySelectorAll !== 'function') return;
  for (const cls of ['map-pin', 'map-zoom']) {
    for (const n of box.querySelectorAll(`.${cls}`)) {
      // 用 hidden 而不是 remove：节点还在，DOM 结构没被改动；而且 `map.js` 若哪天
      // 重画，这两个节点仍按它自己的逻辑出现，不会因为我们删过而漏掉什么。
      n.hidden = true;
      n.setAttribute('aria-hidden', 'true');
    }
  }
}

/**
 * 让样式 chip 切换后**路线覆盖层还在**。
 *
 * ★为什么必须自己再接一次：`renderMapCard()` 内部的 chip 回调只重画它自己那张卡，
 *   我们的覆盖层是事后叠上去的，重画就丢了 —— 用户换个底图样式，路线凭空消失。
 *   这里在 chip 上**追加**一个监听（map.js 那个先注册、先跑，我们的后跑、最后成型），
 *   于是任何一次样式切换都会以「带覆盖层的版本」收尾。
 *
 * @param {Object} box 槽位节点。
 * @param {Object} root 根容器。
 * @param {Object} opts 上一次渲染用的选项。
 * @returns {void}
 */
function _wireStyleChips(box, root, opts) {
  if (!box || typeof box.querySelectorAll !== 'function') return;
  const style = opts && opts.styleId ? opts.styleId : 'street';
  for (const chip of box.querySelectorAll('.map-chip')) {
    chip.addEventListener('click', () => {
      const id = chip.getAttribute('data-style-id');
      renderRouteCard(root, { ...opts, styleId: id || style });
    });
  }
}

/**
 * 渲染路线图卡。
 *
 * @param {Object} root 根容器（会被整槽替换）。
 * @param {Object} [opts] 选项。
 * @param {Array<{lat:number, lon:number}>} [opts.points] 路线折线点（**缺即降级为示意直线**）。
 * @param {Array<{lat:number, lon:number, name?:string, kind?:string}>} [opts.markers] 标记
 *   （停留点 / 已定位打卡；★`coord: null` 的打卡**不许**出现在这里，由调用方先滤掉）。
 * @param {string} [opts.styleId] 底图样式。
 * @param {boolean} [opts.schematic] 是否示意直线（无几何时）。
 * @param {string} [opts.note] 状态行（几何来源 / 降级说明）。
 * @param {number} [opts.minZoom] 层级下界；缺省 `ROADMAP_MIN_ZOOM`（只本卡用低层级）。
 * @param {(stats:Object)=>void} [opts.onStats] 瓦片统计回调。
 * @returns {Object|null} 槽位节点。
 */
export function renderRouteCard(root, opts = {}) {
  if (!root) return null;
  const o = opts && typeof opts === 'object' ? opts : {};
  const rawPts = Array.isArray(o.points) ? o.points : [];
  const rawMarks = Array.isArray(o.markers) ? o.markers : [];
  const schematic = o.schematic === true || rawPts.length < 2;

  // ★示意直线的点是**两端直连**：起点 → 终点（+ 途中已定位的点），不是编出来的路径。
  //   它只在没有几何时出现，且界面必须标注（见下面的 rt.mapSchematic）。
  const pts = rawPts.filter((p) => _isFiniteCoord(p && p.lat) && _isFiniteCoord(p && p.lon));
  const bbox = _bboxOf(pts.length > 0 ? pts : rawMarks);
  const minZoom = Number.isFinite(Number(o.minZoom)) ? Math.round(Number(o.minZoom)) : ROADMAP_MIN_ZOOM;
  const fit = fitBoundsZoom(bbox, minZoom);

  // ★minZoom 必须传给 renderMapCard：fitBounds 算得出来 z6，若底图仍按街道级下界钳回
  //   z10，结果就是「路线按 z6 投影、瓦片按 z10 铺」—— 两者不一致，路线画在错误的位置
  //   且**没有任何报错**。这是本轮唯一一处跨模块的隐式契约。
  const box = renderMapCard(root, {
    coord: fit.center,
    zoom: fit.z,
    minZoom,
    styleId: o.styleId || 'street',
    onStats: o.onStats,
  });
  if (!box) return null;

  _hideOwnPositionUi(box);

  const located = rawMarks.filter(
    (m) => _isFiniteCoord(m && m.lat) && _isFiniteCoord(m && m.lon)
  );

  // ★降级为「示意直线」：没有几何时，用**已定位的点直连**画一条虚线。
  //   为什么不干脆不画：一张只有底图、什么都没有的卡，用户分不清「没画出来」和
  //   「这一程是空的」；而实线会被当成真实路径 —— 所以画，但画成虚线并标注（见下）。
  const linePts = pts.length >= 2 ? pts : located.length >= 2 ? located : [];
  const projected = projectRoute(linePts, fit.center, fit.z);

  const marks = [];
  for (const one of projectRoute(located, fit.center, fit.z)) {
    marks.push({
      x: one.x,
      y: one.y,
      kind: (located.find((m) => m.lat === one.lat && m.lon === one.lon) || {}).kind === 'stay' ? 'stay' : 'check',
      label: (located.find((m) => m.lat === one.lat && m.lon === one.lon) || {}).name || '',
    });
  }

  const viewport = box.querySelector('.map-viewport');
  if (viewport) viewport.appendChild(_overlay(projected, marks, schematic));

  // 状态 / 降级说明：★没有几何时必须写「这是示意直线，不是真实路径」——
  //   一条没标注的直线会被当成真实路径，那是把推算值冒充实测值。
  const notes = [];
  if (typeof o.note === 'string' && o.note !== '') notes.push(o.note);
  if (schematic && bbox) notes.push(t('rt.mapSchematic'));
  if (!fit.covers) notes.push(t('rt.mapNoFit'));
  if (notes.length > 0) {
    const card = box.querySelector('.card') || box;
    for (const line of notes) card.appendChild(h('p', { class: 'card-note', text: line }));
  }
  // ★署名行是 `renderMapCard()` 自己画的（`.map-credit`，随样式切换），这里一行不动 ——
  //   Esri 的条款要求署名常驻，删掉它就是违约。

  _wireStyleChips(box, root, o);
  return box;
}
