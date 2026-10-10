/**
 * GRID 态主页面横幅：文案如实 + 样式钩子真实存在。
 *
 * 背景（2026-10-11 三态降级落地后的复核）：
 *   grid（部分瓦片没取到、底图降为网格）在健康层返回 'partial'；横幅原先直接拿
 *   overallMode() 去渲染，于是 grid 上屏的文案是「部分数据源不可用，其余数据正常」——
 *   五个 API 明明都正常，坏的只是瓦片，用户读完会以为天气/空气也跟着坏了。
 *   更隐蔽的是：`.banner--partial` 在 app.css 里根本不存在（只有 stale / offline /
 *   failed / no-map 四条），样式静默退回基础 `.banner`，用户只看到一个琥珀小圆点。
 *
 * 本文件钉死两件事：
 *   1) grid 有自己如实的文案与 `banner--grid` 变体，不再借用 API 降级的 partial；
 *   2) app.css 里 `.banner--grid` 与 `.banner--partial` 两条规则都真的存在。
 *
 * 断言风格沿用 mapmode.test.mjs：渲染行为走运行时（假 DOM），装配约定走源码级
 * match / doesNotMatch，避免为了可测而给生产代码开后门。
 *
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs 的极简假 DOM。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  createFakeDom,
  installFetch,
  installNavigator,
  installStorage,
  FakeStorage,
  text,
} from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });
const fetchMock = installFetch();

const DOM_IDS = [{ id: 'app' }, { id: 'banner' }];
const dom = createFakeDom(DOM_IDS);
dom.document.readyState = 'loading';

const now = await import('../src/ui/now.js');
const app = await import('../src/ui/app.js');
const { sampleTiles, tileUrl, mapMode, setMapMode, MAP_MODE } = await import('../src/data/tiles.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const appSrc = read('src/ui/app.js');
const cssSrc = read('styles/app.css');
const zhSrc = read('src/i18n/zh.js');

/** 从文案表里抠出某个 key 的值。 */
const copyOf = (key) => {
  const m = zhSrc.match(new RegExp(`^\\s*'${key.replace('.', '\\.')}':\\s*'([^']*)'`, 'm'));
  return m ? m[1] : null;
};

beforeEach(() => {
  dom.byId['banner'].textContent = '';
  dom.byId['banner'].hidden = true;
  dom.byId['banner'].className = '';
});

test('grid 态横幅：class 是 banner--grid，文案是 mode.grid（不是 partial 那句）', () => {
  const bannerEl = dom.byId['banner'];
  now.renderBanner(bannerEl, 'grid');

  assert.equal(bannerEl.hidden, false, 'grid 属于降级态，横幅必须可见');
  assert.equal(
    bannerEl.className,
    'banner banner--grid',
    `grid 横幅必须挂 banner--grid 变体，实际 class='${bannerEl.className}'`
  );

  const bannerText = text(bannerEl);
  assert.equal(
    bannerText,
    copyOf('mode.grid'),
    `grid 横幅文案必须取 mode.grid，实际：${bannerText}`
  );
  // 这是本次缺陷的核心：grid 绝不能再套用「部分数据源不可用」那句
  assert.ok(
    !bannerText.includes(copyOf('mode.partial')),
    `grid 不得复用 partial 文案（会让用户以为天气数据坏了），实际：${bannerText}`
  );
  assert.ok(
    !bannerText.includes('数据源'),
    `grid 坏了的是瓦片不是数据源，文案里不该出现「数据源」三个字，实际：${bannerText}`
  );
});

test('grid 徽点复用琥珀色 stale 变体（不新增色值）', () => {
  const bannerEl = dom.byId['banner'];
  now.renderBanner(bannerEl, 'grid');
  const badge = bannerEl.children[0];
  assert.equal(
    badge.className,
    'badge badge--stale',
    `grid 徽点应复用 badge--stale（--c-state-stale 即 --c-warn），实际：${badge.className}`
  );
});

