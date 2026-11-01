/**
 * 「添加到桌面 / 主屏幕」安装状态机（src/ui/install.js）的行为测试。
 *
 * 为什么单独一个文件：这里要钉的是**「没有状态」时必须如实说没有** —— 这类错误
 * 全是「不报错、只是界面骗人」的类型，靠肉眼在真机上根本发现不了：
 *   1) iOS Safari **永远不触发** `beforeinstallprompt`。没捕获到事件却显示一个按钮，
 *      用户点了没反应 —— 这比不显示按钮坏得多（显示＝承诺）。
 *   2) 没检测到 standalone 就说「已安装」，同样是把推测当成事实。
 *   3) 事件对象只能用一次：prompt() 之后必须清掉，否则按钮留着就是个死按钮。
 *   4) 异常不许冒出去：浏览器在连点等情况下会抛，页面不能白屏。
 *
 * 环境：复用 tests/harness.mjs 的假 navigator；window 由本文件自己装（harness 没有
 * 提供 —— 真浏览器里 window 上挂着 addEventListener / matchMedia，本模块只用它俩）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installNavigator } from './harness.mjs';

installNavigator({ online: true });

/** 假 window：只提供 addEventListener / matchMedia，外加测试用的 fire()。 */
const fakeWindow = {
  listeners: new Map(),
  standaloneMatches: false,
  matchMediaCalls: [],
  addEventListener(type, fn) {
    const k = String(type);
    if (!this.listeners.has(k)) this.listeners.set(k, []);
    this.listeners.get(k).push(fn);
  },
  removeEventListener() {},
  matchMedia(query) {
    this.matchMediaCalls.push(String(query));
    return { matches: this.standaloneMatches };
  },
  /** 触发某个 window 事件（测试驱动）。 */
  fire(type, ev = {}) {
    (this.listeners.get(String(type)) || []).slice().forEach((fn) => fn(ev));
  },
};
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true });

/** 每次取一份**全新**的模块实例：_deferred 是模块级状态，不换实例就互相污染。 */
let seq = 0;

/**
 * 加载一份全新的 install.js（靠查询串绕开 ESM 模块缓存）。
 *
 * @returns {Promise<Object>} 模块。
 */
function freshModule() {
  seq += 1;
  return import(`../src/ui/install.js?case=${seq}`);
}

/**
 * 造一个假 `beforeinstallprompt` 事件对象。
 *
 * @param {{outcome?:string, rejectChoice?:boolean, throwPrompt?:boolean}} [opts] 行为编排。
 * @returns {Object} 事件对象。
 */
function makePromptEvent(opts = {}) {
  const spec = opts || {};
  return {
    prevented: 0,
    promptCalls: 0,
    preventDefault() {
      this.prevented += 1;
    },
    prompt() {
      this.promptCalls += 1;
      if (spec.throwPrompt) throw new Error('prompt() called twice');
    },
    get userChoice() {
      if (spec.rejectChoice) return Promise.reject(new Error('userChoice exploded'));
      return Promise.resolve({ outcome: spec.outcome || 'accepted' });
    },
  };
}

/**
 * 复位环境：清掉监听、回到「没有 standalone 信号」、navigator 恢复成 harness 那份默认。
 *
 * ★UA 注入一律**改属性、不换全局对象** —— 整体替换 globalThis.navigator 会让 harness
 *   里其它替身（含 installNavigator 装上的那个对象）失去同一性，而且 restored 顺序一乱
 *   就污染后面的用例；这里只动 userAgent / maxTouchPoints 两个字段。
 *
 * @returns {void}
 */
function resetEnv() {
  fakeWindow.listeners = new Map();
  fakeWindow.standaloneMatches = false;
  fakeWindow.matchMediaCalls = [];
  globalThis.navigator.standalone = undefined;
  globalThis.navigator.userAgent = 'Mozilla/5.0 (QA-FakeBrowser)';
  delete globalThis.navigator.maxTouchPoints;
}

/**
 * 装一段 UA（可选连 maxTouchPoints 一起），返回一个还原函数。
 *
 * @param {string} ua userAgent。
 * @param {number|undefined} touch maxTouchPoints；不传表示「设备没有这个属性」。
 * @returns {() => void} 还原函数。
 */
function withUa(ua, touch) {
  const nav = globalThis.navigator;
  const savedUa = nav.userAgent;
  const savedTouch = nav.maxTouchPoints;
  const hadTouch = Object.prototype.hasOwnProperty.call(nav, 'maxTouchPoints');

  nav.userAgent = ua;
  if (touch === undefined) delete nav.maxTouchPoints;
  else nav.maxTouchPoints = touch;

  return () => {
    nav.userAgent = savedUa;
    if (hadTouch) nav.maxTouchPoints = savedTouch;
    else delete nav.maxTouchPoints;
  };
}

