/**
 * 自驾页「筛选条件可编辑」的回归（用户明确提的需求）
 *
 * 为什么要单独一个文件：`tests/roadtrip-ui.test.mjs` 钉的是候选主流程（配额 / 不落盘 /
 *   缺 Key 不锁死），而这一块钉的是**条件本身能不能改**。两者混在一起会让「主流程」
 *   那批用例随筛选面板的每次调整一起抖动。
 *
 * ★这批用例想拦的是三类「纯函数测试全绿、但界面其实没接线」的经典漏法：
 *   1) `_filters()` 仍然 `return DEFAULT_FILTERS`（常量）—— 面板画得出来、点得动、
 *      状态也真的写进去了，但下面三组**永远按老门槛切**。所以每条断言都走**真实渲染**，
 *      断言的是「改完条件之后分组真的变了」，不是「某个变量变成某个值」。
 *   2) 初值写成 `= DEFAULT_FILTERS`（浅引用）—— 用户勾一下复选框就把 core 的模块级
 *      常量改了，下一次新建行程拿到的是被改过的默认值，而且**不报错**。
 *      这条有专门的用例（`DEFAULT_FILTERS` 前后快照深比较）。
 *   3) 控件不回写 `selected` / `checked` —— 本页每次变化都整槽重建，不带初值就等于
 *      把用户刚选的档位扔掉。这条照 `sel-daily` 的模式逐个控件断言。
 *
 * ★红线（与实现同源，改测试前先读）：房价 / 房型 / 景区等级 / 特色菜名，高德免费 POI
 *   接口**一律拿不到**。候选里没有就是没有 —— 它们必须进 `partitionByFilter()` 的
 *   unknown 组并被计数。本文件里**没有任何一条**断言会因为它们「被补上了值」而变绿。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage + 可控 fetch（零第三方依赖）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFakeDom, installNavigator, installStorage, installFetch, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });
const net = installFetch();

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
  // 规划主流程用到的预置控件（`_bindControls()` 走 `document.getElementById`）
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
  { id: 'btn-geo' },
  { id: 'btn-export' },
  { id: 'btn-import-apply' },
  { id: 'in-trip-file' },
]);

/** 必须在 import 被测模块之前装好全局（cache.js 在加载期就决定走内存还是 localStorage）。 */
const { setAmapKey, hasAmapKey } = await import('../src/core/apikeys.js');
const { DEFAULT_FILTERS, partitionByFilter, asFilterableCandidate } = await import('../src/core/roadtrip.js');
const { init: initRoadtrip } = await import('../src/ui/roadtrip.js');
const { t } = await import('../src/i18n/index.js');

/** 一份合法（非空、无空格、不超长）的高德 Key 形状。 */
const GOOD_KEY = 'abcdefgh12345678';

/** 常量快照：用来钉「改 UI 不许改到 core 的模块级常量」。 */
const DEFAULT_SNAPSHOT = JSON.parse(JSON.stringify(DEFAULT_FILTERS));

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

beforeEach(() => {
  net.clearHandler();
  net.reset();
});

/* ------------------------------------------------------------------ */
/* 主流程夹具（照 tests/roadtrip-ui.test.mjs 的同一套写法）              */
/* ------------------------------------------------------------------ */

/** 等待微任务与 placesearch 的防抖定时器（350ms）。 */
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/**
 * 把「已解析的 RouteInfo 夹具」还原成一份**原始 OSRM 响应**。
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
        legs: [{ distance: parsed.distanceM, duration: parsed.durationS, annotation: { duration: durs, distance: dists } }],
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
      // ★房价 / 房型 / 等级 / 菜名一个都不给 —— 与高德免费接口的实测一致。
      //   谁把这批候选补上任何「看起来合理」的字段，下面的「未填」断言就会立刻变绿，
      //   那是**假绿**：本仓不许拿推算值冒充实测值。
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
 * ★为什么不直接 initRoadtrip()：假 DOM 的预置节点不随重画换新，监听会**累加**，
 *   点一次跑 N 遍处理器，「请求恰好 N 次」这类计数断言会失真（harness 注释同因）。
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

/** 主流程链路的进度（同一进程内只跑一次，后续用例直接复用已搜好的候选）。 */
const flow = { picked: false, planned: false, stayOnly: false, allTypes: false };

