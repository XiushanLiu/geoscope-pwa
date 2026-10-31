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
 * 复位环境：清掉监听、回到「没有 standalone 信号」、navigator 不带 standalone。
 *
 * @returns {void}
 */
function resetEnv() {
  fakeWindow.listeners = new Map();
  fakeWindow.standaloneMatches = false;
  fakeWindow.matchMediaCalls = [];
  globalThis.navigator.standalone = undefined;
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