beforeEach(resetEnv);

test('没捕获到 beforeinstallprompt → canPrompt() 为 false（不许给按钮）', async () => {
  const { initInstallPrompt, canPrompt } = await freshModule();
  initInstallPrompt(() => {});

  assert.equal(canPrompt(), false, '没有事件对象就是不能弹 —— 显示按钮等于承诺一个点了没反应的动作');
});

test('捕获到事件 → canPrompt() 为 true，且事件被 preventDefault() 拦下', async () => {
  const { initInstallPrompt, canPrompt } = await freshModule();
  initInstallPrompt(() => {});

  const ev = makePromptEvent();
  fakeWindow.fire('beforeinstallprompt', ev);

  assert.equal(canPrompt(), true, '真捕获到事件对象才能说能弹');
  assert.equal(ev.prevented, 1, '★必须先 preventDefault()，否则浏览器自己弹迷你条、事件对象随之失效');
});

test('捕获到事件 → onChange 被调用（界面要重画，按钮此刻才该出现）', async () => {
  const { initInstallPrompt } = await freshModule();
  let calls = 0;
  initInstallPrompt(() => {
    calls += 1;
  });

  fakeWindow.fire('beforeinstallprompt', makePromptEvent());
  assert.equal(calls, 1, '状态变了必须回调，否则界面永远停在「手动步骤」那一档');
});

test('★onChange 不是函数 → 不抛（回调取不到不许退化成静默断线以外的崩溃）', async () => {
  const { initInstallPrompt } = await freshModule();
  initInstallPrompt(undefined);

  assert.doesNotThrow(() => fakeWindow.fire('beforeinstallprompt', makePromptEvent()));
  assert.doesNotThrow(() => fakeWindow.fire('appinstalled', {}));
});

test('appinstalled → 事件对象被清掉，canPrompt() 回到 false，且 onChange 被调用', async () => {
  const { initInstallPrompt, canPrompt } = await freshModule();
  let calls = 0;
  initInstallPrompt(() => {
    calls += 1;
  });

  fakeWindow.fire('beforeinstallprompt', makePromptEvent());
  assert.equal(canPrompt(), true, '前置：此刻能弹');

  fakeWindow.fire('appinstalled', {});
  assert.equal(canPrompt(), false, '装完了就不该再留着那个一次性事件对象');
  assert.equal(calls, 2, '装完也要回调（卡片该从「有条可点」变成「已经装好了」）');
});

test('promptInstall() 之前没事件对象 → outcome 为 unavailable，且不抛', async () => {
  const { initInstallPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});

  const res = await promptInstall();
  assert.equal(res.outcome, 'unavailable', 'iOS / 事件还没到时只许如实说不可用');
});

test('用户接受 → outcome 为 accepted', async () => {
  const { initInstallPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});
  const ev = makePromptEvent({ outcome: 'accepted' });
  fakeWindow.fire('beforeinstallprompt', ev);

  const res = await promptInstall();
  assert.equal(res.outcome, 'accepted', '用户的选择必须原样带回来');
  assert.equal(ev.promptCalls, 1, '确实弹了一次');
});

test('用户取消 → outcome 为 dismissed', async () => {
  const { initInstallPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});
  fakeWindow.fire('beforeinstallprompt', makePromptEvent({ outcome: 'dismissed' }));

  const res = await promptInstall();
  assert.equal(res.outcome, 'dismissed', '取消了就必须说取消了，不许说成 accepted');
});

test('★userChoice 抛错 → outcome 为 failed 且不崩（异常不许冒出去白屏）', async () => {
  const { initInstallPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});
  fakeWindow.fire('beforeinstallprompt', makePromptEvent({ rejectChoice: true }));

  // 若 promptInstall() 真的 reject，这一行 await 就会把用例打红 —— 这就是「不许崩」的断言
  const res = await promptInstall();
  assert.equal(res.outcome, 'failed');
  assert.ok(res.error, 'failed 必须带上原始错误，便于排查');
});

test('★prompt() 自己抛 → outcome 为 failed 且不崩（连点第二次就是这种）', async () => {
  const { initInstallPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});
  fakeWindow.fire('beforeinstallprompt', makePromptEvent({ throwPrompt: true }));

  const res = await promptInstall();
  assert.equal(res.outcome, 'failed');
});

