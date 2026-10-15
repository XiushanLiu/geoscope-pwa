/**
 * 候选列表卡（住宿 / 景点 / 美食各一组）
 *
 * 职责：把一个类别的候选按 `pass / fail / unknown` 三分组渲染成卡片。**只负责画**，
 *   发请求与筛选都在 ui/roadtrip.js，本模块不 import data 层、不发请求。
 *
 * ★三分组为什么必须在界面上是**三个可见的分组**（而不是过滤掉两组）：
 *   架构 §4.7 定的语义是「看不清就是看不清，但要让用户看见有多少条看不清」。
 *   把 `unknown` 藏起来，用户会以为「附近没有 4A 以上景区」，而真相是「高德没返回
 *   等级字段，无从判断」—— 那是把「没数据」伪装成「没结果」，与本仓「静默错误最可怕」
 *   的一贯口径冲突。所以三组各有标题、各有计数，`unknown` 还要**按字段**细分计数。
 *
 * ★`fail` 与 `unknown` 不许合并：房价 260 元是**有值但不达标**（fail）；
 *   房价字段为 null 是**看不清**（unknown）。合成一组，用户就分不清该砍价还是该补录。
 *
 * ★候选**不落盘**（架构 §4.6）：本模块画的每一行都是运行时数据，点「采用」之后才由
 *   上层转成 CheckIn 写进行程。这里不碰 localStorage、不碰 tripstore。
 *
 * 依赖方向：ui → core（format）+ i18n。
 */

import { t } from '../i18n/index.js';
import { h } from './now.js';
import * as fmt from '../core/format.js';

/**
 * 待筛选字段名 → 显示名文案键。
 *
 * 为什么字段名不直接显示英文：`partitionByFilter()` 给的 `unknownCounts` 用的是
 * **数据字段名**（pricePerNight / roomType / level / localSpecial），那是给程序看的；
 * 甩给用户就是「未填：pricePerNight（3）」—— 国内用户看不懂，也违反「文案零硬编码」。
 *
 * @type {Object<string,string>}
 */
const FIELD_KEY = {
  pricePerNight: 'rt.field.pricePerNight',
  roomType: 'rt.field.roomType',
  level: 'rt.field.level',
  localSpecial: 'rt.field.localSpecial',
  // ★rating / keywords 同样是 `_evaluate()` 会记进 `unknownCounts` 的字段名（评分三类
  //   共用、关键词是美食那条）。原先漏了这两个，界面上会直接甩出 `未填：rating（3）`
  //   —— 与「文案零硬编码」冲突，也看不懂。补上。
  rating: 'rt.field.rating',
  keywords: 'rt.field.keywords',
};

/**
 * 把数据字段名翻成给人看的字段名。
 *
 * @param {string} field 字段名。
 * @returns {string} 显示名；未知字段名原样返回（宁可显示原始字段名，也不猜一个译名）。
 */
function poiFieldLabel(field) {
  const key = FIELD_KEY[String(field)];
  return key ? t(key) : String(field);
}

/**
 * 取候选的直线距离文案。
 *
 * ★为什么必须写「直线」：高德返回的是圆心到 POI 的**直线**距离，不是路网距离；
 *   路网距离要再发一次请求才拿得到。写成「1.2 km」用户会当成开车 1.2 km，
 *   而实际上可能隔着一条河 —— 那就是把推算值冒充实测值。
 *
 * @param {Object} c 候选。
 * @returns {string} 文案；距离缺失时返回 '—'（core/format.js 的 DASH）。
 */
function poiDistanceText(c) {
  const m = c && Number.isFinite(Number(c.distanceM)) ? Number(c.distanceM) : null;
  if (m === null) return fmt.DASH;
  return t('rt.poiStraight', { m: fmt.num(m / 1000, 1, ' km') });
}

/**
 * 画一行候选。
 *
 * @param {Object} c 候选。
 * @param {'stay'|'sight'|'food'} type 类别。
 * @param {{onAdopt?:Function, adoptedIds?:Object}} opts 选项。
 * @returns {Object} 行节点。
 */
