/**
 * UI 层集成验证（假 DOM + mock fetch）
 *
 * 这一组用例专门抓「mock 单元测试抓不到」的运行时问题：DOM id/选择器对不上、
 * 事件绑定缺失、异步竞态（请求返回时元素已被重绘）、导出文件名、
 * 首屏是否真的「先出天气卡」、定位被拒路径是否真的能渲染、离线是否有兜底。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installFetch, installNavigator, installStorage, FakeStorage, text } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: { effectiveType: '4g', downlink: 9.6 } });
const fetchMock = installFetch();

const DOM_IDS = [
  { id: 'app' }, { id: 'banner' },
  { id: 'summary' }, { id: 'src-list' }, { id: 'tile-list' }, { id: 'tile-dedupe' }, { id: 'log' },
  { id: 'network-type' }, { id: 'sample-count' }, { id: 'btn-run', tag: 'button' }, { id: 'btn-export', tag: 'button' },
];

const dom = createFakeDom(DOM_IDS);
const document = dom.document;
document.readyState = 'loading';

// 两个入口模块都会注册 DOMContentLoaded（我们不触发，改为显式调用 boot/init）
const app = await import('../src/ui/app.js');
const selfcheck = await import('../src/ui/selfcheck.js');
const now = await import('../src/ui/now.js');
// 磁偏角详情卡 renderDeclinationCard 归地理页（compass.js）；「本机算 / 缺失不编方向」
// 两条承诺的用例改挂到这里，所以本文件要用它（readyState='loading'，不会顶层自启动）。
const compass = await import('../src/ui/compass.js');
const i18n = await import('../src/i18n/index.js');
const { getLastSnapshot } = await import('../src/core/store.js');

const ctx = { lat: 39.9087, lon: 116.3975 };

/** 构造一个 Response-like 对象，供延迟解析场景使用。 */
const jsonRes = (obj, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(obj),
});

/** 稳定的天气响应样本。 */
const WEATHER_JSON = {
  utc_offset_seconds: 28800,
  current: {
    time: '2025-06-21T14:00',
    temperature_2m: 31.2,
    relative_humidity_2m: 48,
    apparent_temperature: 33.1,
    precipitation: 0.4,
    weather_code: 95,
    wind_speed_10m: 3.4,
    wind_direction_10m: 135,
    surface_pressure: 1006.2,
    visibility: 12400,
  },
  daily: {
    time: ['2025-06-21'],
    weather_code: [95],
    temperature_2m_max: [34.5],
    temperature_2m_min: [22.1],
    sunrise: ['2025-06-21T04:46'],
    sunset: ['2025-06-21T19:44'],
    uv_index_max: [9],
    precipitation_sum: [1.2],
  },
  hourly: { time: Array.from({ length: 24 }, (_, i) => `2025-06-21T${String(i).padStart(2, '0')}:00`), temperature_2m: Array(24).fill(28), precipitation_probability: Array(24).fill(10), weather_code: Array(24).fill(95) },
};

/** 稳定的空气响应样本。 */
const AIR_JSON = {
  utc_offset_seconds: 28800,
  current: { time: '2025-06-21T14:00', european_aqi: 42, pm10: 18.4, pm2_5: 11.2, ozone: 63.1, nitrogen_dioxide: 12.7 },
};

/** 稳定的地名响应样本。 */
const REVERSE_JSON = {
  features: [{ properties: { name: '天安门', street: '长安街', district: '东城区', city: '北京市', state: '北京市', country: '中国', osm_key: 'place' } }],
};

/** 让 fetch 按 URL 返回样本数据的处理器。 */
function routeFixture(extra = {}) {
  fetchMock.setHandler((url) => {
    if (url.includes('/v1/forecast')) return extra.weather === null ? { status: 500, json: {} } : { json: WEATHER_JSON };
    if (url.includes('air-quality')) return extra.air === null ? { status: 500, json: {} } : { json: AIR_JSON };
    if (url.includes('/reverse')) return extra.reverse === null ? { status: 500, json: {} } : { json: REVERSE_JSON };
    if (url.includes('/v1/elevation')) return extra.elevation === null ? { status: 500, json: {} } : { json: { elevation: [43] } };
    if (url.includes('/v1/search')) return { json: { results: [{ name: '北京', latitude: 39.9075, longitude: 116.397, country: '中国' }] } };
    if (url.includes('arcgisonline.com')) {
      if (extra.tile === null) return { status: 403, json: {} };
      if (extra.tile === 'fake') return { arrayBuffer: new Uint8Array([7, 7, 7, 7]) }; // 占位图：所有瓦片字节全同
      // 真实瓦片：字节随「样式 + z/y/x」变化，使 9 块瓦片指纹两两不同
      const m = url.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
      const [, z, y, x] = m ? m.map(Number) : [12, 0, 0];
      const styleSeed = url.includes('World_Imagery') ? 1 : url.includes('Canvas/') ? 2 : 0;
      return { arrayBuffer: new Uint8Array([styleSeed * 64 + (z & 63), y & 255, x & 255, (z + y + x + styleSeed) & 255]) };
    }
    return null;
  });
}