/** 填好出发地 / 目的地并算出路线。 */
async function ensurePlanned() {
  installRouteHandler();
  reloadRoadtrip();
  if (!flow.picked) {
    await pickPlace('ps-origin', '成都');
    await pickPlace('ps-destination', '西安');
    flow.picked = true;
  }
  if (!flow.planned) {
    setAmapKey(GOOD_KEY);
    reloadRoadtrip();
    await clickOnce('btn-plan');
    flow.planned = true;
  }
}

/**
 * 只搜住宿并拿到候选。
 *
 * ★为什么收窄到一类：三类拿到的都是**同一批**候选，于是「未填（2）」这种计数在三张
 *   列表卡上同时出现，断言就没法区分是哪一类变了。只搜住宿之后，页面上每个分组计数
 *   **唯一归属住宿**，改一条条件就能干净地看到它自己的变化。
 */
async function ensureStayCandidates() {
  await ensurePlanned();
  if (!flow.stayOnly) {
    reloadRoadtrip();
    await clickOnce('btn-only-stay');
    reloadRoadtrip();
    await clickOnce('btn-poi');
    flow.stayOnly = true;
  }
}

/**
 * 拨一个筛选条件开关（含整页重画）。
 *
 * @param {string} id 复选框 id。
 * @param {boolean} want 想要的状态。
 * @returns {Promise<void>}
 */
async function setSwitch(id, want) {
  const cb = appNode(id);
  assert.ok(cb, `找不到开关 #${id}（筛选面板没画出来？）`);
  cb.checked = !!want;
  await cb.fire('change');
  await settle(30);
}

/**
 * 改一个下拉框的档位（含整页重画）。
 *
 * @param {string} id select 的 id。
 * @param {string} value 目标档位。
 * @returns {Promise<void>}
 */
async function setSelect(id, value) {
  const sel = appNode(id);
  assert.ok(sel, `找不到下拉框 #${id}`);
  assert.equal(sel.hasAttribute('disabled'), false, `#${id} 是禁用的：该条件当前没勾上`);
  sel.value = String(value);
  await sel.fire('change');
  await settle(30);
}

/**
 * 取下拉框当前被选中的那个 option 的 value。
 *
 * @param {string} id select 的 id。
 * @returns {string|null} 选中值；没有选中项时返回 null。
 */
function selectedValue(id) {
  const sel = appNode(id);
  if (!sel) return null;
  const opts = sel.descendants().filter((n) => n.tagName === 'OPTION' && n.hasAttribute('selected'));
  return opts.length === 1 ? opts[0].getAttribute('value') : null;
}

/* ------------------------------------------------------------------ */
/* 面板渲染                                                             */
/* ------------------------------------------------------------------ */

test('★筛选条件面板画得出来：三类各一块，标题上写出「已生效 N 项」', () => {
  reloadRoadtrip();

  const txt = appText();
  assert.ok(txt.indexOf(t('rt.filterTitle')) !== -1, `必须有「${t('rt.filterTitle')}」区块`);
  assert.ok(txt.indexOf(t('rt.filterHint')) !== -1, '必须写明「没勾的这条不参与判定」');

  for (const [type, n] of [['stay', 2], ['sight', 2], ['food', 1]]) {
    const det = appNode(`filt-${type}`);
    assert.ok(det, `必须有 ${type} 的折叠块 #filt-${type}`);
    assert.equal(det.tagName, 'DETAILS', `${type} 的折叠块必须是 <details>（原生可折叠，不自己写 JS）`);
    // 折叠状态也要看得到「现在按什么筛」：条数写在 summary 上
    assert.ok(
      det.textContent.indexOf(t('rt.filter.effective', { n })) !== -1,
      `${type} 的标题行应写「${t('rt.filter.effective', { n })}」，实际：${det.textContent}`
    );
  }
});

