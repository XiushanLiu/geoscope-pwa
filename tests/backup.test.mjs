/**
 * core/backup.js 独立验证
 *
 * 覆盖：导出结构（键固定、不含瓦片与 API 原文）/ 导出→导入往返一致 /
 * 四类失败各自 ok:false 且 reason 互不相同 / 越界坐标整体拒绝且原状态不变 /
 * favorites 非法项跳过 + 去重 + 200 条截断 / debug 不从备份带入 /
 * 失败时状态完全不变 / 字符串与对象两种入参行为一致 / 快照为 null 时清掉旧快照。
 *
 * 环境：必须在 import 被测模块**之前**装好 localStorage（cache.js 在加载期就决定
 * 走内存还是 localStorage），与 cache.test.mjs 同一套路。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
const backup = await import('../src/core/backup.js');
const store = await import('../src/core/store.js');
const fmt = await import('../src/core/format.js');

/**
 * 构造一份合法备份载荷（默认 latitude=0/longitude=0，够用即止）。
 *
 * @param {Object} [overrides] 覆盖 prefs 字段。
 * @returns {Object} 备份载荷。
 */
function makePayload(overrides = {}) {
  return {
    schema: 1,
    app: 'geoscope',
    exportedAt: '2025-01-05T06:23:00.000Z',
    snapshot: null,
    prefs: {
      defaultPlace: { lat: 0, lon: 0, name: '原点' },
      unitSystem: 'metric',
      networkType: 'unknown',
      debug: false,
      favorites: [],
      ...overrides,
    },
  };
}

/**
 * 把当前 store 状态抽成一份可逐字段比对的对象。
 *
 * @returns {Object} 状态快照（含 snapshot）。
 */
function readAll() {
  const s = store.getState();
  return {
    defaultPlace: store.getDefaultPlace(),
    unitSystem: store.getUnitSystem(),
    networkType: store.getNetworkType(),
    debug: store.isDebug(),
    favorites: store.getFavorites(),
    snapshot: store.getLastSnapshot(),
    state: s,
  };
}

beforeEach(() => {
  store.resetStore();
  store.setLastSnapshot(null);
});

test('导出结构：顶层键固定为 schema/app/exportedAt/prefs/snapshot', () => {
  const p = backup.exportBackup();
  assert.deepEqual(Object.keys(p).sort(), ['app', 'exportedAt', 'prefs', 'schema', 'snapshot']);
  assert.equal(p.schema, 1, 'schema 必须是整数 1');
  assert.equal(p.app, 'geoscope');
  assert.ok(!Number.isNaN(Date.parse(p.exportedAt)), `exportedAt 必须是合法 ISO 串，实际 ${p.exportedAt}`);
  assert.deepEqual(Object.keys(p.prefs).sort(), ['debug', 'defaultPlace', 'favorites', 'networkType', 'unitSystem']);
});

test('导出不含瓦片缓存与任何 API 响应原文（硬排除两条）', () => {
  store.setDefaultPlace({ lat: 39.9087, lon: 116.3975, name: '北京 · 天安门' });
  store.addFavorite({ lat: 31.2304, lon: 121.4737, name: '上海' });
  store.setLastSnapshot({ tempC: 26.5, code: 0, placeName: '北京', observedAt: 1_700_000_000_000 });

  const text = JSON.stringify(backup.exportBackup());
  for (const forbidden of ['open-meteo', 'arcgisonline', 'data:image', 'tileBytes', 'responseText', 'rawResponse']) {
    assert.ok(text.indexOf(forbidden) === -1, `导出内容不得包含 ${forbidden}（瓦片 / API 原文属于硬排除项）`);
  }
  // 快照是「已解析对象」而非原文：字段级可解析，且导出体里不应出现顶层 tiles 桶
  assert.equal(backup.exportBackup().snapshot.code, 0);
});

