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
 *   4) **T04b 主流程的四条硬要求**（候选不落盘 / N×M 配额数 / 缺 Key 不锁死其余 /
 *      存盘失败可见）。这四条原先只活在一次性的临时探针里，等于没有 —— 这里把它们搬进
 *      仓库，用**真夹具**（`fixtures/osrm-cd-xian.json`）跑完整条
 *      「搜地点 → 求路 → 切段 → 搜候选 → 存盘」链路。只断言界面文本与开关 / 请求计数
 *      的断言，是「不加也绿」的假绿；要红就得真的走一遍。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage + 可控 fetch（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeDom, installNavigator, installStorage, installFetch, FakeStorage } from './harness.mjs';

/**
 * 行程键写盘开关（只在这一个用例里打开）。
 *
 * ★为什么用开关而不是另装一份 storage：cache.js 在**模块加载期**就决定走内存还是
 *   localStorage，之后换不掉。用开关才能在同一份存储上既测「存成功」又测「存失败」。
 */
let blockTripWrites = false;

// store.js / cache.js 在**模块加载期**就决定走内存还是 localStorage，必须先装全局。
const store = new FakeStorage({
  failOn: (k) => blockTripWrites && String(k).indexOf('trip') !== -1,
});
installStorage(store);
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
  // 规划主流程用到的控件：`_bindControls()` / `_onSave()` / `_onPlan()` 走
  // `document.getElementById()`，命中的是**预置**的这批（假 DOM 的索引表只认预置项）。
  { id: 'btn-plan' },
  { id: 'btn-via-add' },
  { id: 'btn-poi' },
  { id: 'btn-only-stay' },
  { id: 'btn-all-types' },
  { id: 'btn-save' },
  { id: 'in-trip-name' },
  { id: 'in-start-date' },
  { id: 'sel-daily' },
  { id: 'in-manual-name' },
  { id: 'sel-manual-type' },
  { id: 'place-results' },
  // 路线图 / 实录 / 搬家
  { id: 'btn-geo' },
  { id: 'btn-export' },
  { id: 'btn-import-apply' },
  { id: 'in-trip-file' },
]);

/** 必须在 import 被测模块之前装好全局（理由同上）。 */
const { getAmapKey, setAmapKey, hasAmapKey, clearAmapKey, KEY_MAX_LEN } = await import('../src/core/apikeys.js');
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
  // ★连 handler 一起清：主流程用例会给 fetch 装一个「按 URL 分发」的处理器，
  //   漏清会让 Key 卡的用例也拿到假路线 / 假候选。
  net.clearHandler();
  net.reset();
  blockTripWrites = false;
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