/** 清空所有容器。 */
function clearDom() {
  dom.byId['app'].textContent = '';
  dom.byId['banner'].textContent = '';
  dom.byId['banner'].hidden = true;
  dom.byId['src-list'].textContent = '';
  dom.byId['tile-list'].textContent = '';
  dom.byId['tile-dedupe'].textContent = '';
  dom.byId['log'].textContent = '';
  dom.byId['summary'].textContent = '';
  dom.byId['btn-export'].disabled = true;
}

beforeEach(async () => {
  // 等上一轮 boot 的后台补齐（reverse / 瓦片）跑完，避免残余请求污染计数与 DOM
  await new Promise((r) => setTimeout(r, 15));
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  globalThis.navigator.onLine = true;
  clearDom();
});

test('回归锁（缺陷 5）：离线且无 store 快照、但 cache 里有数据时，必须读 cache 三态渲染而非空态', async () => {
  const cache = await import('../src/core/cache.js');
  // 只写 cache，不写 store 快照
  cache.set('gs:v1:weather:39.9087:116.3975', {
    atMs: Date.now(), tzOffsetSec: 28800, tempC: 31.2, wmoCode: 95, feelsC: 33.1,
    humidityPct: 48, precipMm: 0.4, windMs: 3.4, windDeg: 135, pressureHpa: 1006,
    visibilityM: 12400, sunriseAt: Date.now(), sunsetAt: Date.now(), uvMax: 9,
    todayMaxC: 34.5, todayMinC: 22.1, hourlyTempC: [], hourlyPopPct: [],
  }, 600000);
  globalThis.navigator.onLine = false;
  await app.boot();
  const full = text(dom.byId['app']);
  assert.ok(full.includes('31°'), `离线必须读 cache 渲染出气温，不得显示空态，实际：${full.slice(0, 120)}`);
  assert.ok(text(dom.byId['banner']).includes('离线'));
});

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 磁偏角卡（2026-10-26：「方位 · 磁偏角」概览卡删除，只留一张详情卡）   */
/*                                                                      */
/* ★下面两条原是「此刻页方位卡」的用例。概览卡删了以后**不许连断言一起删**： */
/*   「本机算、不联网」与「没算出来不许编一个方向」是产品承诺，跟着卡一起 */
/*   消失等于把覆盖缺口记成接受缺口。改目标到 renderDeclinationCard ——    */
/*   它如今是磁偏角唯一的渲染出口。                                      */
/* ------------------------------------------------------------------ */

test('★磁偏角详情卡必须本机算：渲染它一个网络请求都不许发', () => {
  const root = document.createElement('div');
  const snapshot = compass.createSnapshot(ctx, { atMs: Date.now() });
  const res = compass.computeAt(ctx, { altitudeM: 44, atMs: Date.now() });
  snapshot.mag = res.mag;
  const before = fetchMock.count;
  compass.renderDeclinationCard(root, snapshot);
  assert.equal(
    fetchMock.count,
    before,
    '磁偏角走本机 WMM2025 系数，不许联网 —— 这是它不触发任何权限请求的前提'
  );
  const card = text(root.querySelector('#card-declination'));
  assert.ok(/东偏|西偏|正北/.test(card), `磁偏角卡必须给出方向，实际：${card}`);
});

test('★磁偏角缺失（mag:null）时显示「暂不可用」，不抛错也不编方向', () => {
  const root = document.createElement('div');
  // 走 compass.js 的 `!snapshot.mag` 分支
  compass.renderDeclinationCard(root, { mag: null, error: 'WMM_OUT_OF_RANGE' });
  const card = text(root.querySelector('#card-declination'));
  assert.ok(card.includes('暂不可用'), `没算出来必须显示「暂不可用」，实际：${card}`);
  // ★光钉「暂不可用」不够：卡片右上角那个 chip 用的也是 `compass.na`（同文案），
  //   把整句原因换成别的话它照样绿。所以再钉住**带原因的那一整句** —— 少了这半句，
  //   「把失败原因藏起来」这种改法测不出来（变异验证：把 note 换成 calcNote 会红）。
  assert.ok(
    card.includes(i18n.t('compass.unavailable', { reason: 'WMM_OUT_OF_RANGE' })),
    `没算出来必须把原因原样说出来，实际：${card}`
  );
  assert.ok(!/东偏|西偏|正北/.test(card), '★没算出来时不许编一个方向出来');
});

