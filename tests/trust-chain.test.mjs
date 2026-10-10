/**
 * 「体检即授信 → 日常命中缓存」端到端链路验证。
 *
 * 为什么必须有这一组用例：
 * 瓦片层的其余用例验的都是**缓存机制本身**（LRU、TTL、撤销即清、未授信不写），
 * 但从来没有人验过「自检授信之后，日常使用真的能命中」这条完整链路。
 * 而授信持久化的全部意义就是防止「缓存永不生效」——机制再对，链路不通等于白做。
 *
 * 链路顺序（关键，容易搞反）：
 *   1. 自检跑完 → 样式判 real → markStyleTrusted(styleId, true)
 *   2. 授信之后的**第一次**探测仍然是真请求（此时缓存还是空的，要去填充）
 *   3. 第二次及以后才命中缓存：fromCache=true、latencyMs=0、零网络请求
 *
 * 零第三方依赖，纯 node:test + node:assert。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDom, installFetch, installNavigator, installStorage, FakeStorage } from './harness.mjs';

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

const app = await import('../src/ui/app.js');
const selfcheck = await import('../src/ui/selfcheck.js');
const {
  probeTile,
  sampleTiles,
  markStyleTrusted,
  isStyleTrusted,
  clearTileCache,
  tileCacheSize,
  setMapMode,
  MAP_MODE,
} = await import('../src/data/tiles.js');

const ctx = { lat: 39.9087, lon: 116.3975 };
const ALL_STYLES = ['street', 'imagery', 'dark'];

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
  hourly: {
    time: Array.from({ length: 24 }, (_, i) => `2025-06-21T${String(i).padStart(2, '0')}:00`),
    temperature_2m: Array(24).fill(28),
    precipitation_probability: Array(24).fill(10),
    weather_code: Array(24).fill(95),
  },
};
const AIR_JSON = {
  utc_offset_seconds: 28800,
  current: { time: '2025-06-21T14:00', european_aqi: 42, pm10: 18.4, pm2_5: 11.2, ozone: 63.1, nitrogen_dioxide: 12.7 },
};
const REVERSE_JSON = {
  features: [{ properties: { name: '天安门', street: '长安街', district: '东城区', city: '北京市', state: '北京市', country: '中国', osm_key: 'place' } }],
};

/** 瓦片字节随「样式 + z/y/x」变化 → 3 块瓦片指纹两两不同 → 判 real。 */
function routeFixture(extra = {}) {
  fetchMock.setHandler((url) => {
    if (url.includes('/v1/forecast')) return extra.weather === null ? { status: 500, json: {} } : { json: WEATHER_JSON };
    if (url.includes('air-quality')) return extra.air === null ? { status: 500, json: {} } : { json: AIR_JSON };
    if (url.includes('/reverse')) return extra.reverse === null ? { status: 500, json: {} } : { json: REVERSE_JSON };
    if (url.includes('/v1/elevation')) return { json: { elevation: [43] } };
    if (url.includes('/v1/search')) return { json: { results: [{ name: '北京', latitude: 39.9075, longitude: 116.397, country: '中国' }] } };
    if (url.includes('arcgisonline.com')) {
      if (extra.deadUrl && url === extra.deadUrl) return { status: 403, json: {} };
      if (extra.tile === null) return { status: 403, json: {} };
      if (extra.tile === 'fake') return { arrayBuffer: new Uint8Array([7, 7, 7, 7]) };
      const m = url.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
      const [, z, y, x] = m ? m.map(Number) : [12, 0, 0];
      const styleSeed = url.includes('World_Imagery') ? 1 : url.includes('Canvas/') ? 2 : 0;
      return { arrayBuffer: new Uint8Array([styleSeed * 64 + (z & 63), y & 255, x & 255, (z + y + x + styleSeed) & 255]) };
    }
    return null;
  });
}

/** 把授信与瓦片缓存恢复到「全新用户」状态。 */
function resetTrust() {
  for (const s of ALL_STYLES) markStyleTrusted(s, false);
  clearTileCache();
  setMapMode(MAP_MODE.MAP);
}

/** 瓦片探测在后台补齐阶段跑，boot() 不 await 它，必须等一下。 */
const drain = () => new Promise((r) => setTimeout(r, 40));
const tileCalls = () => fetchMock.calls.filter((u) => u.includes('arcgisonline.com'));

beforeEach(async () => {
  await drain(); // 等上一轮后台补齐跑完，避免残余请求污染计数
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  globalThis.navigator.onLine = true;
  resetTrust();
  dom.byId['app'].textContent = '';
  dom.byId['banner'].textContent = '';
  dom.byId['src-list'].textContent = '';
  dom.byId['tile-list'].textContent = '';
  dom.byId['tile-dedupe'].textContent = '';
});

