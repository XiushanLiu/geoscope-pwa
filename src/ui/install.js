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
 * 「能不能装 / 装没装 / 弹的结果是什么 / 当前是哪一类环境」这四个**事实**（返回值全是
 * 枚举或布尔），一句可见文案都没有，全部文案都在 settings.js 里走 t()）。这样它也能被
 * Node 侧单测直接加载，不必先装假 i18n。
 * ★这条纪律是刻意守的：`detectHostEnv()` 只许返回 'ios' / 'android' / 'wechat' /
 *   'qq' / 'unknown' 这五种枚举之一，**不许带半句说明文案** —— 文案一进来本模块就得
 *   import t()；而且「环境是什么」（事实）与「界面上怎么说」（措辞）必须分开，
 *   前者可测，后者可调，混在一起两头都动不了。
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
 * 判当前**宿主环境**是哪一类（用来决定「催收/A路」给哪一条）。
 *
 * 为什么需要它（2026 真机反馈）：用户在微信里点右上角「…」→「添加到桌面」，试了几次
 * 桌面上都找不到，点左上角小房子却进了 WorkBuddy —— 原因是微信内置的是 **WebView
 * 而不是浏览器**，根本不支持 PWA 安装；随后他在真浏览器里打开同一链接，右上角「…」
 * 又没了（那个 ⋮ 只有 Chrome / Edge 有，三星 / 小米 / 华为 / UC / 夸克的菜单在**底栏**，
 * iOS 更是必须用 Safari、入口在底部中间的分享）。所以「给一条手动步骤」不够，
 * 必须**分环境**给：先说清当前环境为什么装不了，再说出路在哪。
 *
 * ★★判据的可靠程度不同，**下面逐条标注了哪些有实测支撑**，别把它们当成一样硬：
 *   - `'wechat'`（有真机行为佐证）：UA 含 `MicroMessenger`。这是微信专有 token，
 *     零误判风险。
 *   - `'qq'`（**仅 UA 约定，未实测**）：UA 含 ` QQ/`（**前导空格是关键**）。它的作用不是
 *     「避开 QQ 浏览器」—— 实测 QQ 浏览器 UA（`QQBrowser` / `MQQBrowser`）里根本不含
 *     `QQ/`，把空格去掉它也不会被误判成 `'qq'`（这一条由单测「QQ 浏览器 → android」
 *     钉着）。带空格的真正理由是：` QQ/` 是一个**带前导空格的独立 token**，要求它前后
 *     有边界，才能避免命中任何**以 `QQ/` 收尾**的其它 token（UA 是一串空格分隔片段，
 *     没有边界约束的子串匹配迟早会在某个没见过的 UA 上误伤）。
 *     依据是 QQ **内置** WebView 的 UA 形如 ` QQ/8.9.63`。**没有真机验证过**：若判错，
 *     本档会退化成 ios / android 档（那两条路径依然正确，不会把用户带错路），
 *     所以这是**可接受的降级**。
 *     ★不许自行扩大这条路 —— 加一个容器就要为它的真伪判据负责，没实测过的一律不加
 *     （钉钉 / 微博等一概不识）。
 *   - `'ios'`：UA 含 `iPhone` / `iPad` / `iPod`，**或** UA 含 `Macintosh` 且
 *     `navigator.maxTouchPoints > 1`。后半条是 iPadOS 13+ 的坑：iPad 上 Safari 默认
 *     把自己伪装成 Macintosh，只认 `Macintosh` 会把 iPad 判成桌面，只认 `iPhone`
 *     又会漏掉 iPad —— 两条都不许去掉。
 *   - `'android'`：UA 含 `Android`。
 *   - `'unknown'`：以上都不成立（桌面浏览器、Node 侧、拿不到 navigator）。
 *
 * ★顺序：**先判容器再判系统**。微信 / QQ 的 WebView UA 里同样带着 `iPhone` 或
 *   `Android`，先判系统会把容器吃掉，那正是这次真机事故的形态。
 *
 * @returns {'ios'|'android'|'wechat'|'qq'|'unknown'} 宿主环境枚举。
 */
export function detectHostEnv() {
  const nav = _nav();
  if (!nav) return 'unknown';
  const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';

  // ① 容器（优先级最高：它们的 UA 里也带 iPhone / Android）
  if (ua.indexOf('MicroMessenger') !== -1) return 'wechat';
  if (ua.indexOf(' QQ/') !== -1) return 'qq';

  // ② 系统
  if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1 || ua.indexOf('iPod') !== -1) return 'ios';
  // iPadOS 13+ 伪装成 Macintosh：只有「多点触控」能把 iPad 与真 Mac 分开。
  // ★先排除 null / undefined —— Number(null) === 0 本项目已踩过四次，这里一旦
  //   把「没这个属性」算成 0 还好，算成点数参与比较就会错判。
  const rawTouch = nav.maxTouchPoints;
  const touchPoints = rawTouch === null || rawTouch === undefined ? 0 : Number(rawTouch);
  if (ua.indexOf('Macintosh') !== -1 && touchPoints > 1) return 'ios';
  if (ua.indexOf('Android') !== -1) return 'android';

  return 'unknown';
}

