/**
 * 指标释义（图例）
 *
 * 职责：把界面上出现的那些专业数字讲成人话 —— 它是什么、什么单位、档位怎么分。
 * 此刻页底部一颗「指标释义」按钮，点开就地展开面板；默认收起，不占首屏。
 *
 * ★阈值纪律（本模块存在的底线，改动前必读）：
 *   凡是出现**分档数字**的地方，一律从 src/core/wmo.js 的既有换算表**读出来**
 *   （beaufortScale / aqiScale / uvScale / windRose16 四个只读访问器），本文件
 *   **不手写、不另立、不微调任何一个阈值**。将来换算表改了，图例会跟着改，不会说谎。
 *
 *   代码里**找不到现成分档**的指标（气温 / 体感 / 湿度 / 降水量 / 风速 / 气压 /
 *   能见度 / 日出日落 / 昼长 / 今日最高最低 / 四种污染物浓度 / 海拔 / 坐标 / 时区），
 *   一律只写「是什么 + 单位」，分档一栏留空；其中用户最容易去找阈值找不到的四项
 *   （湿度 / 气压 / 能见度 / 污染物）额外标一行「本应用没有对这项设分档」。
 *
 * 依赖方向：ui/legend.js → i18n/zh.js + core/wmo.js。**不 import ui/now.js**
 *   （now.js 要 import 本模块来建槽位，反方向依赖会成环 —— 与 map.js 复用 now.js 的
 *   h() 是同一条纪律，只不过那里是 map→now，这里必须自给自足），所以自带一个
 *   极简元素构造器 `_el()`，不复用 now.js 的 h()。
 *
 * 状态：`_open` 是模块级的。renderSkeleton() 每次 boot 都整槽重建，面板展开与否
 *   必须活过重建 —— 否则用户刚点开、一阵网络回调回来就又被收起来了。
 */

import { t } from '../i18n/zh.js';
import { beaufortScale, aqiScale, uvScale, windRose16 } from '../core/wmo.js';

/** 槽位 id（与 now.js 的 _slot() 同口径：DOM id 为 `card-` + 此值）。 */
export const LEGEND_SLOT_ID = 'legend';

/** 面板展开状态（模块级：活过整槽重建）。 */
let _open = false;

/**
 * 取（或建）图例槽位。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {HTMLElement} 槽位节点。
 */
function _slot(root) {
  const domId = `card-${LEGEND_SLOT_ID}`;
  let box = root.querySelector(`#${domId}`);
  if (!box) {
    box = _el('div', { class: 'card-slot', id: domId });
    root.appendChild(box);
  }
  return box;
}

/**
 * 极简 DOM 构造器（零依赖；不复用 now.js 的 h()，理由见文件头）。
 *
 * @param {string} tag 标签名。
 * @param {Object} [props] 属性表；class / text 有专门处理。
 * @param {Array<Node|string>|string} [children] 子节点。
 * @returns {HTMLElement} 元素。
 */