function _row(c, type, opts) {
  const cand = c && typeof c === 'object' ? c : {};
  const adopted = !!(opts.adoptedIds && opts.adoptedIds[cand.id]);

  const meta = [
    // 类别原串（高德 type 原文，如 '住宿服务;宾馆酒店'）—— 缺就是 '—'，不编。
    // ★优先取 `category`：候选条目上的 `type` 已被上层改写成 'stay' / 'sight' / 'food'
    //   （`partitionByFilter()` 按它取筛选条件），高德原文存在 `category` 里。
    (cand.category || cand.type) ? String(cand.category || cand.type) : fmt.DASH,
    // 评分：高德**真的返回了**才有值，否则 '—'（绝不用 4.0 兜底）
    `★ ${fmt.num(cand.rating, 1)}`,
    poiDistanceText(cand),
  ].join(' · ');

  const children = [
    h('p', { class: 'card-title', text: String(cand.name || fmt.DASH) }),
    h('p', { class: 'card-note', text: meta }),
  ];
  if (cand.address) children.push(h('p', { class: 'card-note', text: String(cand.address) }));

  if (adopted) {
    children.push(h('p', { class: 'card-note', text: t('rt.poiAdopted') }));
  } else if (typeof opts.onAdopt === 'function') {
    const btn = h('button', {
      class: 'btn',
      type: 'button',
      'data-poi-id': String(cand.id || ''),
      text: t('rt.poiAdopt'),
    });
    // ★回调取不到必须是看得见的失败（共享约定 §9 第 2 条）：这里由调用方保证
    //   onAdopt 一定存在才画出这颗按钮 —— 画一颗点了没反应的按钮比不画更糟。
    btn.addEventListener('click', () => opts.onAdopt(cand, type));
    children.push(btn);
  }

  return h('div', { class: 'poi-row' }, children);
}

/**
 * 画一个分组（标题 + 计数 + 各行）。
 *
 * @param {string} titleKey 标题文案键。
 * @param {number} count 条数。
 * @param {Array<Object>} items 条目。
 * @param {'stay'|'sight'|'food'} type 类别。
 * @param {Object} opts 选项。
 * @returns {Object|null} 分组节点；空组返回 null（不画空标题）。
 */
function _group(titleKey, count, items, type, opts) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0 && count === 0) return null;
  const box = h('div', { class: 'poi-group' }, [
    h('p', { class: 'card-note', text: t(titleKey, { n: count }) }),
  ]);
  for (const item of list) box.appendChild(_row(item, type, opts));
  return box;
}

/**
 * 渲染一个类别的候选列表卡。
 *
 * @param {Object} opts 选项。
 * @param {'stay'|'sight'|'food'} opts.type 类别。
 * @param {{pass:Array, fail:Array, unknown:Array, unknownCounts:Object, total:number}} opts.groups
 *   `partitionByFilter()` 的产出。
 * @param {(cand:Object, type:string) => void} [opts.onAdopt] 采用回调；不传则**不画**采用按钮。
 * @param {Object<string, boolean>} [opts.adoptedIds] 已采用的候选 id 集合。
 * @param {boolean} [opts.showUnknownHint] 是否附一行「未填意味着什么」的说明。
 * @returns {Object} 卡片节点。
 */
export function renderPoiGroup(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const type = o.type === 'stay' || o.type === 'sight' || o.type === 'food' ? o.type : 'sight';
  const g = o.groups && typeof o.groups === 'object' ? o.groups : {};
  const pass = Array.isArray(g.pass) ? g.pass : [];
  const fail = Array.isArray(g.fail) ? g.fail : [];
  const unknown = Array.isArray(g.unknown) ? g.unknown : [];

  const card = h('div', { class: 'card' }, [
    h('p', { class: 'card-title', text: t(`rt.type.${type}`) }),
  ]);

  const gp = _group('rt.groupPass', pass.length, pass, type, o);
  if (gp) card.appendChild(gp);

  const gf = _group('rt.groupFail', fail.length, fail, type, o);
  if (gf) card.appendChild(gf);

  const gu = _group('rt.groupUnknown', unknown.length, unknown, type, o);
  if (gu) {
    card.appendChild(gu);
    // ★「未填」要按**字段**细分计数：用户得知道缺的是房价还是景区等级 ——
    //   两者的处置完全不同（补录 vs 换一家）。
    const counts = g.unknownCounts && g.unknownCounts[type] ? g.unknownCounts[type] : {};
    for (const field of Object.keys(counts)) {
      card.appendChild(
        h('p', {
          class: 'card-note',
          text: t('rt.groupUnknownField', { field: poiFieldLabel(field), n: counts[field] }),
        })
      );
    }
    if (o.showUnknownHint !== false) {
      card.appendChild(h('p', { class: 'card-note', text: t('rt.unknownHint') }));
    }
  }

  if (!gp && !gf && !gu) {
    card.appendChild(h('p', { class: 'card-note', text: t('rt.poiEmpty') }));
  }
  return card;
}
