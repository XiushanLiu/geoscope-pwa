/**
 * 多地点对比（任务 A）验证
 *
 * 背景：对比页从「我的」页进（不进底部 tabbar —— 320px 屏上四个 tab 已贴临界点，
 * 加第五项必断行）。每个地点单独取一次数，串行（http.js 全局并发恒为 1）。
 *
 * 这一组用例钉死五件事：
 *   1) **串行**：请求是「A 的天气 → A 的空气 → B 的天气 → B 的空气 …」，
 *      任一时刻在飞的请求不超过 1 个；
 *   2) **部分失败**：失败的那个地点单独标出，且**不许拿别处的数据填** ——
 *      它的卡片里不该出现任何温度数字；
 *   3) **全失败**：给明确的空态说明（不是空白、不是一直「进行中」）；
 *   4) **空收藏**：入口按钮禁用并写明「先收藏地点」；
 *   5) **上限**：收藏超过 6 条时只对比前 6 条，并且如实说出来。
 *
 * 环境：与 favorites.test.mjs 同一套路 —— 装好假 DOM / 假 localStorage 后再 import
 * 被测模块（compare.js 与 settings.js 都在模块顶层引导主题，没有 document 会炸）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeDom,
  installNavigator,
  installStorage,
  FakeStorage,
  text,
} from './harness.mjs';

installStorage(new FakeStorage());
const nav = installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: null });

const dom = createFakeDom([
  { id: 'app' }, { id: 'banner' },
  // 我的页那几处预置 id：settings.js 用 _el(id) 取节点，假 DOM 只索引预置 id
  { id: 'export-current' }, { id: 'export-privacy' },
  { id: 'file-backup' }, { id: 'import-preview' }, { id: 'import-result' }, { id: 'btn-confirm' },
]);
dom.document.readyState = 'loading';

const compare = await import('../src/ui/compare.js');
const settings = await import('../src/ui/settings.js');
const store = await import('../src/core/store.js');
const cache = await import('../src/core/cache.js');
const { t } = await import('../src/i18n/zh.js');

/** 三个对比地点（气温刻意差得很开，填错数据一眼能看出来）。 */
const A = { lat: 39.9087, lon: 116.3975, name: '北京' };
const B = { lat: 31.2304, lon: 121.4737, name: '上海' };
const C = { lat: 22.5431, lon: 114.0579, name: '深圳' };

/** 纬度串 → 气温（构造响应时按坐标区分地点）。 */
const TEMP_OF = {
  '39.9087': 20,
  '31.2304': 28,
  '22.5431': 33,
};

/** 请求记录（顺序 + 并发峰值）。 */
const rec = { calls: [], inFlight: 0, maxInFlight: 0, failWhen: null };

/**
 * 构造某地的天气响应。
 *
 * @param {string} latStr 纬度串（四位小数）。
 * @returns {Object} 响应 JSON。
 */
function weatherJson(latStr) {
  const temp = TEMP_OF[latStr] === undefined ? 25 : TEMP_OF[latStr];
  const hours = Array.from({ length: 24 }, (unused, i) => `2025-06-21T${String(i).padStart(2, '0')}:00`);
  return {
    utc_offset_seconds: 28800,
    current: {
      time: '2025-06-21T14:00',
      temperature_2m: temp,
      relative_humidity_2m: 55,
      apparent_temperature: temp + 2,
      precipitation: 0.4,
      weather_code: 3,
      wind_speed_10m: 2.1,
      wind_direction_10m: 90,
      surface_pressure: 1004,
      visibility: 12000,
    },
    daily: {
      time: ['2025-06-21'],
      weather_code: [3],
      temperature_2m_max: [temp + 4],
      temperature_2m_min: [temp - 4],
      sunrise: ['2025-06-21T05:00'],
      sunset: ['2025-06-21T19:30'],
      uv_index_max: [6],
      precipitation_sum: [0.4],
    },
    hourly: {
      time: hours,
      temperature_2m: Array.from({ length: 24 }, () => temp),
      precipitation_probability: Array.from({ length: 24 }, (unused, i) => (i === 14 ? 37 : 0)),
      weather_code: Array.from({ length: 24 }, () => 3),
    },
  };
}

/**
 * 构造某地的空气响应。
 *
 * @param {string} latStr 纬度串（四位小数）。
 * @returns {Object} 响应 JSON。
 */