test('★七条条件的控件一个都不能少（房价 / 房型 / 评分 / 等级 / 特色 / 关键词）', () => {
  reloadRoadtrip();
  const ids = [
    'cb-stay-price', 'sel-stay-price',
    'cb-stay-roomType', 'cb-stay-room-standard', 'cb-stay-room-king', 'cb-stay-room-twin',
    'cb-stay-rating', 'sel-stay-rating',
    'cb-sight-level', 'sel-sight-level',
    'cb-sight-rating', 'sel-sight-rating',
    'cb-food-localSpecial',
    'cb-food-keywords', 'in-food-keywords',
  ];
  for (const id of ids) {
    assert.ok(appNode(id), `筛选面板缺控件 #${id} —— 用户就改不了这一条条件`);
  }
});

test('★默认值必须回填：整页重画后用户看到的仍是当前这一套条件', () => {
  reloadRoadtrip();

  // 住宿：房价 + 房型勾上，评分没勾（DEFAULT_STAY_FILTER 的原样）
  assert.equal(appNode('cb-stay-price').hasAttribute('checked'), true, '房价默认勾上');
  assert.equal(appNode('cb-stay-roomType').hasAttribute('checked'), true, '房型默认勾上');
  assert.equal(appNode('cb-stay-rating').hasAttribute('checked'), false, '住宿评分默认**不**勾');
  assert.equal(selectedValue('sel-stay-price'), '150', '房价档位默认 150');
  assert.equal(appNode('cb-stay-room-standard').hasAttribute('checked'), true, '标准间默认勾上');
  assert.equal(appNode('cb-stay-room-king').hasAttribute('checked'), true, '大床房默认勾上');
  assert.equal(appNode('cb-stay-room-twin').hasAttribute('checked'), false, '双床房默认**不**勾');

  // 景点：4A + 4.6
  assert.equal(appNode('cb-sight-level').hasAttribute('checked'), true, '景区等级默认勾上');
  assert.equal(selectedValue('sel-sight-level'), '4A', '默认 4A');
  assert.equal(appNode('cb-sight-rating').hasAttribute('checked'), true, '景点评分默认勾上');
  assert.equal(selectedValue('sel-sight-rating'), '4.6', '默认 4.6');

  // 美食：当地特色勾上、关键词没勾
  assert.equal(appNode('cb-food-localSpecial').hasAttribute('checked'), true, '当地特色默认勾上');
  assert.equal(appNode('cb-food-keywords').hasAttribute('checked'), false, '关键词默认**不**勾');

  // ★没勾的那条，它的取值控件也得是禁用的 —— 否则看着能改，改了却不起作用
  assert.equal(appNode('sel-stay-rating').hasAttribute('disabled'), true, '没勾的评分档位该是禁用的');
  assert.equal(appNode('in-food-keywords').hasAttribute('disabled'), true, '没勾的关键词框该是禁用的');
  assert.equal(appNode('sel-stay-price').hasAttribute('disabled'), false, '勾着的房价档位必须可改');
});

/* ------------------------------------------------------------------ */
/* 状态写入（不污染常量 / 重画不丢）                                      */
/* ------------------------------------------------------------------ */

test('★改筛选条件不许污染 core 的模块级常量 DEFAULT_FILTERS', async () => {
  // ★这条守的是「初值必须是深拷贝」。`DEFAULT_FILTERS.stay.enabled` 与 `.roomTypes`
  //   都是引用；写成 `filters: DEFAULT_FILTERS`（或任何浅拷贝）的话，用户勾一下复选框
  //   就把**常量**改了 —— 下一次新建行程拿到的是被改过的默认值，而且全程不报错。
  reloadRoadtrip();

  await setSwitch('cb-stay-price', false); // 写 enabled.price（对象引用）
  await setSwitch('cb-stay-room-twin', true); // 写 roomTypes（数组引用）
  await setSelect('sel-sight-level', '5A'); // 写 minLevel

  assert.deepEqual(
    DEFAULT_FILTERS,
    DEFAULT_SNAPSHOT,
    '★改了界面上的筛选条件，core 的 DEFAULT_FILTERS 却被改了 —— 初值不是深拷贝'
  );
  assert.equal(DEFAULT_FILTERS.stay.enabled.price, true, '默认「勾上房价」必须是 true');
  assert.deepEqual(DEFAULT_FILTERS.stay.roomTypes, ['standard', 'king'], '默认房型不许被加进 twin');
  assert.equal(DEFAULT_FILTERS.sight.minLevel, '4A', '默认景区等级不许被改成 5A');

  // 还原，免得影响后面的用例（本文件按书写顺序跑）
  await setSwitch('cb-stay-price', true);
  await setSwitch('cb-stay-room-twin', false);
  await setSelect('sel-sight-level', '4A');
});