/**
 * 由「安装状态 + 宿主环境」这两个**事实**裁决：该显示哪一档。
 *
 * 为什么这个判定要住在 install.js 而不是 settings.js：它回答的是「事实是哪一档」，
 *   不是「这一档画成什么样」。画成什么样是渲染（settings.js 建 DOM、i18n 给措辞），
 *   而「该给哪一档」能在 Node 侧被直接单测 —— install.js 零 import，这正是它的优势。
 *   放在 `_fillInstallCard()` 的 if/else 链里就测不到，只能靠下一次改这块的人自觉。
 *
 * ★★判定顺序（不许变）：**事实压推断**。
 *   第 2 步之所以排在环境档之前，是因为「env === 'wechat' ⇒ 装不了」是一条**推断**
 *   （建立在 UA 约定上，见 detectHostEnv() 的 JSDoc：QQ 那档压根没实测过），
 *   而「手里真有一个 `beforeinstallprompt` 事件对象」是**事实** —— 事实永远压推断。
 *   微信 / QQ 里 canPrompt() 必然是 false（它们压根不触发那个事件），所以两档在真机上
 *   不会真的冲突；顺序留成「事件对象优先」，是本模块第一条纪律（没捕获到事件就不许
 *   显示按钮）的镜像 —— 反过来排，就会在某个 UA 约定失灵的环境里，**把本来能装的
 *   用户**推进「装不了」那一档。
 *
 * ★入参健壮性：缺字段 / 非对象 / 未知 env 一律走**保守档** —— `installed` 没给当没装、
 *   `canPrompt` 没给当不能弹、env 不认识当 'manual-other'。**永不抛**。
 *   ★判等一律用 `=== true`：写成 truthy 会把 undefined / 字符串 'false' 吃进来，
 *     而 `!= null` 那类写法会把 `false` 也判成真 —— 两者都是「显示一个点了没反应的
 *     按钮」的经典入口。
 *
 * @param {{installed?:boolean, canPrompt?:boolean, env?:string}} [input] 三个信号。
 * @returns {'installed'|'prompt'|'blocked-wechat'|'blocked-qq'|'manual-ios'|'manual-android'|'manual-other'}
 *   该显示的那一档。
 */
export function pickInstallMode(input) {
  const src = input && typeof input === 'object' ? input : {};
  const installed = src.installed === true;
  const canPromptNow = src.canPrompt === true;
  const env = typeof src.env === 'string' ? src.env : '';

  if (installed) return 'installed';
  if (canPromptNow) return 'prompt';
  if (env === 'wechat') return 'blocked-wechat';
  if (env === 'qq') return 'blocked-qq';
  if (env === 'ios') return 'manual-ios';
  if (env === 'android') return 'manual-android';
  return 'manual-other';
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

/**
 * 本站在**入口页**上的绝对网址（用户粘到「网站快捷方式」里用的就是它）。
 *
 * ★必须是 `origin + '/index.html'` 而不是 `location.href`：`manifest.webmanifest` 的
 *   `start_url` 就是 index.html，那是用户点开 App 的**正门**；而这张卡在 settings.html
 *   上，用 href 会复制出一个设置页地址 —— 用户在桌面上点开就直接进设置，且地址栏
 *   显示的是那一页，等于把人带错门。
 *
 * 拿不到 location（Node 侧）或 origin 为空 / 为字符串 'null'（file:// 下就是它）
 * → 返回空串。★空串是「没有这个事实」，调用方**不许**把它塞进带占位符的模板 ——
 *   t() 缺参会留下字面占位符，那是一条坏文案。
 *
 * @returns {string} 入口页绝对网址；拿不到则空串。
 */
export function installEntryUrl() {
  if (typeof location === 'undefined' || !location) return '';
  const origin = typeof location.origin === 'string' ? location.origin : '';
  if (!origin || origin === 'null') return '';
  return `${origin}/index.html`;
}

/**
 * 把一段文本写进剪贴板。
 *
 * ★失败一律返回 **false**（不是抛）：`navigator.clipboard` 在非安全上下文、file://、
 *   老浏览器里根本不存在，那是**正常环境**不是错误。返回 false 是为了让调用方有机会
 *   说一句「这个浏览器不允许网页复制，请长按手动选」—— 本模块零文案，那句话由
 *   调用方（settings.js）走 t() 说。
 *   ★做不到就说做不到，这是本模块第一条纪律的同一面：宁可不给按钮，也不给一个
 *     点了没反应（或偷偷失败）的按钮。
 *
 * @param {string} text 要复制的文本；非字符串或空串直接 false（没东西可复制）。
 * @returns {Promise<boolean>} 是否复制成功；**永不 reject、永不抛**。
 */
export async function copyText(text) {
  if (typeof text !== 'string' || text === '') return false;

  const nav = _nav();
  const clip = nav && nav.clipboard ? nav.clipboard : null;
  if (!clip || typeof clip.writeText !== 'function') return false;

  try {
    await clip.writeText(text);
    return true;
  } catch (err) {
    // 权限被拒、文档没聚焦、浏览器实现抛错 —— 都是「复制没成」这一件事
    return false;
  }
}
