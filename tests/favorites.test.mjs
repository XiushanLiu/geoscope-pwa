/**
 * 收藏功能端到端验证
 *
 * 背景：store.js 的 addFavorite / getFavorites 早就写好，但界面上没有任何入口 ——
 * 真机导出的两份备份里 favorites 都是 []。本轮把收藏补成完整闭环
 * （能添加 / 能看见 / 能跳转 / 能删除），这一组用例就是那条闭环的护栏。
 *
 * 覆盖：
 *   1) removeFavorite 命中 / 未命中 / 删后落盘；
 *   2) URL 参数解析：合法 / 缺参 / 只有 lat / 越界 / 非数字 / 空串；
 *   3) ★source:'explicit' 时 isDefaultPlace 必须是 false（旧写法 !== 'gps' 会判错）；
 *      （'explicit' 由 'favorite' 改名而来：这条 URL 通路现在还承载地点搜索结果，
 *        继续叫「收藏」是假话。语义未变，只是名字中性化。）
 *   4) 收藏按钮 toggle 往返（加 → 已收藏 → 取消 → 未收藏）；
 *   5) 我的页收藏列表渲染 + 删除后条数变化 + 空态 + 导出卡计数同步；
 *   6) ★逆地理未返回时点收藏：name 用坐标串兜底，绝不留空（缺陷 A 护栏）；
 *      以及 placeName 写回后必须被「点击时现读」到（钉死不抓闭包）；
 *   7) ★导入全链路（选文件 → 预览 → 确认）后条数 / 导出卡 {count} / 我的页计数三处同步
 *      （M13 护栏：删掉 settings.js 的 _onConfirm() 里那句 _refreshFavorites() 必须报红）。
 *
 * 环境：与 ui.test.mjs 同一套路 —— 装好假 DOM / 假 localStorage 后再 import
 * 被测模块（now.js 与 settings.js 都在模块顶层引导主题，没有 document 会炸）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeDom,
  installFetch,
  installNavigator,
  installStorage,
  FakeStorage,
  text,
} from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0', connection: null });
const fetchMock = installFetch();

const DOM_IDS = [
  { id: 'app' }, { id: 'banner' },
  // 导出卡的两个文案位：预置进索引，settings.js 的 _refreshExport() 才能被观测到
  { id: 'export-current' }, { id: 'export-privacy' },
  // 导入链路的四个交互位：settings.js 用 _el(id)（= document.getElementById）取节点，
  // 而假 DOM 的索引只收录预置 id —— 不预置就拿不到，走不完「选文件 → 预览 → 确认」
  { id: 'file-backup' }, { id: 'import-preview' }, { id: 'import-result' }, { id: 'btn-confirm' },
];

/**
 * 假 FileReader：Node 22 有 File / Blob 但没有 FileReader 全局。
 *
 * 只实现 settings.js 的 _readFileAsText() 真正用到的成员：
 * readAsText() + result / error / onload / onerror。
 */
class FakeFileReader {
  /**
   * 读文件为文本（异步回调，与浏览器一致）。
   *
   * @param {Object} file File 对象（Node 的 File 自带 text()）。
   * @returns {void}
   */
  readAsText(file) {
    Promise.resolve()
      .then(() => (file && typeof file.text === 'function' ? file.text() : String(file || '')))
      .then((s) => {
        this.result = s;
        if (typeof this.onload === 'function') this.onload();
      })
      .catch((err) => {
        this.error = err;
        if (typeof this.onerror === 'function') this.onerror();
      });
  }
}
Object.defineProperty(globalThis, 'FileReader', { value: FakeFileReader, configurable: true, writable: true });

const dom = createFakeDom(DOM_IDS);
const document = dom.document;
document.readyState = 'loading'; // 不让入口模块自动 boot/init，改为显式调用

const store = await import('../src/core/store.js');
const now = await import('../src/ui/now.js');
const settings = await import('../src/ui/settings.js');
const app = await import('../src/ui/app.js');
// ★2026-10-17 导航重构：parsePlaceParam / resolveCoord 已从 ui/app.js 迁到 core/geo.js。
const geo = await import('../src/core/geo.js');

/** 上海人民广场。 */
const SH = { lat: 31.2304, lon: 121.4737, name: '上海 · 人民广场' };
/** 北京天安门（store 的出厂默认地点）。 */
const BJ = { lat: 39.9087, lon: 116.3975, name: '北京 · 天安门' };