test('i18n：mode.grid 文案如实（说瓦片、说网格，不说数据源）', () => {
  const grid = copyOf('mode.grid');
  assert.ok(grid, "文案表缺少 mode.grid —— grid 会渲染出 'undefined'");
  assert.ok(grid.includes('瓦片'), `mode.grid 必须说清坏的是瓦片，实际：${grid}`);
  assert.ok(grid.includes('网格'), `mode.grid 必须说明已降为网格，实际：${grid}`);
  assert.ok(!grid.includes('数据源'), `mode.grid 不得出现「数据源」，实际：${grid}`);
  assert.notEqual(grid, copyOf('mode.partial'), 'mode.grid 不得与 mode.partial 同文案');
  assert.notEqual(grid, copyOf('mode.no-map'), 'mode.grid 不得与 no-map 同文案（半残 ≠ 没有）');
  // 「其余数据正常」这类断言式措辞在 grid 场景下是假话，any 降级态都不该这么写
  assert.ok(!grid.includes('其余数据正常'), `mode.grid 不得出现「其余数据正常」，实际：${grid}`);
});

test('app.js：横幅态先判 mapMode() === GRID，再回落 overallMode()', () => {
  assert.match(
    appSrc,
    /mapMode\(\)\s*===\s*MAP_MODE\.GRID/,
    '主页面必须先判 grid，否则 grid 会一路沿用 partial 的错误文案'
  );
  assert.match(
    appSrc,
    /import\s*\{[^}]*MAP_MODE[^}]*\}\s*from\s*'\.\.\/data\/tiles\.js'/,
    'app.js 需要从 tiles.js 引入 MAP_MODE / mapMode'
  );
  // 硬约束：overallMode() 的返回值一个字都不能改，只在展示层分支
  const healthSrc = read('src/data/health.js');
  assert.match(
    healthSrc,
    /if\s*\(mapMode\(\)\s*===\s*MAP_MODE\.GRID\)\s*return\s*'partial'/,
    "overallMode() 对 grid 仍必须返回 'partial'（健康层其他消费者依赖这个值）"
  );
});

test('app.js：三处横幅渲染全部走 _bannerMode()，不得直接喂 overallMode()', () => {
  assert.doesNotMatch(
    appSrc,
    /renderBanner\([^)]*overallMode\(\)/,
    'renderBanner 不得再直接吃 overallMode() —— grid 态会拿到 partial 的错误文案'
  );
  const hits = appSrc.match(/renderBanner\(bannerEl,\s*_bannerMode\(\)/g) || [];
  assert.equal(hits.length, 3, `横幅调用点应全部换成 _bannerMode()，实际 ${hits.length} 处`);
});

test('_bannerMode() 优先级：grid 压得过 partial，压不过 offline / empty / stale', () => {
  // 字面照搬「先判 grid 就返回 grid」会把更严重的三档一起盖掉：
  // 离线、没数据、数据陈旧都比「底图少了几块瓦片」更值得说。
  const m = appSrc.match(/const gridWins = ([^;]+);/);
  assert.ok(m, 'app.js 需要显式列出 grid 能压过哪几档，不能用一句无条件 return 糊过去');
  const wins = m[1];

  for (const mode of ['partial', 'no-map', 'live']) {
    assert.ok(wins.includes(`'${mode}'`), `grid 应能压过 ${mode}（否则 grid 态上不了屏）`);
  }
  for (const mode of ['offline', 'empty', 'stale']) {
    assert.ok(!wins.includes(`'${mode}'`), `grid 不得压过 ${mode} —— 那档比底图半残严重得多`);
  }
});

test('app.css：.banner--grid 与 .banner--partial 两条规则都真实存在', () => {
  assert.match(cssSrc, /\.banner--grid\s*\{/, '缺少 .banner--grid 规则（grid 横幅会退回基础样式）');
  assert.match(
    cssSrc,
    /\.banner--partial\s*\{/,
    '缺少 .banner--partial 规则 —— 这是原先的死样式钩，renderBanner 一直在拼这个 class'
  );
});

test('app.css：grid 变体用琥珀色 --c-warn，且比 partial 更重', () => {
  const gridRule = cssSrc.match(/\.banner--grid\s*\{([^}]*)\}/);
  const partialRule = cssSrc.match(/\.banner--partial\s*\{([^}]*)\}/);
  assert.ok(gridRule && partialRule, '两条规则都要能抠出来');

  assert.match(gridRule[1], /var\(--c-warn\)/, 'grid 必须走琥珀色 --c-warn（与徽点同源）');
  assert.match(gridRule[1], /border-color/, 'grid 需要有边框色');
  assert.match(gridRule[1], /background/, 'grid 需要有底色，不能只描一圈边框');
  assert.match(gridRule[1], /color:/, 'grid 需要保证文字对比度');

  // partial 说「数据缺一块」，比 grid 轻；两者不能共用同一个色阶
  const gridFill = Number((gridRule[1].match(/var\(--c-warn\)\s*(\d+)%/) || [])[1] || 0);
  const partialFill = Number((partialRule[1].match(/var\(--c-warn\)\s*(\d+)%/) || [])[1] || 0);
  assert.ok(gridFill > 0 && partialFill > 0, '两条规则的填充比例都要能从源码里读出来');
  assert.ok(
    gridFill > partialFill,
    `grid 的琥珀填充应重于 partial（${gridFill}% vs ${partialFill}%），否则两者撞脸`
  );
});

/* ------------------------------------------------------------------ */
/* 端到端：真跑一遍 boot()，看横幅到底上了什么                            */
/* ------------------------------------------------------------------ */

const ctx = { lat: 39.9087, lon: 116.3975 };

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
  features: [{ properties: { name: '天安门', street: '长安街', district: '东城区', city: '北京市', country: '中国' } }],
};