function _el(tag, props = {}, children = []) {
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
 * 阈值数字的原样呈现（去掉浮点尾巴：8.0 → '8'，保留 0.3 / 10.8）。
 *
 * @param {number} v 数值。
 * @returns {string} 文本。
 */
function _num(v) {
  return String(Number(v));
}

/* ------------------------------------------------------------------ */
/* 档位表（全部读自 core/wmo.js，本文件不写死任何阈值）                  */
/* ------------------------------------------------------------------ */

/**
 * 蒲福风级档位行。
 *
 * 第 i 级的区间是 [上一级的 maxMs, 本级 maxMs)；最高级没有上限，用「≥」表述。
 *
 * @returns {string[]} 13 行文案。
 */
function _beaufortRows() {
  const scale = beaufortScale();
  return scale.map((r, i) => {
    if (i === scale.length - 1) {
      return t('legend.beaufort.rowLast', { level: r.level, zh: r.zh, min: _num(scale[i - 1].maxMs) });
    }
    return t('legend.beaufort.row', { level: r.level, zh: r.zh, max: _num(r.maxMs) });
  });
}

/**
 * 欧洲 AQI 档位行。
 *
 * 下界 = 上一档 max + 1，最高档不设上界。
 *
 * @returns {string[]} 6 行文案。
 */
function _aqiRows() {
  const scale = aqiScale();
  return scale.map((r, i) => {
    const min = i === 0 ? 0 : scale[i - 1].max + 1;
    if (i === scale.length - 1) {
      return t('legend.aqi.rowLast', { min, zh: r.zh, advice: r.advice });
    }
    return t('legend.aqi.row', { min, max: r.max, zh: r.zh, advice: r.advice });
  });
}

/**
 * UV 档位行（与 AQI 同构：下界 = 上一档 max + 1）。
 *
 * @returns {string[]} 5 行文案。
 */
function _uvRows() {
  const scale = uvScale();
  return scale.map((r, i) => {
    const min = i === 0 ? 0 : scale[i - 1].max + 1;
    if (i === scale.length - 1) {
      return t('legend.uv.rowLast', { min, zh: r.zh, advice: r.advice });
    }
    return t('legend.uv.row', { min, max: r.max, zh: r.zh, advice: r.advice });
  });
}

/**
 * 风向 16 方位（名称直接读自换算表，不含角度 —— 角度是换算表的实现细节，
 * 抄进文案等于又写死一个数）。
 *
 * @returns {string[]} 16 个方位名。
 */
function _windDirRows() {
  return windRose16().map((zh) => t('legend.winddir.row', { zh }));
}

/**
 * 释义条目模型。
 *
 * 每项：`rows` 为空表示「本应用没有对这项设分档」；`wrap` 为 true 时档位横向
 * 排布（风向 16 方位那一项，竖排会拉出一长条）。
 *
 * @returns {Array<{title:string, items:Array<Object>}>} 分组模型。
 */
export function legendModel() {
  return [
    {
      title: t('legend.group.weather'),
      items: [
        {
          id: 'temp',
          title: t('legend.temp.title'),
          unit: t('legend.temp.unit'),
          body: t('legend.temp.body'),
          rows: [],
        },
        {
          id: 'feels',
          title: t('legend.feels.title'),
          unit: t('legend.feels.unit'),
          body: t('legend.feels.body'),
          rows: [],
        },
        {
          id: 'humidity',
          title: t('legend.humidity.title'),
          unit: t('legend.humidity.unit'),
          body: t('legend.humidity.body'),
          rows: [],
          noScale: true,
        },
        {
          id: 'precip',
          title: t('legend.precip.title'),
          unit: t('legend.precip.unit'),
          body: t('legend.precip.body'),
          rows: [],
        },
        {
          id: 'wind',
          title: t('legend.wind.title'),
          unit: t('legend.wind.unit'),
          body: t('legend.wind.body'),
          rows: [],
        },
        {
          id: 'beaufort',
          title: t('legend.beaufort.title'),
          unit: t('legend.beaufort.unit'),
          body: t('legend.beaufort.body'),
          rows: _beaufortRows(),
        },
        {
          id: 'winddir',
          title: t('legend.winddir.title'),
          unit: t('legend.winddir.unit'),
          body: t('legend.winddir.body'),
          rows: _windDirRows(),
          wrap: true,
        },
        {
          id: 'pressure',
          title: t('legend.pressure.title'),
          unit: t('legend.pressure.unit'),
          body: t('legend.pressure.body'),
          rows: [],
          noScale: true,
        },
        {
          id: 'visibility',
          title: t('legend.visibility.title'),
          unit: t('legend.visibility.unit'),
          body: t('legend.visibility.body'),
          rows: [],
          noScale: true,
        },
        {
          id: 'uv',
          title: t('legend.uv.title'),
          unit: t('legend.uv.unit'),
          body: t('legend.uv.body'),
          rows: _uvRows(),
        },
        {
          id: 'sun',
          title: t('legend.sun.title'),
          unit: t('legend.sun.unit'),
          body: t('legend.sun.body'),
          rows: [],
        },
        {
          id: 'dayLength',
          title: t('legend.dayLength.title'),
          unit: t('legend.dayLength.unit'),
          body: t('legend.dayLength.body'),
          rows: [],
        },
        {
          id: 'today',
          title: t('legend.today.title'),
          unit: t('legend.today.unit'),
          body: t('legend.today.body'),
          rows: [],
        },
        {
          id: 'wmo',
          title: t('legend.wmo.title'),
          unit: t('legend.wmo.unit'),
          body: t('legend.wmo.body'),
          rows: [],
        },
        {
          id: 'observedAt',
          title: t('legend.observedAt.title'),
          unit: t('legend.observedAt.unit'),
          body: t('legend.observedAt.body'),
          rows: [],
        },
      ],
    },
    {
      title: t('legend.group.air'),
      items: [
        {
          id: 'aqi',
          title: t('legend.aqi.title'),
          unit: t('legend.aqi.unit'),
          body: t('legend.aqi.body'),
          rows: _aqiRows(),
        },
        {
          id: 'pollutants',
          title: t('legend.pollutants.title'),
          unit: t('legend.pollutants.unit'),
          body: t('legend.pollutants.body'),
          rows: [],
          noScale: true,
        },
      ],
    },
    {
      title: t('legend.group.place'),
      items: [
        {
          id: 'elevation',
          title: t('legend.elevation.title'),
          unit: t('legend.elevation.unit'),
          body: t('legend.elevation.body'),
          rows: [],
        },
        {
          id: 'coord',
          title: t('legend.coord.title'),
          unit: t('legend.coord.unit'),
          body: t('legend.coord.body'),
          rows: [],
        },
        {
          id: 'tz',
          title: t('legend.tz.title'),
          unit: t('legend.tz.unit'),
          body: t('legend.tz.body'),
          rows: [],
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 单条释义。
 *
 * @param {Object} item 条目模型。
 * @returns {HTMLElement} 条目节点。
 */
function _itemNode(item) {
  const nodes = [
    _el('div', { class: 'legend-item-head' }, [
      _el('span', { class: 'legend-item-name', text: item.title }),
      _el('span', { class: 'legend-item-unit', text: item.unit }),
    ]),
    _el('p', { class: 'legend-item-body', text: item.body }),
  ];

  if (item.rows.length > 0) {
    const cls = item.wrap ? 'legend-scale legend-scale--wrap' : 'legend-scale';
    nodes.push(_el('ul', { class: cls }, item.rows.map((r) => _el('li', { class: 'legend-scale-row', text: r }))));
  } else if (item.noScale) {
    nodes.push(_el('p', { class: 'legend-none', text: t('legend.noScale') }));
  }

  return _el('div', { class: 'legend-item', 'data-legend': item.id }, nodes);
}

/**
 * 面板内容（展开时才有）。
 *
 * @returns {HTMLElement} 面板节点。
 */
function _panelNode() {
  const groups = legendModel().map((g) =>
    _el('div', { class: 'legend-group' }, [
      _el('h3', { class: 'legend-group-title', text: g.title }),
      _el('div', { class: 'legend-list' }, g.items.map(_itemNode)),
    ])
  );
  return _el('div', { class: 'legend-panel' }, [
    _el('p', { class: 'legend-note', text: t('legend.note') }),
    ...groups,
  ]);
}

/**
 * 渲染（或收起）指标释义面板。
 *
 * 整槽替换，与 now.js 的其它卡片同一套节奏：每次渲染都是一颗新按钮，
 * 展开与否从模块级 `_open` 读，不靠 DOM 记忆。
 *
 * @param {HTMLElement} root 根容器（#app）。
 * @returns {HTMLElement|null} 槽位节点；无根容器时 null。
 */
export function renderLegend(root) {
  if (!root) return null;
  const box = _slot(root);

  const toggle = _el('button', {
    type: 'button',
    class: 'btn legend-toggle',
    'aria-expanded': _open ? 'true' : 'false',
  });
  toggle.textContent = _open ? t('legend.close') : t('legend.open');
  toggle.addEventListener('click', () => {
    _open = !_open;
    renderLegend(root);
  });

  const nodes = [toggle];
  if (_open) nodes.push(_panelNode());
  _fill(box, nodes);
  return box;
}

/**
 * 面板当前是否展开（测试与调试用）。
 *
 * @returns {boolean} 是否展开。
 */
export function isLegendOpen() {
  return _open;
}