/**
 * 读取落盘的收藏（证明「删完 _persist() 了」，而不只是内存态变了）。
 *
 * @returns {Array<{lat:number, lon:number, name:string}>} 盘上的收藏。
 */
function persistedFavorites() {
  const raw = localStorage.getItem('gs:v1:store:prefs');
  if (!raw) return [];
  const entry = JSON.parse(raw);
  return (entry && entry.v && Array.isArray(entry.v.favorites) ? entry.v.favorites : []);
}

beforeEach(() => {
  localStorage.clear();
  store.resetStore();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: {} });
  globalThis.navigator.onLine = true;
  dom.byId['app'].textContent = '';
  dom.byId['banner'].textContent = '';
  dom.byId['export-current'].textContent = '';
  dom.byId['export-privacy'].textContent = '';
  if (globalThis.location) delete globalThis.location;
});

/* ------------------------------------------------------------------ */
/* 1. removeFavorite                                                    */
/* ------------------------------------------------------------------ */

test('removeFavorite 命中：删掉 lat+lon 精确相等的那一条，返回 true', () => {
  store.addFavorite(SH);
  store.addFavorite(BJ);
  assert.equal(store.getFavorites().length, 2);

  assert.equal(store.removeFavorite(SH.lat, SH.lon), true, '命中必须返回 true');
  const left = store.getFavorites();
  assert.equal(left.length, 1, '只删命中的那一条');
  assert.deepEqual(left[0], BJ, '删掉的必须是上海，留下的必须是北京');
});

test('removeFavorite 未命中：返回 false，列表一个字节都不动', () => {
  store.addFavorite(SH);
  const before = JSON.stringify(store.getFavorites());

  assert.equal(store.removeFavorite(1.2345, 6.789), false, '未命中必须返回 false');
  assert.equal(store.removeFavorite(SH.lat + 0.0001, SH.lon), false, '差 0.0001° 也是不同地点，不得误删');
  assert.equal(JSON.stringify(store.getFavorites()), before, '未命中时列表不得变化');
});

test('removeFavorite 删完落盘（重新读盘上就是删后的结果）', () => {
  store.addFavorite(SH);
  store.addFavorite(BJ);
  assert.equal(persistedFavorites().length, 2, 'addFavorite 已落盘');

  store.removeFavorite(SH.lat, SH.lon);
  const onDisk = persistedFavorites();
  assert.equal(onDisk.length, 1, '删除必须 _persist()，盘上不能还是 2 条');
  assert.equal(onDisk[0].lat, BJ.lat, '盘上剩下的必须是北京');
  // 内存态与盘上一致（getFavorites 读的是内存，这里两边一起钉）
  assert.equal(store.getFavorites().length, 1);
});

test('isFavorite 与 addFavorite 去重口径一致（精确 lat+lon）', () => {
  assert.equal(store.isFavorite(SH.lat, SH.lon), false);
  store.addFavorite(SH);
  assert.equal(store.isFavorite(SH.lat, SH.lon), true);
  assert.equal(store.isFavorite(SH.lat, SH.lon + 0.0001), false, '差 0.0001° 不算同一个地点');
  store.removeFavorite(SH.lat, SH.lon);
  assert.equal(store.isFavorite(SH.lat, SH.lon), false, '删掉后必须查不到');
});

/* ------------------------------------------------------------------ */
/* 2. URL 参数解析                                                       */
/* ------------------------------------------------------------------ */

test('URL 参数合法：解析出坐标与中文名，source 标记为 explicit', () => {
  const got = geo.parsePlaceParam('?lat=31.2304&lon=121.4737&name=' + encodeURIComponent('上海 · 人民广场'));
  assert.notEqual(got, null, '合法参数必须解析出结果');
  assert.equal(got.lat, 31.2304);
  assert.equal(got.lon, 121.4737);
  assert.equal(got.name, '上海 · 人民广场', '中文名必须解出来');
  assert.equal(got.source, 'explicit');
});

test('URL 参数：没有 name 时退化为空串，不崩', () => {
  const got = geo.parsePlaceParam('?lat=31.2304&lon=121.4737');
  assert.notEqual(got, null, 'name 是可选的，缺了也要能跳');
  assert.equal(got.name, '', '缺 name 必须退化成空串');
  assert.equal(got.source, 'explicit');
});

