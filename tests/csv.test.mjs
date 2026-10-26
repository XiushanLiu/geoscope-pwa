/**
 * CSV 导出回归（core/csv.js）
 *
 * 背景：导出去的文件用户会在 Excel / Numbers 里打开，而「看起来对」的 CSV 有三类
 * 经典死法，全部**写完不报错、肉眼看不出来**：
 *   ① 字段里带逗号 / 双引号 / 换行却没转义 → 整行错位，后面所有列串行；
 *   ② 没有 UTF-8 BOM → 中文版 Excel 按本地编码打开，标题行全是乱码；
 *   ③ 行尾用裸 LF → 部分解析器不认，整份读成一行。
 * 本文件把这三类与「缺失值不许填 0」一起钉死。
 *
 * 环境：纯 Node，不需要假 DOM（core 层不碰 document）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOM,
  CRLF,
  escapeCsvField,
  toCsv,
  csvFilename,
  snapshotToCsv,
} from '../src/core/csv.js';
import { hasKey, t } from '../src/i18n/index.js';
import { beaufort, windDir16, wmo } from '../src/core/wmo.js';

/* ------------------------------------------------------------------ */
/* toCsv：转义 / BOM / CRLF / 空数据                                     */
/* ------------------------------------------------------------------ */

test('escapeCsvField：含逗号的字段被引号包裹', () => {
  assert.equal(escapeCsvField('北京, 朝阳'), '"北京, 朝阳"');
});

test('escapeCsvField：含双引号的字段被引号包裹且内部引号翻倍', () => {
  assert.equal(escapeCsvField('他说"你好"'), '"他说""你好"""');
});

test('escapeCsvField：含换行的字段被引号包裹（CR 与 LF 都要）', () => {
  assert.equal(escapeCsvField('第一行\n第二行'), '"第一行\n第二行"');
  assert.equal(escapeCsvField('第一行\r\n第二行'), '"第一行\r\n第二行"');
});

test('escapeCsvField：含逗号 + 引号 + 换行三者齐发时同时成立', () => {
  const raw = 'a,b"c\nd';
  assert.equal(escapeCsvField(raw), '"a,b""c\nd"');
});

test('escapeCsvField：普通文本与数字不加引号（不加引号才能被 Excel 当数字）', () => {
  assert.equal(escapeCsvField('晴'), '晴');
  assert.equal(escapeCsvField(18.2), '18.2');
  assert.equal(escapeCsvField(0), '0');
});

