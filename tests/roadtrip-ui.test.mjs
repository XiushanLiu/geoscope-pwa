/**
 * 自驾相关 UI 的交互回归（roadtrip.html 外壳 + 「我的」页自驾两卡）
 *
 * 为什么单独一个文件：`tests/roadtrip-model.test.mjs` 测的是 trip 这条纯数据模型，
 * `tests/roadtrip-plan.test.mjs` 测的是切段算法，两者都不碰 DOM。而 T03 真正落地的是
 * **界面** —— 那三处最容易烂、又最没人管的地方全在这层：
 *
 *   1) **空态不许发请求**。roadtrip.js 的文件头写着「这一版不发任何请求」，但那只是一句
 *      注释；只要哪天有人在 init() 里顺手预热一下路线，这句话就成了假话，而且**没有任何
 *      测试会红**。这里用真实的 fetch 计数器把它钉住。
 *   2) **返回入口必须是 `<a href>`**。本仓没有 SPA 路由，页面之间一律真链接 —— 离线时
 *      SW 能直接命中预缓存页面；换成按钮 + JS 跳转，离线就断了。
 *   3) **Key 卡的掩码与「失败看得见」**。密钥明文一旦出现在「当前值」里，就是把它摆在
 *      一块可能被截图 / 投屏的屏幕上；而保存失败若静默当成功，用户会以为自己填好了。
 *      这两条都是**隐私红线**，不能只靠 code review 记着。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage + 可控 fetch（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installNavigator, installStorage, installFetch, FakeStorage } from './harness.mjs';

// store.js / cache.js 在**模块加载期**就决定走内存还是 localStorage，必须先装全局。
installStorage(new FakeStorage());
installNavigator({ online: true });
const net = installFetch();

// ★为什么这批 id 要预置：`_bindControls()` 是用 `document.getElementById()` 取节点的，
//   而假 DOM 的索引表只认 createFakeDom() 预置的那批（同 tests/csv-card.test.mjs）。
//   `#key-current` 是例外：它只被 `_refreshKeyState()` 写，走的是渲染时新建的那个引用，
//   所以要到 #app 子树里找（见下面的 currentText()）。
const dom = createFakeDom([
  { id: 'app' },
  { id: 'theme-mode' },
  { id: 'font-scale' },
  { id: 'font-result' },
  { id: 'csv-result' },
  { id: 'export-current' },
  { id: 'export-privacy' },
  { id: 'input-amap-key' },
  { id: 'btn-key-save' },
  { id: 'btn-key-clear' },
  { id: 'btn-key-check' },
  { id: 'key-result' },
]);

/** 必须在 import 被测模块之前装好全局（理由同上）。 */
const { getAmapKey, hasAmapKey, clearAmapKey, KEY_MAX_LEN } = await import('../src/core/apikeys.js');
const { init: initRoadtrip } = await import('../src/ui/roadtrip.js');
const { init: initSettings } = await import('../src/ui/settings.js');
const { t } = await import('../src/i18n/index.js');

/** 一份合法（非空、无空格、不超长）的高德 Key 形状。 */
const GOOD_KEY = 'abcdefgh12345678';

/**
 * 从 #app 子树里按 id 找节点（渲染期新建的节点不在预置索引表里）。
 *
 * @param {string} id 目标 id。
 * @returns {Object|null} 节点或 null。
 */