test('URL 参数非法：缺参 / 只有 lat / 越界 / 非数字 / 空串 全部返回 null', () => {
  assert.equal(geo.parsePlaceParam('?lat=31.2304'), null, '只有 lat 没有 lon → null');
  assert.equal(geo.parsePlaceParam('?lon=121.4737'), null, '只有 lon 没有 lat → null');
  assert.equal(geo.parsePlaceParam(''), null, '空查询串 → null');
  assert.equal(geo.parsePlaceParam('?debug=1'), null, '没有坐标参数 → null（不能把 debug 当成地点）');
  assert.equal(geo.parsePlaceParam('?lat=91&lon=121'), null, '纬度 91° 越界 → null');
  assert.equal(geo.parsePlaceParam('?lat=-91&lon=121'), null, '纬度 -91° 越界 → null');
  assert.equal(geo.parsePlaceParam('?lat=31&lon=181'), null, '经度 181° 越界 → null');
  assert.equal(geo.parsePlaceParam('?lat=31&lon=-181'), null, '经度 -181° 越界 → null');
  assert.equal(geo.parsePlaceParam('?lat=abc&lon=121'), null, '非数字 → null');
  assert.equal(geo.parsePlaceParam('?lat=31&lon=abc'), null, '非数字 → null');
  // ★空串绝不能被 Number('')===0 兜成「几内亚湾 0,0」这个真实存在的地点
  assert.equal(geo.parsePlaceParam('?lat=&lon='), null, '空串 → null');
  assert.equal(geo.parsePlaceParam('?lat=%20&lon=121'), null, '纯空格 → null');
  assert.equal(geo.parsePlaceParam('?lat=Infinity&lon=121'), null, 'Infinity → null');
});

test('URL 参数：边界值 ±90 / ±180 视为合法', () => {
  assert.notEqual(geo.parsePlaceParam('?lat=90&lon=180'), null, '90/180 是合法边界');
  assert.notEqual(geo.parsePlaceParam('?lat=-90&lon=-180'), null, '-90/-180 是合法边界');
});

test('★URL 参数只收十进制字面量：十六进制 / 科学计数法 / 前导 + 号一律不收，0,0 必须收', () => {
  // Number() 会接受非十进制字面量 —— 0x10 → 16，旧实现正是被它兜成 16,16
  assert.equal(geo.parsePlaceParam('?lat=0x10&lon=0x10'), null, '十六进制 0x10 不得被 Number() 兜成 16');
  assert.equal(geo.parsePlaceParam('?lat=0x0&lon=0x0'), null, '十六进制 0x0 也不收');
  assert.equal(geo.parsePlaceParam('?lat=1e2&lon=1e2'), null, '科学计数法 1e2 不收（见 core/geo.js 的取舍说明）');
  assert.equal(geo.parsePlaceParam('?lat=%2B31&lon=121'), null, '前导 + 号不收');
  assert.equal(geo.parsePlaceParam('?lat=.5&lon=121'), null, '省略整数位的「.5」不收');
  assert.equal(geo.parsePlaceParam('?lat=31.&lon=121'), null, '尾随小数点的「31.」不收');
  assert.equal(geo.parsePlaceParam('?lat=-Infinity&lon=121'), null, '-Infinity 不收');

  // ★真实的零点必须保持合法：0,0（几内亚湾）是个真实地点，不能被「像空值」误杀
  const zero = geo.parsePlaceParam('?lat=0&lon=0');
  assert.notEqual(zero, null, '0,0 是真实地点，必须解析成功');
  assert.equal(zero.lat, 0, 'lat 必须是数字 0');
  assert.equal(zero.lon, 0, 'lon 必须是数字 0');

  // 小数与负数照常放行
  const dec = geo.parsePlaceParam('?lat=-31.2304&lon=121.4737');
  assert.notEqual(dec, null, '负小数必须合法');
  assert.equal(dec.lat, -31.2304);
  assert.equal(dec.lon, 121.4737);
  assert.notEqual(geo.parsePlaceParam('?lat=0.0000&lon=-0.0000'), null, '带小数的零点也合法');
});

/* ------------------------------------------------------------------ */
/* 3. ★isDefaultPlace 语义                                              */
/* ------------------------------------------------------------------ */

test('★source=explicit 时 isDefaultPlace 必须为 false（旧写法 !== "gps" 会判成 true）', () => {
  const r = geo.resolveCoord({ lat: SH.lat, lon: SH.lon, name: SH.name, source: 'explicit' });
  assert.equal(r.isDefaultPlace, false, '从收藏 / 搜索跳过去绝不能显示「未取得定位，正在显示默认地点」');
  assert.equal(r.base.source, 'explicit');
  assert.equal(r.base.lat, SH.lat);
  assert.equal(r.base.lon, SH.lon);
});

