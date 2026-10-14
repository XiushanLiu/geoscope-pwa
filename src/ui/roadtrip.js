/**
 * 自驾页（roadtrip.html 入口）
 *
 * 职责：**目前只有外壳**。路线规划、行程实录、路线图分别在 T04 / T05 落地，
 * 这一版刻意只做「页头 + 返回入口 + 空态说明」，并且**不发任何请求**。
 *
 * ★为什么不先塞点假数据把页面填满：本项目的红线是「缺就显示未填，绝不用推算值
 *   冒充实测」。规划功能没做完的时候，唯一诚实的界面就是明确写出「还没做完」，
 *   而不是画一排看起来有内容、实际是编的卡片。等 T04 落地，这个空态会被真实
 *   的行程列表替换掉。
 *
 * 为什么这一页**不带底部 tabbar**：`.tabbar` 是 `position: fixed` 且没有 width
 * （shrink-to-fit，宽度由内容决定），四个 tab 在 320px 屏上已经贴着临界点（实测
 * 内容宽 294px），真机上出过「此刻」两字断成两行的 bug（fa1ec49）。加第五项必撑破。
 * 所以本页改用一个明确的「返回『我的』」入口，不进 tabbar。
 *
 * 依赖方向：ui ← data ← core。本页目前只 import core（store）与 ui（now.js 的 h /
 * applyI18n、theme.js、locale.js）。★T04 起会 import data/roadsources.js，那时必须
 * 同时 import '../data/sources.js' —— 源解析器是 sources.js 在**自己加载时**通过
 * setSourceResolver() 注入的，漏掉这一行 requestRoadSource() 会拿到 UNSUPPORTED，
 * 不发任何请求、每个按钮都点了没反应（compare.js:40 有同一条注释）。
 *
 * 顶层只做三件全站属性的引导（主题 / 字号 / 语言），其余 DOM 访问全在 init() 内。
 */

import { t } from '../i18n/index.js';
import { applyLocale } from './locale.js';
import { getThemeMode, getFontScale, getLocale } from '../core/store.js';
import { h, applyI18n } from './now.js';
// 主题 / 字号是全站属性，本页作为入口之一必须各引导一次（实现见 ui/theme.js）。
import { applyThemeMode, applyFontScale } from './theme.js';

// ★主题引导（模块顶层，行首无缩进）：与 index/settings/compass/selfcheck/compare 同一时机。
applyThemeMode(getThemeMode());
// ★字号档位引导（与主题同一时机、同一理由）。放大乘数在 styles/tokens.css。
applyFontScale(getFontScale());
// 语言引导（同上）。三个都是行首无缩进 —— tools/check.mjs 第 15 节按这个形状断言。
applyLocale(getLocale());

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
 * 渲染页面外壳（页头 + 返回入口 + 空态说明）。
 *
 * 现在只有这三块；T04 / T05 会往 `_slots` 里挂行程列表与路线图，外壳不用改。
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
        h('h1', { class: 'hd-place', text: t('rt.title') }),
        h('p', { class: 'hd-coord', text: t('rt.subtitle') }),
      ]),
    ])
  );

  // 返回入口：本页不进 tabbar，必须给一条明确的回「我的」的路，否则用户要靠
  // 浏览器返回键，而 PWA 全屏模式下那个键不一定存在。
  app.appendChild(
    h('div', { class: 'field field--row' }, [
      h('a', { class: 'btn', href: 'settings.html', text: t('rt.back') }),
    ])
  );

  // 空态：如实说明「还没做完」，而不是画一排看起来有内容的卡片。
  app.appendChild(
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('rt.empty') }),
      h('p', { class: 'card-note', text: t('rt.emptyHint') }),
    ])
  );
}

/**
 * 页面入口。
 *
 * @returns {void}
 */
export function init() {
  _renderShell();
  // 静态 HTML 里的 data-i18n 属性（title / meta）在渲染之后统一翻译一次。
  applyI18n(document);
  // ★再显式设一次 document.title：applyI18n 只会把 <title> 翻成页名（「自驾」），
  //   而 compare / selfcheck / settings 三页用的是「地候 GeoScope · 页名」——
  //   切到别的标签页 / 加书签时，带 App 名的那个标题才认得出来是哪一页。
  //   HTML 里那个简短 <title> 保留着：它是无 JS 时的兜底，不是死代码。
  if (typeof document !== 'undefined' && document.title !== undefined) {
    document.title = `${t('app.name')} · ${t('rt.title')}`;
  }
}

// 三个全站属性已在上面的模块顶层引导过（不在这里重复）。其余装配仍需守卫：Node 侧
// 静态检查 import 本模块时没有 document，不能渲染。
if (typeof document !== 'undefined' && document !== null) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
