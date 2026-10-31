/**
 * 壳更新提示条（src/ui/shellupdate.js）的行为测试。
 *
 * 为什么单独一个文件：这条提示条要钉的是**判定与时机**，而这两样都是「错了不报错」的
 * 类型 ——
 *   1) 只有 reg.waiting 存在才提示。installing 中的壳还没装完，这时候说「有新版本」
 *      是假话；无条件提示则会在每次访问都闪一条，用户很快就学会无视它。
 *   2) 必须**立刻**判定一次。2026-10-31 那次事故的实际情形就是「壳是几天前装好的，
 *      用户今天才打开页面」—— 只监听 updatefound 抓不到存量 waiting，因为
 *      updatefound 只在「本次会话内新装出一个壳」时才触发。
 *   3) **绝不自动 reload**。用户可能正在输入搜索词。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 navigator（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });

const dom = createFakeDom([{ id: 'app' }]);
const { t } = await import('../src/i18n/index.js');

/** location.reload() 的调用计数（本文件全套用例的唯一权威来源）。 */
let reloadCalls = 0;

// 假 location：只提供 reload()。真浏览器里 location 上还有一大堆成员，本模块只用它。
globalThis.location = {
  reload() {
    reloadCalls += 1;
  },
};

/** 每次取一份**全新**的模块实例：_watched 是模块级标志，不换实例就只能测一次。 */
let seq = 0;

/**
 * 加载一份全新的 shellupdate.js（靠查询串绕开 ESM 模块缓存）。
 *
 * @returns {Promise<{watchShellUpdate:Function}>} 模块。
 */
function freshModule() {
  seq += 1;
  return import(`../src/ui/shellupdate.js?case=${seq}`);
}

/**
 * 造一个假的 ServiceWorkerRegistration。
 *
 * @param {{waiting?:Object|null, installing?:Object|null}} opts 各阶段持有的 SW。
 * @returns {Object} 假注册对象。
 */
function makeReg(opts = {}) {
  const listeners = new Map();
  return {
    waiting: opts.waiting === undefined ? null : opts.waiting,
    installing: opts.installing === undefined ? null : opts.installing,
    updateCalls: 0,
    async update() {
      this.updateCalls += 1;
    },
    addEventListener(type, fn) {
      const k = String(type);
      if (!listeners.has(k)) listeners.set(k, []);
      listeners.get(k).push(fn);
    },
    removeEventListener() {},
    /** 触发某个事件的监听（测试驱动）。 */
    fire(type) {
      (listeners.get(String(type)) || []).slice().forEach((fn) => fn({}));
    },
  };
}

/**
 * 装上假的 navigator.serviceWorker。
 *
 * @param {Object|null} reg getRegistration() 的返回值；null 表示「压根没注册」。
 * @returns {Object} 装好的容器（含 getRegistrationCalls）。
 */