test('resolveCoord：default 为真、gps 为假，三条来源互斥', () => {
  assert.equal(geo.resolveCoord({ lat: 1, lon: 2, source: 'default' }).isDefaultPlace, true, '兜底地点才算默认地点');
  assert.equal(geo.resolveCoord({ lat: 1, lon: 2, source: 'gps' }).isDefaultPlace, false, 'GPS 定位不是默认地点');
  assert.equal(geo.resolveCoord({ lat: 1, lon: 2, source: 'explicit' }).isDefaultPlace, false, '用户显式指定的地点不是默认地点');
});

test('★boot 带收藏参数：跳过定位、渲染该地点，且不出现「未取得定位」提示', async () => {
  // 让离线分支有缓存可读（否则会走空态把整屏清掉，看不到标题区）
  const cache = await import('../src/core/cache.js');
  cache.set(`gs:v1:weather:${SH.lat}:${SH.lon}`, {
    atMs: Date.now(), tzOffsetSec: 28800, tempC: 28.4, wmoCode: 0, feelsC: 29,
    humidityPct: 60, precipMm: 0, windMs: 2, windDeg: 90, pressureHpa: 1008,
    visibilityM: 10000, sunriseAt: Date.now(), sunsetAt: Date.now(), uvMax: 4,
    todayMaxC: 30, todayMinC: 22, hourlyTempC: [], hourlyPopPct: [],
  }, 600000);
  globalThis.navigator.onLine = false;

  Object.defineProperty(globalThis, 'location', {
    value: { search: `?lat=${SH.lat}&lon=${SH.lon}&name=${encodeURIComponent(SH.name)}` },
    configurable: true,
    writable: true,
  });

  const before = fetchMock.count;
  await app.boot();
  assert.equal(fetchMock.count, before, '离线时不发请求（本条只验坐标来源，不验网络）');

  const full = text(dom.byId['app']);
  assert.ok(full.indexOf('31.2304°N, 121.4737°E') !== -1, `必须渲染 URL 指定的坐标，实际：${full.slice(0, 200)}`);
  assert.ok(
    full.indexOf('未取得定位') === -1,
    `从收藏跳过去绝不能显示「未取得定位，正在显示默认地点」，实际：${full.slice(0, 200)}`
  );
  // 2026-11-05 起地名经 fmt.placeTitle() 排版加固：间隔号前是不换行空格（NBSP），
  // 断言必须钉住新形态 —— 「·」不许再出现在行首（中文行首禁则）。
  assert.ok(full.indexOf('上海\u00A0· 人民广场') !== -1, `URL 上的名字必须显示出来，实际：${full.slice(0, 200)}`);
  globalThis.navigator.onLine = true;
});

test('boot 无收藏参数：行为不变（定位被拒 → 默认地点 + 未取得定位提示）', async () => {
  const cache = await import('../src/core/cache.js');
  cache.set(`gs:v1:weather:${BJ.lat}:${BJ.lon}`, {
    atMs: Date.now(), tzOffsetSec: 28800, tempC: 20, wmoCode: 0, feelsC: 20,
    humidityPct: 50, precipMm: 0, windMs: 1, windDeg: 0, pressureHpa: 1010,
    visibilityM: 10000, sunriseAt: Date.now(), sunsetAt: Date.now(), uvMax: 2,
    todayMaxC: 25, todayMinC: 15, hourlyTempC: [], hourlyPopPct: [],
  }, 600000);
  globalThis.navigator.onLine = false;

  await app.boot();
  const full = text(dom.byId['app']);
  assert.ok(full.indexOf('39.9087°N, 116.3975°E') !== -1, `无参数时必须走原定位流程显示默认地点，实际：${full.slice(0, 200)}`);
  assert.ok(full.indexOf('未取得定位') !== -1, '真正兜底时才显示「未取得定位」提示');
  globalThis.navigator.onLine = true;
});

/* ------------------------------------------------------------------ */
/* 4. 收藏按钮 toggle 往返                                               */
/* ------------------------------------------------------------------ */