test('★改完档位整页重画后仍选中：不带 selected 就等于把用户刚选的扔掉', async () => {
  reloadRoadtrip();
  await setSelect('sel-stay-price', '300');
  assert.equal(selectedValue('sel-stay-price'), '300', '重画后房价档位必须仍是 300');

  await setSelect('sel-stay-price', '150');
  assert.equal(selectedValue('sel-stay-price'), '150', '改回 150 也要回写');
});

test('★关掉的开关重画后仍是关的，勾上的重画后仍是勾的', async () => {
  reloadRoadtrip();
  await setSwitch('cb-stay-price', false);
  assert.equal(appNode('cb-stay-price').hasAttribute('checked'), false, '关掉后重画不许又变回勾上');
  // ★开关关了，它那条取值控件也要跟着禁用（看着能改却不起作用是最坏的一种界面）
  assert.equal(appNode('sel-stay-price').hasAttribute('disabled'), true);

  await setSwitch('cb-stay-price', true);
  assert.equal(appNode('cb-stay-price').hasAttribute('checked'), true, '勾上后重画不许丢');
  assert.equal(appNode('sel-stay-price').hasAttribute('disabled'), false);
});

/* ------------------------------------------------------------------ */
/* ★真实渲染路径：改条件之后三分组真的重算                                */
/* ------------------------------------------------------------------ */

test('★关掉「房价 / 房型」→ 住宿不再进「未填」，改落「符合」（真实的分组重算）', async () => {
  await ensureStayCandidates();
  reloadRoadtrip();

  // 前置：默认条件下两条住宿候选都缺房价与房型 → 进「未填」并**按字段**计数。
  // 这两条断言同时也是「不许补数据」的护栏：房价一旦被补上值，它们立刻变绿（假绿）。
  assert.ok(
    appText().indexOf(t('rt.groupUnknown', { n: 2 })) !== -1,
    `默认条件下两条住宿都该在「未填」组，实际页面：${appText()}`
  );
  assert.ok(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.pricePerNight'), n: 2 })) !== -1,
    '必须有「未填：房价（2）」'
  );
  assert.ok(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.roomType'), n: 2 })) !== -1,
    '必须有「未填：房型（2）」'
  );

  // 关掉这两条 → 它们**压根不参与判定**，于是既没有 fail 也没有 unknown
  await setSwitch('cb-stay-price', false);
  await setSwitch('cb-stay-roomType', false);

  const after = appText();
  assert.ok(
    after.indexOf(t('rt.groupPass', { n: 2 })) !== -1,
    `关掉条件后两条住宿都该落进「符合」，实际页面：${after}`
  );
  assert.equal(
    after.indexOf(t('rt.groupUnknownField', { field: t('rt.field.pricePerNight'), n: 2 })),
    -1,
    '★关掉的条件不许再产生「未填：房价」计数 —— 那说明它其实还在参与判定'
  );
  assert.equal(after.indexOf(t('rt.groupUnknown', { n: 2 })), -1, '关掉后不该再有「未填（2）」');

  // 还原（后面几条用例从默认条件出发）
  await setSwitch('cb-stay-price', true);
  await setSwitch('cb-stay-roomType', true);
  assert.ok(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.pricePerNight'), n: 2 })) !== -1,
    '勾回来之后「未填：房价（2）」必须回来（开关是双向的）'
  );
});