function installSw(reg) {
  const container = {
    controller: null,
    getRegistrationCalls: 0,
    async getRegistration() {
      this.getRegistrationCalls += 1;
      return reg;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.navigator.serviceWorker = container;
  return container;
}

/** 拆掉假的 serviceWorker（回到「本环境没有 SW」）。 */
function uninstallSw() {
  globalThis.navigator.serviceWorker = null;
}

/**
 * 取 body 里所有 #shell-update-note 节点。
 *
 * @returns {Array} 节点列表。
 */
function notes() {
  return dom.body.descendants().filter((n) => n.getAttribute('id') === 'shell-update-note');
}

beforeEach(() => {
  reloadCalls = 0;
  uninstallSw();
  // 复位 body：只留预置的 #app（提示条是被插到 body 最前面的，必须能看见它）
  dom.body.children = [dom.byId.app];
  dom.byId.app.parentNode = dom.body;
  dom.byId.app.textContent = '';
});

test('reg.waiting 存在 → 出现提示条，文案是 shell.updateReady，且带刷新按钮', async () => {
  const reg = makeReg({ waiting: { postMessage() {} } });
  installSw(reg);
  const { watchShellUpdate } = await freshModule();

  await watchShellUpdate();

  const found = notes();
  assert.equal(found.length, 1, '新壳已 waiting 时必须出现提示条');
  assert.ok(
    found[0].textContent.indexOf(t('shell.updateReady')) !== -1,
    `文案必须含「${t('shell.updateReady')}」，实际：${JSON.stringify(found[0].textContent)}`
  );
  const btn = found[0].querySelector('.btn');
  assert.ok(btn, '提示条上必须有刷新按钮');
  assert.equal(btn.textContent, t('shell.reloadBtn'));
  assert.equal(btn.getAttribute('type'), 'button', '必须显式 type="button"（否则会提交表单）');
  assert.equal(reg.updateCalls, 1, '应当主动催一次 reg.update()');
});

test('提示条插在 <body> 最前面（写死任一页面 id 都会在另一个页面失效）', async () => {
  installSw(makeReg({ waiting: { postMessage() {} } }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  assert.equal(dom.body.firstElementChild.getAttribute('id'), 'shell-update-note');
});

test('只有 installing（还没装完）→ 不出现提示条', async () => {
  installSw(makeReg({ installing: { state: 'installing', addEventListener() {} } }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  assert.equal(notes().length, 0, 'installing 中的壳还没就绪，不许说「有新版本」');
});

test('只有 active（没有 waiting）→ 不出现提示条', async () => {
  installSw(makeReg({ waiting: null, installing: null }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  assert.equal(notes().length, 0, '没有等待接管的新壳就不该提示');
});

test('reg 为 null（压根没注册 SW）→ 不出现、不抛', async () => {
  installSw(null);
  const { watchShellUpdate } = await freshModule();
  await assert.doesNotReject(watchShellUpdate());
  assert.equal(notes().length, 0);
});

test('navigator.serviceWorker 不存在 → 不出现、不抛（file:// / 非安全上下文）', async () => {
  uninstallSw();
  const { watchShellUpdate } = await freshModule();
  await assert.doesNotReject(watchShellUpdate());
  assert.equal(notes().length, 0, '那种环境连问都没处问，不该有任何提示');
});

test('幂等：连续调用两次 → 只有一个提示条节点', async () => {
  installSw(makeReg({ waiting: { postMessage() {} } }));
  const { watchShellUpdate } = await freshModule();

  await watchShellUpdate();
  await watchShellUpdate();

  assert.equal(notes().length, 1, `只应有一条提示条，实际 ${notes().length} 条`);
});

test('幂等：新壳反复 activate 触发多次 check() → 仍然只有一条', async () => {
  const reg = makeReg({ waiting: { postMessage() {} } });
  installSw(reg);
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  // 「我的」页点「检查更新」→ 新壳 activate → updatefound → statechange → check()
  // 这条链路会跑多次，提示条只能有一条。
  reg.fire('updatefound');
  reg.fire('updatefound');

  assert.equal(notes().length, 1, `只应有一条提示条，实际 ${notes().length} 条`);
});

test('★不自动刷新：点按钮之前 location.reload() 一次都没被调用过', async () => {
  installSw(makeReg({ waiting: { postMessage() {} } }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  assert.equal(notes().length, 1, '前置：提示条已出现');
  assert.equal(reloadCalls, 0, '探测到新壳绝不许自动刷新 —— 会把正在输入的搜索词冲掉');
});

test('点了「立即刷新」才刷一次', async () => {
  installSw(makeReg({ waiting: { postMessage() {} } }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  const btn = notes()[0].querySelector('.btn');
  btn.click();
  assert.equal(reloadCalls, 1, '点一次按钮应恰好刷一次');
  btn.click();
  assert.equal(reloadCalls, 2);
});

test('★存量 waiting 必须被「立刻 check()」抓到（只监听 updatefound 抓不到）', async () => {
  // 场景：壳是**几天前**就装好并进 waiting 的，用户今天才打开页面。
  // 此时本次会话内不会有任何 updatefound 事件 —— 只有「进来就判定一次」才抓得到。
  const reg = makeReg({ waiting: { postMessage() {} } });
  installSw(reg);
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  assert.equal(reg.updateCalls, 1, '确实催过一次 update()');
  assert.equal(notes().length, 1, '存量 waiting 必须被抓到（这是 2026-10-31 事故的实际情形）');
});

test('★提示条复用现成 .banner（不许自建 CSS 类，否则要新增 color: 声明）', async () => {
  installSw(makeReg({ waiting: { postMessage() {} } }));
  const { watchShellUpdate } = await freshModule();
  await watchShellUpdate();

  const note = notes()[0];
  assert.equal(note.className, 'banner', '必须复用现成的 .banner（自带 color: var(--c-text-2)）');
});