test('★自驾页带底部 tabbar，且恰好三个主导航 tab（此刻 / 自驾 / 我的）', () => {
  // ★直接读**静态 HTML**：tabbar 是写在 .html 里的静态结构，不是 JS 渲染出来的，
  //   所以「用假 DOM 查 body 里有没有 .tabbar」根本看不到它 ——
  //   本用例的前身「自驾页不带 tabbar」就是这么一直绿着的：它测的东西从一开始就缺位。
  const src = fs.readFileSync(new URL('../roadtrip.html', import.meta.url), 'utf8');
  const block = /<nav class="tabbar"[^>]*>([\s\S]*?)<\/nav>/.exec(src);
  assert.ok(block, 'roadtrip.html 必须含 <nav class="tabbar">');

  const hrefs = [...block[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    hrefs,
    ['index.html', 'roadtrip.html', 'settings.html'],
    '主导航三个 tab（此刻 / 自驾 / 我的）—— 2026-10-16 决策：自检与方位降为「我的」里的入口，' +
      '空出的位置让给自驾。四个 tab 时 320px 屏上内容宽 294px 已贴临界点（真机出过断行）'
  );
  assert.equal(
    (block[1].match(/class="tab tab--active"/g) || []).length,
    1,
    '本页自己是激活项'
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

/* ------------------------------------------------------------------ */
/* 规划主流程（T04b 四条硬要求）—— 真夹具跑完整条链路                    */
/* ------------------------------------------------------------------ */

/** 等待微任务与 placesearch 的防抖定时器（350ms）。 */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/**
 * 把「已解析的 RouteInfo 夹具」还原成一份**原始 OSRM 响应**。
 *
 * ★为什么必须还原：夹具是 `parseRoute()` 的**产出**（`fixtures/README.md` 有出处），
 *   直接喂给 `requestRoadSource()` 会被再解析一次，得到 `code !== 'Ok'` →
 *   `rt.err.noRoute`。逐边 annotation 由 `cumulativeS` / `cumulativeM` 相邻两项反推，
 *   反推后 `parseRoute()` 重算的累积曲线与原夹具**逐位相同**（前端补 0，长度 = 点数）。
 *
 * @returns {Object} 原始 OSRM 响应形状。
 */
function rawRouteResponse() {
  const parsed = JSON.parse(
    fs.readFileSync(new URL('./fixtures/osrm-cd-xian.json', import.meta.url), 'utf8')
  );
  const cumS = parsed.cumulativeS;
  const cumM = parsed.cumulativeM || [];
  const durs = [];
  const dists = [];
  for (let i = 0; i < cumS.length - 1; i += 1) {
    durs.push(Number((cumS[i + 1] - cumS[i]).toFixed(6)));
    dists.push(Number(((cumM[i + 1] || 0) - (cumM[i] || 0)).toFixed(6)));
  }
  return {
    code: 'Ok',
    routes: [
      {
        distance: parsed.distanceM,
        duration: parsed.durationS,
        geometry: { coordinates: parsed.geometry },
        legs: [
          {
            distance: parsed.distanceM,
            duration: parsed.durationS,
            annotation: { duration: durs, distance: dists },
          },
        ],
      },
    ],
    waypoints: parsed.waypoints.map((w) => ({
      location: [w.snapped.lon, w.snapped.lat],
      name: w.name || '',
      distance: w.snapDistanceM,
    })),
  };
}

/** 给 fetch 装上「按 URL 分发」的处理器（地名 / 求路 / 候选三路）。 */
function installRouteHandler() {
  const routeJson = rawRouteResponse();
  net.setHandler((u) => {
    const s = String(u);
    if (s.indexOf('/v1/search') !== -1) {
      const kw = decodeURIComponent((s.match(/name=([^&]*)/) || [, ''])[1] || '');
      const table = {
        成都: { latitude: 30.5728, longitude: 104.0668, admin1: '四川' },
        西安: { latitude: 34.3416, longitude: 108.9398, admin1: '陕西' },
      };
      return { status: 200, json: { results: [{ name: kw || '成都', ...(table[kw] || table['成都']) }] } };
    }
    if (s.indexOf('osrm') !== -1) return { status: 200, json: routeJson };
    if (s.indexOf('amap') !== -1) {
      return {
        status: 200,
        json: {
          status: '1',
          count: '2',
          pois: [
            {
              id: 'B001',
              name: '锦江宾馆',
              location: '104.0668,30.6520',
              type: '住宿服务;宾馆酒店',
              address: '成都市锦江区',
              biz_ext: { rating: '4.5', cost: '300' },
            },
            {
              id: 'B002',
              name: '无名小店',
              location: '104.0700,30.6600',
              type: '住宿服务',
              address: null,
              biz_ext: {},
            },
          ],
        },
      };
    }
    return { status: 200, json: { ok: true } };
  });
}

/**
 * 重画自驾页（= 一次全新的页面加载，但保留 `_state`）。
 *
 * @returns {void}
 */
function reloadRoadtrip() {
  for (const id of Object.keys(dom.byId)) {
    const n = dom.byId[id];
    if (n && n.listeners) n.listeners.clear();
  }
  initRoadtrip();
}

/**
 * 点**一次**预置节点上的 click 监听。
 *
 * ★为什么先断言「恰好 1 个监听」：假 DOM 的 `getElementById` 一直返回同一批预置节点，
 *   每次重画都会再绑一遍。不清就点，一次点击会跑 N 遍处理器（harness 的 `fire()` 已
 *   改成先快照，但**累加本身**仍会让「请求恰好 N×M 次」这类计数断言失真）。
 *
 * @param {string} id 预置节点 id。
 * @returns {Promise<void>}
 */
async function clickOnce(id) {
  const n = dom.byId[id];
  const fns = n.listeners.get('click') || [];
  assert.equal(fns.length, 1, `预置节点 #${id} 上应恰好 1 个 click 监听（先 reload 再点）`);
  await n.fire('click');
  await settle(30);
}

/** 走一遍地点搜索，把某个地点字段填上。 */
async function pickPlace(inputId, keyword) {
  const input = appNode(inputId);
  assert.ok(input, `找不到输入框 #${inputId}`);
  input.value = keyword;
  await input.fire('input');
  await settle(450);
  const box = appNode('place-results');
  const btns = (box ? box.descendants() : []).filter((n) => n.tagName === 'BUTTON');
  assert.ok(btns.length > 0, `地点搜索「${keyword}」没出结果`);
  await btns[0].fire('click');
  await settle(30);
}

/** 主流程链路的进度（同一进程内只跑一次，后续用例直接复用已规划好的页面）。 */
const flow = { picked: false, planned: false, searched: false };

/** 填好出发地 / 目的地。 */
async function ensurePoints() {
  installRouteHandler();
  reloadRoadtrip();
  if (!flow.picked) {
    await pickPlace('ps-origin', '成都');
    await pickPlace('ps-destination', '西安');
    flow.picked = true;
  }
}

/** 填好地点并算出路线（切段结果留在 `_state` 里）。 */
async function ensurePlanned() {
  await ensurePoints();
  if (!flow.planned) {
    setAmapKey(GOOD_KEY);
    reloadRoadtrip();
    await clickOnce('btn-plan');
    flow.planned = true;
  }
}

test('★③ 缺 Key 只降级候选：求路 / 切段照常，绝不整页锁死', async () => {
  await ensurePoints();
  assert.equal(hasAmapKey(), false, '前置：本用例故意不填 Key');

  reloadRoadtrip();
  assert.equal(appNode('btn-plan').disabled, false, '缺 Key 时「算路线」仍可点');
  assert.ok(appText().indexOf(t('rt.poiNoKey')) !== -1, '缺 Key 要有说明条');
  assert.ok(appText().indexOf(t('rt.poiGoSettings')) !== -1, '缺 Key 要有去填 Key 的入口');
  assert.equal(appNode('btn-poi').disabled, true, '缺 Key 时**只**禁用候选按钮');

  net.reset();
  reloadRoadtrip();
  await clickOnce('btn-plan');
  assert.ok(
    net.calls.some((u) => String(u).indexOf('osrm') !== -1),
    `缺 Key 不该拦求路，实际请求：${JSON.stringify(net.calls)}`
  );
  assert.ok(
    appText().indexOf(t('rt.daysLabel', { n: 2 })) !== -1,
    '成都→西安 / 每天 4h 应切成 2 天（结果卡要把天数写出来）'
  );
  // 注脚带 {pct} 占位，取占位符之前那段做前缀匹配（不把整句写死在用例里）
  const driftPrefix = t('rt.driftNote', { pct: '@@' }).split('@@')[0];
  assert.ok(appText().indexOf(driftPrefix) !== -1, '必须有「两个口径相差」注脚');
  assert.ok(appText().indexOf(t('rt.freeflowNote')) !== -1, '必须有自由流注脚');
});

test('★② N×M 配额次数必须写在按下之前，且与实际请求数一致', async () => {
  await ensurePlanned();
  reloadRoadtrip();
  assert.ok(
    appText().indexOf(t('rt.poiQuota', { a: 1, t: 3, n: 3 })) !== -1,
    `配额提示必须写明「1 个停留点 × 3 个类别 = 3 次」，实际页面：${appText()}`
  );
  assert.equal(appNode('btn-poi').disabled, false, '有 Key 之后候选按钮要可点');

  net.reset();
  await clickOnce('btn-poi');
  flow.searched = true;
  const amapCalls = net.calls.filter((u) => String(u).indexOf('amap') !== -1);
  assert.equal(
    amapCalls.length,
    3,
    `候选请求必须恰好 N×M = 3 次（串行、并发恒为 1），实际 ${amapCalls.length} 次`
  );
  assert.ok(appText().indexOf('锦江宾馆') !== -1, '候选要真的画出来');

  // ★「未填」必须单独成组并**按字段**计数：房价 / 房型是高德没给的，不许拿默认值补
  assert.ok(appText().indexOf(t('rt.groupUnknown', { n: 2 })) !== -1, '未填组必须可见并计数');
  assert.ok(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.pricePerNight'), n: 2 })) !== -1,
    '未填必须按字段细分成「未填：房价（2）」'
  );
  assert.ok(appText().indexOf(t('rt.unknownHint')) !== -1, '必须有「未填意味着什么」的说明');
});

test('★① 候选不落盘：存储里除了高德的 HTTP 缓存，不许出现候选内容', async () => {
  await ensurePlanned();
  if (!flow.searched) {
    reloadRoadtrip();
    await clickOnce('btn-poi');
    flow.searched = true;
  }
  // ★唯一的例外：`amapPoi` 源明文登记「缓存 6 小时（省每月 5000 次配额）」，
  //   它是可淘汰的缓存条目，不是用户数据。「不落盘」管的是**不写进行程** ——
  //   写进行程就会随 tripstore 的容量淘汰被当用户数据处置（架构 §4.3）。
  const dumped = [];
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (String(k).indexOf('amapPoi') !== -1) continue;
    const v = store.getItem(k);
    if (v && String(v).indexOf('锦江宾馆') !== -1) dumped.push(k);
  }
  assert.deepEqual(dumped, [], `候选落在了存储里：${dumped.join(', ')}`);
});

test('★存盘成功：落盘内容不带候选、不带几何，只留标量', async () => {
  await ensurePlanned();
  reloadRoadtrip();
  // ★写**预置**节点：`_onSave()` 走 `document.getElementById`（假 DOM 只认预置的那批）
  dom.byId['in-trip-name'].value = '成都—西安';
  await clickOnce('btn-save');
  assert.ok(
    appText().indexOf(t('rt.saveOk', { name: '成都—西安' })) !== -1,
    `存盘成功要有成功提示，实际：${appText()}`
  );

  let payloads = 0;
  for (let i = 0; i < store.length; i += 1) {
    const k = store.key(i);
    if (String(k).indexOf('trip') === -1) continue;
    const raw = String(store.getItem(k) || '');
    assert.ok(raw.indexOf('锦江宾馆') === -1, `行程 ${k} 里带了候选`);
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      json = null;
    }
    // cache.js 的条目是 `{v: 正文, t, ttl, stale}` 包装；索引键只有 id 列表
    const body = json && typeof json.v === 'object' && json.v !== null ? json.v : json;
    if (!body || typeof body !== 'object' || !('schema' in body)) continue;
    payloads += 1;
    assert.ok(body.route, `行程 ${k} 没有 route`);
    assert.equal(body.route.geometry, null, `行程 ${k} 落了几何（几百 KB，会吃光预算）`);
    assert.equal(body.route.cumulativeS, null, `行程 ${k} 落了逐边累积时长`);
    assert.equal(body.route.cumulativeM, null, `行程 ${k} 落了逐边累积里程`);
    assert.equal(body.name, '成都—西安', `行程 ${k} 没存下名字`);
  }
  assert.ok(payloads > 0, '没找到行程正文（只有索引键）');
});

test('★④ saveTrip() 返回 false 必须看得见：不许静默当成功', async () => {
  await ensurePlanned();
  // 把行程键的写入掐掉，逼 `saveTrip()` 走 `_writeIndex()/set()` 失败分支
  blockTripWrites = true;
  reloadRoadtrip();
  dom.byId['in-trip-name'].value = '成都—西安';
  await clickOnce('btn-save');
  assert.ok(
    appText().indexOf(t('rt.saveFail')) !== -1,
    `存盘失败必须给出失败提示，实际：${appText()}`
  );
  assert.ok(
    appText().indexOf(t('rt.saveOk', { name: '成都—西安' })) === -1,
    '存失败不许同时报成功 —— 那等于告诉用户「存好了」'
  );
});

test('★路线图取几何只许 simplified：full 是百 KB 量级，任何时候都不许请求', async () => {
  await ensurePlanned();
  net.reset();
  reloadRoadtrip();
  await clickOnce('btn-geo');
  const osrm = net.calls.filter((u) => String(u).indexOf('osrm') !== -1);
  assert.ok(osrm.length > 0, `点「取几何」要真的发一次请求，实际：${JSON.stringify(net.calls)}`);
  for (const u of osrm) {
    assert.ok(
      String(u).indexOf('overview=simplified') !== -1,
      `路线图只许要 simplified 几何，实际：${u}`
    );
    assert.equal(String(u).indexOf('overview=full'), -1, `★路线图不许请求 full 几何：${u}`);
  }
});

test('★缺 Key 时手动添加照样能用：降级不是锁死', async () => {
  // 本用例故意不调 ensurePlanned：它要守的正是「没有 Key 也能加打卡」
  installRouteHandler();
  reloadRoadtrip();
  assert.equal(hasAmapKey(), false, '前置：本用例不填 Key');

  const manual = appNode('in-manual-name');
  assert.ok(manual, '缺 Key 时手填输入框必须还在');
  const manualBtns = dom.byId.app
    .descendants()
    .filter((n) => n.tagName === 'BUTTON' && n.textContent === t('rt.poiManualAdd'));
  assert.equal(manualBtns.length, 1, '手填按钮必须恰好一个');
  // ★禁用优于报错：名字为空时按钮不可点，用户根本撞不上那次失败
  assert.equal(manualBtns[0].disabled, true, '名字为空时手填按钮必须是禁用的');

  manual.value = '路边一家店';
  await manual.fire('input');
  assert.equal(manualBtns[0].disabled, false, '填了名字就能加');
  await manualBtns[0].fire('click');
  await settle(30);
  assert.ok(appText().indexOf('路边一家店') !== -1, '手填的打卡要真的进列表');
  assert.ok(appText().indexOf(t('rt.checkedTitle', { n: 1 })) !== -1, '已采用计数应为 1');
});

/* ------------------------------------------------------------------ */
/* 真机报障（2026-10-15）：地点输入与结果面板位置                        */
/* ------------------------------------------------------------------ */

test('★重画后输入框草稿不丢：打了一半的字必须还在（真机「点算路线后地点全空」）', async () => {
  installRouteHandler();
  reloadRoadtrip();

  const input = appNode('ps-origin');
  assert.ok(input, '前置：出发地输入框存在');
  input.value = '成';
  await input.fire('input');
  await settle(450);

  // 触发一次整页重画：没选地点就点「算路线并分天」，走 needMorePoints 分支
  await clickOnce('btn-plan');

  const after = appNode('ps-origin');
  assert.equal(
    after.value,
    '成',
    '重画后输入框里的字被清空了 —— 真机现象「点算路线后出发地/目的地全空」'
  );
});

test('★选中地点后搜索词必须清掉：留着会像「已选」，其实是残留', async () => {
  installRouteHandler();
  reloadRoadtrip();

  await pickPlace('ps-origin', '成都');

  const input = appNode('ps-origin');
  assert.equal(input.value, '', '选中后输入框里还停着旧搜索词');
  assert.ok(appText().indexOf('成都') !== -1, '已选地点必须显示在行上（name 或坐标）');
});

test('★搜索结果必须贴在输入框那一行下面，不许落在页尾（真机看不到就等于没结果）', async () => {
  installRouteHandler();
  reloadRoadtrip();

  const input = appNode('ps-origin');
  input.value = '成都';
  await input.fire('input');
  await settle(450);

  const box = appNode('place-results');
  assert.ok(box, '结果面板必须存在');
  assert.ok(box.textContent.length > 0, '结果面板里必须有内容');

  // 输入框所在的「行」就是它的父节点；结果面板必须紧跟在那一行之后。
  // 这条钉的是真机根因：面板原先 append 在规划卡最底部（按钮之后），
  // 用户打字时结果渲染在屏幕外 —— 看不见就等于没有结果。
  const row = input.parentNode;
  assert.equal(row.nextSibling, box, '结果面板没有贴在当前输入框下面');
});

test('★空必经点槽位不许变成 (0,0) 进 URL：这是真机 HTTP 400 的根因', async () => {
  // 真机报障「数据源返回 HTTP 400」。实测 OSRM：URL 含 `0.000000,0.000000` → 400 InvalidUrl。
  // 而「点了『添加一个必经点』但还没选地点」的空槽位，其 PlaceRef 是 {lat:null, lon:null} ——
  // `Number(null)` 是 0，所以只要拿 `Number.isFinite(Number(p.lat))` 判坐标，空槽位就会
  // 被当成合法点 (0,0) 放行。这条用例把这个坑钉死。
  installRouteHandler();
  reloadRoadtrip();

  await pickPlace('ps-origin', '成都');
  reloadRoadtrip();
  await pickPlace('ps-destination', '北京');
  reloadRoadtrip();
  await clickOnce('btn-via-add'); // 加空槽位：不选地点
  reloadRoadtrip();
  await clickOnce('btn-plan');

  const osrm = net.calls.filter((u) => String(u).indexOf('osrm') !== -1);
  assert.ok(osrm.length > 0, `前置：应当真的发出了一次求路，实际：${JSON.stringify(net.calls)}`);
  for (const u of osrm) {
    assert.equal(
      String(u).indexOf('0.000000,0.000000'),
      -1,
      `★URL 里出现了零坐标：${u} —— 实测 OSRM 对它是 HTTP 400 InvalidUrl`
    );
  }
});

/**
 * ★真机截图里「必经点 1」显示成 `0.0000°N, 0.0000°E` —— 与上一条进 URL 的是
 * **同一个坑的两半**：`Number(null) === 0` 既会让空槽位混进点序列，也会让它在界面上
 * 显示成一个看似合法的坐标。上面的用例只钉住了「进 URL」那一半，这里钉显示那一半。
 */
test('★空槽位显示「—」，不许因 Number(null)===0 显示成 0.0000°N', async () => {
  installRouteHandler();
  reloadRoadtrip();
  await pickPlace('ps-origin', '成都');
  reloadRoadtrip();
  await pickPlace('ps-destination', '西安');
  reloadRoadtrip();
  await clickOnce('btn-via-add'); // 加空槽位：不选地点

  const text = appText();
  assert.equal(
    text.indexOf('0.0000'),
    -1,
    `空槽位不许显示成 0.0000°N, 0.0000°E —— 用户会以为程序坏了。实际页面：${text.slice(0, 400)}`
  );
  assert.ok(text.indexOf('—') !== -1, '空槽位应当显示占位符「—」，而不是空行');
});

/**
 * ★真机报障「搜索出发地和目的地，出现一些莫名其妙的候选项」的**消歧那一半**。
 *
 * 根因：`parseGeocode` 只留下 `admin1` 就丢掉了 `admin2`。云南的丽江市 / 曲靖市 /
 * 昆明市各有一个叫「上海」的村庄，只拼 `name · admin1` 就是三条一模一样的
 * 「上海 · 云南」；带上 admin2 立刻分得开。
 * （排序那一半 —— 首都排前、村庄降权 —— 在 `tests/place-rank.test.mjs` 里钉。）
 */
test('★候选必须带 admin2：否则同名地点完全分不开', async () => {
  net.setHandler((u) => {
    if (String(u).indexOf('/v1/search') !== -1) {
      return {
        status: 200,
        json: {
          results: [
            {
              name: '上海',
              latitude: 27.0741,
              longitude: 100.107,
              admin1: '云南',
              admin2: '丽江市',
              feature_code: 'PPL',
            },
          ],
        },
      };
    }
    return { status: 200, json: {} };
  });
  reloadRoadtrip();

  const input = appNode('ps-origin');
  input.value = '上海';
  await input.fire('input');
  await settle(450);

  const box = appNode('place-results');
  const btns = (box ? box.descendants() : []).filter((n) => n.tagName === 'BUTTON');
  assert.ok(btns.length > 0, '地点搜索「上海」没出结果');
  const label = String(btns[0].textContent || '');
  assert.ok(
    label.indexOf('丽江市') !== -1,
    `候选必须带 admin2 才能与云南其他「上海」区分开，实际候选是「${label}」`
  );

  installRouteHandler(); // 还原共享 handler，免得影响后续用例
});

