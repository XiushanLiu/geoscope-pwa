/**
 * 「默认地点」（src/ui/defaultplace.js + 设置页那张卡）的行为测试。
 *
 * 为什么单独一个文件：这张卡踩的坑全是**「不报错、只是悄悄写错」**那一类 ——
 *   1) 定位失败时把 `core/geo.js` 的兜底坐标（北京天安门）当成「我的位置」写进去。
 *      那不是用户的位置，是占位；写进去等于把一句假话持久化，还会随备份导出 / 导入
 *      带到别的设备上继续冒充「你的位置」。所以 `canAdoptGps()` 为假时必须**一个字节
 *      都不写**，并如实报失败原因（拒绝 / 超时 / 环境不支持）。
 *   2) 写完不重画卡片：第一行「现在是：…」纹丝不动，用户以为没生效于是反复点 ——
 *      状态其实早就变了，界面在说假话。
 *   3) `adoptFavorite()` 找不到时回退出厂默认：那等于「没找到」被说成「用了默认值」，
 *      正是第 1 条那句假话的另一种写法。
 *
 * 环境：复用 tests/harness.mjs 的假 DOM + 假 localStorage + 假 navigator
 * （假 navigator 的 `geolocation` 为 null → 本文件里「定位失败」走的是
 *  **环境不支持**那一档，正好是要钉的那一档）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFakeDom, installNavigator, installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
// 假 navigator 的 `geolocation` 默认是 null（＝环境不支持，正好钉「不支持」那一档）；
// 下面「定位成功」那条用例会临时把它换成假的 getCurrentPosition，用完立刻换回去。
const nav = installNavigator({ online: true });

// 只预置设置页真正会 getElementById 的那几个 id（同 csv-card.test.mjs 的做法）。
// 卡片自己造的节点（btn-dp-gps / dp-current / dp-result …）不在静态 HTML 里，
// 假 DOM 的索引表认不到 —— 所以下面一律从 #app 子树里按属性找，不走 byId。
const dom = createFakeDom([
  { id: 'app' },
  { id: 'theme-mode' },
  { id: 'font-scale' },
  { id: 'font-result' },
  { id: 'csv-result' },
  { id: 'export-current' },
  { id: 'export-privacy' },
]);

/** 必须在 import 被测模块之前装好全局（store.js 在加载期决定走内存还是 localStorage）。 */
const dp = await import('../src/ui/defaultplace.js');
const store = await import('../src/core/store.js');
const { init } = await import('../src/ui/settings.js');
const { t } = await import('../src/i18n/index.js');

const { setDefaultPlace, getDefaultPlace, addFavorite, getFavorites, removeFavorite } = store;

/** 一个「用户自己设的」地点：上海人民广场 —— 与出厂那份（北京天安门）毫不相干。 */
const MINE = { lat: 31.2304, lon: 121.4737, name: '上海 · 人民广场' };

/**
 * 从 #app 子树里按 id 属性找节点（假 DOM 的 getElementById 只索引预置 id）。
 *
 * @param {string} id 目标 id。
 * @returns {Object|null} 节点或 null。
 */
function nodeById(id) {
  const hits = dom.byId.app.descendants().filter((n) => n.getAttribute('id') === id);
  return hits.length ? hits[hits.length - 1] : null;
}

beforeEach(() => {
  // 收藏会跨用例累积（FakeStorage 不重置），逐个删干净再开始
  getFavorites().forEach((f) => removeFavorite(f.lat, f.lon));
  setDefaultPlace(MINE);
});

/* ------------------------------------------------------------------ */
/* 一、决策层：纯函数                                                   */
/* ------------------------------------------------------------------ */

test('factoryDefault() 给出副本：改返回值不许改到出厂那份', () => {
  const a = dp.factoryDefault();
  assert.equal(a.name, '北京 · 天安门', '出厂默认的名字就是这一条');
  a.lat = 0;
  a.lon = 0;
  a.name = '被改坏了';
  const b = dp.factoryDefault();
  assert.equal(b.lat, 39.9087, '★交出去的是副本：改它不许污染模块级常量');
  assert.equal(b.lon, 116.3975);
  assert.equal(b.name, '北京 · 天安门');
});