test('★事件对象只能用一次：prompt 之后 canPrompt() 必为 false，再 prompt 得 unavailable', async () => {
  const { initInstallPrompt, canPrompt, promptInstall } = await freshModule();
  initInstallPrompt(() => {});
  const ev = makePromptEvent({ outcome: 'dismissed' });
  fakeWindow.fire('beforeinstallprompt', ev);

  await promptInstall();
  assert.equal(canPrompt(), false, '事件对象已消耗 → 按钮必须消失，不能留个死按钮');

  const again = await promptInstall();
  assert.equal(again.outcome, 'unavailable', '第二次不许再去碰那个一次性对象');
  assert.equal(ev.promptCalls, 1, 'prompt() 全程只被调用过一次');
});

test('isInstalled()：display-mode 匹配 → true', async () => {
  const { isInstalled } = await freshModule();
  fakeWindow.standaloneMatches = true;

  assert.equal(isInstalled(), true);
  assert.deepEqual(fakeWindow.matchMediaCalls, ['(display-mode: standalone)']);
});

test('isInstalled()：navigator.standalone（iOS 私有字段）→ true', async () => {
  const { isInstalled } = await freshModule();
  globalThis.navigator.standalone = true;

  assert.equal(isInstalled(), true, 'iOS 只给 navigator.standalone，这条信号必须认');
});

test('★isInstalled()：两个信号都没有 → false（没信号就是没信号，不许猜）', async () => {
  const { isInstalled } = await freshModule();
  fakeWindow.standaloneMatches = false;
  globalThis.navigator.standalone = undefined;

  assert.equal(isInstalled(), false, '不许把「没检测出来」当成「已安装」');
});

test('isInstalled()：navigator.standalone 为 false → 不认（严格判 true）', async () => {
  const { isInstalled } = await freshModule();
  globalThis.navigator.standalone = false;

  assert.equal(isInstalled(), false, '只有显式 true 才算装好，其它值一律不算');
});

test('isInstalled()：matchMedia 抛（老浏览器不认这个查询）→ 不崩，继续问 navigator', async () => {
  const { isInstalled } = await freshModule();
  const savedMatchMedia = fakeWindow.matchMedia;
  fakeWindow.matchMedia = () => {
    throw new Error('unsupported media query');
  };

  try {
    let out = null;
    assert.doesNotThrow(() => {
      out = isInstalled();
    }, '媒体查询不支持只是「这条信号拿不到」，不是错误');
    assert.equal(out, false);
  } finally {
    fakeWindow.matchMedia = savedMatchMedia;  // 别污染后面的用例
  }
});

test('★window 不存在（Node / SSR 侧）→ 全程不抛，状态一律「没有」', async () => {
  const saved = globalThis.window;
  Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true, writable: true });
  try {
    const { initInstallPrompt, isInstalled, canPrompt, promptInstall } = await freshModule();
    assert.doesNotThrow(() => initInstallPrompt(() => {}));
    assert.equal(isInstalled(), false, '没有 window 就没有任何信号 → false，不许猜');
    assert.equal(canPrompt(), false);
    const res = await promptInstall();
    assert.equal(res.outcome, 'unavailable');
  } finally {
    Object.defineProperty(globalThis, 'window', { value: saved, configurable: true, writable: true });
  }
});

/* ------------------------------------------------------------------ */
/* detectHostEnv()：宿主环境判定                                         */
/* ------------------------------------------------------------------ */
/*
 * ★这些 UA 是**按各家的公开格式拼出来的样本**，不是从真机抓的包 —— 本文件要钉的是
 *   「给定一段 UA，检出哪一档」这个**映射关系**，而不是某台设备当时的 UA 原文。
 *   判据本身的可靠程度见 install.js 的 detectHostEnv() JSDoc：微信那条有真机行为佐证，
 *   QQ 那条**只有 UA 约定、没实测过**，这里钉的是「照约定」，不代表验证过约定成立。
 */

/** 微信 iPhone（含 MicroMessenger，且 UA 里同样带 iPhone）。 */
const UA_WECHAT_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.40(0x18002832) NetType/WIFI Language/zh_CN';

/** 微信安卓（含 MicroMessenger，且 UA 里同样带 Android）。 */
const UA_WECHAT_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-S9080 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/537.36 MicroMessenger/8.0.40.2420(0x28002851) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';