test('收藏按钮往返：未收藏 → 点击 → 已收藏 → 再点 → 未收藏（store 与按钮同步）', () => {
  const root = document.createElement('div');
  const snapshot = { atMs: null, coord: { lat: SH.lat, lon: SH.lon, source: 'gps' }, placeName: SH.name, provenance: [] };
  now.renderSkeleton(root);
  now.renderHeader(root, snapshot, {});

  const btn = () => root.querySelector('.fav-btn');
  assert.notEqual(btn(), null, '有坐标时必须渲染收藏按钮');
  assert.equal(btn().getAttribute('aria-pressed'), 'false', '初始为未收藏');
  assert.equal(btn().getAttribute('type'), 'button', '必须 type=button（键盘可访问且不提交表单）');
  assert.ok(text(btn()).indexOf('收藏此地') !== -1, `未收藏态文案应为「收藏此地」，实际：${text(btn())}`);
  assert.equal(store.getFavorites().length, 0);

  // ① 收藏
  btn().click();
  assert.equal(store.getFavorites().length, 1, '点击后必须真的写进 store');
  assert.deepEqual(
    store.getFavorites()[0],
    { lat: SH.lat, lon: SH.lon, name: SH.name },
    '存的是 {lat, lon, name}，且名字取当前显示的地名'
  );
  assert.equal(btn().getAttribute('aria-pressed'), 'true', '按钮必须就地翻成已收藏');
  assert.ok(text(btn()).indexOf('已收藏') !== -1, `已收藏态文案必须变化，实际：${text(btn())}`);

  // ② 整槽重建（renderHeader 再跑一次）后，状态从 store 重读，仍是已收藏
  now.renderHeader(root, snapshot, {});
  assert.equal(root.querySelector('.fav-btn').getAttribute('aria-pressed'), 'true', '重建后必须从 store 读回已收藏');
  assert.ok(root.querySelector('.fav-btn').className.indexOf('fav-btn--on') !== -1, '已收藏态必须带 fav-btn--on');

  // ③ 取消收藏
  root.querySelector('.fav-btn').click();
  assert.equal(store.getFavorites().length, 0, '再点一次必须删掉');
  assert.equal(root.querySelector('.fav-btn').getAttribute('aria-pressed'), 'false', '按钮必须翻回未收藏');

  // ④ 已收藏状态不会重复写入（addFavorite 自身去重，第二条校验往返稳定）
  root.querySelector('.fav-btn').click();
  root.querySelector('.fav-btn').click();
  assert.equal(store.getFavorites().length, 0, '连续两次点击 = 一加一删，回到未收藏');
});

test('收藏按钮：无坐标时不渲染（没有坐标就存不出能跳回去的收藏）', () => {
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderHeader(root, { coord: null, provenance: [] }, {});
  assert.equal(root.querySelector('.fav-btn'), null, '无坐标时不得给出点了没反应的按钮');
});

test('收藏按钮：点击后给出短暂反馈文案（加 / 取消各一句，走 i18n）', () => {
  const root = document.createElement('div');
  const snapshot = { atMs: null, coord: { lat: SH.lat, lon: SH.lon, source: 'gps' }, placeName: SH.name, provenance: [] };
  now.renderSkeleton(root);
  now.renderHeader(root, snapshot, {});

  const hint = () => root.querySelector('.hd-hint');
  assert.equal(text(hint()), '', '初始没有反馈文案');

  root.querySelector('.fav-btn').click();
  assert.ok(text(hint()).indexOf('已收藏') !== -1, `收藏后必须给反馈，实际：「${text(hint())}」`);

  root.querySelector('.fav-btn').click();
  assert.ok(text(hint()).indexOf('已取消收藏') !== -1, `取消后反馈文案应变化，实际：「${text(hint())}」`);
});

/* ------------------------------------------------------------------ */
/* 5. 我的页：收藏列表                                                    */
/* ------------------------------------------------------------------ */

test('我的页：空收藏时显示引导文案，说明「收藏后会出现在这里，备份时会一起导出」', () => {
  settings.init();
  const listText = text(dom.byId['app'].querySelector('#fav-list'));
  assert.ok(listText.indexOf('还没有收藏地点') !== -1, `空态必须给出引导，实际：${listText}`);
  assert.ok(listText.indexOf('备份') !== -1, `空态必须讲清与备份的关系，实际：${listText}`);
  assert.equal(dom.byId['app'].querySelectorAll('.fav-item').length, 0, '空态不得渲染任何条目');
});