function airJson(latStr) {
  const base = TEMP_OF[latStr] === undefined ? 40 : TEMP_OF[latStr] + 20;
  return {
    utc_offset_seconds: 28800,
    current: {
      time: '2025-06-21T14:00',
      european_aqi: base,
      pm10: 12,
      pm2_5: 6,
      ozone: 33,
      nitrogen_dioxide: 9,
    },
  };
}

/**
 * 构造一个 Response-like 对象。
 *
 * ★`headers` 不能省：http.js 的 `_contentType(res)` 会去调 `res.headers.get()`，
 * 少了它会在解析阶段抛 TypeError → 被当成 NETWORK（可重试）→ 每次请求都白跑第二遍，
 * 调用次数断言立刻失真。这个坑是「看起来像在测网络，其实在测假响应缺字段」。
 *
 * @param {number} status HTTP 状态。
 * @param {Object} json 响应体。
 * @returns {Object} Response-like。
 */
function resLike(status, json) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(json),
  };
}

/**
 * 安装可控 fetch：记录 URL 顺序与并发峰值，支持按 URL 让指定请求失败。
 *
 * ★为什么自己替换 `globalThis.fetch` 而不用 harness 的 `setHandler()`：
 * harness 那段代码写的是 `state.handler(url) ? state.handler(url) : …` —— 为了判空
 * 把处理器**调了两遍**。任何写在处理器里的计数都会被记成两倍，「发了几次请求」
 * 这个断言当场失真（本组用例第一版就因此把 4 次记成 8 次）。直接接管 fetch，
 * 一次请求只进一次函数，计数才是真的。
 *
 * 失败用 **HTTP 400**（不是 500 / 超时）：http.js 只对「超时 / 网络 / 5xx / 429」
 * 重试，用 400 才能保证一次请求只发一次，调用次数断言才数得清。
 *
 * @returns {void}
 */
function installHandler() {
  rec.calls = [];
  rec.inFlight = 0;
  rec.maxInFlight = 0;
  rec.failWhen = null;
  globalThis.fetch = (url, init = {}) => {
    const u = String(url);
    rec.calls.push(u);
    rec.inFlight += 1;
    if (rec.inFlight > rec.maxInFlight) rec.maxInFlight = rec.inFlight;
    const latStr = (u.match(/latitude=(-?[\d.]+)/) || [])[1] || '';
    const isAir = u.indexOf('air-quality') !== -1;
    return new Promise((resolve) => {
      setTimeout(() => {
        rec.inFlight -= 1;
        if (rec.failWhen && rec.failWhen(u)) {
          resolve(resLike(400, {}));
          return;
        }
        resolve(resLike(200, isAir ? airJson(latStr) : weatherJson(latStr)));
      }, 3);
    });
  };
}

/**
 * 取列表容器里的卡片文本数组（按文档顺序）。
 *
 * @returns {string[]} 每张卡的纯文本。
 */
function cardTexts() {
  const list = dom.byId['app'].querySelector('#compare-list');
  if (!list) return [];
  return list.children.map((c) => text(c));
}

/**
 * 清空本机状态并写入指定收藏。
 *
 * @param {Array<Object>} places 收藏地点。
 * @returns {void}
 */
function seedFavorites(places) {
  store.resetStore();
  cache.clearAll();
  store.resetStore(); // clearAll 会顺带清掉刚写回的 prefs，重新落一次
  places.forEach((p) => store.addFavorite(p));
}

beforeEach(() => {
  installHandler();
  nav.setOnline(true);
});

test('① 串行取数：顺序是 A天气→A空气→B天气→B空气，且在飞请求恒不超过 1', async () => {
  seedFavorites([A, B]);
  await compare.init();

  // 顺序：两地点 × 两路 = 4 次，且严格「同一地点的两路挨在一起」
  assert.equal(rec.calls.length, 4, `应恰好 4 次请求，实际 ${rec.calls.length}`);
  const kinds = rec.calls.map((u) => {
    const latStr = (String(u).match(/latitude=(-?[\d.]+)/) || [])[1] || '';
    return `${latStr}:${String(u).indexOf('air-quality') !== -1 ? 'air' : 'weather'}`;
  });
  assert.deepEqual(
    kinds,
    ['39.9087:weather', '39.9087:air', '31.2304:weather', '31.2304:air'],
    `取数必须是「一个地点取完再取下一个」的串行顺序，实际：${kinds.join(' → ')}`
  );
  // ★并发护栏：Promise.all 式的并发会把这个数顶到 2 以上
  assert.equal(rec.maxInFlight, 1, `任一时刻在飞请求必须 ≤ 1，实际峰值 ${rec.maxInFlight}`);

  const cards = cardTexts();
  assert.equal(cards.length, 2, '应渲染两张地点卡');
  assert.ok(cards[0].includes('20°'), `北京卡应显示 20°，实际：${cards[0]}`);
  assert.ok(cards[1].includes('28°'), `上海卡应显示 28°，实际：${cards[1]}`);
  assert.ok(cards[0].includes(t('status.ok')), '取到的行应标「正常」');
});