/** QQ 内置 WebView：带 ` QQ/`（前导空格）且同时带 MQQBrowser。 */
const UA_QQ_INAPP =
  'Mozilla/5.0 (Linux; Android 12; V2154A Build/SP1A.210812.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046240 Mobile Safari/537.36 V1_AND_SQ_8.9.63_4662_YYB_D QQ/8.9.63.12110 NetType/WIFI WebP/0.3.0 Pixel/1080 StatusBarHeight/44 QQTheme/1000';

/** QQ 浏览器（不是内置 WebView）：只有 MQQBrowser，没有 ` QQ/`。 */
const UA_QQ_BROWSER =
  'Mozilla/5.0 (Linux; Android 12; V2154A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 MQQBrowser/13.5 Mobile Safari/537.36';

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const UA_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** iPadOS 13+「请求桌面网站」时的 UA：伪装成 Macintosh，只有 maxTouchPoints 能把它认出来。 */
const UA_IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

const UA_DESKTOP_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

test('detectHostEnv：微信内置（iPhone）→ wechat（容器优先于系统）', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_WECHAT_IPHONE);
  try {
    assert.equal(detectHostEnv(), 'wechat', 'UA 里同时有 iPhone 与 MicroMessenger，必须先判容器');
  } finally {
    restore();
  }
});

test('detectHostEnv：微信内置（安卓）→ wechat', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_WECHAT_ANDROID);
  try {
    assert.equal(detectHostEnv(), 'wechat');
  } finally {
    restore();
  }
});

test('detectHostEnv：QQ 内置 WebView（UA 含 ` QQ/`）→ qq', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_QQ_INAPP);
  try {
    assert.equal(detectHostEnv(), 'qq', '★判据是按 UA 约定的，未在真机上验证过');
  } finally {
    restore();
  }
});

test('detectHostEnv：QQ 浏览器（只有 MQQBrowser、没有 ` QQ/`）→ android，不许误判成 qq', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_QQ_BROWSER);
  try {
    assert.equal(detectHostEnv(), 'android', 'QQ 浏览器是**能装**的浏览器，判成 qq 会把用户引向一条错的路');
  } finally {
    restore();
  }
});

test('detectHostEnv：iPhone → ios', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_IPHONE);
  try {
    assert.equal(detectHostEnv(), 'ios');
  } finally {
    restore();
  }
});

test('detectHostEnv：iPad → ios', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_IPAD);
  try {
    assert.equal(detectHostEnv(), 'ios');
  } finally {
    restore();
  }
});

test('★detectHostEnv：iPadOS 伪装成 Macintosh + maxTouchPoints 2 → ios', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_IPAD_DESKTOP, 2);
  try {
    assert.equal(detectHostEnv(), 'ios', 'iPad 请求桌面网站时 UA 里没有 iPad —— 漏了这条就等于漏掉所有 iPad');
  } finally {
    restore();
  }
});

test('★detectHostEnv：真 Mac（Macintosh + maxTouchPoints 0）→ unknown，不许判成 ios', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_DESKTOP_MAC, 0);
  try {
    assert.equal(detectHostEnv(), 'unknown', '桌面 Mac 也带 Macintosh，只有「多点触控」能把 iPad 与它分开');
  } finally {
    restore();
  }
});

test('detectHostEnv：Macintosh 但设备没有 maxTouchPoints 属性 → unknown', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_DESKTOP_MAC, undefined);
  try {
    assert.equal(detectHostEnv(), 'unknown', '★属性缺失不是 0：不许把「没这个属性」当成有效点数参与比较');
  } finally {
    restore();
  }
});

test('detectHostEnv：安卓 Chrome → android', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa(UA_ANDROID);
  try {
    assert.equal(detectHostEnv(), 'android');
  } finally {
    restore();
  }
});

test('detectHostEnv：空 UA → unknown', async () => {
  const { detectHostEnv } = await freshModule();
  const restore = withUa('');
  try {
    assert.equal(detectHostEnv(), 'unknown', '拿不到 UA 就是不知道，不许猜');
  } finally {
    restore();
  }
});

test('detectHostEnv：userAgent 不是字符串 → unknown 且不抛', async () => {
  const { detectHostEnv } = await freshModule();
  const nav = globalThis.navigator;
  const saved = nav.userAgent;
  nav.userAgent = null;
  try {
    let out = null;
    assert.doesNotThrow(() => {
      out = detectHostEnv();
    }, 'UA 形态异常只当「这条信号拿不到」');
    assert.equal(out, 'unknown');
  } finally {
    nav.userAgent = saved;
  }
});