test('导出 → 导入 往返一致（逐字段比对）', () => {
  store.setDefaultPlace({ lat: 31.2304, lon: 121.4737, name: '上海 · 人民广场' });
  store.setUnitSystem('imperial');
  store.setNetworkType('cellular');
  store.addFavorite({ lat: 39.9087, lon: 116.3975, name: '北京' });
  store.addFavorite({ lat: 22.5431, lon: 114.0579, name: '深圳' });
  store.setLastSnapshot({ tempC: 26.5, code: 0, placeName: '上海', observedAt: 1_700_000_000_000 });

  const payload = backup.exportBackup();
  // 清空后再导入，确保读到的每一字段都是这次导入写进去的
  store.resetStore();
  store.setLastSnapshot(null);

  const res = backup.importBackup(JSON.stringify(payload));
  assert.equal(res.ok, true, `导入必须成功：${res.reason || ''}`);
  assert.deepEqual(store.getDefaultPlace(), { lat: 31.2304, lon: 121.4737, name: '上海 · 人民广场', source: 'default' });
  assert.equal(store.getUnitSystem(), 'imperial');
  assert.equal(store.getNetworkType(), 'cellular');
  assert.deepEqual(store.getFavorites(), [
    { lat: 39.9087, lon: 116.3975, name: '北京' },
    { lat: 22.5431, lon: 114.0579, name: '深圳' },
  ]);
  assert.deepEqual(store.getLastSnapshot(), { tempC: 26.5, code: 0, placeName: '上海', observedAt: 1_700_000_000_000 });
});

test('四类导入失败各自 ok:false，且 reason 互不相同', () => {
  const badJson = backup.importBackup('{不是 JSON');
  const badSchema = backup.importBackup(JSON.stringify({ ...makePayload(), schema: 2 }));
  const badApp = backup.importBackup(JSON.stringify({ ...makePayload(), app: 'some-other-app' }));
  const noPrefs = backup.importBackup(JSON.stringify({ schema: 1, app: 'geoscope', exportedAt: 'x', snapshot: null }));

  for (const [i, r] of [badJson, badSchema, badApp, noPrefs].entries()) {
    assert.equal(r.ok, false, `第 ${i + 1} 类必须导入失败`);
    assert.equal(r.applied, undefined, '失败时不得返回 applied');
    assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '失败必须带中文 reason');
  }
  const reasons = [badJson.reason, badSchema.reason, badApp.reason, noPrefs.reason];
  assert.equal(new Set(reasons).size, 4, `四条 reason 必须互不相同，实际：${JSON.stringify(reasons)}`);
  assert.equal(badJson.reason, '不是合法 JSON');
  assert.match(badSchema.reason, /schema=2/, '版本不支持必须带上实际 schema 值');
  assert.equal(badApp.reason, '不是地候的备份文件');
  assert.equal(noPrefs.reason, '缺少 prefs');
});

test('越界坐标（lat=91）整体拒绝，且原状态不变', () => {
  store.setDefaultPlace({ lat: 39.9087, lon: 116.3975, name: '北京' });
  store.addFavorite({ lat: 31.2304, lon: 121.4737, name: '上海' });
  const before = readAll();

  const res = backup.importBackup(makePayload({ defaultPlace: { lat: 91, lon: 0, name: '越界' } }));
  assert.equal(res.ok, false, '纬度 91 必须整体拒绝，不能静默拿默认值糊过去');
  assert.match(res.reason, /defaultPlace/);

  const after = readAll();
  assert.deepEqual(after.defaultPlace, before.defaultPlace, '拒绝后 defaultPlace 必须原样');
  assert.deepEqual(after.favorites, before.favorites, '拒绝后 favorites 必须原样');
  assert.equal(after.unitSystem, before.unitSystem);
  assert.equal(after.networkType, before.networkType);
  assert.deepEqual(after.snapshot, before.snapshot);
});

test('坐标校验：±90 / ±180 边界接受，null / 字符串 / 越界经度拒绝', () => {
  const ok90 = backup.importBackup(makePayload({ defaultPlace: { lat: 90, lon: 180, name: '边界' } }));
  assert.equal(ok90.ok, true, '边界值必须合法');
  assert.deepEqual(store.getDefaultPlace(), { lat: 90, lon: 180, name: '边界', source: 'default' });

  for (const [label, place] of [
    ['null 纬度', { lat: null, lon: 0, name: 'x' }],
    ['字符串纬度', { lat: '39.9', lon: 0, name: 'x' }],
    ['越界经度 181', { lat: 0, lon: 181, name: 'x' }],
    ['缺 lat', { lon: 0, name: 'x' }],
  ]) {
    store.resetStore();
    const r = backup.importBackup(makePayload({ defaultPlace: place }));
    assert.equal(r.ok, false, `${label} 必须被拒绝`);
  }
  // NaN 在 JSON 里序列化成 null，用原文构造一个真 NaN 场景
  store.resetStore();
  const r = backup.importBackup('{"schema":1,"app":"geoscope","prefs":{"defaultPlace":{"lat":null,"lon":0,"name":"x"}}}');
  assert.equal(r.ok, false, 'null 坐标不得被当成 0 接受');
});