test('★2026-10-17 导航重构：气候页不再有方位槽 / 地点槽 / 底图槽（都归地理页）', async () => {
  // 为什么必须走 boot（而不是只看源码）：在线路径是「出一张渲染一张」的增量流，
  // 不走 renderSnapshot()，判断「气候页到底画了哪几张卡」只能看真实 boot 的结果。
  // ★这条取代了原来的「此刻页方位卡必须真的被渲染出来」—— 方位卡 2026-10-17 搬到
  //   地理页，2026-10-26 又因「磁偏角数值一屏重复两遍」被整张删除（renderBearingCard
  //   随之删除）。上面的两条用例已改挂到磁偏角详情卡 renderDeclinationCard 上，
  //   覆盖没跟着卡一起消失。这里反向钉住：气候页不许再出现这三个槽。
  routeFixture();
  await app.boot();
  for (const gone of ['bearing', 'place', 'map']) {
    assert.equal(
      dom.byId['app'].querySelector(`#card-${gone}`),
      null,
      `气候页不许再有 #card-${gone} 槽（已随地理页搬走）`
    );
  }
  // 反向钉的另一半：气候页该有的槽一个都不能少
  for (const keep of ['weather', 'air', 'climate', 'prov', 'search']) {
    assert.ok(dom.byId['app'].querySelector(`#card-${keep}`), `气候页必须有 #card-${keep} 槽`);
  }
});

test('★自检页产物不许被 WMM 拖胖：now.js 不得 import mag.js / wmm2025.js', async () => {
  // now.js 在「数据源自检页」单文件产物的依赖闭包内（selfcheck.js 只为 h / applyI18n 引它）。
  // 一旦它 import 了 WMM，mag.js 26.6 KB + wmm2025.js 9.5 KB 就变成那个从不显示磁偏角的
  // 诊断页的死重量 —— build-standalone 会直接「打包中止」，这里再钉一道更明确的护栏。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/ui/now.js', import.meta.url), 'utf8');
  for (const banned of ["from '../core/mag.js'", "from '../data/wmm2025.js'"]) {
    assert.ok(!src.includes(banned), `now.js 不许 import ${banned}（会把 WMM 拖进自检页产物）`);
  }
});

test('回归锁（缺陷 3）：天气码缺失时界面显示「未知天气」，绝不能显示「晴」', () => {
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderWeatherCard(root, {
    atMs: Date.now(),
    coord: { lat: 39.9087, lon: 116.3975 },
    weather: {
      atMs: Date.now(), tzOffsetSec: 0, tempC: 20, wmoCode: null,
      feelsC: null, humidityPct: null, precipMm: null, windMs: null, windDeg: null,
      pressureHpa: null, visibilityM: null, sunriseAt: null, sunsetAt: null, uvMax: null,
      todayMaxC: null, todayMinC: null, hourlyTempC: [], hourlyPopPct: [],
    },
  });
  const card = text(root.querySelector('#card-weather'));
  assert.ok(card.includes('未知'), `天气码缺失必须显示未知，实际：${card.slice(0, 120)}`);
  assert.ok(!card.includes('晴'), `天气码缺失绝不能显示「晴」：${card.slice(0, 120)}`);
});

test('回归锁：AQI / UV 负值被钳制，界面不得出现「AQI -10」「低 · -3」这类自相矛盾文案', async () => {
  const wmo = await import('../src/core/wmo.js');
  const neg = wmo.aqi(-10);
  assert.equal(neg.displayValue, 0, 'displayValue 必须钳制到 0');
  assert.equal(neg.value, -10, 'value 保留原始值便于排查');
  const negUv = wmo.uv(-3);
  assert.equal(negUv.displayValue, 0);

  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderAirCard(root, { air: { europeanAqi: -10, pm10: null, pm25: null, ozone: null, no2: null } });
  const card = text(root.querySelector('#card-air'));
  assert.ok(!/AQI\s*-/.test(card), `不得显示负的 AQI：${card}`);
  assert.ok(card.includes('AQI 0'), `应显示钳制后的 AQI 0：${card}`);
});

test('回归锁（缺陷 4）：瓦片坐标非法时 probeTile 直接返回 PARSE 且不发请求', async () => {
  const { probeTile, setNoMapMode, isNoMapMode } = await import('../src/data/tiles.js');
  setNoMapMode(false);
  const before = fetchMock.count;
  const p = await probeTile('street', { z: 12, x: Number.NaN, y: 1 });
  assert.equal(p.ok, false);
  assert.equal(p.error.code, 'PARSE', '非法坐标必须被拦下，不能拼进 URL');
  assert.equal(fetchMock.count - before, 0, '非法坐标不得发起请求');
  assert.equal(isNoMapMode(), false, '这是坐标越界错误，不应误判为「底图不可用」');
});

test('此刻屏冷启动：定位被拒（无 geolocation）也能渲染，走默认地点北京天安门', async () => {
  routeFixture();
  await app.boot();

  const appEl = dom.byId['app'];
  const full = text(appEl);
  assert.ok(full.length > 0, '此刻屏不得白屏');
  assert.ok(full.includes('39.9087°N, 116.3975°E'), `必须显示默认地点坐标，实际：${full.slice(0, 120)}`);
  assert.ok(full.includes('未取得定位'), '必须给出「未取得定位，正在显示默认地点」说明');
  assert.ok(full.includes('31°'), `必须显示气温 31°，实际片段：${full.slice(0, 200)}`);
  assert.ok(full.includes('雷阵雨'), 'WMO 95 必须翻译成雷阵雨');
  assert.ok(full.includes('43 m'), '必须显示海拔 43 m');
  assert.ok(full.includes('中') && full.includes('AQI 42'), '必须显示欧洲 AQI 42（中）');
  assert.ok(full.includes('数据来源'), '必须渲染溯源气泡区');
  assert.equal(dom.byId['banner'].hidden, true, '全绿时不得显示降级横幅');
});