function appNode(id) {
  const hits = dom.byId.app.descendants().filter((n) => n.getAttribute('id') === id);
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * #app 里的全部纯文本。
 *
 * @returns {string} 文本。
 */
function appText() {
  return dom.byId.app.textContent;
}

/**
 * Key 卡「当前值」的文本（渲染期新建的那个节点）。
 *
 * @returns {string} 文本。
 */
function currentText() {
  const n = appNode('key-current');
  return n ? n.textContent : '';
}

/**
 * Key 卡操作结果提示的文本（`_setStatus` 走 getElementById，命中的是预置节点）。
 *
 * @returns {string} 文本。
 */
function resultText() {
  return dom.byId['key-result'].textContent;
}

/**
 * 重画设置页。
 *
 * ★为什么不能直接调 initSettings()：真浏览器里 init() 一页只跑一次，`_bindControls()`
 *   装完监听就完事；而假 DOM 的预置节点**不会随重画换新**（getElementById 一直返回同一批），
 *   反复 init() 会让监听**累加** —— 点一次「保存」实际跑 N 遍 _onKeySave，第二遍起输入框
 *   已被上一遍清空，结果提示被改写成「没存进去」。这是测试台的形状，不是产品缺陷，
 *   所以在测试侧把旧监听摘掉，让每个用例都等价于「一次全新的页面加载」。
 *
 * @returns {void}
 */
function renderSettings() {
  for (const id of Object.keys(dom.byId)) {
    const n = dom.byId[id];
    if (n && n.listeners) n.listeners.clear();
  }
  initSettings();
}

beforeEach(() => {
  // 每个用例都从「没填 Key」开始：apikeys 是持久化的，不清会串味。
  if (hasAmapKey()) clearAmapKey();
  dom.byId['key-result'].textContent = '';
  net.reset();
});

/* ------------------------------------------------------------------ */
/* roadtrip.html 外壳                                                   */
/* ------------------------------------------------------------------ */

test('自驾页：页头 / 规划 / 候选 / 存盘四块的文案一处都不能少', () => {
  // ★T04b 之后本页不再是「空态外壳」：原来断言的 rt.empty / rt.emptyHint 已被
  //   真实页面取代。四块各缺一块，用户就少一段「这里在干什么」的说明 ——
  //   这就是这条用例改名后仍然存在的理由。
  initRoadtrip();
  const txt = appText();
  for (const key of ['rt.title', 'rt.subtitle', 'rt.planTitle', 'rt.poiTitle', 'rt.saveTitle']) {
    assert.ok(
      txt.indexOf(t(key)) !== -1,
      `页面必须显示 ${key}（「${t(key)}」），实际页面文本：${txt}`
    );
  }
});

test('返回「我的」必须是 <a href="settings.html">：没有 SPA 路由，离线要靠 SW 命中预缓存', () => {
  initRoadtrip();
  // ★不再断言「整页只有一个链接」：T04b 之后候选区还会出现「去设置页填 Key」等链接。
  //   该守的是**返回入口本身**的形状，不是页面里链接的总数。
  const back = dom.byId.app
    .descendants()
    .filter((n) => n.tagName === 'A' && n.textContent === t('rt.back'));
  assert.equal(back.length, 1, `必须恰好有一条文案为「${t('rt.back')}」的入口`);
  assert.equal(back[0].getAttribute('href'), 'settings.html', '返回入口必须指向 settings.html');
  assert.equal(back[0].tagName, 'A', '必须是 <a>，不能是按钮 + JS 跳转');
});

test('自驾页不带底部 tabbar：第五个 tab 会撑破 320px（roadtrip.js 文件头有实测）', () => {
  initRoadtrip();
  assert.equal(
    dom.body.querySelectorAll('.tabbar').length,
    0,
    '本页不许出现 .tabbar —— 它的宽度是 shrink-to-fit，第五项必撑破'
  );
});

test('document.title 必须是「App 名 · 页名」：切标签页 / 加书签时才认得出是哪一页', () => {
  initRoadtrip();
  assert.equal(
    dom.document.title,
    `${t('app.name')} · ${t('rt.title')}`,
    '只写页名的话，浏览器标签页里认不出这是地候的哪一页'
  );
});

test('★init() 一次请求都不许发：求路 / 搜候选都必须等用户点了按钮', () => {
  // ★T04b 之后本页会发请求（求路 / 候选），但**只能**发生在用户点了按钮之后。
  //   init() 自己偷偷预热一次路线，用户会在不知情的情况下消耗流量与配额 ——
  //   这条改名后守的正是这一条，比原来「空态不发」那条更难被绕过。
  initRoadtrip();
  renderSettings();
  assert.equal(
    net.count,
    0,
    `init() 不许发请求，实际发了 ${net.count} 次：${JSON.stringify(net.calls)}`
  );
});

/* ------------------------------------------------------------------ */
/* 「我的」页自驾两卡                                                     */
/* ------------------------------------------------------------------ */

test('入口卡是一条 <a href="roadtrip.html">，不是按钮 + JS 跳转', () => {
  renderSettings();
  const links = dom.byId.app.descendants().filter((n) => n.getAttribute('href') === 'roadtrip.html');
  assert.equal(links.length, 1, '设置页必须有且只有一条进自驾的链接');
  assert.equal(links[0].tagName, 'A', '必须是 <a>，不能是按钮');
  assert.equal(links[0].textContent, t('rt.entryBtn'));
});

test('代价说明与隐私说明常驻：用户要在按下去 / 填进去之前就知道', () => {
  renderSettings();
  const txt = appText();
  assert.ok(
    txt.indexOf(t('rt.keyCheckHint')) !== -1,
    `「校验」的配额代价必须常驻在按钮下方（未点击就可见），实际：${txt.indexOf(t('rt.keyCheck')) !== -1}`
  );
  assert.ok(
    txt.indexOf(t('rt.keyStored')) !== -1,
    'Key 只存本机的说明必须常驻，不能点完才闪一下'
  );
});

test('没填 Key 时：当前值写「未填」，校验按钮是禁用的', () => {
  renderSettings();
  assert.equal(hasAmapKey(), false, '前置：本用例假定没填 Key');
  assert.equal(currentText(), t('rt.keyNone'), `当前值应写「${t('rt.keyNone')}」，实际：${currentText()}`);

  const check = appNode('btn-key-check');
  assert.ok(check, 'Key 卡必须有 #btn-key-check');
  assert.equal(check.hasAttribute('disabled'), true, '没 Key 时不许让人点出一个必然失败的请求');
});

test('保存合法 Key：只回显掩码、输入框清空、明文一次都不出现在界面上', () => {
  renderSettings();
  dom.byId['input-amap-key'].value = GOOD_KEY;
  dom.byId['btn-key-save'].click();

  assert.equal(hasAmapKey(), true, '合法 Key 必须存进去');
  assert.equal(getAmapKey(), GOOD_KEY);

  // ★隐私红线：整串回显等于把密钥摆在一块可能被截图 / 投屏的屏幕上。
  const shown = `${currentText()}${resultText()}${appText()}`;
  assert.ok(
    shown.indexOf(GOOD_KEY) === -1,
    `界面上不许出现 Key 明文，实际：${shown}`
  );
  // 掩码首尾各留 4 位 + 中间全星号（core/apikeys.js 的 maskKey）。
  const mask = `${GOOD_KEY.slice(0, 4)}${'*'.repeat(GOOD_KEY.length - 8)}${GOOD_KEY.slice(-4)}`;
  assert.ok(currentText().indexOf(mask) !== -1, `当前值应是掩码「${mask}」，实际：${currentText()}`);
  assert.equal(resultText(), t('rt.keySaved', { mask }), `结果提示应带掩码，实际：${resultText()}`);

  // 存进去之后把框清空：框里再留着明文，等于把刚藏起来的密钥又摊开一次。
  assert.equal(dom.byId['input-amap-key'].value, '', '保存后必须清空输入框');

  const check = appNode('btn-key-check');
  assert.equal(check.hasAttribute('disabled'), false, '有 Key 之后校验按钮要可点');
});

test('保存不合法（超长）：必须原样报出来，且真的没存进去', () => {
  renderSettings();
  dom.byId['input-amap-key'].value = 'a'.repeat(KEY_MAX_LEN + 1);
  dom.byId['btn-key-save'].click();

  assert.equal(hasAmapKey(), false, '不合法的 Key 不许写进存储');
  assert.equal(
    resultText(),
    t('rt.keyBad', { max: KEY_MAX_LEN }),
    `失败必须看得见（不许静默当成功），实际：${resultText()}`
  );
  assert.equal(currentText(), t('rt.keyNone'), '没存进去，当前值就不许显示成已填');
});

test('保存不合法（中间有空格）：同上，不许静默当成功', () => {
  renderSettings();
  dom.byId['input-amap-key'].value = 'abcd efgh1234';
  dom.byId['btn-key-save'].click();

  assert.equal(hasAmapKey(), false, '带空格的 Key 不许写进存储');
  assert.equal(resultText(), t('rt.keyBad', { max: KEY_MAX_LEN }));
});

test('清除：回到未填，校验按钮重新禁用', () => {
  renderSettings();
  dom.byId['input-amap-key'].value = GOOD_KEY;
  dom.byId['btn-key-save'].click();
  assert.equal(hasAmapKey(), true, '前置：先存一个进去');

  dom.byId['btn-key-clear'].click();
  assert.equal(hasAmapKey(), false, '清除后必须真的没了');
  assert.equal(resultText(), t('rt.keyCleared'), `应提示「${t('rt.keyCleared')}」，实际：${resultText()}`);
  assert.equal(currentText(), t('rt.keyNone'));

  const check = appNode('btn-key-check');
  assert.equal(check.hasAttribute('disabled'), true, 'Key 没了，校验按钮要重新禁用');
});

test('本来就没填时点清除：如实说「不用清」，不许报成已清除', () => {
  renderSettings();
  assert.equal(hasAmapKey(), false, '前置：本用例假定没填 Key');

  dom.byId['btn-key-clear'].click();
  assert.equal(
    resultText(),
    t('rt.keyClearFail'),
    `没 Key 时清除是空操作，提示必须是「${t('rt.keyClearFail')}」，实际：${resultText()}`
  );
});