/** 五个 API 全部 200，只让 deadUrl 那一块瓦片 403；extra.dead 则整场全灭。 */
function routeFixture(extra = {}) {
  fetchMock.setHandler((url) => {
    if (extra.dead) return url.includes('arcgisonline.com') ? { status: 403, json: {} } : { status: 500, json: {} };
    if (url.includes('/v1/forecast')) return { json: WEATHER_JSON };
    if (url.includes('air-quality')) return { json: AIR_JSON };
    if (url.includes('/reverse')) return { json: REVERSE_JSON };
    if (url.includes('/v1/elevation')) return { json: { elevation: [43] } };
    if (url.includes('/v1/search')) return { json: { results: [{ name: '北京', latitude: 39.9075, longitude: 116.397 }] } };
    if (url.includes('arcgisonline.com')) {
      if (extra.deadUrl && url === extra.deadUrl) return { status: 403, json: {} };
      const m = url.match(/\/tile\/(\d+)\/(\d+)\/(\d+)$/);
      const [, z, y, x] = m ? m.map(Number) : [12, 0, 0];
      return { arrayBuffer: new Uint8Array([z & 255, y & 255, x & 255, (z + y + x) & 255]) };
    }
    return null;
  });
}

const drain = () => new Promise((r) => setTimeout(r, 40));

test('端到端：boot() 跑完「3 块坏 1 块」，横幅真挂 banner--grid 与 grid 文案', async () => {
  // 单元用例能造出 grid、源码里也确实判了 grid，都不等于主页面真的上屏了 grid。
  // 这是本次缺陷的最后一公里：五个 API 全绿，只有一块瓦片 403。
  setMapMode(MAP_MODE.MAP);
  localStorage.clear();
  fetchMock.reset();
  const tiles = sampleTiles(ctx);
  routeFixture({ deadUrl: tileUrl('street', tiles[1].z, tiles[1].x, tiles[1].y) });

  await app.boot();
  await drain();

  assert.equal(mapMode(), MAP_MODE.GRID, '3 块坏 1 块必须落到 grid（不是 no-map，也不是 map）');

  const bannerEl = dom.byId['banner'];
  assert.equal(
    bannerEl.className,
    'banner banner--grid',
    `主页面横幅必须挂 banner--grid，实际 class='${bannerEl.className}'`
  );
  const bannerText = text(bannerEl);
  assert.equal(bannerText, copyOf('mode.grid'), `主页面横幅文案必须是 mode.grid，实际：${bannerText}`);
  assert.ok(
    !bannerText.includes('数据源'),
    `五个 API 都正常，横幅不得出现「数据源」字样，实际：${bannerText}`
  );
});