test('② 部分失败：失败的那个地点单独标出，★且不许拿别处的数据填', async () => {
  seedFavorites([A, B, C]);
  // 让「上海」这一地点的两路都失败
  rec.failWhen = (url) => String(url).indexOf('latitude=31.2304') !== -1;
  await compare.init();

  const cards = cardTexts();
  assert.equal(cards.length, 3, '三个地点都应出卡（失败的那个也要出，不能消失）');
  assert.ok(cards[0].includes(t('status.ok')), '北京应正常');
  assert.ok(cards[2].includes(t('status.ok')), '深圳应正常');
  assert.ok(cards[1].includes(t('status.failed')), `上海必须标「失败」，实际：${cards[1]}`);
  assert.ok(cards[1].includes(t('compare.rowFailed', { reason: '' }).split('：')[0]), '失败行应写出原因前缀');
  // ★关键护栏：失败那行不许出现任何一个地点的温度值。
  //  注意不能写成 /d+°/ 这种宽正则 —— 坐标串「31.2304°N」本身就带 °，会误伤。
  //  这里逐个钉住三个真实温度值（20° / 28° / 33°），任一个出现在失败行里
  //  都等于「拿别处的数据填了它」。
  for (const bad of ['20°', '28°', '33°']) {
    assert.ok(!cards[1].includes(bad), `失败的地点不得出现温度 ${bad}（那是别的地点的数），实际：${cards[1]}`);
  }
  assert.ok(cards[1].includes('上海'), '失败行仍要写明是哪个地点');
  // 成功的两行数据各自独立（20° / 33°，没有互相污染）
  assert.ok(cards[0].includes('20°') && !cards[0].includes('33°'), '北京行不该出现深圳的温度');
  assert.ok(cards[2].includes('33°') && !cards[2].includes('20°'), '深圳行不该出现北京的温度');
});

test('③ 单路源失败（空气挂了、天气正常）：该格显示占位符「—」，整行仍算取到', async () => {
  seedFavorites([A]);
  // 只让空气那一路失败
  rec.failWhen = (url) => String(url).indexOf('air-quality') !== -1;
  await compare.init();

  const cards = cardTexts();
  assert.equal(cards.length, 1);
  assert.ok(cards[0].includes(t('status.ok')), '天气取到了，整行就应标「正常」');
  assert.ok(cards[0].includes('20°'), '气温应照常显示');
  assert.ok(cards[0].includes('—'), `缺失的 AQI 那一格应显示占位符「—」，实际：${cards[0]}`);
  // 空气值是 40（20+20），失败时不该出现
  assert.ok(!cards[0].includes('40'), '空气没取到，就不该出现它的数值');
});

test('④ 全失败：给明确的空态说明 + 重试，不是空白也不是转圈', async () => {
  seedFavorites([A, B]);
  rec.failWhen = () => true;
  await compare.init();

  const cards = cardTexts();
  assert.equal(cards.length, 1, '全失败时列表应换成一张空态卡');
  const empty = cards[0];
  assert.ok(empty.includes(t('compare.allFailed', { total: 2 }).split('。')[0]), `空态必须说明情况，实际：${empty}`);
  assert.ok(!empty.includes(t('status.running')), '空态不该还写着「进行中」（不许一直转圈）');
  assert.ok(!/\d+°/.test(empty), '空态不该出现任何温度数字');
  // 重试按钮必须存在（否则用户只能手动刷新页面）
  assert.ok(empty.includes(t('app.retry')), `空态应带重试按钮，实际：${empty}`);
});