/* ------------------------------------------------------------------ */
/* pickInstallMode()：该显示哪一档（事实压推断）                          */
/* ------------------------------------------------------------------ */
/*
 * 为什么这一组必须有：三年前那条纪律「没捕获到 beforeinstallprompt 就不许显示按钮」，
 *   落到七档分环境之后就变成了**两条顺序**（installed 压 canPrompt、canPrompt 压环境档）。
 *   顺序只活在渲染函数里是测不到的 —— 本组钉的就是这两条顺序，以及「缺字段走保守档」。
 */

test('★pickInstallMode：{canPrompt:true, env:wechat} → prompt（事件对象优先于容器提示）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(
    pickInstallMode({ installed: false, canPrompt: true, env: 'wechat' }),
    'prompt',
    '★环境档是 UA 推断、手里的事件对象是事实 —— 事实压推断：这个浏览器真能装，就不许说装不了'
  );
});

test('★pickInstallMode：{installed:true, canPrompt:true} → installed（已装不许再给按钮）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(
    pickInstallMode({ installed: true, canPrompt: true, env: 'android' }),
    'installed',
    '一次性动作：装完就该安静，不许再摆一个按钮'
  );
});

test('★pickInstallMode：{installed:true, canPrompt:false, env:wechat} → installed（已装压一切）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ installed: true, canPrompt: false, env: 'wechat' }), 'installed');
});

test('pickInstallMode：wechat（没装、不能弹）→ blocked-wechat', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ installed: false, canPrompt: false, env: 'wechat' }), 'blocked-wechat');
});

test('pickInstallMode：qq → blocked-qq', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ canPrompt: false, env: 'qq' }), 'blocked-qq');
});

test('pickInstallMode：ios → manual-ios', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ canPrompt: false, env: 'ios' }), 'manual-ios');
});

test('pickInstallMode：android → manual-android', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ canPrompt: false, env: 'android' }), 'manual-android');
});

test('pickInstallMode：env unknown → manual-other', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode({ canPrompt: false, env: 'unknown' }), 'manual-other');
});

test('pickInstallMode：env 是从没见过的字符串 → manual-other（不许抛，也不许跟丢默认值混淆）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(
    pickInstallMode({ canPrompt: false, env: 'harmonyos' }),
    'manual-other',
    '新增一个没识别的环境时，必须退化到「两条路都摆出来」那一档，而不是空白'
  );
});

test('★pickInstallMode：空对象 {} → manual-other 且不抛', async () => {
  const { pickInstallMode } = await freshModule();

  let out = null;
  assert.doesNotThrow(() => {
    out = pickInstallMode({});
  });
  assert.equal(out, 'manual-other', '缺字段一律走保守档：没装、不能弹、环境不认识');
});

test('★pickInstallMode：入参 undefined → manual-other 且不抛', async () => {
  const { pickInstallMode } = await freshModule();

  let out = null;
  assert.doesNotThrow(() => {
    out = pickInstallMode(undefined);
  });
  assert.equal(out, 'manual-other');
});

test('pickInstallMode：入参不是对象（字符串 / null）→ manual-other 且不抛', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(pickInstallMode('wechat'), 'manual-other', '字符串入参不许被当成 { env }');
  assert.equal(pickInstallMode(null), 'manual-other');
});

test('★pickInstallMode：installed 用 === true 判等（false / undefined / "true" 都不算已装）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(
    pickInstallMode({ installed: undefined, canPrompt: false, env: 'ios' }),
    'manual-ios',
    'installed 没给就当没装'
  );
  assert.equal(
    pickInstallMode({ installed: 'true', canPrompt: false, env: 'ios' }),
    'manual-ios',
    '★字符串 "true" 不许被 truthy 吃进来'
  );
});

test('★pickInstallMode：canPrompt 用 === true 判等（false / "true" 都不算能弹）', async () => {
  const { pickInstallMode } = await freshModule();

  assert.equal(
    pickInstallMode({ installed: false, canPrompt: 'true', env: 'wechat' }),
    'blocked-wechat',
    '★truthy 判等会把 "true" 当成有事件对象 → 在微信里显示一个点了没反应的按钮'
  );
  assert.equal(
    pickInstallMode({ installed: false, canPrompt: undefined, env: 'qq' }),
    'blocked-qq',
    'canPrompt 没给就当不能弹'
  );
});

test('★detectHostEnv：navigator 不存在（Node / SSR 侧）→ unknown 且不抛', async () => {
  const { detectHostEnv } = await freshModule();
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true, writable: true });
  try {
    let out = null;
    assert.doesNotThrow(() => {
      out = detectHostEnv();
    });
    assert.equal(out, 'unknown');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true });
  }
});