test('escapeCsvField：null / undefined 一律空串', () => {
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

test('escapeCsvField：以 = / + / @ 开头的字段前置单引号（挡公式注入）', () => {
  // 单引号本身不是 RFC 4180 要求转义的字符，所以只加前缀、不额外包引号
  assert.equal(escapeCsvField('=1+1'), "'=1+1");
  assert.equal(escapeCsvField('@sum'), "'@sum");
  assert.equal(escapeCsvField('+123'), "'+123");
  // 两个条件同时成立时（既是公式触发器、又含逗号）→ 引号包裹 + 单引号前缀
  assert.equal(escapeCsvField('=a,b'), '"\'=a,b"');
});

test('escapeCsvField：负数**不**被当前置单引号（气温/磁偏角都是负值）', () => {
  assert.equal(escapeCsvField('-12.0'), '-12.0');
  assert.equal(escapeCsvField(-7.49), '-7.49');
});

test('toCsv：首字符是 UTF-8 BOM（否则中文版 Excel 打开是乱码）', () => {
  const text = toCsv([{ a: 1 }], [{ key: 'a', header: '甲' }]);
  assert.equal(text.charCodeAt(0), 0xfeff, '第一个字符必须是 U+FEFF');
  assert.equal(text.slice(0, BOM.length), BOM);
});

test('toCsv：行尾是 CRLF，且全文不含裸 LF / 裸 CR', () => {
  const text = toCsv([{ a: 1 }, { a: 2 }], [{ key: 'a', header: '甲' }]);
  const body = text.slice(BOM.length);
  assert.ok(body.endsWith(CRLF), '末行必须以 CRLF 结束');
  assert.equal(body.split(CRLF).length, 4, '表头 + 两行数据 + 末尾空串');
  // 剥掉所有 CRLF 之后不该再有 CR 或 LF 残留
  assert.ok(!/\r|\n/.test(body.split(CRLF).join('')), '存在裸 CR / LF 行尾');
});

test('toCsv：空数据只输出表头（不编造一行假数据，也不返回空串）', () => {
  const text = toCsv([], [{ key: 'a', header: '甲' }, { key: 'b', header: '乙' }]);
  assert.equal(text, `${BOM}甲,乙${CRLF}`);
});

test('toCsv：rows 非数组时不抛，按空数据处理', () => {
  assert.equal(toCsv(null, [{ key: 'a', header: '甲' }]), `${BOM}甲${CRLF}`);
});

test('toCsv：列定义既接受 {key,header} 也接受裸字符串键名', () => {
  const rows = [{ a: '甲', b: '乙' }];
  assert.equal(toCsv(rows, ['a', 'b']), `${BOM}a,b${CRLF}甲,乙${CRLF}`);
  assert.equal(toCsv(rows, [{ key: 'a', header: 'A' }, { key: 'b' }]), `${BOM}A,b${CRLF}甲,乙${CRLF}`);
});

test('toCsv：支持点号路径，取不到的列留空而不是写 undefined', () => {
  const text = toCsv([{ w: { tempC: 3 } }, {}], [{ key: 'w.tempC', header: '气温' }]);
  const rows = text.slice(BOM.length).split(CRLF);
  assert.equal(rows[0], '气温');
  assert.equal(rows[1], '3');
  assert.equal(rows[2], '', '取值不到的单元格必须留空');
  assert.ok(text.indexOf('undefined') === -1, 'CSV 里不许出现 "undefined"');
});

/* ------------------------------------------------------------------ */
/* csvFilename                                                          */
/* ------------------------------------------------------------------ */

test('csvFilename：文件名带本地时间戳且以 .csv 结尾', () => {
  const d = new Date(2025, 0, 5, 14, 23);
  const name = csvFilename(d.getTime());
  assert.equal(name, 'geoscope-now-20250105-1423.csv');
});

test('csvFilename：同一分钟内两次导出文件名相同，跨分钟不同（不会被静默覆盖）', () => {
  const a = new Date(2025, 0, 5, 14, 23).getTime();
  const b = a + 60 * 1000;
  assert.equal(csvFilename(a), csvFilename(a));
  assert.notEqual(csvFilename(a), csvFilename(b));
});

/* ------------------------------------------------------------------ */
/* snapshotToCsv：业务构造                                               */
/* ------------------------------------------------------------------ */

/** 造一份与 app.js 落盘形状一致的快照（字段一个不多、一个不少）。 */
const SNAP = {
  atMs: Date.UTC(2025, 0, 5, 6, 0),
  coord: { lat: 39.9087, lon: 116.3975 },
  placeName: '北京 · 天安门',
  elevationM: 43.5,
  weather: {
    atMs: Date.UTC(2025, 0, 5, 6, 0),
    tzOffsetSec: 8 * 3600,
    tempC: 18.2,
    feelsC: 17.1,
    humidityPct: 46,
    precipMm: 0.4,
    windMs: 3.4,
    windDeg: 135,
    pressureHpa: 1013.4,
    visibilityM: 12400,
    wmoCode: 2,
    sunriseAt: Date.UTC(2025, 0, 4, 22, 20),
    sunsetAt: Date.UTC(2025, 0, 5, 10, 32),
    uvMax: 5,
    todayMaxC: 21.5,
    todayMinC: 7.8,
  },
  air: { europeanAqi: 30, pm10: 12.3, pm25: 8.1, ozone: 55.2, no2: 9.7 },
  provenance: [
    { label: '天气（Open-Meteo Forecast）', latencyMs: 412 },
    { label: '空气质量（Open-Meteo Air Quality）', latencyMs: 388 },
  ],
};

/** 拆出正文行（去掉 BOM 与末尾 CRLF）。 */
function rowsOf(text) {
  return text.slice(BOM.length).replace(new RegExp(`${CRLF}$`), '').split(CRLF);
}

test('snapshotToCsv：一行数据 + 表头，且表头全部是中文（不是 key 本身）', () => {
  const out = snapshotToCsv(SNAP, { atMs: Date.UTC(2025, 0, 5, 6, 5), tr: t });
  const rows = rowsOf(out.text);
  assert.equal(rows.length, 2, '表头 + 一行数据');
  const headers = rows[0].split(',');
  assert.equal(headers.length, out.columns);
  for (const h of headers) {
    assert.ok(h.length > 0, '表头不许为空');
    assert.ok(!/^[a-zA-Z0-9._-]+$/.test(h), `表头 ${h} 像是没取到文案的 key`);
  }
});

test('snapshotToCsv：每一列的 i18n key 都真实存在于文案表（防止列写好了文案没加）', () => {
  // csv.js 的表头 key 是变量拼的，check.mjs 第 9 节那只扫 t('字面量') 的眼睛看不见它们，
  // 所以这一列 key 的完整性由本用例兜住。
  const keys = [
    'csv.h.exportedAt', 'csv.h.observedAt', 'csv.h.place', 'csv.h.lat', 'csv.h.lon',
    'csv.h.elevation', 'csv.h.temp', 'csv.h.feels', 'csv.h.humidity', 'csv.h.precip',
    'csv.h.windSpeed', 'csv.h.windDir', 'csv.h.beaufort', 'csv.h.pressure', 'csv.h.visibility',
    'csv.h.weather', 'csv.h.wmoCode', 'csv.h.sunrise', 'csv.h.sunset', 'csv.h.dayLength',
    'csv.h.uv', 'csv.h.uvLevel', 'csv.h.todayMax', 'csv.h.todayMin', 'csv.h.aqi',
    'csv.h.aqiLevel', 'csv.h.pm10', 'csv.h.pm25', 'csv.h.ozone', 'csv.h.no2',
    'csv.h.declination', 'csv.h.sources',
  ];
  for (const k of keys) assert.ok(hasKey(k), `文案表缺 ${k}`);
  const out = snapshotToCsv(SNAP, { atMs: Date.UTC(2025, 0, 5, 6, 5), tr: t });
  assert.equal(out.columns, keys.length, '列数与 key 清单不一致（加列请同步两边）');
});

test('snapshotToCsv：数值按界面口径算出（含时区偏移换算的观测时刻）', () => {
  const out = snapshotToCsv(SNAP, { atMs: Date.UTC(2025, 0, 5, 6, 5), declinationDeg: -7.4863, tr: t });
  const cells = rowsOf(out.text)[1].split(',');
  const byHeader = {};
  const headers = rowsOf(out.text)[0].split(',');
  headers.forEach((h, i) => {
    byHeader[h] = cells[i];
  });
  // 观测时刻按 tzOffsetSec = +8h 换算：06:00 UTC → 14:00 本地
  assert.equal(byHeader['观测时刻（当地）'], '2025-01-05 14:00');
  assert.equal(byHeader['气温（°C）'], '18.2');
  assert.equal(byHeader['体感（°C）'], '17.1');
  assert.equal(byHeader['湿度（%）'], '46');
  // 分档类字段一律与「界面上那个数字」同源：拿 core/wmo.js 的换算结果直接比对，
  // 不在测试里另抄一份档位表（抄了就等于新造一套标准，将来改了换算表测试还在说谎）。
  assert.equal(byHeader['蒲福风级'], String(beaufort(3.4).level));
  assert.equal(byHeader['风向'], t('w.windFrom', { dir: t(windDir16(135).abbrKey) }));
  assert.equal(byHeader['天气现象'], t(wmo(2, true).key));
  assert.equal(byHeader['天气码'], String(wmo(2, true).code));
  // ★2026-10 真机：表头改成 EAQI 口径（与屏幕一致 —— 空气卡上写的是 EAQI）。
  //   用 `t()` 取而不是写死字面量：写死的话改表头文案时这条会红，那是假失败；
  //   而「列还在、表头说的还是欧洲标准」才是要钉的（★改的是表头文案，列一列没删）。
  assert.equal(byHeader[t('csv.h.aqi')], '30');
  assert.equal(byHeader[t('csv.h.aqiLevel')], '良', '30 落在「良」档（20 < v ≤ 40）');
  assert.ok(
    t('csv.h.aqi').includes('EAQI') && t('csv.h.aqiLevel').includes('EAQI'),
    `两列表头必须标明是欧洲标准（EAQI），实际：${t('csv.h.aqi')} / ${t('csv.h.aqiLevel')}`
  );
  assert.equal(byHeader['紫外线指数'], '5');
  assert.equal(byHeader['紫外线档位'], '中', '5 落在「中」档（2 < v ≤ 5）');
  assert.equal(byHeader['昼长（分）'], String(Math.round((Date.UTC(2025, 0, 5, 10, 32) - Date.UTC(2025, 0, 4, 22, 20)) / 60000)));
  assert.equal(byHeader['磁偏角（度，东偏为正）'], '-7.49');
  assert.equal(byHeader['数据来源'], '天气（Open-Meteo Forecast） 412 ms; 空气质量（Open-Meteo Air Quality） 388 ms');
});

test('snapshotToCsv：缺失值留空，不填 0、也不写占位符「—」', () => {
  const thin = {
    atMs: Date.UTC(2025, 0, 5, 6, 0),
    coord: { lat: 39.9087, lon: 116.3975 },
    placeName: '',
    elevationM: null,
    weather: { atMs: Date.UTC(2025, 0, 5, 6, 0), tzOffsetSec: 0, tempC: null, feelsC: null },
    air: null,
    provenance: [],
  };
  const out = snapshotToCsv(thin, { atMs: Date.UTC(2025, 0, 5, 6, 5), tr: t });
  const cells = rowsOf(out.text)[1];
  assert.ok(cells.indexOf('—') === -1, `CSV 里不许出现占位符「—」（会让整列退化成文本列）：${cells}`);
  // 列数一个不少（缺的只是值），行里应是一串连续逗号
  assert.equal(cells.split(',').length, out.columns);
  assert.ok(/^,*,*$/.test(cells.replace(/[^,]/g, '')), '缺失列应留空而不是补 0');
});

test('snapshotToCsv：空对象不抛，且仍给出完整表头（界面上「暂无数据」时不该导出半个文件）', () => {
  const out = snapshotToCsv({}, { tr: t });
  const rows = rowsOf(out.text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].split(',').length, out.columns);
});

test('snapshotToCsv：文件名与正文同源（文件名时间戳 = 导出时刻）', () => {
  const at = new Date(2025, 0, 5, 14, 23).getTime();
  const out = snapshotToCsv(SNAP, { atMs: at, tr: t });
  assert.equal(out.name, csvFilename(at));
  assert.equal(out.rows, 1);
});

test('snapshotToCsv：导出时间按设备本地时区，与文件名是同一刻（不许表里 UTC、文件名本地）', () => {
  const at = new Date(2025, 0, 5, 14, 23).getTime();
  const out = snapshotToCsv(SNAP, { atMs: at, tr: t });
  const headers = rowsOf(out.text)[0].split(',');
  const cells = rowsOf(out.text)[1].split(',');
  const i = headers.indexOf('导出时间（本机）');
  assert.ok(i > -1, '应有导出时间这一列');
  // 文件名 geoscope-now-YYYYMMDD-HHmm.csv 里的那串数字，必须就是表里这一格的时刻。
  // 抓的是真实踩过的坑：一次导出里两个时间戳不同源，用户会对不上是哪一份。
  const m = /(\d{8})-(\d{4})\.csv$/.exec(out.name);
  assert.ok(m, `文件名格式不对：${out.name}`);
  assert.equal(cells[i].slice(0, 10).replace(/-/g, ''), m[1], '日期必须与文件名同源');
  assert.equal(cells[i].slice(11).replace(':', ''), m[2], '时分必须与文件名同源');
});

test('snapshotToCsv：两个时间列各按各的时区（导出按本机、观测按查询地）', () => {
  // 设备本地（本机时区）14:23 导出的、观测时刻是 UTC 06:00 / 当地 +8h = 14:00 的一份数据
  const at = new Date(2025, 0, 5, 14, 23).getTime();
  const snap = {
    atMs: at,
    coord: { lat: 39.9, lon: 116.4, source: 'geocode' },
    placeName: '北京',
    elevationM: 44,
    weather: { atMs: Date.UTC(2025, 0, 5, 6, 0), tzOffsetSec: 8 * 3600, tempC: 1 },
    air: {},
    provenance: [],
  };
  const out = snapshotToCsv(snap, { atMs: at, tr: t });
  const headers = rowsOf(out.text)[0].split(',');
  const cells = rowsOf(out.text)[1].split(',');
  const byHeader = {};
  headers.forEach((h, i) => {
    byHeader[h] = cells[i];
  });
  assert.equal(byHeader['观测时刻（当地）'], '2025-01-05 14:00', '观测时刻按查询地时区 +8h');
  // 导出时间按本机时区。这里用 Date 的本地取数（getFullYear/getHours…）独立算一遍期望值，
  // 与 csv.js 里「偏移 + UTC 取数」的写法是两套算法 —— 对得上才说明时区没搞反。
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  const localWall = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  assert.equal(byHeader['导出时间（本机）'], localWall, '导出时间必须是本机墙钟，不是 UTC');
});

test('snapshotToCsv：磁偏角缺失时那一列留空（不许拿 0 冒充「正北不偏」）', () => {
  const out = snapshotToCsv(SNAP, { atMs: Date.UTC(2025, 0, 5, 6, 5), tr: t });
  const headers = rowsOf(out.text)[0].split(',');
  const cells = rowsOf(out.text)[1].split(',');
  const i = headers.indexOf('磁偏角（度，东偏为正）');
  assert.ok(i > -1, '应有磁偏角这一列');
  assert.equal(cells[i], '', '没传磁偏角就留空 —— 0 会被读成「正北不偏」，那是另一个意思');
});