test('★空气卡必须标明这把尺子是欧洲标准（EAQI）：数值与等级词不许被当成国标读', () => {
  // 真机：空气卡显示「差 · AQI 74」+ 建议减少户外活动。中国用户按国标读 74 = 「良」
  // （51–100），而这个数取自 european_aqi、档位 20/40/60/80/100 是**欧洲 AQI**，
  //   74 落在 60–80 = poor。数值没错，缺的是「这把尺子是哪把」。
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderAirCard(root, {
    air: { europeanAqi: 74, pm10: 30, pm25: 20, ozone: 90, no2: 20 },
  });
  const card = text(root.querySelector('#card-air'));
  assert.ok(card.includes('EAQI 74'), `chip 必须写 EAQI 而不是光写 AQI，实际：${card}`);
  assert.ok(
    card.includes(i18n.t('air.aqiScale')),
    `★必须说明是欧洲标准（档位与国标不同），实际：${card}`
  );
  // ★只补标签、不补算法：等级词与建议仍是 wmo.js 那套（74 → 差 / 减少户外活动）
  assert.ok(card.includes(i18n.t('level.aqi.poor')), `74 在欧标里仍是「差」，实际：${card}`);
  assert.ok(card.includes(i18n.t('aqi.poor.advice')), '建议那行不许丢');
});

test('DOM 挂载点稳定：天气/空气/气候常态/溯源四个 slot 都存在且唯一', async () => {
  // ★2026-10-17 导航重构：原来的第四个是 `card-place`（地点卡）。地点卡搬去了地理页，
  //   气候页的槽位变成 `search→weather→air→climate→prov→legend`，
  //   所以这里改成钉 `card-climate`（决定 C：本次发布带上气候常态，它必须在）。
  routeFixture();
  await app.boot();
  const appEl = dom.byId['app'];
  for (const id of ['card-weather', 'card-air', 'card-climate', 'card-prov']) {
    const hits = appEl.querySelectorAll(`#${id}`);
    assert.equal(hits.length, 1, `#${id} 必须恰好存在 1 个，实际 ${hits.length} 个`);
  }
});

test('首屏串行：weather 先出卡，air 尚未返回时仍然是骨架（不是什么都不出）', async () => {
  let resolveAir;
  const airDefer = new Promise((r) => {
    resolveAir = r;
  });
  fetchMock.setHandler((url) => {
    if (url.includes('/v1/forecast')) return { json: WEATHER_JSON };
    if (url.includes('air-quality')) return { defer: airDefer };
    return null;
  });

  const bootPromise = app.boot();
  // 等天气卡上屏、空气请求已进入挂起
  await new Promise((r) => setTimeout(r, 20));

  const airBox = dom.byId['app'].querySelector('#card-air');
  const weatherBox = dom.byId['app'].querySelector('#card-weather');
  assert.ok(weatherBox && weatherBox.children.length > 0, '天气卡必须已经渲染');
  assert.ok(text(weatherBox).includes('31°'), '天气卡应已显示气温');
  assert.ok(airBox && airBox.children.length === 1 && airBox.children[0].className === 'sk', '空气卡此刻仍应是骨架');

  resolveAir(jsonRes(AIR_JSON));
  await bootPromise;

  const airBox2 = dom.byId['app'].querySelector('#card-air');
  assert.ok(text(airBox2).includes('AQI 42'), `空气卡必须被增量替换成真实数据，实际：${text(airBox2).slice(0, 80)}`);
});

test('异步竞态：解绑前的旧请求返回时不得把旧数据写回已被重绘的卡片（重跑 boot 后数据必须来自最新一次）', async () => {
  routeFixture();
  await app.boot();
  const first = text(dom.byId['app'].querySelector('#card-weather'));

  // 第二轮把温度改成 5°，验证回落LANDೊ ... 第二轮后必须显示 5°
  const cold = JSON.parse(JSON.stringify(WEATHER_JSON));
  cold.current.temperature_2m = 5.4;
  fetchMock.clearHandler();
  fetchMock.setHandler((url) => {
    if (url.includes('/v1/forecast')) return { json: cold };
    if (url.includes('air-quality')) return { json: AIR_JSON };
    if (url.includes('/reverse')) return { json: REVERSE_JSON };
    if (url.includes('/v1/elevation')) return { json: { elevation: [43] } };
    if (url.includes('arcgisonline.com')) return { arrayBuffer: new Uint8Array([9, 9]) };
    return null;
  });
  await app.boot();
  const second = text(dom.byId['app'].querySelector('#card-weather'));
  assert.ok(first.includes('31°') && second.includes('5°'), `重跑后必须显示新数据，实际：${second.slice(0, 80)}`);
});

