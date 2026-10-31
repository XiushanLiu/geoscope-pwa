/**
 * 壳更新提示条：任何页面上，只要探测到新壳已就绪，就在页面顶部插一条可点的提示。
 *
 * 为什么需要它（不是锦上添花，是一次事故的直接产物）：
 *   v66 把「版本号 + 检查更新」做进了「我的」页（settings.js 的 _renderShellCard），
 *   但**只有那一页知道**有新壳 —— 用户若一直停在「地理」页或「气候」页，永远看不到。
 *   2026-10-31 那次事故的根就在这里：发布了 v65/v66，用户那儿跑的还是 10-25 的旧壳，
 *   因为没有任何一页告诉他。所以要补的是「任何页面都能看见」。
 *
 * ★两条不变量（勿回退）：
 *   1) **绝不自动 reload()**。用户可能正在输入搜索词，自动刷新会把输入冲掉 —— 与
 *      app.js 的 _registerSW() 拒绝自动重载是同一个理由。这里只给一条提示条，
 *      刷不刷由用户点那个按钮决定。
 *   2) **零新增样式**。提示条复用现成的 `.banner`（styles/app.css 自带
 *      `color: var(--c-text-2)`），按钮复用现成的 `.btn`：这样
 *      tools/contrast-audit.mjs 的 88 条 `color:` 一条都不会被打破。
 *
 * 依赖方向：本模块**只 import i18n 的 t()**。不许 import ui/now.js —— 那会把整个
 * now.js（连同它的一大坨渲染代码）拖进 settings / compare / selfcheck 的依赖图，
 * 而它们要的只是这里的一句文案。DOM 一律用原生 document.createElement，不用 h()。
 */

import { t } from '../i18n/index.js';

/** 提示条的元素 id（幂等判据：文档里已经有了就不再插第二次）。 */
const NOTE_ID = 'shell-update-note';

/** @type {boolean} 模块级幂等标志：watchShellUpdate() 重复调用只做一次。 */
let _watched = false;

/**
 * 开始监听壳更新；一旦新壳就绪就在页面上插一条提示。
 *
 * 失败一律静默（file:// 或非安全上下文下 navigator.serviceWorker 根本不存在，
 * 那是**正常**环境而不是错误，不许抛）。
 *
 * @returns {Promise<void>} 可被 await（测试要等它落地）；永不 reject。
 */
export function watchShellUpdate() {
  if (_watched) return Promise.resolve();
  _watched = true;

  const nav = typeof navigator !== 'undefined' && navigator ? navigator : null;
  // file:// / 非安全上下文：连问都没处问，直接放弃（不抛）
  if (!nav || !nav.serviceWorker) return Promise.resolve();

  const sw = nav.serviceWorker;
  if (typeof sw.getRegistration !== 'function') return Promise.resolve();

  return Promise.resolve()
    .then(() => sw.getRegistration())
    .then((reg) => {
      if (!reg) return;

      // 主动催一次：浏览器默认只在导航时顺便查一次 sw.js（见 app.js 的 _registerSW）
      if (typeof reg.update === 'function') reg.update().catch(() => {});

      /**
       * 判定：只有**已经装好、正在等待接管**的新壳才算「就绪」。
       * installing 中的壳还没装完，这时候提示「有新版本」是假话。
       *
       * @returns {void}
       */
      const check = () => {
        if (reg.waiting) showNote();
      };

      // ★立刻执行一次 —— 这一条是关键：覆盖「打开页面时新壳早就在 waiting 里躺着」
      //   的场景，那正是 2026-10-31 事故的实际情形（壳是前几天就装好的，用户今天才
      //   打开页面）。只监听 updatefound **抓不到存量 waiting**：updatefound 只在
      //   「本次会话内新装出一个壳」时才触发。
      check();

      if (typeof reg.addEventListener !== 'function') return;
      reg.addEventListener('updatefound', () => {
        const inst = reg.installing;
        if (!inst || typeof inst.addEventListener !== 'function') return;
        inst.addEventListener('statechange', () => {
          if (inst.state === 'installed') check();
        });
      });
    })
    .catch(() => {});
}

/**
 * 在页面顶部插入提示条。
 *
 * 幂等：文档里已经有 #shell-update-note 就直接返回。用户点「我的」页的「检查更新」
 * 会让新壳 activate，随后 check() 可能被调用多次 —— 提示条只能有一条。
 *
 * @returns {void}
 */
function showNote() {
  const doc = typeof document !== 'undefined' && document ? document : null;
  if (!doc || !doc.body || typeof doc.createElement !== 'function') return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(NOTE_ID)) return;

  const el = doc.createElement('div');
  // 复用现成 .banner：自带 color: var(--c-text-2)，本模块零新增 color: 声明
  el.className = 'banner';
  el.setAttribute('id', NOTE_ID);

  const text = doc.createElement('span');
  text.textContent = t('shell.updateReady');
  el.appendChild(text);

  const btn = doc.createElement('button');
  btn.className = 'btn';
  btn.setAttribute('type', 'button');
  btn.textContent = t('shell.reloadBtn');
  btn.addEventListener('click', () => {
    // ★只有用户点了才刷新。绝不自动 reload —— 会把用户正在输入的搜索词冲掉，
    //   与 app.js 的 _registerSW() 拒绝自动重载是同一个理由。
    if (typeof location !== 'undefined' && location && typeof location.reload === 'function') {
      location.reload();
    }
  });
  el.appendChild(btn);

  // 插到 <body> 最前面：index.html 的第一个子元素是 #banner，selfcheck.html 的是
  // <header class="sc-head"> —— 写死任一 id 都会在另一个页面上失效，所以插 firstElementChild 之前。
  doc.body.insertBefore(el, doc.body.firstElementChild);
}