test('我的页：收藏列表渲染出地点名与等宽经纬度，跳转链接带 encodeURIComponent 后的中文名', () => {
  store.addFavorite(SH);
  store.addFavorite(BJ);
  settings.init();

  const items = dom.byId['app'].querySelectorAll('.fav-item');
  assert.equal(items.length, 2, `应渲染 2 条收藏，实际 ${items.length}`);

  const first = items[0];
  assert.ok(text(first).indexOf('上海 · 人民广场') !== -1, `第一条应是上海，实际：${text(first)}`);
  assert.ok(text(first).indexOf('31.2304°N, 121.4737°E') !== -1, `必须显示经纬度，实际：${text(first)}`);
  // 经纬度必须走等宽排版（项目既有 .num 类）
  const coordNode = first.querySelector('.fav-coord');
  assert.notEqual(coordNode, null, '经纬度节点必须存在');
  assert.ok(coordNode.className.indexOf('num') !== -1, `经纬度必须用 .num（等宽），实际 class=${coordNode.className}`);

  const href = first.querySelector('.fav-link').getAttribute('href');
  assert.equal(
    href,
    `index.html?lat=${SH.lat}&lon=${SH.lon}&name=${encodeURIComponent(SH.name)}`,
    '跳转链接必须带 lat/lon 与 encodeURIComponent 过的中文名'
  );
  assert.ok(href.indexOf('%E4%B8%8A%E6%B5%B7') !== -1, `中文名必须是百分号编码，实际：${href}`);
});

test('我的页：点删除 → 该条消失、条数减一、导出卡 {count} 同步刷新', () => {
  store.addFavorite(SH);
  store.addFavorite(BJ);
  settings.init();

  assert.equal(dom.byId['app'].querySelectorAll('.fav-item').length, 2);
  const exportBefore = text(dom.byId['export-current']);
  assert.ok(exportBefore.indexOf('收藏 2 条') !== -1, `导出卡应显示 2 条，实际：${exportBefore}`);

  // 删第一条（上海）
  const delBtn = dom.byId['app'].querySelectorAll('.fav-item')[0].querySelector('.btn');
  delBtn.click();

  assert.equal(store.getFavorites().length, 1, 'store 里必须真的删掉一条');
  assert.equal(store.getFavorites()[0].lat, BJ.lat, '删掉的必须是上海');
  const items = dom.byId['app'].querySelectorAll('.fav-item');
  assert.equal(items.length, 1, `列表必须重画成 1 条，实际 ${items.length}`);
  assert.ok(text(items[0]).indexOf('北京 · 天安门') !== -1, '留下来的必须是北京');

  // ★导出卡必须跟着刷新，否则还显示旧条数
  const exportAfter = text(dom.byId['export-current']);
  assert.ok(exportAfter.indexOf('收藏 1 条') !== -1, `导出卡 {count} 必须同步，实际：${exportAfter}`);
  assert.notEqual(exportAfter, exportBefore, '导出卡文案必须真的变了');
});

test('我的页：删到最后一条 → 回到空态，导出卡回到 0 条', () => {
  store.addFavorite(SH);
  settings.init();
  assert.equal(dom.byId['app'].querySelectorAll('.fav-item').length, 1);

  dom.byId['app'].querySelectorAll('.fav-item')[0].querySelector('.btn').click();

  assert.equal(store.getFavorites().length, 0);
  assert.equal(dom.byId['app'].querySelectorAll('.fav-item').length, 0, '删空后不得残留条目');
  const listText = text(dom.byId['app'].querySelector('#fav-list'));
  assert.ok(listText.indexOf('还没有收藏地点') !== -1, `删空后必须回到空态，实际：${listText}`);
  assert.ok(text(dom.byId['export-current']).indexOf('收藏 0 条') !== -1, '导出卡必须回到 0 条');
});

test('我的页：无名字的收藏显示「未命名地点」，链接里 name 为空串', () => {
  store.addFavorite({ lat: 0, lon: 0, name: '' });
  settings.init();
  const item = dom.byId['app'].querySelectorAll('.fav-item')[0];
  assert.ok(text(item).indexOf('未命名地点') !== -1, `无名字必须显示占位名，实际：${text(item)}`);
  assert.equal(
    item.querySelector('.fav-link').getAttribute('href'),
    'index.html?lat=0&lon=0&name=',
    'name 为空时链接里也是空串'
  );
});

/* ------------------------------------------------------------------ */
/* 6. ★逆地理未返回时点收藏（缺陷 A）                                     */
/* ------------------------------------------------------------------ */

/**
 * 造一棵已渲染标题区的 DOM（骨架 + 标题），返回根节点。
 *
 * @param {Object} snapshot NowSnapshot。
 * @returns {Object} 根容器。
 */