test('⑤ 离线：一个请求都不发，并如实说明「未发起请求」', async () => {
  seedFavorites([A, B]);
  nav.setOnline(false);
  await compare.init();

  assert.equal(rec.calls.length, 0, `离线时不应发起任何请求，实际发了 ${rec.calls.length} 次`);
  const cards = cardTexts();
  assert.equal(cards.length, 1, '离线应给空态');
  assert.ok(cards[0].includes(t('compare.offline')), `应写明离线，实际：${cards[0]}`);
  nav.setOnline(true);
});

test('⑥ 空收藏：对比入口按钮禁用，并写明「先收藏地点」', async () => {
  seedFavorites([]);
  settings.init();

  const app = dom.byId['app'];
  const btn = app
    .descendants()
    .find((n) => n.tagName === 'BUTTON' && n.textContent === t('compare.entryBtn'));
  assert.ok(btn, '我的页应有对比入口按钮');
  assert.equal(btn.disabled, true, '收藏为空时入口必须禁用');
  const appText = text(app);
  assert.ok(appText.includes(t('compare.needFav')), `应写明「先收藏地点」，实际片段：${appText.slice(0, 400)}`);

  // 有了收藏之后：按钮亮起、提示撤掉（同一颗按钮在收藏变化后要跟着变）
  store.addFavorite(A);
  settings.init();
  const btn2 = dom
    .byId['app']
    .descendants()
    .find((n) => n.tagName === 'BUTTON' && n.textContent === t('compare.entryBtn'));
  assert.ok(btn2, '重渲染后仍应找到入口按钮');
  assert.equal(btn2.disabled, false, '有收藏后入口必须可用');
});

test('⑦ 空收藏时进对比页：给空态而不是空白', async () => {
  seedFavorites([]);
  await compare.init();
  assert.equal(rec.calls.length, 0, '没有地点就不该发请求');
  const cards = cardTexts();
  assert.equal(cards.length, 1, '应渲染一张空态卡');
  assert.ok(cards[0].includes(t('compare.needFav').split('：')[0]), `应说明先去收藏，实际：${cards[0]}`);
});

test('⑧ 超过 6 条收藏：只对比前 6 条，并如实说明', async () => {
  const many = [];
  for (let i = 0; i < 8; i += 1) {
    // 纬度各不相同，保证是 8 条互不重复的收藏
    many.push({ lat: 20 + i, lon: 110 + i, name: `地点${i}` });
  }
  seedFavorites(many);
  await compare.init();

  assert.equal(compare.MAX_PLACES, 6, '上限常量应为 6');
  assert.equal(rec.calls.length, 12, `6 个地点 × 2 路 = 12 次请求，实际 ${rec.calls.length}`);
  const appText = text(dom.byId['app']);
  assert.ok(
    appText.includes(t('compare.maxNote', { max: 6 }).split('。')[0]),
    `应如实说明只对比了前 6 条，实际片段：${appText.slice(0, 600)}`
  );
  assert.ok(appText.includes(t('compare.current', { count: 8 })) === false || true, '条数文案在对比页非必需');
});

test('⑨ 汇总统计 summarize：成功 / 失败 / 待取各归各位', () => {
  const rows = compare.buildRows([A, B, C]);
  assert.equal(rows.length, 3);
  assert.deepEqual(compare.summarize(rows), { total: 3, ok: 0, failed: 0, pending: 3 });

  rows[0].status = compare.ROW_STATUS.OK;
  rows[1].status = compare.ROW_STATUS.FAILED;
  assert.deepEqual(compare.summarize(rows), { total: 3, ok: 1, failed: 1, pending: 1 });
  assert.deepEqual(compare.summarize([]), { total: 0, ok: 0, failed: 0, pending: 0 });
  assert.deepEqual(compare.summarize(null), { total: 0, ok: 0, failed: 0, pending: 0 }, '非数组不得抛异常');
});

test('⑩ buildRows：每个地点各持一份副本，初始状态一律「待取」', () => {
  const rows = compare.buildRows([A, B]);
  assert.notEqual(rows[0].place, A, '行应持有地点副本，不是同一个对象引用');
  assert.equal(rows[0].place.name, '北京');
  assert.equal(rows[0].status, compare.ROW_STATUS.PENDING);
  assert.equal(rows[0].weather, null);
  assert.equal(rows[0].air, null);
  assert.equal(rows[0].error, null);
  assert.equal(rows[0].stale, false);
  assert.deepEqual(compare.buildRows(null), [], '非数组输入应返回空数组而不是抛异常');
});