test('端到端主链路：自检判 real → 授信 → 日常探测命中缓存（零请求 / fromCache / latencyMs=0）', async () => {
  routeFixture();

  // 1) 体检：真瓦片指纹两两不同 → 各样式判 real → 授信
  assert.equal(isStyleTrusted('street'), false, '起始状态：新用户未授信');
  const report = await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });
  assert.equal(report.tileDedupe.verdict, 'real', '真瓦片必须判 real');
  assert.equal(isStyleTrusted('street'), true, '自检判 real 后必须授信，否则缓存永不生效');

  // 2) 授信后的第一次日常探测：缓存还是空的，必须真的发请求去填充
  fetchMock.reset();
  await app.boot();
  await drain();
  const first = tileCalls();
  assert.ok(first.length >= 1, '首次探测应真实发请求填充缓存');

  // 3) 第二次日常探测：必须命中缓存 —— 零网络请求
  fetchMock.reset();
  await app.boot();
  await drain();
  const second = tileCalls();
  assert.equal(second.length, 0, `第二次必须命中缓存、零请求，实际仍发了 ${second.length} 次：${second.join(', ')}`);

  // 4) 直接验证命中标记与时延（这是「缓存真的生效」最硬的证据）
  const tiles = sampleTiles(ctx);
  const p = await probeTile('street', tiles[0]);
  assert.equal(p.ok, true);
  assert.equal(p.fromCache, true, '命中缓存时必须置 fromCache=true');
  assert.equal(p.latencyMs, 0, '命中缓存时不得计入网络时延');
  assert.ok(tileCacheSize() > 0, '缓存里应留有字节');
});

test('反向对照：未授信时第二次探测仍必须发请求（证明授信是缓存生效的前提）', async () => {
  routeFixture();
  // 不跑自检，直接日常使用
  assert.equal(isStyleTrusted('street'), false);

  await app.boot();
  await drain();
  assert.ok(tileCalls().length >= 1, '首次探测应发请求');

  fetchMock.reset();
  await app.boot();
  await drain();
  assert.ok(
    tileCalls().length >= 1,
    '未授信时不得写缓存，第二次仍应发请求（否则「未授信不写」这条约束形同虚设）'
  );
  assert.equal(tileCacheSize(), 0, '未授信时缓存必须为空');
});

test('端到端：3 块瓦片坏 1 块时主页面真的进 grid，且横幅给出「部分不可用」而不是 live', async () => {
  // 这是「修好了 vs 看着像修好了」的分水岭：
  // degradeMapMode 的单元用例能出 grid，不代表主页面跑一遍真能进 grid。
  // 场景：让第 2 块瓦片 403，其余两块 200 → 部分失败。
  const tiles = sampleTiles(ctx);
  const { tileUrl, mapMode, MAP_MODE } = await import('../src/data/tiles.js');
  const deadUrl = tileUrl('street', tiles[1].z, tiles[1].x, tiles[1].y);
  routeFixture({ deadUrl });

  await app.boot();
  await drain();

  assert.equal(mapMode(), MAP_MODE.GRID, '3 块坏 1 块必须落到 grid，而不是直接宣布 no-map');

  // 健康层必须接住 grid，否则用户会看到「一切正常」而底图少了一块
  const { overallMode } = await import('../src/data/health.js');
  assert.equal(overallMode(), 'partial', 'grid 必须给出 partial，绝不能落到 live');
  // grid 的观感必须严格区别于 no-map：不能说「底图不可用」，也不能说「暂无可用数据」。
  // 否则用户看到的还是「地图没了」，三态裁决就白做了。
  const bannerText = dom.byId['banner'].textContent || '';
  assert.ok(!bannerText.includes('暂无可用数据'), `grid 不得显示空态文案，实际：${bannerText}`);
  assert.ok(!bannerText.includes('底图不可用'), `grid 只是部分瓦片失败，不得谎称底图不可用，实际：${bannerText}`);
});

test('安全红线：自检判 fake（占位图）不得授信，且已缓存字节必须被清空', async () => {
  routeFixture({ tile: 'fake' });

  const report = await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });
  assert.equal(report.tileDedupe.verdict, 'fake', '占位图必须判 fake');
  for (const s of ALL_STYLES) {
    assert.equal(isStyleTrusted(s), false, `${s} 判 fake 后不得授信`);
  }

  // 授信后再跑一次 fake 自检 → 必须撤销授信并清掉该样式已缓存的字节
  markStyleTrusted('street', true);
  clearTileCache();
  await probeTile('street', sampleTiles(ctx)[0]);
  assert.ok(tileCacheSize() > 0, '授信后探测应写入缓存');

  await selfcheck.runSelfCheck({ samples: 1, networkType: 'wifi' });
  assert.equal(isStyleTrusted('street'), false, '判 fake 必须撤销授信');
  assert.equal(tileCacheSize(), 0, '撤销授信必须清空该样式已缓存字节，绝不能把占位图留在缓存里');
});