test('empty 是最重的一档：红系 --c-alert，且色阶压过 grid / partial', () => {
  const emptyRule = cssSrc.match(/\.banner--empty\s*\{([^}]*)\}/);
  assert.ok(emptyRule, '缺少 .banner--empty 规则 —— 关键源全败时横幅会静默退回基础样式');
  assert.match(emptyRule[1], /var\(--c-alert\)/, 'empty 必须走红系告警色 --c-alert');

  const fillOf = (sel) => {
    const r = cssSrc.match(new RegExp(`\\.banner--${sel}\\s*\\{([^}]*)\\}`));
    return Number((r[1].match(/var\(--c-(?:alert|warn)\)\s*(\d+)%/) || [])[1] || 0);
  };
  assert.ok(
    fillOf('empty') > fillOf('grid'),
    `empty 的填充必须重于 grid（${fillOf('empty')}% vs ${fillOf('grid')}%）：一个数据都没有，比底图少几块瓦片严重`
  );
  assert.ok(
    fillOf('grid') > fillOf('partial'),
    `grid 的填充必须重于 partial（${fillOf('grid')}% vs ${fillOf('partial')}%）`
  );
  // 文字色必须走随主题翻转的 --c-text-1，不能用告警色本身当文字色
  //（红字压深底在深色屏下会掉到 4.5:1 以下）
  assert.match(emptyRule[1], /color:\s*var\(--c-text-1\)/, 'empty 的文字色必须用 --c-text-1');
});

test('端到端：关键源全败且无缓存 → 横幅真挂 banner--empty', async () => {
  // QA 的 ui.test.mjs 已证明 empty 可达并断言了文案，但没断言 class。
  // 这里补上最后一环：class 也必须是 banner--empty，且 app.css 里真有这条规则。
  setMapMode(MAP_MODE.MAP);
  localStorage.clear();
  fetchMock.reset();
  routeFixture({ dead: true });

  await app.boot();
  await drain();

  const bannerEl = dom.byId['banner'];
  assert.equal(bannerEl.hidden, false, '完全没数据时横幅必须可见');
  assert.equal(
    bannerEl.className,
    'banner banner--empty',
    `空态横幅必须挂 banner--empty，实际 class='${bannerEl.className}'`
  );
  assert.equal(text(bannerEl), copyOf('mode.empty'), `空态横幅文案必须是 mode.empty，实际：${text(bannerEl)}`);
  assert.ok(
    cssSrc.includes('.banner--empty'),
    'CSS 里必须有 .banner--empty 规则，否则这个 class 是空的、横幅静默退回基础样式'
  );
});

test('renderBanner 会拼出的可达变体，CSS 里都有钩子（stale/partial/grid/empty/offline/no-map）', () => {
  // 变体名由 `banner banner--${mode}` 直接拼出：少一条规则就是静默退回基础横幅，
  // 不会报错、不会告警，只有肉眼能发现 —— 所以必须在这里钉死。
  // 不含 'live'（横幅直接 hidden，不需要样式）与 'failed'（overallMode() 从不返回，不可达）。
  for (const mode of ['stale', 'partial', 'grid', 'empty', 'offline', 'no-map']) {
    assert.ok(
      cssSrc.includes(`.banner--${mode}`),
      `app.css 缺少 .banner--${mode}：renderBanner('${mode}') 会拿到基础横幅样式`
    );
  }
});