test('离线且无本机快照：显示离线空态 + 重试按钮，不得白屏也不得转圈', async () => {
  globalThis.navigator.onLine = false;
  const before = fetchMock.count;
  await app.boot();
  const full = text(dom.byId['app']);
  assert.equal(fetchMock.count, before, '离线时一次请求都不能发');
  assert.ok(full.includes('离线'), `必须给出离线提示，实际：${full}`);
  assert.ok(dom.byId['app'].querySelectorAll('.btn').length >= 1, '必须提供重试按钮');
  assert.equal(dom.byId['banner'].hidden, false, '离线必须显示降级横幅');
});

test('离线且有本机快照：展示陈旧快照并标注离线（有陈旧数据绝不显示空白）', async () => {
  routeFixture();
  await app.boot();
  const snap = getLastSnapshot();
  assert.ok(snap && snap.weather, '在线跑完后必须落一份本机快照');

  clearDom();
  globalThis.navigator.onLine = false;
  await app.boot();
  const full = text(dom.byId['app']);
  assert.ok(full.includes('31°'), `离线降级必须显示快照里的气温，实际：${full.slice(0, 120)}`);
  assert.ok(full.includes('39.9087°N'), '离线降级必须显示坐标');
  assert.equal(dom.byId['banner'].hidden, false, '离线必须显示横幅');
  assert.ok(text(dom.byId['banner']).includes('离线'), '横幅必须给出离线态文案');
});

test('陈旧降级：缓存过期 + 上游全失败时，仍必须显示旧值而不是空白', async () => {
  routeFixture();
  await app.boot(); // 第一写入 cache（TTL 10 分钟）

  // 让缓存过期：直接改写 storiedAt
  const key = 'gs:v1:weather:39.9087:116.3975';
  const raw = JSON.parse(localStorage.getItem(key));
  raw.t = Date.now() - 20 * 60 * 1000; // 20 分钟前 → 过期
  localStorage.setItem(key, JSON.stringify(raw));
  const airKey = 'gs:v1:air:39.9087:116.3975';
  if (localStorage.getItem(airKey)) {
    const rawAir = JSON.parse(localStorage.getItem(airKey));
    rawAir.t = Date.now() - 20 * 60 * 1000;
    localStorage.setItem(airKey, JSON.stringify(rawAir));
  }

  clearDom();
  routeFixture({ weather: null, air: null });
  await app.boot();

  const weatherText = text(dom.byId['app'].querySelector('#card-weather'));
  assert.ok(weatherText.includes('31°'), `上游失败时必须用陈旧值兜底，不得空白：${weatherText.slice(0, 80)}`);
  assert.equal(dom.byId['banner'].hidden, false, '必须显示降级横幅');
  assert.ok(/陈旧|不可用|离线/.test(text(dom.byId['banner'])), `横幅必须说明降级原因，实际：${text(dom.byId['banner'])}`);
});

test('关键源全失败且无缓存（真·空数据）→ 顶部显示「暂无可用数据」，不空白也不转圈', async () => {
  routeFixture({ weather: null, air: null, elevation: null, reverse: null, tile: null });
  await app.boot();
  const full = text(dom.byId['app']);
  assert.ok(full.includes('暂无'), `必须给出空态文案，实际：${full.slice(0, 160)}`);
  assert.equal(dom.byId['banner'].hidden, false);
  assert.ok(text(dom.byId['banner']).includes('暂无可用数据'), `横幅应为 empty：${text(dom.byId['banner'])}`);
});

test('网络恢复后重新开始一轮，若瓦片探测成功则必须退出无地图模式（不可 sticky）', async () => {
  const { setNoMapMode, isNoMapMode } = await import('../src/data/tiles.js');
  routeFixture({ tile: null });
  await app.boot();
  assert.equal(isNoMapMode(), true, '瓦片失败应进入无地图模式');
  await new Promise((r) => setTimeout(r, 10)); // 等后台补齐
  assert.ok(text(dom.byId['banner']).includes('底图不可用'), '横幅应提示无地图模式');

  clearDom();
  routeFixture(); // 瓦片恢复
  await app.boot();
  assert.equal(isNoMapMode(), false, '瓦片探测成功后必须复位无地图模式，否则横幅会一直谎称底图不可用');
  assert.equal(dom.byId['banner'].hidden, true, '全绿时不得再显示降级横幅');
  setNoMapMode(false);
});