test('★打开「最低评分 4.8」→ 4.5 分的那条进「不达标」，缺评分的那条仍在「未填」', async () => {
  await ensureStayCandidates();
  reloadRoadtrip();

  await setSwitch('cb-stay-rating', true);
  // 打开时阈值还是 null，界面必须补一个**用户看得见的档位**（默认最低档 4.0），
  // 而不是留一个「勾上了但没阈值」的空条件
  assert.equal(selectedValue('sel-stay-rating'), '4', `打开评分应落到 4.0 档，实际：${selectedValue('sel-stay-rating')}`);

  await setSelect('sel-stay-rating', '4.8');

  const txt = appText();
  // 锦江宾馆 4.5 < 4.8 → fail；无名小店没评分 → unknown（缺不等于达标）
  assert.ok(txt.indexOf(t('rt.groupFail', { n: 1 })) !== -1, `4.5 分那条该进「不达标」，实际：${txt}`);
  assert.ok(txt.indexOf(t('rt.groupUnknown', { n: 1 })) !== -1, `没评分那条该仍在「未填」，实际：${txt}`);
  assert.ok(
    txt.indexOf(t('rt.groupUnknownField', { field: t('rt.field.rating'), n: 1 })) !== -1,
    `「未填：评分（1）」必须出现（rt.field.rating 这条文案原先缺，会甩英文 rating），实际：${txt}`
  );

  // 关掉评分 → 回到两条都在「未填」的状态（这条条件不再参与判定）
  await setSwitch('cb-stay-rating', false);
  const back = appText();
  assert.equal(back.indexOf(t('rt.groupFail', { n: 1 })), -1, '关掉评分后不该再有「不达标」');
  assert.ok(back.indexOf(t('rt.groupUnknown', { n: 2 })) !== -1, `关掉后两条都回到「未填」，实际：${back}`);
});

test('★美食关键词：勾上才参与判定，「未填：关键词（2）」随开关出现 / 消失', async () => {
  await ensureStayCandidates();

  // 换成搜三类：关键词属于美食，只搜住宿时没有美食分组
  if (!flow.allTypes) {
    reloadRoadtrip();
    await clickOnce('btn-all-types');
    reloadRoadtrip();
    await clickOnce('btn-poi');
    flow.allTypes = true;
  }
  reloadRoadtrip();
  assert.equal(hasAmapKey(), true, '前置：候选搜索需要 Key');

  const before = appText();
  assert.equal(
    before.indexOf(t('rt.groupUnknownField', { field: t('rt.field.keywords'), n: 2 })),
    -1,
    '关键词默认**不**勾，不该有「未填：关键词（2）」'
  );

  await setSwitch('cb-food-keywords', true);
  // 候选里没有 tags / 菜名（高德免费接口给不了）→ 勾上之后如实进「未填：关键词」
  assert.ok(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.keywords'), n: 2 })) !== -1,
    `勾上关键词后必须有「未填：关键词（2）」，实际：${appText()}`
  );

  // 关键词输入框：改完要回写得出来（否则重画后用户以为没存住）
  const input = appNode('in-food-keywords');
  input.value = '当地特色,火锅';
  await input.fire('change');
  await settle(30);
  assert.equal(appNode('in-food-keywords').getAttribute('value'), '当地特色,火锅', '关键词要回写');

  await setSwitch('cb-food-keywords', false);
  assert.equal(
    appText().indexOf(t('rt.groupUnknownField', { field: t('rt.field.keywords'), n: 2 })),
    -1,
    '关掉关键词之后不许还有「未填：关键词（2）」'
  );
});

test('★条件关到底不许出现 0 个房型：那等于「勾着却不起作用」', async () => {
  reloadRoadtrip();
  // 逐个取消，最后一个必须取消不掉（与 POI 类别开关同一条规矩）
  await setSwitch('cb-stay-room-standard', false);
  await setSwitch('cb-stay-room-king', false);
  await setSwitch('cb-stay-room-twin', false);

  const left = ['standard', 'king', 'twin'].filter((v) =>
    appNode(`cb-stay-room-${v}`).hasAttribute('checked')
  );
  assert.equal(
    left.length,
    1,
    `房型不许被清成 0 个（0 个 = 没有阈值 = 这条条件静默失效），实际还剩：${left.join(',') || '无'}`
  );

  // 还原成默认的「标准间 + 大床房」
  for (const v of ['standard', 'king', 'twin']) {
    const want = v !== 'twin';
    const node = appNode(`cb-stay-room-${v}`);
    if (node.hasAttribute('checked') !== want) await setSwitch(`cb-stay-room-${v}`, want);
  }
  assert.deepEqual(
    ['standard', 'king', 'twin'].filter((v) => appNode(`cb-stay-room-${v}`).hasAttribute('checked')).sort(),
    ['king', 'standard'],
    '还原后应回到默认房型'
  );
});

