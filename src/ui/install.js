/**
 * 「添加到桌面 / 主屏幕」的安装状态机（PWA 安装入口）。
 *
 * 为什么需要它（真机反馈，不是纸面推演）：
 *   `manifest.webmanifest` 一直齐备（display: standalone + 两个 512 图标 any/maskable），
 *   Service Worker 也在，浏览器菜单里**其实能装** —— 但 App 内一个引导都没有，用户
 *   的原话是「在哪里『添加到桌面或主屏幕』？我没找到」。所以缺的不是能力，是把那条
 *   本来就存在的入口摆到用户看得见的地方。这是一次性动作：装完就该安静，不该常驻
 *   占地方（卡片在 settings.js 里装完后折叠成一行，正是这个意思）。
 *
 * ★★本模块的第一条纪律：这是一个「状态可能根本没有」的功能，缺什么就说什么，
 *   绝不拿常量拼装假状态。与 `src/ui/settings.js` 的 `_renderShellCard()` 里
 *   「如实说 unknown / unsupported，绝不编版本号」是同一条纪律：
 *     1) **没捕获到 `beforeinstallprompt` 就不许显示按钮**。iOS Safari 永远不触发这个
 *        事件（这是它的既定行为，不是我们没接好），显示一个点了没反应的按钮＝骗人；
 *        那种环境只能给手动步骤文案。
 *     2) **没检测到 standalone 就不许说「已安装」**。`display-mode` 与 `navigator.standalone`
 *        都没给出信号时返回 false —— 没信号就是没信号，不许猜成 true。
 *     3) **捕获到的事件对象只能用一次**。`prompt()` 之后再调会直接抛，所以无论用户
 *        接受还是取消，都要把它清掉（canPrompt() 随即变回 false，界面上那个按钮
 *        必须消失，而不是留一个按下去只会报 failed 的死按钮）。
 *
 * 依赖方向：本模块**一个 import 都没有**（连 i18n 的 t() 都不需要 —— 它只回答
 * 「能不能装 / 装没装 / 装的结果是什么」这三个事实，一句可见文案都没有，全部文案
 * 都在 settings.js 里走 t()）。这样它也能被 Node 侧单测直接加载，不必先装假 i18n。
 *
 * 零新增样式：本模块不建任何 DOM，类名是调用方（settings.js）的事。
 */

/** @type {Object|null} 捕获到的 `beforeinstallprompt` 事件对象；只能用一次。 */
let _deferred = null;

/**
 * 取 window（Node 侧 / 非浏览器环境下为 null，所有函数都靠它降级而不是抛）。
 *
 * @returns {Object|null} window 或 null。
 */
function _win() {
  return typeof window !== 'undefined' && window ? window : null;
}

/**
 * 取 navigator（同上：拿不到就返回 null，绝不抛）。
 *
 * @returns {Object|null} navigator 或 null。
 */
function _nav() {
  return typeof navigator !== 'undefined' && navigator ? navigator : null;
}

/**
 * 开始监听安装相关事件；状态一变就回调 `onChange`（让界面重画）。
 *
 * 挂两个监听：
 *   1) `beforeinstallprompt`：**先 preventDefault()**（不拦的话浏览器会走自己的迷你
 *      安装条，我们存的那个事件对象随后失效），再把事件对象存起来，最后回调 ——
 *      因为「按钮现在能显示了」是这一刻才成立的事实。
 *   2) `appinstalled`：装完了，清掉事件对象（已经用不着了）并回调 —— 卡片该从
 *      「有条可点」变成「已经装好了」。
 *
 * ★两处 `onChange` 都必须先判 `typeof onChange === 'function'`：本项目踩过「回调取不到
 *   退化成空函数」的坑，那条路径不报错、只是界面永远不更新，等于静默断线。
 *
 * @param {() => void} [onChange] 状态变化回调（可空）。
 * @returns {void}
 */
export function initInstallPrompt(onChange) {
  const win = _win();
  if (!win || typeof win.addEventListener !== 'function') return;

  win.addEventListener('beforeinstallprompt', (ev) => {
    // ★顺序不能换：不 preventDefault() 的话浏览器会自己弹迷你安装条，
    //   而我们手里这个事件对象随之失效 —— 存了也白存。
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    _deferred = ev || null;
    if (typeof onChange === 'function') onChange();
  });

  win.addEventListener('appinstalled', () => {
    _deferred = null;
    if (typeof onChange === 'function') onChange();
  });
}

/**
 * 当前是不是**已经以独立窗口运行**（＝已经装到桌面 / 主屏幕上）。
 *
 * 两个信号取或：`display-mode: standalone` 媒体查询（标准写法）与 iOS Safari 私有的
 * `navigator.standalone`。两个都没有信号 → 返回 false（没信号就是没信号，不许猜 true）。
 *
 * @returns {boolean} 已安装则 true；否则 false。
 */
export function isInstalled() {
  const win = _win();
  if (win && typeof win.matchMedia === 'function') {
    try {
      const mq = win.matchMedia('(display-mode: standalone)');
      if (mq && mq.matches === true) return true;
    } catch (err) {
      // 老浏览器不认这个媒体查询时会抛 —— 那只是「这条信号拿不到」，继续问下一条
    }
  }
  const nav = _nav();
  if (nav && nav.standalone === true) return true;
  return false;
}

/**
 * 现在**能不能真的弹安装提示**（＝是否已经捕获到 `beforeinstallprompt` 事件）。
 *
 * ★判据只有一个：手里有没有那个事件对象。没有就 false —— iOS Safari 永远不给，
 *   「显示一个点了没反应的按钮」比「不显示按钮」坏得多。
 *
 * @returns {boolean} 能弹则 true。
 */
export function canPrompt() {
  return Boolean(_deferred) && typeof _deferred.prompt === 'function';
}

/**
 * 弹一次系统安装提示，并把用户的选择原样带回来。
 *
 * @returns {Promise<{outcome: string, error?: *}>}
 *   - `{ outcome: 'unavailable' }`：手里没有事件对象（iOS / 已经用过 / 事件还没到），
 *     什么都不做 —— 界面根本不该出现这个按钮，走到这里说明是兜底；
 *   - `{ outcome: 'accepted' }` / `{ outcome: 'dismissed' }`：用户接受 / 取消；
 *   - `{ outcome: 'failed', error }`：浏览器抛了异常（连点触发第二次 prompt() 是最常见的一种）。
 *   ★永不 reject：整个 async 段包在 try/catch 里，异常不许冒出去把页面搞白。
 */
export async function promptInstall() {
  const ev = _deferred;
  // ★没有事件对象就如实说 unavailable，绝不假装有（见本模块 JSDoc 第 1 条）
  if (!ev || typeof ev.prompt !== 'function') return { outcome: 'unavailable' };

  // ★事件对象只能用一次：先摘下来再 prompt()。这样 await 期间 canPrompt() 已经是
  //   false —— 界面上的按钮会消失，用户连点第二次也走不到真实的 prompt()。
  _deferred = null;

  try {
    ev.prompt();
    const choice = await ev.userChoice;
    // 浏览器只约定了 accepted / dismissed 两种取值；拿到别的（或压根没给）一律按
    // 「没装成」处理，而不是编一个 outcome 出来。
    const outcome = choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    return { outcome };
  } catch (error) {
    return { outcome: 'failed', error };
  }
}