test('瓦片探测失败 → 进入无地图纯坐标模式，气候页页头仍显示坐标（不重试）', async () => {
  routeFixture({ tile: null });
  const before = fetchMock.count;
  await app.boot();
  await new Promise((r) => setTimeout(r, 30)); // 瓦片探测在后台补齐阶段（boot 不 await）
  // ★2026-10-17：地点卡搬到地理页了，气候页的「纯坐标」改由**页头**承载
  //   （renderHeader 里那行 .hd-coord），所以这里看的是 .hd 而不是 #card-place。
  const placeText = text(dom.byId['app'].querySelector('.hd'));
  assert.ok(placeText.includes('39.9087°N, 116.3975°E'), `无地图模式必须显示坐标，实际：${placeText}`);
  // 「不重试」的准确含义：每块瓦片各请求一次，**不得对同一块重复请求**。
  // 主页面现在探 TILE_PROBE_COUNT 个不同位置（只探一块时 grid 态数学上不可达），
  // 所以总次数是 3 而不是 1 —— 那是 3 块不同的瓦片，不是同一块重试 3 次。
  const tileCalls = fetchMock.calls.filter((u) => u.includes('arcgisonline.com'));
  // 光判「去重后 == 总数」是不够的：它只保证没有重复，却管不住探测块数。
  // 一旦有人把探测改回单块，tiles.length===1 时去重断言照样成立 —— 而单块恰是
  // 「grid 态数学上不可达」那个缺陷的根因，会被这条用例静默放过。
  // 所以这里同时钉死两件事：块数恰好等于 TILE_PROBE_COUNT(3)，且每块各请求一次。
  const perUrl = new Map();
  for (const u of tileCalls) perUrl.set(u, (perUrl.get(u) || 0) + 1);
  assert.equal(
    perUrl.size,
    3, // TILE_PROBE_COUNT；必须 ≥ 2，否则 grid 的判定区间 0 < ok < length 为空集
    `应恰好探测 3 块不同瓦片，实际 ${perUrl.size} 块（共 ${tileCalls.length} 次请求）`
  );
  assert.ok(
    [...perUrl.values()].every((n) => n === 1),
    `每块瓦片各请求一次、失败不重试，实际请求次数分布：${JSON.stringify([...perUrl.values()])}`
  );
  assert.ok(fetchMock.count > before);
});

test('自检页：点击「开始自检」走完整流程，results 覆盖 5 路 API 源 + 瓦片 3×3，判定 all-ok', async () => {
  routeFixture();
  selfcheck.init();
  const runBtn = dom.byId['btn-run'];
  await runBtn.fire('click');

  const listText = text(dom.byId['src-list']);
  const rows = dom.byId['src-list'].querySelectorAll('.sc-row');
  assert.equal(rows.length, 5, `自检 results 应只统计 5 路 API 源（瓦片在下方单独成表），实际渲染了 ${rows.length} 行`);
  for (const id of ['weather', 'air', 'geocode', 'elevation', 'reverse']) {
    assert.notEqual(dom.byId['src-list'].querySelector(`#row-${id}`), null, `缺少 ${id} 行`);
  }
  assert.equal(dom.byId['src-list'].querySelector('#row-tile'), null, '瓦片不应出现在 API 源结果表里');

  const tiles = dom.byId['tile-list'].querySelectorAll('.sc-row');
  assert.equal(tiles.length, 9, `瓦片应为 3 样式 × 3 位置 = 9 行，实际 ${tiles.length}`);

  assert.equal(dom.byId['btn-export'].disabled, false, '跑完后必须解锁导出按钮');
  assert.ok(text(dom.byId['summary']).includes('通过 5/5'), `汇总应为「通过 5/5」，实际：${text(dom.byId['summary'])}`);
  assert.ok(text(dom.byId['summary']).includes('全部数据源可用'), 'verdict 应为 all-ok');

  // 不得向数据源发畸形请求（变量名 NaN 泄漏到 URL 是典型事故）
  const badUrls = fetchMock.calls.filter((u) => /NaN|undefined|null/.test(u));
  assert.deepEqual(badUrls, [], `自检不得发出畸形 URL：\n${badUrls.join('\n')}`);

  // 去重判定：每样式一行 + 总判定
  const dedupe = text(dom.byId['tile-dedupe']);
  assert.ok(dedupe.includes('去重判定：real'), `真实瓦片应判定 real，实际：${dedupe}`);
  assert.ok(dedupe.includes('街道图') && dedupe.includes('影像图') && dedupe.includes('暗色图'), 'byStyle 必须覆盖三种样式');
  assert.ok(listText.length > 0);
});

test('自检页：瓦片指纹全同（占位图）时，集成链路必须判定 fake 并上屏警示', async () => {
  routeFixture({ tile: 'fake' });
  const report = await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });

  assert.equal(report.tiles.filter((p) => p.ok).length, 9, '9 块瓦片都返回 200');
  const dedupe = text(dom.byId['tile-dedupe']);
  assert.ok(dedupe.includes('fake'), `全同指纹必须判 fake（识破「200 但占位图」的假成功源），实际：${dedupe}`);
  assert.ok(dedupe.includes('街道图') && dedupe.includes('影像图') && dedupe.includes('暗色图'), 'byStyle 必须逐个样式给出结论');
  assert.equal(report.tileDedupe.verdict, 'fake');
  assert.equal(report.tileDedupe.unique, 1);
  assert.equal(report.tileDedupe.total, 9);
  // 三个样式各自也必须判 fake（byStyle 与总判定口径一致）
  for (const styleId of ['street', 'imagery', 'dark']) {
    assert.equal(report.tileDedupe.byStyle[styleId].verdict, 'fake', `${styleId} 应判 fake`);
  }
});