function renderHeaderOnly(snapshot) {
  const root = document.createElement('div');
  now.renderSkeleton(root);
  now.renderHeader(root, snapshot, {});
  return root;
}

test('★首屏 placeName 为 null 时点收藏：存进去的 name 绝不能是空串，必须是坐标串', () => {
  // 复现 QA 的实测场景：GPS 已成功、逆地理（Photon）还没回来
  const root = renderHeaderOnly({ atMs: null, coord: { lat: 22.5431, lon: 114.0579, source: 'gps' }, placeName: null, provenance: [] });

  root.querySelector('.fav-btn').click();

  const favs = store.getFavorites();
  assert.equal(favs.length, 1, '点击必须真的写进 store');
  assert.equal(favs[0].lat, 22.5431, '坐标必须是当前定位');
  assert.equal(favs[0].lon, 114.0579);
  assert.notEqual(favs[0].name, '', '★name 绝不能是空串（空串在「我的」页显示成「未命名地点」）');
  assert.equal(favs[0].name, '22.5431°N, 114.0579°E', `★必须是可读的坐标串，实际：「${favs[0].name}」`);

  // 落到「我的」页：不得出现「未命名地点」
  dom.byId['app'].textContent = '';
  settings.init();
  const listText = text(dom.byId['app'].querySelector('#fav-list'));
  assert.ok(listText.indexOf('未命名地点') === -1, `★我的页不得显示「未命名地点」，实际：${listText}`);
  assert.ok(listText.indexOf('22.5431°N, 114.0579°E') !== -1, `坐标必须显示出来，实际：${listText}`);
});

test('★同一颗按钮上 placeName 被后台写回后（不重建按钮）点收藏 → 必须拿到真实地名', () => {
  // 这一条钉的是「click 时现读」而不是「构造时抓闭包」：
  // 按钮只在首屏渲染过一次，placeName 是渲染之后才被 _background() 写回的。
  const snapshot = { atMs: null, coord: { lat: 22.5431, lon: 114.0579, source: 'gps' }, placeName: null, provenance: [] };
  const root = renderHeaderOnly(snapshot);

  // 模拟逆地理返回（app.js 的 _background() 就是这么原地改 placeName 的），**不重画**
  snapshot.placeName = '深圳 · 福田';

  root.querySelector('.fav-btn').click();

  const favs = store.getFavorites();
  assert.equal(favs.length, 1);
  assert.equal(favs[0].name, '深圳 · 福田', `★必须读到写回后的真实地名，实际：「${favs[0].name}」`);
});

test('★逆地理返回后重新渲染标题再收藏 → 拿到真实地名（坐标兜底不误伤正常路径）', () => {
  const snapshot = { atMs: null, coord: { lat: 22.5431, lon: 114.0579, source: 'gps' }, placeName: null, provenance: [] };
  const root = renderHeaderOnly(snapshot);

  // 后台反查写回 + 重画标题（renderHeader 会造一颗新按钮）
  snapshot.placeName = '深圳 · 福田';
  now.renderHeader(root, snapshot, {});

  root.querySelector('.fav-btn').click();
  assert.equal(
    store.getFavorites()[0].name,
    '深圳 · 福田',
    `反查到地名后收藏，存进去的必须是真名，实际：「${store.getFavorites()[0].name}」`
  );
});

test('★零点（几内亚湾）无地名时也能兜底成坐标串，不留空', () => {
  const root = renderHeaderOnly({ atMs: null, coord: { lat: 0, lon: 0, source: 'gps' }, placeName: null, provenance: [] });
  root.querySelector('.fav-btn').click();
  const favs = store.getFavorites();
  assert.notEqual(favs[0].name, '', '0,0 也不得存成空串');
  assert.equal(favs[0].name, '0.0000°N, 0.0000°E', `实际：「${favs[0].name}」`);
});

test('★coord.name 已有名字（收藏跳转 / 默认地点）时优先用它，不被坐标串覆盖', () => {
  const root = renderHeaderOnly({ atMs: null, coord: { lat: 39.9087, lon: 116.3975, source: 'default', name: '北京 · 天安门' }, placeName: null, provenance: [] });
  root.querySelector('.fav-btn').click();
  assert.equal(store.getFavorites()[0].name, '北京 · 天安门');
});

/* ------------------------------------------------------------------ */
/* 7. ★导入全链路回归（M13 护栏）                                         */
/* ------------------------------------------------------------------ */