test('canAdoptGps() 只认真拿到了定位的 gps 结果', () => {
  assert.equal(dp.canAdoptGps({ lat: 31.2, lon: 121.4, source: 'gps' }), true);
  assert.equal(dp.canAdoptGps({ lat: 39.9087, lon: 116.3975, source: 'default' }), false, '★兜底坐标不是用户的位置');
  assert.equal(dp.canAdoptGps({ lat: 31.2, lon: 121.4, source: 'explicit' }), false, '收藏 / 搜索跳转不算');
  assert.equal(dp.canAdoptGps(null), false);
  assert.equal(dp.canAdoptGps({}), false);
  // ★Number(null) === 0：坐标缺失时必须判 false，不能当成 (0, 0)
  assert.equal(dp.canAdoptGps({ lat: null, lon: 121.4, source: 'gps' }), false);
  assert.equal(dp.canAdoptGps({ lat: 31.2, lon: undefined, source: 'gps' }), false);
  assert.equal(dp.canAdoptGps({ lat: Number.NaN, lon: 121.4, source: 'gps' }), false);
});

test('adoptGps() 名字优先用 coord.name，坐标必须 round4', () => {
  const p = dp.adoptGps({ lat: 31.230449, lon: 121.473711, source: 'gps', name: '上海' });
  assert.deepEqual(p, { lat: 31.2304, lon: 121.4737, name: '上海' });

  const noName = dp.adoptGps({ lat: 31.230449, lon: 121.473711, source: 'gps', name: '' });
  assert.equal(noName.lat, 31.2304);
  assert.equal(noName.lon, 121.4737);
  assert.ok(noName.name.indexOf('31.2304') !== -1, `没名字时退回坐标串，实际：${noName.name}`);
});

test('adoptGps() 非法输入返回 null（绝不把兜底坐标造出来给人写）', () => {
  assert.equal(dp.adoptGps(null), null);
  assert.equal(dp.adoptGps({}), null);
  assert.equal(dp.adoptGps({ lat: 'abc', lon: 121.4, source: 'gps' }), null);
  assert.equal(dp.adoptGps({ lat: 39.9087, lon: 116.3975, source: 'default', name: '北京 · 天安门' }), null,
    '★定位兜底出来的那份不许被 adopt 成用户的默认地点');
});

test('adoptFavorite() 按 id 找到就返回 place，找不到返回 null（不回退出厂默认）', () => {
  const list = [
    { lat: 24.4798, lon: 118.0894, name: '厦门' },
    { lat: 30.2741, lon: 120.1551, name: '杭州' },
  ];
  assert.deepEqual(dp.adoptFavorite(list, 0), { lat: 24.4798, lon: 118.0894, name: '厦门' });
  assert.deepEqual(dp.adoptFavorite(list, '1'), { lat: 30.2741, lon: 120.1551, name: '杭州' });

  // ★变异 ③：这里若回退出厂默认，等于把「没找到」说成「用了北京天安门」
  assert.equal(dp.adoptFavorite(list, 9), null, '越界：找不到就是找不到');
  assert.equal(dp.adoptFavorite(list, 'nope'), null);
  assert.equal(dp.adoptFavorite(list, null), null);
  assert.equal(dp.adoptFavorite(list, ''), null, '★空串转数字是 0，不许命中第一项');
  assert.equal(dp.adoptFavorite([], 0), null);
  assert.equal(dp.adoptFavorite(null, 0), null);
});

test('adoptFavorite() 收藏项自带 id 时按 id 命中（含数字 / 字符串两种写法）', () => {
  const list = [
    { id: 'a1', lat: 24.4798, lon: 118.0894, name: '厦门' },
    { id: 7, lat: 30.2741, lon: 120.1551, name: '杭州' },
  ];
  assert.deepEqual(dp.adoptFavorite(list, 'a1'), { lat: 24.4798, lon: 118.0894, name: '厦门' });
  assert.deepEqual(dp.adoptFavorite(list, 7), { lat: 30.2741, lon: 120.1551, name: '杭州' });
  assert.deepEqual(dp.adoptFavorite(list, '7'), { lat: 30.2741, lon: 120.1551, name: '杭州' });
  assert.equal(dp.adoptFavorite(list, 'zz'), null);
});