test('回归锁：占位图（全同指纹）必须把整轮结论降级为 partial，且 fake 结论上屏且进导出', async () => {
  routeFixture({ tile: 'fake' });
  const report = await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });
  assert.equal(report.tileDedupe.verdict, 'fake');
  assert.equal(report.verdict, 'partial', '疑似占位图时整轮结论必须降级，不能显示「全部数据源可用」');
  assert.ok(text(dom.byId['tile-dedupe']).includes('fake'), 'fake 结论必须上屏');
  assert.ok(JSON.stringify(report).includes('"verdict":"fake"'), 'fake 结论必须进入导出 JSON');
  assert.ok(text(dom.byId['summary']).includes('部分数据源不可用'), '汇总徽标必须同步降级');
});

test('自检页：取样次数 1/3/5 生效，且预热请求不计入统计', async () => {
  routeFixture();
  await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });
  let weatherCalls = fetchMock.calls.filter((u) => u.includes('/v1/forecast')).length;
  assert.equal(weatherCalls, 2, `samples=1 时 weather 应为 1 次预热 + 1 次正式 = 2 次，实际 ${weatherCalls}`);

  fetchMock.reset();
  await selfcheck.runSelfCheck({ samples: 5, networkType: 'cellular' });
  weatherCalls = fetchMock.calls.filter((u) => u.includes('/v1/forecast')).length;
  assert.equal(weatherCalls, 6, `samples=5 时应为 1 次预热 + 5 次正式 = 6 次，实际 ${weatherCalls}`);
});

test('自检页：离线时零请求，verdict=offline 且每行标 offline', async () => {
  globalThis.navigator.onLine = false;
  await selfcheck.runSelfCheck({ samples: 3, networkType: 'wifi' });
  assert.equal(fetchMock.count, 0, '离线自检必须一次请求都不发');
  const rows = dom.byId['src-list'].querySelectorAll('.sc-row');
  assert.equal(rows.length, 5);
  assert.ok(text(dom.byId['summary']).includes('离线'), `汇总必须给出 offline，实际：${text(dom.byId['summary'])}`);
  assert.ok(text(dom.byId['tile-dedupe']).length >= 0);
});

test('缺陷复现：自检页把 tile 源也塞进了 API 结果表，向瓦片域名发出 tile/undefined/undefined/undefined 畸形请求', async () => {
  // 按真实服务端行为构造：正则瓦片返回字节，畸形 URL 返回 404
  fetchMock.setHandler((url) => {
    if (url.includes('arcgisonline.com')) {
      if (/NaN|undefined|null/.test(url)) return { status: 404, json: {} };
      const m = url.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
      const [, z, y, x] = m ? m.map(Number) : [12, 0, 0];
      const seed = url.includes('World_Imagery') ? 1 : url.includes('Canvas/') ? 2 : 0;
      return { arrayBuffer: new Uint8Array([seed * 64 + (z & 63), y & 255, x & 255, (z + y + x + seed) & 255]) };
    }
    return { status: 200, json: { ok: true, features: [{ properties: { name: '天安门' } }], results: [{ name: '北京' }], elevation: [43] } };
  });
  const report = await selfcheck.runSelfCheck({ samples: 3, networkType: 'wifi' });

  const ids = report.results.map((r) => r.sourceId);
  assert.deepEqual(ids, ['weather', 'air', 'geocode', 'elevation', 'reverse'], `results 不得包含 tile，实际：${ids.join(',')}`);

  const malformed = fetchMock.calls.filter((u) => /NaN|undefined|null/.test(u));
  assert.deepEqual(malformed, [], `不得向数据源发畸形 URL，实际发出：\n${malformed.join('\n')}`);

  assert.equal(report.verdict, 'all-ok', '五路 API + 九块瓦片全部正常时，结论必须是 all-ok');
});

test('自检页：部分源失败时 verdict=partial，失败行给出错误码文案', async () => {
  routeFixture({ reverse: null, elevation: null });
  const report = await selfcheck.runSelfCheck({ samples: 3 });
  assert.equal(report.verdict, 'partial');
  assert.ok(text(dom.byId['src-list']).includes('HTTP'), '失败行必须带上错误码');
  assert.ok(text(dom.byId['summary']).includes('部分数据源不可用'));
});

test('自检页：导出 JSON 触发下载且文件名符合 geoscope-selfcheck-<YYYYMMDD-HHmm>.json', async () => {
  routeFixture();
  const report = await selfcheck.runSelfCheck({ samples: 1, networkType: 'unknown' });
  assert.ok(report && Array.isArray(report.results));
  // ★是 'geoscope'（文件格式标识）不是品牌名：与文件名前缀 geoscope-selfcheck-<stamp>.json
  //   以及 backup.js 的 `app: APP_ID` 同一口径。品牌改名不该改变导出文件的格式。
  assert.equal(report.app, 'geoscope');
  assert.equal(report.warmup, true, '报告必须声明含预热');
  assert.equal(report.networkType, 'unknown');
  assert.equal(report.samples, 1);
  assert.ok(typeof report.userAgent === 'string');
  assert.ok(report.tileDedupe && report.tileDedupe.byStyle, '必须给出 byStyle 分样式去重');
  // 报告必须可被 JSON 序列化（导出链路的前提）
  assert.doesNotThrow(() => JSON.stringify(report));

  selfcheck.exportReport(report);
  const logText = text(dom.byId['log']);
  assert.ok(/export → geoscope-selfcheck-\d{8}-\d{4}\.json/.test(logText), `导出文件名不符规范，日志：${logText.slice(-160)}`);
  assert.ok(!logText.includes('export failed'), `导出不应失败：${logText.slice(-200)}`);
});