test('favorites：非法项只跳过该项，其余正常导入', () => {
  const res = backup.importBackup(
    makePayload({
      defaultPlace: { lat: 0, lon: 0, name: '原点' },
      favorites: [
        { lat: 1, lon: 1, name: 'A' },
        { lat: 91, lon: 1, name: '越界纬度' },
        { lat: 2, lon: 2, name: 'B' },
        { lat: null, lon: 3, name: 'null 纬度' },
        { lat: 3, lon: 3, name: 'C' },
      ],
    })
  );
  assert.equal(res.ok, true, '单个非法收藏项不得导致整体拒绝');
  assert.deepEqual(store.getFavorites(), [
    { lat: 1, lon: 1, name: 'A' },
    { lat: 2, lon: 2, name: 'B' },
    { lat: 3, lon: 3, name: 'C' },
  ]);
  assert.equal(res.applied.favoritesDropped, 2, '应报告被丢弃的 2 条');
});

test('favorites：按 lat+lon 去重', () => {
  const res = backup.importBackup(
    makePayload({
      favorites: [
        { lat: 39.9087, lon: 116.3975, name: '北京' },
        { lat: 39.9087, lon: 116.3975, name: '北京（重复）' },
        { lat: 39.9087, lon: 116.3976, name: '北京邻近点' },
      ],
    })
  );
  assert.equal(res.ok, true);
  assert.equal(store.getFavorites().length, 2, '同 lat+lon 视为同一条，经度不同的保留');
  assert.equal(res.applied.favoritesDropped, 1);
});

test('favorites：超 200 条截断', () => {
  const many = [];
  for (let i = 0; i < 260; i += 1) many.push({ lat: i * 0.1, lon: 0, name: `P${i}` }); // 0 ~ 25.9，均在范围内
  const res = backup.importBackup(makePayload({ favorites: many }));
  assert.equal(res.ok, true);
  assert.equal(store.getFavorites().length, backup.MAX_FAVORITES, '超出上限必须截断到 200 条');
  assert.equal(res.applied.favoritesDropped, 60);
});

test('favorites 非数组时按空数组处理（宽容：收藏丢了不致命）', () => {
  const res = backup.importBackup(makePayload({ favorites: { 0: { lat: 1, lon: 1, name: 'A' } } }));
  assert.equal(res.ok, true, 'favorites 形状不对不应整体拒绝');
  assert.deepEqual(store.getFavorites(), []);
});

test('debug 不从备份带入', () => {
  store.setDebug(true);
  const res = backup.importBackup(makePayload({ debug: false }));
  assert.equal(res.ok, true);
  assert.equal(store.isDebug(), true, '导入 debug:false 的备份后，本机 debug 必须仍是 true');

  // 反向：本机 debug=false 时，导入 debug:true 的备份也不得把它打开
  store.resetStore();
  store.setDebug(false);
  const res2 = backup.importBackup(makePayload({ debug: true }));
  assert.equal(res2.ok, true);
  assert.equal(store.isDebug(), false, 'debug 是排障开关，不得从别处导入而打开');
});

test('导入失败时状态完全不变（逐字段比对）', () => {
  store.setDefaultPlace({ lat: 22.5431, lon: 114.0579, name: '深圳' });
  store.setUnitSystem('imperial');
  store.setNetworkType('wifi');
  store.setDebug(true);
  store.addFavorite({ lat: 39.9087, lon: 116.3975, name: '北京' });
  store.setLastSnapshot({ tempC: 18, code: 3, placeName: '深圳' });
  const before = readAll();

  // 连续喂四种坏备份，任何一种都不得留下半截状态
  for (const bad of [
    '{坏 JSON',
    JSON.stringify({ ...makePayload(), schema: 9 }),
    JSON.stringify({ ...makePayload(), app: 'nope' }),
    JSON.stringify({ schema: 1, app: 'geoscope' }),
    makePayload({ defaultPlace: { lat: 200, lon: 0, name: '越界' } }),
  ]) {
    const r = backup.importBackup(bad);
    assert.equal(r.ok, false);
  }

  const after = readAll();
  assert.deepEqual(after.defaultPlace, before.defaultPlace);
  assert.equal(after.unitSystem, before.unitSystem);
  assert.equal(after.networkType, before.networkType);
  assert.equal(after.debug, before.debug);
  assert.deepEqual(after.favorites, before.favorites);
  assert.deepEqual(after.snapshot, before.snapshot);
});