test('isFactoryDefault() 只认出厂那份（界面据此标注「这不是你的位置」）', () => {
  assert.equal(dp.isFactoryDefault(dp.factoryDefault()), true);
  assert.equal(dp.isFactoryDefault({ lat: 39.9087, lon: 116.3975, name: '北京 · 天安门' }), true);
  assert.equal(dp.isFactoryDefault(MINE), false);
  assert.equal(dp.isFactoryDefault(null), false);
  assert.equal(dp.isFactoryDefault({}), false);
});

test('classifyGpsFailure() 分得出环境不支持 / 拒绝 / 超时，分不出就说原因不明', () => {
  assert.equal(dp.classifyGpsFailure({ supported: false }), 'unsupported');
  assert.equal(dp.classifyGpsFailure({ supported: true, permission: 'denied' }), 'denied');
  assert.equal(dp.classifyGpsFailure({ supported: true, elapsedMs: 8000, timeoutMs: 8000 }), 'timeout');
  assert.equal(dp.classifyGpsFailure({ supported: true, elapsedMs: 120, timeoutMs: 8000 }), 'other');
  // ★不传耗时 / 上限时不能靠 Number(undefined) 蒙出一个结论
  assert.equal(dp.classifyGpsFailure({ supported: true }), 'other');
  assert.equal(dp.classifyGpsFailure(), 'other');
});

/* ------------------------------------------------------------------ */
/* 二、设置页那张卡                                                     */
/* ------------------------------------------------------------------ */

test('卡片第一行就是现状：名字 + 坐标', () => {
  init();
  const cur = nodeById('dp-current');
  assert.ok(cur, '默认地点卡必须有 #dp-current 现状行');
  assert.ok(cur.textContent.indexOf('上海 · 人民广场') !== -1, `现状行要带地点名，实际：${cur.textContent}`);
  assert.ok(cur.textContent.indexOf('31.2304') !== -1, `现状行要带坐标，实际：${cur.textContent}`);
});

test('出厂默认必须被标注出来（不标注的话用户会以为自己设过它）', () => {
  setDefaultPlace(dp.factoryDefault());
  init();
  const note = nodeById('dp-factory');
  assert.ok(note, '★出厂默认时必须多出一行说明：这是出厂默认、不是你的位置');
  assert.equal(note.textContent, t('settings.defaultPlaceFactoryNote'));

  // 反向：用户自己设的地点不许挂这一行
  setDefaultPlace(MINE);
  init();
  assert.equal(nodeById('dp-factory'), null, '不是出厂默认时不许乱标注');
});

test('定位失败时不许写入：默认地点保持原样，并如实报「环境不支持」', async () => {
  init();
  const btn = nodeById('btn-dp-gps');
  assert.ok(btn, '默认地点卡必须有 #btn-dp-gps');
  await btn.fire('click');

  // ★变异 ①：canAdoptGps() 恒 true 时，这里会被写成出厂那份（北京天安门）
  assert.equal(getDefaultPlace().name, MINE.name, '定位没拿到就不许动默认地点');
  assert.equal(getDefaultPlace().lat, MINE.lat);
  assert.equal(getDefaultPlace().lon, MINE.lon);

  const result = nodeById('dp-result');
  assert.ok(result, '默认地点卡必须有 #dp-result 结果位');
  assert.equal(result.textContent, t('settings.defaultPlaceGpsUnsupported'), '本环境没有 geolocation，必须报「不支持」');
});