test('自检页：非法取样次数/网络类型被安全兜底，不崩溃', async () => {
  routeFixture();
  const r1 = await selfcheck.runSelfCheck({ samples: 999 });
  assert.equal(r1.samples, 3, '越界取样次数必须回落到默认 3');
  const r2 = await selfcheck.runSelfCheck({ networkType: '卫星' });
  assert.ok(['wifi', 'cellular', 'unknown'].includes(r2.networkType), '非法网络类型必须回落');
  selfcheck.setNetworkType('火星');
  selfcheck.setSamples(0);
});

test('now.js 渲染对残缺快照不抛异常（缺 weather / air / coord 都能出卡）', () => {
  const root = document.createElement('div');
  const bannerEl = document.createElement('div');
  now.renderSkeleton(root);
  now.renderHeader(root, { coord: null, provenance: [] }, {});
  now.renderWeatherCard(root, { weather: null });
  now.renderAirCard(root, { air: null });
  now.renderPlaceCard(root, { elevationM: null, placeName: null, coord: null });
  now.renderProvenance(root, { provenance: [] });
  now.renderBanner(bannerEl, 'live');
  assert.equal(text(bannerEl), '', 'live 态横幅必须空且隐藏');
  assert.equal(bannerEl.hidden, true);
  now.renderBanner(bannerEl, 'stale', { staleAgeMs: 610000 });
  assert.ok(text(bannerEl).includes('陈旧'), 'stale 横幅必须给出说明');
  now.renderBanner(bannerEl, undefined);
  assert.ok(text(root).length > 0, '残缺快照下不得渲染出全空页面');
  assert.ok(text(root.querySelector('#card-weather')).includes('暂无'), '无天气数据时应显示占位文案');
});

test('★溯源气泡：缓存命中必须显示「缓存命中」，不许显示 0 ms（没发请求 ≠ 耗时 0）', () => {
  // ★为什么在渲染层再钉一次（pull.test.mjs 已经钉了字段）：字段对了但**没人读**一样
  //   会显示 0 ms。这条钉的是「渲染层真的按 fromCache 分支说话」——
  //   变异验证：把 now.js 的 `p.fromCache === true ? …` 改回 `fmt.latency(p.latencyMs)`，
  //   这条立刻红（出「—」而不是「缓存命中」），而 pull.test.mjs 那两条仍是绿的。
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderProvenance(root, {
    provenance: [
      // 命中那一条：pull.js 给的 latencyMs 是 null（忠实复制 http.js 的 0 也行，见下）
      { sourceId: 'elevation', label: '海拔', url: 'https://example.test/elev', latencyMs: null, fromCache: true, fetchedAt: Date.now(), state: 'fresh', attribution: '' },
      { sourceId: 'weather', label: '天气', url: 'https://example.test/w', latencyMs: 137, fromCache: false, fetchedAt: Date.now(), state: 'fresh', attribution: '' },
    ],
  });
  const box = text(root.querySelector('#card-prov'));
  assert.ok(box.includes('缓存命中'), `命中那条必须说「缓存命中」，实际：${box}`);
  assert.ok(!/\b0 ms\b/.test(box), `命中不许显示「0 ms」（那是把没发请求说成耗时 0），实际：${box}`);
  assert.ok(box.includes('137 ms'), `未命中那条要显示实测时延，实际：${box}`);
});

test('now.js：缺失字段必须显示占位符「—」而不是 0（与 format  regressions 对齐）', () => {
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderWeatherCard(root, {
    atMs: Date.now(),
    coord: { lat: 39.9087, lon: 116.3975 },
    weather: {
      atMs: Date.now(), tzOffsetSec: 0,
      tempC: 20, feelsC: null, humidityPct: null, precipMm: null,
      windMs: null, windDeg: null, pressureHpa: null, visibilityM: null,
      wmoCode: 3, sunriseAt: null, sunsetAt: null, uvMax: null,
      todayMaxC: null, todayMinC: null,
      hourlyTempC: [], hourlyPopPct: [],
    },
  });
  const card = text(root.querySelector('#card-weather'));
  assert.ok(card.includes('—'), '缺失数值必须显示占位符');
  // 体感缺失时不得渲染成「体感 0°」
  assert.ok(!/体感\s*0°/.test(card), `不得把缺失的体感温度显示成 0°：${card}`);
  assert.ok(!/湿度\s*0%/.test(card), '不得把缺失湿度显示成 0%');
});