/* ------------------------------------------------------------------ */
/* asFilterableCandidate：候选 → 可筛选条目的**唯一**形状契约            */
/* ------------------------------------------------------------------ */

test('★asFilterableCandidate：补 type 与 category，且高德原文让位给类别', () => {
  const out = asFilterableCandidate({ id: 'p1', name: '如家', type: '住宿服务;宾馆酒店', rating: 4.5 }, 'stay');
  assert.equal(out.type, 'stay', '必须补上语义 type，否则 partitionByFilter 取不到筛选条件');
  assert.equal(out.category, '住宿服务;宾馆酒店', '高德原文必须挪到 category（列表卡照它显示）');
  assert.equal(out.name, '如家', '其余字段原样保留，不许丢');
});

test('★asFilterableCandidate：评分必须落到 common.rating —— 否则「4.6 分以上」永远匹配不上', () => {
  // 为什么必须补：`_evaluate()` 读 `item.common.rating`（CheckIn 形状），
  // 而 `parsePoi()` 把评分放在**顶层**。不补 → 同一块屏幕上「★ 4.5」与「未填：评分」并存。
  const withRating = asFilterableCandidate({ rating: 4.5 }, 'sight');
  assert.equal(withRating.common.rating, 4.5, '评分必须落到 common.rating');

  // 补了之后，景点「4.6 分以上」这条用户明确要的条件才真的能分出 pass / fail
  const filters = { sight: { enabled: { rating: true }, minRating: 4.6 } };
  const groups = partitionByFilter(
    [asFilterableCandidate({ name: 'A', rating: 4.8 }, 'sight'), asFilterableCandidate({ name: 'B', rating: 4.2 }, 'sight')],
    filters
  );
  assert.equal(groups.pass.length, 1, '4.8 分必须进「符合」');
  assert.equal(groups.fail.length, 1, '4.2 分必须进「不达标」');
  assert.equal(groups.unknown.length, 0, '评分已知就不许再算成未填');
});

test('★asFilterableCandidate：没有评分的候选仍然进「未填」，不许用默认值占位', () => {
  const groups = partitionByFilter(
    [asFilterableCandidate({ name: '无名店' }, 'sight')],
    { sight: { enabled: { rating: true }, minRating: 4.6 } }
  );
  assert.equal(groups.unknown.length, 1, '高德没给评分 = 未填，不许拿默认分冒充');
  assert.equal(groups.unknownCounts.sight.rating, 1, '未填必须被计数');
});

test('★asFilterableCandidate：房价 / 房型 / 等级一律不补 —— 高德免费接口给不了就是给不了', () => {
  const out = asFilterableCandidate({ name: '某酒店', rating: 4.5 }, 'stay');
  assert.equal(out.stay, undefined, '不许凭空造出 stay 子结构（房价 / 房型都在里面）');
  assert.equal(out.sight, undefined, '不许造 sight 子结构（景区等级在里面）');
  // 反过来验证：正因为没补，开着房价上限时它老实进 unknown 并被计数
  const groups = partitionByFilter([out], { stay: { enabled: { price: true }, maxPriceCny: 150 } });
  assert.equal(groups.unknown.length, 1, '没有房价就必须进未填，不许假装达标');
  // 字段名是 pricePerNight（_evaluate 里 put() 用的键），enabled 的开关键才叫 price
  assert.equal(groups.unknownCounts.stay.pricePerNight, 1, '未填：房价 必须计数');
});

test('asFilterableCandidate：非法 type 归一成 null，非法候选不抛错', () => {
  assert.equal(asFilterableCandidate({ rating: 4 }, '不存在的类别').type, null, '非法类别归一为 null');
  assert.equal(asFilterableCandidate(null, 'stay').type, 'stay', '候选为 null 时不许抛错');
  assert.doesNotThrow(() => asFilterableCandidate(undefined, 'food'));
});