test('定位成功：写入后卡片立刻重画（现状行马上变成拿到的那个坐标）', async () => {
  // 临时装一个「一定给坐标」的 geolocation：深圳 22.54311, 114.05787
  nav.navigator.geolocation = {
    getCurrentPosition: (ok) => ok({ coords: { latitude: 22.54311, longitude: 114.05787, accuracy: 30 } }),
  };
  try {
    init();
    const btn = nodeById('btn-dp-gps');
    assert.ok(btn, '默认地点卡必须有 #btn-dp-gps');
    await btn.fire('click');

    assert.equal(getDefaultPlace().lat, 22.5431, '★坐标必须 round4 后再写（与缓存键同一口径）');
    assert.equal(getDefaultPlace().lon, 114.0579);
    // ★变异 ②：写完不重画时，现状行还停在上一份（上海）
    const cur = nodeById('dp-current');
    assert.ok(cur.textContent.indexOf('22.5431') !== -1, `现状行必须立刻变成新坐标，实际：${cur.textContent}`);
  } finally {
    nav.navigator.geolocation = null;  // 别漏给后面的用例
  }
});

test('从收藏选：写入后卡片立刻重画（现状行马上变，不等下次进页面）', () => {
  addFavorite({ lat: 24.4798, lon: 118.0894, name: '厦门' });
  init();

  const cur0 = nodeById('dp-current');
  assert.ok(cur0.textContent.indexOf('厦门') === -1, '前置：现状行此刻还不该是厦门');

  const list = nodeById('dp-fav-list');
  assert.ok(list, '有收藏时必须给出可点的收藏按钮');
  const pick = list.children[0];
  assert.equal(pick.textContent, '厦门');
  pick.click();

  // ★变异 ②：写完不重画时，下面这一行会读到旧内容
  const cur1 = nodeById('dp-current');
  assert.ok(cur1.textContent.indexOf('厦门') !== -1, `写入后现状行必须立刻变成新地点，实际：${cur1.textContent}`);
  assert.equal(getDefaultPlace().name, '厦门');
  const result = nodeById('dp-result');
  assert.ok(result.textContent.indexOf('厦门') !== -1, '结果位也要说清写进去了什么');
});

test('恢复出厂默认：写入后卡片立刻重画，并把「出厂默认」那一行标出来', () => {
  init();
  assert.equal(nodeById('dp-factory'), null, '前置：当前是用户自己设的地点');

  const btn = nodeById('btn-dp-reset');
  assert.ok(btn, '默认地点卡必须有 #btn-dp-reset');
  btn.click();

  // ★变异 ②：写完不重画时，现状行与出厂标注都不会出现
  assert.equal(getDefaultPlace().name, '北京 · 天安门');
  const cur = nodeById('dp-current');
  assert.ok(cur.textContent.indexOf(t('place.default')) !== -1, `现状行要变成出厂默认，实际：${cur.textContent}`);
  assert.ok(nodeById('dp-factory'), '恢复出厂默认后必须标注它是出厂那份');
});

test('收藏为空时只给空态文案，不给点了没用的死按钮', () => {
  init();
  assert.equal(getFavorites().length, 0, '前置：本用例假定没有收藏');
  assert.equal(nodeById('dp-fav-list'), null, '★没有收藏就不许摆一排按钮');
  const empty = nodeById('dp-fav-empty');
  assert.ok(empty, '没有收藏时要给出空态说明');
  assert.equal(empty.textContent, t('settings.defaultPlaceFavEmpty'));
});

/* ------------------------------------------------------------------ */
/* 三、跨页一致性（A 部分：此刻屏必须认用户在「我的」页改过的默认地点）   */
/* ------------------------------------------------------------------ */

test('此刻屏的 resolveCoord 必须把用户在「我的」页改过的默认地点传进去', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/ui/app.js', import.meta.url)), 'utf8');
  const call = src.match(/resolveCoord\(\s*coord\s*,/);
  assert.ok(
    call,
    '★src/ui/app.js 的 resolveCoord(coord) 没传第二个参数：定位兜底时会用 core/geo.js 的出厂 DEFAULT_PLACE，' +
      '用户在「我的」页改过的默认地点被无视 —— 「我的」页写着上海、此刻屏却显示北京（对照 ui/compass.js 的同一行）'
  );
  const tail = src.slice(call.index, call.index + 200);
  assert.ok(tail.indexOf('getDefaultPlace') !== -1, '第二个参数里必须带 defaultPlace: getDefaultPlace()');
  assert.ok(tail.indexOf('placeDisplayName') !== -1, '第二个参数里必须带 displayName: placeDisplayName');
});