test('入参是字符串与对象两种形态行为完全一致', () => {
  const payload = makePayload({
    defaultPlace: { lat: 45, lon: 9, name: '米兰' },
    unitSystem: 'imperial',
    networkType: 'cellular',
    favorites: [{ lat: 1, lon: 1, name: 'A' }],
  });
  payload.snapshot = { tempC: 12, code: 2 };

  const fromString = backup.importBackup(JSON.stringify(payload));
  const afterString = readAll();

  store.resetStore();
  store.setLastSnapshot(null);
  const fromObject = backup.importBackup(payload);
  const afterObject = readAll();

  assert.equal(fromString.ok, true);
  assert.equal(fromObject.ok, true);
  assert.deepEqual(fromObject.applied, fromString.applied, '两种入参必须产出同一个 applied');
  assert.deepEqual(afterObject.defaultPlace, afterString.defaultPlace);
  assert.deepEqual(afterObject.favorites, afterString.favorites);
  assert.deepEqual(afterObject.snapshot, afterString.snapshot);
  assert.equal(afterObject.unitSystem, afterString.unitSystem);
});

test('快照为 null / 非法时当 null，并清掉本机残留的旧快照', () => {
  store.setLastSnapshot({ tempC: 30, code: 0, placeName: '旧机器' });
  const res = backup.importBackup(makePayload({ defaultPlace: { lat: 0, lon: 0, name: 'x' }, snapshot: null }));
  assert.equal(res.ok, true);
  assert.equal(store.getLastSnapshot(), null, '备份没有快照时必须清掉旧快照，避免残留上一台机器的数据');

  // 非法快照（数组 / 字符串）也当 null
  for (const bad of [[1, 2], 'not-an-object', 42]) {
    store.setLastSnapshot({ tempC: 1, code: 0 });
    const r = backup.importBackup({ ...makePayload(), snapshot: bad });
    assert.equal(r.ok, true, `快照 ${JSON.stringify(bad)} 不得导致整体失败`);
    assert.equal(store.getLastSnapshot(), null);
  }
});

test('unitSystem / networkType 非法值回退默认值（宽容，不涉及位置隐私）', () => {
  const res = backup.importBackup(makePayload({ unitSystem: 'kelvin', networkType: '5g' }));
  assert.equal(res.ok, true);
  assert.equal(store.getUnitSystem(), 'metric');
  assert.equal(store.getNetworkType(), 'unknown');

  const res2 = backup.importBackup(makePayload({ unitSystem: 'imperial', networkType: 'wifi' }));
  assert.equal(res2.ok, true);
  assert.equal(store.getUnitSystem(), 'imperial', '合法值必须照实导入');
  assert.equal(store.getNetworkType(), 'wifi');
});

test('地点名强制转字符串并截断到 60 字符', () => {
  const res = backup.importBackup(
    makePayload({
      defaultPlace: { lat: 1, lon: 1, name: '名'.repeat(200) },
      favorites: [{ lat: 2, lon: 2, name: 12345 }],
    })
  );
  assert.equal(res.ok, true);
  assert.equal(store.getDefaultPlace().name.length, 60, 'defaultPlace.name 必须截断到 60 字符');
  assert.equal(store.getFavorites()[0].name, '12345', '非字符串名称强制转字符串');
});

test('backupFilename 复用 core/format.js 的时间戳，不重复实现', () => {
  const at = new Date(2025, 0, 5, 14, 23).getTime();
  assert.equal(backup.backupFilename(at), `geoscope-backup-${fmt.stamp(at)}.json`);
  assert.equal(backup.backupFilename(at), 'geoscope-backup-20250105-1423.json');
  assert.match(backup.backupFilename(), /^geoscope-backup-\d{8}-\d{4}\.json$/);
});