/**
 * 造一份合法备份 JSON（schema / app / prefs 三件套齐全，否则 inspectBackup 会拒）。
 *
 * @param {Array<{lat:number, lon:number, name:string}>} favorites 备份里的收藏。
 * @returns {string} JSON 文本。
 */
function makeBackupJson(favorites) {
  return JSON.stringify({
    schema: 1,
    app: 'geoscope',
    exportedAt: '2026-01-05T12:34:56.000Z',
    prefs: {
      defaultPlace: { lat: 31.2304, lon: 121.4737, name: '上海 · 人民广场' },
      unitSystem: 'metric',
      networkType: 'unknown',
      debug: false,
      favorites: favorites.map((f) => ({ lat: f.lat, lon: f.lon, name: f.name })),
    },
    snapshot: null,
  });
}

test('★导入全链路（选文件 → 预览 → 确认）：收藏条数 / 导出卡 {count} / 我的页计数三处同步', async () => {
  // 起点：本机先有 1 条**别的**收藏 —— 让「导入后条数 = 备份条数」不是碰巧相等，
  // 也让「三处同步」有可观测的差值（1 → 2）。
  store.addFavorite({ lat: 23.1291, lon: 113.2644, name: '广州 · 越秀' });
  dom.byId['app'].textContent = '';
  dom.byId['export-current'].textContent = '';
  dom.byId['import-preview'].textContent = '';
  dom.byId['import-result'].textContent = '';
  // ★这两个预置节点跨用例复用，而 settings.init() 每次调用都会再挂一遍监听 ——
  // 前面几个用例各挂过一次，不清干净的话一次 click 会连跑 N 遍 _onConfirm
  // （第一遍写入成功并把 _plan 清空，后面 N-1 遍都会报「请先选择一个备份文件」）。
  // 清的是累积下来的旧监听，本次 settings.init() 挂的那一遍不受影响。
  dom.byId['file-backup'].listeners.clear();
  dom.byId['btn-confirm'].listeners.clear();
  settings.init();

  assert.equal(dom.byId['app'].querySelectorAll('.fav-item').length, 1, '导入前本机 1 条');
  assert.ok(text(dom.byId['export-current']).indexOf('收藏 1 条') !== -1, '导入前导出卡写 1 条');

  // ① 选文件
  const file = new File(
    [makeBackupJson([SH, BJ])],
    'geoscope-backup-20260105-1234.json',
    { type: 'application/json' }
  );
  const input = dom.byId['file-backup'];
  input.files = [file];
  await input.fire('change');

  // ② 预览：只校验不写入，本机状态一个字节都不许动
  assert.equal(store.getFavorites().length, 1, '未确认前不得写入');
  const preview = text(dom.byId['import-preview']);
  assert.ok(preview.indexOf('收藏地点：2 条') !== -1, `预览必须列出备份里的收藏条数，实际：${preview}`);
  assert.equal(dom.byId['btn-confirm'].disabled, false, '确认按钮必须解锁');

  // ③ 确认导入
  dom.byId['btn-confirm'].click();

  // ④ 三处必须同步（缺任何一处，用户都会以为备份里带着的地点没回来）
  assert.equal(store.getFavorites().length, 2, '★收藏列表条数必须 = 备份里的条数');
  assert.equal(persistedFavorites().length, 2, '导入后必须落盘');
  assert.equal(
    dom.byId['app'].querySelectorAll('.fav-item').length,
    2,
    '★「我的」页列表必须重画成 2 条'
  );
  const exportAfter = text(dom.byId['export-current']);
  assert.ok(exportAfter.indexOf('收藏 2 条') !== -1, `★导出卡 {count} 必须与实际条数一致，实际：${exportAfter}`);
  const countLine = dom.byId['app'].querySelector('#fav-count');
  assert.ok(text(countLine).indexOf('共 2 条') !== -1, `★我的页收藏计数文案必须同步，实际：${text(countLine)}`);
  assert.ok(
    text(dom.byId['import-result']).indexOf('收藏 2 条') !== -1,
    `导入结果文案里的条数也要对，实际：${text(dom.byId['import-result'])}`
  );

  // 导回去的确实是备份里的那两条（顺序与内容都对得上）
  const names = store.getFavorites().map((f) => f.name);
  assert.deepEqual(names, ['上海 · 人民广场', '北京 · 天安门'], `实际：${JSON.stringify(names)}`);
});
