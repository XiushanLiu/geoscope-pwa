/**
 * 无网冒烟脚本（零依赖、不发真实请求）
 *
 * 职责：用 mock fetch 覆盖核心链路，验证：超时中断、重试 1 次、串行并发 1、
 * 缓存 fresh/stale/miss、离线短路不发请求、WMO/AQI/UV/方位/蒲福映射、NOAA 日出日落
 * （含极昼极夜）、瓦片指纹去重 real/fake 两种判定、URL 拼装与响应解析。
 *
 * 用法：node tools/smoke.mjs
 * 退出码：全部通过 0；存在失败 1。
 */

import { setTimeout as sleep } from 'node:timers/promises';

import * as cache from '../src/core/cache.js';
import * as http from '../src/core/http.js';
import * as wmo from '../src/core/wmo.js';
import * as sun from '../src/core/sun.js';
import * as fmt from '../src/core/format.js';
import * as geo from '../src/core/geo.js';
import { t, tr } from '../src/i18n/index.js';
import { SOURCES, SOURCE_LIST } from '../src/data/sources.js';
import {
  dedupeTiles,
  fingerprint,
  probeTile,
  tileUrl,
  sampleTiles,
  setNoMapMode,
  isNoMapMode,
  mapMode,
  degradeMapMode,
  markStyleTrusted,
  isStyleTrusted,
  clearTileCache,
  tileCacheSize,
  MAP_MODE,
  TILE_CACHE_MAX,
  TILE_CACHE_TTL_MS,
  TILE_TRUST_TTL_MS,
} from '../src/data/tiles.js';
import * as health from '../src/data/health.js';
import {
  buildWeatherRequest,
  buildAirRequest,
  buildElevationRequest,
  buildGeocodeRequest,
  parseWeather,
  parseAir,
  parseElevation,
  parseGeocode,
} from '../src/data/openmeteo.js';
import { buildReverseRequest, parseReverse } from '../src/data/photon.js';

/* ------------------------- 迷你断言框架 ------------------------- */

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

/**
 * 断言。
 *
 * @param {string} name 用例名。
 * @param {boolean} cond 条件。
 * @param {string} [detail] 失败补充信息。
 * @returns {void}
 */
function check(name, cond, detail = '') {
  if (cond) {
    PASS += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    FAIL += 1;
    FAILURES.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/**
 * 打印小节标题。
 *
 * @param {string} title 标题。
 * @returns {void}
 */
function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/* ------------------------- mock fetch ------------------------- */

/**
 * 构造 JSON 响应（最小 Response 子集）。
 *
 * @param {*} obj 响应体。
 * @param {number} [status=200] HTTP 状态。
 * @returns {Object} mock Response。
 */
function jsonRes(obj, status = 200) {
  const text = JSON.stringify(obj);
  const enc = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => text,
    json: async () => obj,
    arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength),
  };
}

/**
 * 构造字节响应。
 *
 * @param {string} s 内容。
 * @param {number} [status=200] HTTP 状态。
 * @returns {Object} mock Response。
 */
function bytesRes(s, status = 200) {
  const enc = new TextEncoder().encode(s);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'image/jpeg' },
    text: async () => s,
    arrayBuffer: async () => enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength),
  };
}

/**
 * 安装 mock fetch。
 *
 * @param {(url:string, init:Object) => Promise<Object>|Object} handler 处理函数。
 * @returns {void}
 */
function setFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init || {});
}

/* ------------------------- 用例 ------------------------- */

/**
 * 主流程。
 *
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  cache.__useMemory();
  const ctx = { lat: 39.9087, lon: 116.3975, keyword: '北京', lang: 'zh' };

  /* ---------- 1. 串行队列（并发 1） ---------- */
  section('1. 全局串行队列（并发恒为 1）');
  http.resetQueue();
  let running = 0;
  let maxRunning = 0;
  const tasks = [];
  for (let i = 0; i < 4; i += 1) {
    tasks.push(
      http.enqueue(async () => {
        running += 1;
        if (running > maxRunning) maxRunning = running;
        await sleep(15);
        running -= 1;
        return i;
      }, { name: `t${i}` })
    );
  }
  const seq = await Promise.all(tasks);
  check('4 个任务最大并发为 1', maxRunning === 1, `实际 ${maxRunning}`);
  check('任务按入队顺序完成', seq.join(',') === '0,1,2,3', seq.join(','));
  check('queueLength 归零', http.queueLength() === 0, String(http.queueLength()));

  /* ---------- 2. 超时中断 ---------- */
  section('2. 超时中断（AbortController）');
  setFetch((_url, init) =>
    new Promise((_resolve, reject) => {
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    })
  );
  const tOut = await http.requestRaw({ url: 'https://x.test/timeout', responseType: 'json' }, { timeoutMs: 100, retry: 1 });
  check('超时返回 TIMEOUT', !tOut.ok && tOut.error.code === 'TIMEOUT', tOut.error && tOut.error.code);
  check('超时后共 2 次尝试（retry=1）', tOut.meta.attempts === 2, String(tOut.meta.attempts));
  check('超时错误可重试', tOut.error.retriable === true);

  /* ---------- 3. 重试 1 次后成功 ---------- */
  section('3. 重试（仅 retriable）');
  let netCalls = 0;
  setFetch(() => {
    netCalls += 1;
    if (netCalls === 1) throw new Error('simulated network drop');
    return jsonRes({ ok: 1 });
  });
  const rRetry = await http.requestRaw({ url: 'https://x.test/retry' }, { timeoutMs: 1000, retry: 1 });
  check('首次网络失败后重试成功', rRetry.ok === true);
  check('重试共发起 2 次请求', netCalls === 2, String(netCalls));

  /* ---------- 4. HTTP 4xx 不重试 / 5xx 重试 ---------- */
  section('4. HTTP 状态与重试策略');
  let c404 = 0;
  setFetch(() => {
    c404 += 1;
    return jsonRes({}, 404);
  });
  const r404 = await http.requestRaw({ url: 'https://x.test/404' }, { timeoutMs: 1000, retry: 1 });
  check('HTTP 404 不重试（attempts=1）', !r404.ok && r404.meta.attempts === 1 && c404 === 1, `${r404.meta.attempts}/${c404}`);
  check('HTTP 404 retriable=false', r404.error.retriable === false);
  check('HTTP 状态透传', r404.meta.httpStatus === 404 && r404.error.httpStatus === 404);

  let c503 = 0;
  setFetch(() => {
    c503 += 1;
    return jsonRes({}, 503);
  });
  const r503 = await http.requestRaw({ url: 'https://x.test/503' }, { timeoutMs: 1000, retry: 1 });
  check('HTTP 503 重试（attempts=2）', !r503.ok && r503.meta.attempts === 2 && c503 === 2, `${r503.meta.attempts}/${c503}`);
  check('HTTP 503 retriable=true', r503.error.retriable === true);

  /* ---------- 5. 缓存三态与键规则 ---------- */
  section('5. 缓存 fresh / stale / miss + 键规则');
  cache.__useMemory();
  check('缓存键格式（坐标 toFixed(4)）', SOURCES.elevation.cacheKey(ctx) === 'gs:v1:elevation:39.9087:116.3975', SOURCES.elevation.cacheKey(ctx));
  check('缓存键格式（关键词 encodeURIComponent）', SOURCES.geocode.cacheKey(ctx) === `gs:v1:geocode:${encodeURIComponent('北京')}:zh`, SOURCES.geocode.cacheKey(ctx));

  let elevCalls = 0;
  setFetch(() => {
    elevCalls += 1;
    return jsonRes({ elevation: [43] });
  });
  const e1 = await http.request('elevation', ctx);
  check('miss：发请求并写缓存', e1.ok && elevCalls === 1 && e1.meta.cacheState === 'miss', `${e1.ok}/${elevCalls}/${e1.meta.cacheState}`);
  check('解析出海拔 43 m', e1.data && e1.data.elevationM === 43);

  const e2 = await http.request('elevation', ctx);
  check('fresh：命中缓存不发请求', e2.ok && e2.meta.fromCache === true && e2.meta.attempts === 0 && elevCalls === 1, `${e2.meta.fromCache}/${elevCalls}`);

  cache.set(SOURCES.elevation.cacheKey(ctx), { elevationM: 43 }, 1);
  await sleep(5);
  const st = cache.getWithState(SOURCES.elevation.cacheKey(ctx));
  check('过期缓存判定为 stale（值仍可取）', st.state === 'stale' && st.value.elevationM === 43, st.state);

  const e3 = await http.request('elevation', ctx, { force: true });
  check('force 跳过缓存重新请求', e3.ok && elevCalls === 2 && e3.meta.fromCache === false, String(elevCalls));

  /* ---------- 6. 失败但有陈旧值 → 带回旧值（绝不空白） ---------- */
  section('6. 失败降级：有陈旧值就上屏');
  cache.__useMemory();
  cache.set(SOURCES.weather.cacheKey(ctx), { tempC: 7 }, 1);
  await sleep(5);
  setFetch(() => {
    throw new Error('network down');
  });
  const stale = await http.request('weather', ctx);
  check('失败但有旧值：data 带回陈旧值', !stale.ok && stale.data && stale.data.tempC === 7);
  check('失败时 meta.cacheState=stale', stale.meta.cacheState === 'stale', stale.meta.cacheState);
  check('失败时 staleAgeMs > 0', stale.meta.staleAgeMs > 0, String(stale.meta.staleAgeMs));
  check('失败错误码 NETWORK 且可重试', stale.error.code === 'NETWORK' && stale.error.retriable === true);

  /* ---------- 7. 离线短路 ---------- */
  section('7. 离线短路（不发请求）');
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let navSwapped = false;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
    navSwapped = true;
  } catch (err) {
    process.stdout.write(`  ! 无法改写 navigator，跳过离线短路用例（${err && err.message}）\n`);
  }
  if (navSwapped) {
    let offCalls = 0;
    setFetch(() => {
      offCalls += 1;
      return jsonRes({ elevation: [1] });
    });
    const off = await http.request('elevation', ctx);
    check('离线：直接返回 OFFLINE', !off.ok && off.error.code === 'OFFLINE', off.error && off.error.code);
    check('离线：一次请求都没发', offCalls === 0, String(offCalls));
    check('离线：isOnline()=false', http.isOnline() === false);
    const forced = await http.request('elevation', ctx, { force: true });
    check('force 可跳过离线短路（仅自检页可用）', forced.ok === true && offCalls === 1, `${forced.ok}/${offCalls}`);
  }
  if (navDesc && navDesc.configurable !== false) {
    try {
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });
    } catch (err) {
      /* ignore */
    }
  }

  /* ---------- 8. URL 拼装（实测定稿，不得改动） ---------- */
  section('8. URL 拼装与源契约');
  const wReq = buildWeatherRequest(ctx);
  check('weather 端点', wReq.url === 'https://api.open-meteo.com/v1/forecast', wReq.url);
  check('weather current 字段', wReq.params.current.indexOf('temperature_2m') === 0 && wReq.params.current.indexOf('visibility') !== -1);
  check('weather daily 字段', wReq.params.daily.indexOf('weather_code') === 0 && wReq.params.daily.indexOf('precipitation_sum') !== -1);
  check('weather hourly 字段', wReq.params.hourly === 'temperature_2m,precipitation_probability,weather_code');
  check('weather timezone=auto & 7 天', wReq.params.timezone === 'auto' && wReq.params.forecast_days === 7);
  const wUrl = http.buildUrl(wReq);
  check('拼参含 lat/lon（toFixed(4)）', wUrl.indexOf('latitude=39.9087') !== -1 && wUrl.indexOf('longitude=116.3975') !== -1);

  const aReq = buildAirRequest(ctx);
  check('air 端点', aReq.url === 'https://air-quality-api.open-meteo.com/v1/air-quality', aReq.url);
  check('air current 字段', aReq.params.current === 'european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide');

  const gReq = buildGeocodeRequest(ctx);
  check('geocode 端点与参数', gReq.url === 'https://geocoding-api.open-meteo.com/v1/search' && gReq.params.count === 10 && gReq.params.language === 'zh' && gReq.params.format === 'json');

  const elReq = buildElevationRequest(ctx);
  check('elevation 端点', elReq.url === 'https://api.open-meteo.com/v1/elevation', elReq.url);

  const rvReq = buildReverseRequest(ctx);
  check('reverse 端点与 lang', rvReq.url === 'https://photon.komoot.io/reverse' && rvReq.params.lang === 'default');

  check(
    '瓦片 URL（street：{z}/{y}/{x}）',
    tileUrl('street', 12, 3373, 1550) === 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/12/1550/3373',
    tileUrl('street', 12, 3373, 1550)
  );
  check(
    '瓦片 URL（imagery）',
    tileUrl('imagery', 12, 3373, 1550).indexOf('World_Imagery/MapServer/tile/12/1550/3373') !== -1
  );
  check(
    '瓦片 URL（dark：路径层级不同，Canvas/...）',
    tileUrl('dark', 12, 3373, 1550) === 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/12/1550/3373',
    tileUrl('dark', 12, 3373, 1550)
  );

  check('六源顺序 weather,air,geocode,elevation,reverse,tile', SOURCE_LIST.map((s) => s.id).join(',') === 'weather,air,geocode,elevation,reverse,tile');
  check('weather 契约 6000/1/600000', SOURCES.weather.timeoutMs === 6000 && SOURCES.weather.retry === 1 && SOURCES.weather.ttlMs === 600000);
  check('air 契约 6000/1/600000', SOURCES.air.timeoutMs === 6000 && SOURCES.air.retry === 1 && SOURCES.air.ttlMs === 600000);
  check('geocode 契约 6000/1/86400000', SOURCES.geocode.timeoutMs === 6000 && SOURCES.geocode.retry === 1 && SOURCES.geocode.ttlMs === 86400000);
  check('elevation 契约 6000/1/604800000', SOURCES.elevation.timeoutMs === 6000 && SOURCES.elevation.retry === 1 && SOURCES.elevation.ttlMs === 604800000);
  check('reverse 契约 6000/1/604800000', SOURCES.reverse.timeoutMs === 6000 && SOURCES.reverse.retry === 1 && SOURCES.reverse.ttlMs === 604800000);
  check('tile 契约 6000/0/不缓存', SOURCES.tile.timeoutMs === 6000 && SOURCES.tile.retry === 0 && SOURCES.tile.ttlMs === 0 && SOURCES.tile.cacheable === false);

  /* ---------- 9. 响应解析 ---------- */
  section('9. 响应解析');
  const wj = {
    utc_offset_seconds: 28800,
    current: {
      time: '2025-03-20T14:00',
      temperature_2m: 18.2,
      relative_humidity_2m: 46,
      apparent_temperature: 17.1,
      precipitation: 0.2,
      weather_code: 2,
      wind_speed_10m: 3.4,
      wind_direction_10m: 135,
      surface_pressure: 1013.4,
      visibility: 12400,
    },
    daily: {
      weather_code: [2],
      temperature_2m_max: [21.5],
      temperature_2m_min: [7.8],
      sunrise: ['2025-03-20T06:20'],
      sunset: ['2025-03-20T18:32'],
      uv_index_max: [5],
      precipitation_sum: [0.4],
    },
    hourly: {
      temperature_2m: Array.from({ length: 24 }, (_, i) => i),
      precipitation_probability: Array.from({ length: 24 }, (_, i) => i * 3),
    },
  };
  const pw = parseWeather(wj, ctx);
  check('parseWeather 温度/体感/湿度', pw.tempC === 18.2 && pw.feelsC === 17.1 && pw.humidityPct === 46);
  check('parseWeather 风/气压/能见度', pw.windMs === 3.4 && pw.windDeg === 135 && pw.pressureHpa === 1013.4 && pw.visibilityM === 12400);
  check('parseWeather WMO 码', pw.wmoCode === 2);
  check('parseWeather 日出按 utc_offset_seconds 还原', pw.sunriseAt === Date.UTC(2025, 2, 19, 22, 20), String(pw.sunriseAt));
  check('parseWeather 日落按 utc_offset_seconds 还原', pw.sunsetAt === Date.UTC(2025, 2, 20, 10, 32), String(pw.sunsetAt));
  check('parseWeather 观测时刻还原', pw.atMs === Date.UTC(2025, 2, 20, 6, 0), String(pw.atMs));
  check('parseWeather uv/最高/最低', pw.uvMax === 5 && pw.todayMaxC === 21.5 && pw.todayMinC === 7.8);
  check('parseWeather 今日 24h 序列', pw.hourlyTempC.length === 24 && pw.hourlyPopPct.length === 24 && pw.hourlyPopPct[1] === 3);

  const pa = parseAir({ utc_offset_seconds: 28800, current: { time: '2025-03-20T14:00', european_aqi: 42, pm10: 18.4, pm2_5: 11.2, ozone: 63.1, nitrogen_dioxide: 12.7 } }, ctx);
  check('parseAir 欧洲 AQI / PM / O3 / NO2', pa.europeanAqi === 42 && pa.pm10 === 18.4 && pa.pm25 === 11.2 && pa.ozone === 63.1 && pa.no2 === 12.7);

  check('parseElevation（数组响应）', parseElevation({ elevation: [43] }).elevationM === 43);
  check('parseElevation（空响应不崩）', parseElevation({}).elevationM === null);

  const pg = parseGeocode({ results: [{ name: '北京', latitude: 39.9075, longitude: 116.39723, country: '中国', admin1: '北京市', timezone: 'Asia/Shanghai' }] });
  check('parseGeocode 解析地点', pg.length === 1 && pg[0].name === '北京' && pg[0].lat === 39.9075 && pg[0].timezone === 'Asia/Shanghai');
  check('parseGeocode 空结果不崩', parseGeocode({}).length === 0);

  const pr = parseReverse({ features: [{ properties: { name: '天安门', street: '长安街', district: '东城区', city: '北京市', country: '中国', osm_key: 'place' } }] }, ctx);
  check('parseReverse 地名层级拼接', pr.placeName === '天安门 · 长安街 · 东城区 · 北京市 · 中国', String(pr.placeName));
  check('parseReverse 空结果不崩', parseReverse({ features: [] }).placeName === null);

  /* ---------- 10. WMO / AQI / UV / 方位 / 蒲福 ---------- */
  section('10. 映射表：WMO / 欧洲 AQI / UV / 16 方位 / 蒲福');
  // core 只给方位键，「风」这个字由 w.windFrom 一条模板补上（中英语序不同）
  const windText = (deg) => t('w.windFrom', { dir: t(wmo.windDir16(deg).abbrKey) });
  check('WMO 0 → 晴', t(wmo.wmo(0).key) === '晴');
  check('WMO 61 → 小雨', t(wmo.wmo(61).key) === '小雨');
  check('WMO 95 → 雷阵雨', t(wmo.wmo(95).key) === '雷阵雨');
  check('WMO 未知码兜底', t(wmo.wmo(999).key) === '未知天气');
  check('AQI 15 → 优(good)', wmo.aqi(15).level === 'good' && t(wmo.aqi(15).levelKey) === '优');
  check('AQI 35 → 良(fair)', wmo.aqi(35).level === 'fair');
  check('AQI 45 → 中(moderate)', wmo.aqi(45).level === 'moderate');
  check('AQI 65 → 差(poor)', wmo.aqi(65).level === 'poor');
  check('AQI 85 → 很差(very-poor)', wmo.aqi(85).level === 'very-poor');
  check('AQI 120 → 极差(extreme)', wmo.aqi(120).level === 'extreme' && wmo.aqi(120).colorToken === '--c-alert');
  check('AQI advice 非空', typeof t(wmo.aqi(42).adviceKey) === 'string' && t(wmo.aqi(42).adviceKey).length > 0);
  check('UV 1 → 低', wmo.uv(1).level === 'low');
  check('UV 4 → 中', wmo.uv(4).level === 'moderate');
  check('UV 7 → 高', wmo.uv(7).level === 'high');
  check('UV 9 → 很高', wmo.uv(9).level === 'very-high');
  check('UV 11 → 极高', wmo.uv(11).level === 'extreme');
  check('风向 0° → 北风', windText(0) === '北风');
  check('风向 90° → 东风', windText(90) === '东风');
  check('风向 180° → 南风', windText(180) === '南风');
  check('风向 270° → 西风', windText(270) === '西风');
  check('风向 337° → 西北偏北风', windText(337.5) === '西北偏北风');
  check('风向 360° 归一为 0°', windText(360) === '北风');
  check('蒲福 0.1 m/s → 0 级', wmo.beaufort(0.1).level === 0 && t(wmo.beaufort(0.1).key) === '无风');
  check('蒲福 5 m/s → 3 级微风', wmo.beaufort(5).level === 3 && t(wmo.beaufort(5).key) === '微风');
  check('蒲福 20 m/s → 8 级大风', wmo.beaufort(20).level === 8 && t(wmo.beaufort(20).key) === '大风');

  /* ---------- 11. NOAA 日出日落 ---------- */
  section('11. NOAA 日出日落（离线纯函数）');
  const bj = sun.sunriseSunset({ lat: 39.9087, lon: 116.3975, dateUTC: Date.UTC(2025, 2, 20) });
  check('北京春分：有日出日落', bj.sunriseAt !== null && bj.sunsetAt !== null && bj.polar === 'none');
  check('北京春分：昼长 ≈ 12 小时', Math.abs(bj.dayLengthMs - 12 * 3600000) < 25 * 60000, tr(fmt.duration(bj.dayLengthMs)));
  check('北京春分：正午在日出日落之间', bj.solarNoonAt > Math.min(bj.sunriseAt, bj.sunsetAt));
  check('白昼判定', sun.isDaylight(bj.sunriseAt + 3600000, { lat: 39.9087, lon: 116.3975 }) === true);
  check('夜间判定', sun.isDaylight(bj.sunriseAt - 5 * 3600000, { lat: 39.9087, lon: 116.3975 }) === false);
  const pd = sun.sunriseSunset({ lat: 80, lon: 0, dateUTC: Date.UTC(2025, 5, 21) });
  check('北纬 80° 夏至 → 极昼', pd.polar === 'polar-day' && pd.sunriseAt === null);
  const pn = sun.sunriseSunset({ lat: 80, lon: 0, dateUTC: Date.UTC(2025, 11, 21) });
  check('北纬 80° 冬至 → 极夜', pn.polar === 'polar-night' && pn.sunsetAt === null);
  const south = sun.sunriseSunset({ lat: -33.86, lon: 151.2, dateUTC: Date.UTC(2025, 5, 21) });
  check('南半球冬至有日出日落', south.sunriseAt !== null && south.dayLengthMs < 12 * 3600000);

  /* ---------- 12. 瓦片指纹与去重 ---------- */
  section('12. 瓦片指纹（SHA-256 前 16 位）与去重判定');
  const fpA = await fingerprint(new TextEncoder().encode('tile-A-aaa'));
  const fpB = await fingerprint(new TextEncoder().encode('tile-B-bbb'));
  const fpC = await fingerprint(new TextEncoder().encode('tile-C-ccc'));
  check('指纹算法 sha256-16', fpA.algo === 'sha256-16', fpA.algo);
  check('指纹长度 16 hex', fpA.fp.length === 16 && /^[0-9a-f]{16}$/.test(fpA.fp), fpA.fp);
  check('不同字节指纹不同', new Set([fpA.fp, fpB.fp, fpC.fp]).size === 3);
  check('相同字节指纹稳定', (await fingerprint(new TextEncoder().encode('tile-A-aaa'))).fp === fpA.fp);

  const real = dedupeTiles([{ ok: true, fp: fpA.fp }, { ok: true, fp: fpB.fp }, { ok: true, fp: fpC.fp }]);
  check('三瓦片指纹各异 → real', real.verdict === 'real' && real.unique === 3 && real.total === 3, JSON.stringify(real));
  const fake = dedupeTiles([{ ok: true, fp: fpA.fp }, { ok: true, fp: fpA.fp }, { ok: true, fp: fpA.fp }]);
  check('三瓦片指纹全同 → fake（占位图）', fake.verdict === 'fake' && fake.unique === 1 && fake.total === 3, JSON.stringify(fake));
  const unknown = dedupeTiles([{ ok: true, fp: fpA.fp }, { ok: true, fp: fpA.fp }]);
  check('样本不足 3 → unknown', unknown.verdict === 'unknown', unknown.verdict);
  const mixed = dedupeTiles([{ ok: false, fp: null }, { ok: true, fp: fpA.fp }, { ok: true, fp: fpB.fp }, { ok: true, fp: fpC.fp }]);
  check('失败瓦片不计入去重', mixed.total === 3 && mixed.verdict === 'real', JSON.stringify(mixed));

  const samples = sampleTiles(ctx);
  check('瓦片取样 3 个不同坐标', samples.length === 3 && new Set(samples.map((s) => `${s.z}/${s.x}/${s.y}`)).size === 3, JSON.stringify(samples));

  setNoMapMode(false);
  setFetch((url) => bytesRes(url));
  const probe = await probeTile('street', samples[0]);
  check('probeTile 成功并生成指纹', probe.ok === true && probe.fpAlgo === 'sha256-16' && probe.bytes > 0);
  check('probeTile 记录请求 URL', typeof probe.url === 'string' && probe.url.indexOf('server.arcgisonline.com') !== -1);

  setNoMapMode(false);
  setFetch(() => {
    throw new Error('tile down');
  });
  const probeFail = await probeTile('street', samples[1]);
  // ★契约已改：单块失败不再置位（真机波动 13 倍，一次失败就打没整张地图代价太大），
  //   模式由 degradeMapMode() 按整批裁决：全败 → no-map，部分失败 → grid（仅网格 + 坐标）。
  check('瓦片单块失败不再立刻切无地图', probeFail.ok === false && isNoMapMode() === false && mapMode() === 'map', mapMode());
  check('整批全败 → no-map', degradeMapMode([probeFail]) === 'no-map' && isNoMapMode() === true);
  const partialProbes = [{ ok: true }, { ok: true }, { ok: false }, { ok: false }];
  check('整批部分失败 → grid（先不宣布无地图）', degradeMapMode(partialProbes) === 'grid' && isNoMapMode() === false);
  check('整批全成 → map', degradeMapMode([{ ok: true }, { ok: true }]) === 'map');
  check('空批不动当前模式', degradeMapMode([]) === mapMode() && degradeMapMode(null) === mapMode());
  setNoMapMode(false);

  /* ---------- 13. 健康模型与整体降级态 ---------- */
  section('13. 健康模型与整体降级态');
  health.resetHealth();
  check('初始（idle）→ live', health.overallMode() === 'live', health.overallMode());
  health.recordFailure('elevation', { finishedAt: Date.now(), cacheState: 'miss' }, { code: 'TIMEOUT', sourceId: 'elevation' });
  check('非关键源失败 → partial', health.overallMode() === 'partial', health.overallMode());
  health.resetHealth();
  health.recordFailure('weather', { finishedAt: Date.now(), cacheState: 'miss' }, { code: 'HTTP', sourceId: 'weather', httpStatus: 500 });
  health.recordFailure('air', { finishedAt: Date.now(), cacheState: 'miss' }, { code: 'HTTP', sourceId: 'air', httpStatus: 500 });
  check('关键源全失败 → empty', health.overallMode() === 'empty', health.overallMode());
  health.resetHealth();
  health.recordSuccess('weather', { finishedAt: Date.now(), latencyMs: 120, cacheState: 'stale', staleAgeMs: 900000 });
  check('陈旧数据 → stale', health.overallMode() === 'stale', health.overallMode());
  check('recordSuccess 记录时延', health.getHealth('weather').latencyMs === 120);
  health.resetHealth();
  health.recordSuccess('weather', { finishedAt: Date.now(), latencyMs: 90, cacheState: 'fresh' });
  health.recordSuccess('air', { finishedAt: Date.now(), latencyMs: 110, cacheState: 'fresh' });
  check('全部新鲜成功 → live', health.overallMode() === 'live', health.overallMode());
  health.addSample('weather', 100);
  health.addSample('weather', 200);
  check('自检取样样本入表', health.getHealth('weather').samples.join(',') === '100,200');

  /* ---------- 14. 格式化 / i18n / 坐标 ---------- */
  section('14. 格式化、i18n 与坐标工具');
  check('t() 占位符替换', t('sc.httpStatus', { status: 200 }) === 'HTTP 200', t('sc.httpStatus', { status: 200 }));
  check('t() 缺失键返回 key 本身', t('no.such.key') === 'no.such.key');
  check('坐标格式（4 位小数 + 半球）', fmt.coord(39.9087, 116.3975) === '39.9087°N, 116.3975°E', fmt.coord(39.9087, 116.3975));
  check('南纬西经格式', fmt.coord(-33.86, -70.5) === '33.8600°S, 70.5000°W', fmt.coord(-33.86, -70.5));
  check('相对时间：3 分钟前', tr(fmt.relativeTime(Date.now() - 3 * 60000, Date.now())) === '3 分钟前');
  check('相对时间：刚刚', tr(fmt.relativeTime(Date.now() - 1000, Date.now())) === '刚刚');
  check('字节格式', fmt.bytes(2048) === '2.0 KB' && fmt.bytes(512) === '512 B', fmt.bytes(2048));
  check('能见度 km 换算', fmt.visibility(1500) === '1.5 km' && fmt.visibility(800) === '800 m');
  check('时延格式', fmt.latency(123.6) === '124 ms', fmt.latency(123.6));
  check('昼长格式', tr(fmt.duration(10 * 3600000 + 32 * 60000)) === '10 小时 32 分', tr(fmt.duration(10 * 3600000 + 32 * 60000)));
  check('导出时间戳 YYYYMMDD-HHmm', /^\d{8}-\d{4}$/.test(fmt.stamp(Date.now())), fmt.stamp(Date.now()));
  check('缺失值占位符', fmt.tempC(null) === '—' && fmt.num(undefined) === '—');
  check('round4 归一', geo.round4(39.908749) === 39.9087 && geo.round4('116.39749') === 116.3975);
  check('coordKey 片段', geo.coordKey(39.9087, 116.3975) === '39.9087:116.3975');
  check('默认地点为北京天安门', geo.DEFAULT_PLACE.lat === 39.9087 && geo.DEFAULT_PLACE.lon === 116.3975);
  // ★阶段二已兑现：占位恒等被真算法取代。断言随之升级为「加偏量级 + 往返残差 + 境外不纠偏」三条，
  //   只钉算法自洽，不钉真机数值（架构 §0 的偏移/体积数字是沙箱口径）。
  check(
    'GCJ-02 加偏量级在 100–1000 m（不再是恒等占位）',
    (() => {
      const gcj = geo.wgs84ToGcj02(39.9087, 116.3975);
      const m = geo.distanceKm({ lat: 39.9087, lon: 116.3975 }, gcj) * 1000;
      return m > 100 && m < 1000;
    })()
  );
  check(
    'GCJ-02 往返残差 < 1 m',
    (() => {
      const gcj = geo.wgs84ToGcj02(39.9087, 116.3975);
      const back = geo.gcj02ToWgs84(gcj.lat, gcj.lon);
      return geo.distanceKm({ lat: 39.9087, lon: 116.3975 }, back) * 1000 < 1;
    })()
  );
  check(
    '境外（东京）原样返回不纠偏',
    geo.isInOffsetZone(35.6762, 139.6503) === false &&
      geo.gcj02ToWgs84(35.6762, 139.6503).lat === 35.6762 &&
      geo.wgs84ToGcj02(35.6762, 139.6503).lon === 139.6503
  );

  /* ---------- 15. 缓存容量与清理 ---------- */
  section('15. 缓存清理');
  cache.__useMemory();
  cache.set(cache.makeKey('geocode', 'a'), { v: 1 }, 60000);
  cache.set(cache.makeKey('geocode', 'b'), { v: 2 }, 60000);
  cache.set(cache.makeKey('air', '1', '2'), { v: 3 }, 60000);
  check('按前缀清理', cache.clearPrefix('gs:v1:geocode') === 2, String(cache.clearPrefix('gs:v1:geocode')));
  check('其余键不受影响', cache.get(cache.makeKey('air', '1', '2')) !== null);
  cache.set(cache.makeKey('store', 'prefs'), { debug: false }, 60000);
  check('set 返回 true', cache.set(cache.makeKey('store', 'x'), { a: 1 }, 60000) === true);

  /* ---------- 16. QA 缺陷回归护栏 ---------- */
  section('16. QA 缺陷回归护栏（7 条必修 + 建议项）');

  // 必修 1：自检取样分组按 kind 判定，tile 不得进 API 结果表
  const apiIds = SOURCE_LIST.filter((s) => s.kind === 'api').map((s) => s.id);
  check('samples 分组：API 源 = 5 路、不含 tile', apiIds.join(',') === 'weather,air,geocode,elevation,reverse', apiIds.join(','));
  check('samples 分组：tile 的 kind 为 tile', SOURCES.tile.kind === 'tile');
  // 必修 1b：非法瓦片坐标零请求失败
  setNoMapMode(false);
  let badTileCalls = 0;
  setFetch(() => {
    badTileCalls += 1;
    return bytesRes('x');
  });
  const badProbe = await probeTile('street', { z: undefined, x: undefined, y: undefined });
  check('probeTile 非法坐标 → 不发请求', badProbe.ok === false && badTileCalls === 0, `calls=${badTileCalls}`);
  check('probeTile 非法坐标 → 错误码 PARSE 且不可重试', badProbe.error.code === 'PARSE' && badProbe.error.retriable === false);
  // ★改用 url=null：拼出来的 .../tile/NaN/NaN/NaN 不对应任何真实请求，写进导出 JSON 会误导
  check('probeTile 非法坐标 → url 为 null（不得给出脏 URL）', badProbe.url === null, String(badProbe.url));

  // 必修 2：无地图模式不可 sticky
  setFetch(() => bytesRes('tile-ok'));
  setNoMapMode(true);
  const okProbe = await probeTile('street', { z: 12, x: 1, y: 1 });
  check('瓦片探测成功 → 复位无地图模式', okProbe.ok === true && isNoMapMode() === false);

  // 必修 3：天气码缺失不得显示「晴」
  check('wmo(null) → 未知天气', t(wmo.wmo(null).key) === '未知天气');
  check("wmo('') → 未知天气", t(wmo.wmo('').key) === '未知天气');
  check('wmo(undefined) → 未知天气且 code=-1', t(wmo.wmo(undefined).key) === '未知天气' && wmo.wmo(undefined).code === -1);
  check('wmo([]) → 未知天气（Number([])===0 陷阱）', t(wmo.wmo([]).key) === '未知天气');
  check('wmo(0) 仍为晴（正常码不受影响）', t(wmo.wmo(0).key) === '晴');
  check('aqi 负值：level 兜底 good，displayValue 钳制为 0', wmo.aqi(-10).level === 'good' && wmo.aqi(-10).displayValue === 0);
  check('uv 负值：level 兜底 low，displayValue 钳制为 0', wmo.uv(-3).level === 'low' && wmo.uv(-3).displayValue === 0);

  // 必修 4：sampleTiles 极区不得产生 NaN
  for (const c of [{ lat: 89.9, lon: -179.9 }, { lat: 90, lon: 0 }, { lat: -89.9, lon: 0 }, { lat: 0, lon: 180 }]) {
    const ts = sampleTiles(c);
    const allFinite = ts.every((t) => Number.isFinite(t.x) && Number.isFinite(t.y) && t.x >= 0 && t.y >= 0);
    check(`sampleTiles(${c.lat},${c.lon}) 输出合法瓦片`, allFinite, JSON.stringify(ts));
  }

  // 必修 7 + 额外 1：SourceResult 带显式 stale 字段
  cache.__useMemory();
  cache.set(SOURCES.air.cacheKey(ctx), { europeanAqi: 9 }, 1);
  await sleep(5);
  setFetch(() => {
    throw new Error('down');
  });
  const staleRes = await http.request('air', ctx);
  check('失败带回陈旧值时 stale=true', staleRes.ok === false && staleRes.stale === true, String(staleRes.stale));
  const freshRes = await http.requestRaw('https://x.test/ok', { timeoutMs: 500, retry: 0 }).catch(() => null);
  check('requestRaw 结果也带 stale 字段（失败时 false）', freshRes === null || freshRes.stale === false);

  // 下面两条是 QA「硬规则：缺失绝不显示成 0」与「dateUTC 三种形态等价」的回归护栏，
  // 之前 Number(' ')===0 / Number([])===0 把「没数据」渲染成 0°，ISO 字符串则被当成算不出来。
  const blanks = [' ', '\t', '\n', [], [0]];
  check(
    '空白串 / 空数组一律显示占位符（绝不显示成 0）',
    blanks.every((v) => fmt.tempC(v) === fmt.DASH && fmt.num(v) === fmt.DASH),
    blanks.map((v) => fmt.tempC(v)).join('|')
  );
  check('数字字符串仍正常解析（不能被误判成缺失）', fmt.tempC('23') === '23°' && fmt.num('23.4', 1) === '23.4');

  const isoMs = Date.parse('2025-06-21T00:00:00Z');
  const byMs = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: isoMs });
  const byIso = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: '2025-06-21T00:00:00Z' });
  const byDate = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: new Date(isoMs) });
  check(
    'dateUTC 支持 ms epoch / Date / ISO 字符串且结果一致',
    byIso.sunriseAt === byMs.sunriseAt && byDate.sunriseAt === byMs.sunriseAt && byIso.sunsetAt === byMs.sunsetAt
  );
  const badDate = sun.sunriseSunset({ lat: 39.9, lon: 116.4, dateUTC: 'not-a-date' });
  check('无法解析的 dateUTC 降级为 null 且不抛异常', badDate.sunriseAt === null && badDate.sunsetAt === null);

  /* ---------- 17. 瓦片缓存（内存 LRU + TTL + 样式授信）与三态降级 ---------- */
  section('17. 瓦片缓存（LRU + TTL + 授信）与地图三态');
  clearTileCache();
  markStyleTrusted('street', false);
  markStyleTrusted('imagery', false);
  setNoMapMode(false);

  // 虚拟时钟：TTL 用例必须精确打点，不能靠真实 sleep
  const REAL_NOW = Date.now;
  let clock = REAL_NOW();
  Date.now = () => clock;

  let tileCalls = 0;
  setFetch((url) => {
    tileCalls += 1;
    return bytesRes(url); // 字节随 URL 变化 → 九块瓦片指纹各异
  });

  const tileAt = (i) => ({ z: 12, x: 100 + i, y: 200 });

  // ① 未授信：成功也不写缓存
  const untrusted1 = await probeTile('street', tileAt(0));
  check('未授信样式探测成功', untrusted1.ok === true && untrusted1.fromCache === false);
  check('未授信 → 不写缓存', tileCacheSize() === 0, `size=${tileCacheSize()}`);
  tileCalls = 0;
  await probeTile('street', tileAt(0));
  check('未授信 → 第二次仍走网络', tileCalls === 1, `tileCalls=${tileCalls}`);

  // ② 授信后再请求 → 写缓存；第二次命中缓存且零请求
  markStyleTrusted('street', true);
  const trusted1 = await probeTile('street', tileAt(0));
  check('授信后写入缓存', tileCacheSize() === 1, `size=${tileCacheSize()}`);
  tileCalls = 0;
  const trusted2 = await probeTile('street', tileAt(0));
  check('第二次命中缓存（零请求）', tileCalls === 0, `tileCalls=${tileCalls}`);
  check('命中缓存时 fromCache=true 且 latencyMs=0', trusted2.fromCache === true && trusted2.latencyMs === 0);
  check('命中缓存时 fp / bytes / httpStatus 照实回填', trusted2.fp === trusted1.fp && trusted2.bytes === trusted1.bytes && trusted2.httpStatus === trusted1.httpStatus);

  // ③ TTL 过期不命中
  clock += TILE_CACHE_TTL_MS + 1;
  tileCalls = 0;
  const afterTtl = await probeTile('street', tileAt(0));
  check('TTL 过期 → 不命中，重新走网络', tileCalls === 1 && afterTtl.fromCache === false);

  // ④ LRU 上限：灌满 96 条后再加 1 条，size 仍为 96
  clearTileCache();
  for (let i = 0; i < TILE_CACHE_MAX; i += 1) {
    clock += 1; // 虚拟时钟必须逐条前进，否则所有条目 lastUsed 相同，LRU 无从区分
    await probeTile('street', tileAt(i));
  }
  check(`灌满 ${TILE_CACHE_MAX} 条 → size 等于上限`, tileCacheSize() === TILE_CACHE_MAX, `size=${tileCacheSize()}`);
  tileCalls = 0;
  await probeTile('street', tileAt(0));
  check('最久未用的第 1 条此刻仍在缓存里', tileCalls === 0);
  await probeTile('street', tileAt(999)); // 第 97 条 → 触发淘汰
  check('超过上限后 size 仍等于上限', tileCacheSize() === TILE_CACHE_MAX, `size=${tileCacheSize()}`);
  tileCalls = 0;
  const evicted = await probeTile('street', tileAt(1)); // 已被淘汰（第 1 条刚被用过，淘汰的是第 2 条）
  check('超限时淘汰 lastUsed 最久的条目', evicted.fromCache === false && tileCalls === 1);
  tileCalls = 0;
  const kept = await probeTile('street', tileAt(0)); // 刚被命中过，lastUsed 最新，不会被淘汰
  check('近期用过的条目未被淘汰', kept.fromCache === true && tileCalls === 0);

  // ⑤ 撤销授信 → 该样式的缓存被清空（占位图一旦确诊，缓存必须立即失效）
  clearTileCache();
  markStyleTrusted('imagery', true);
  await probeTile('street', tileAt(0));
  await probeTile('imagery', tileAt(0));
  check('两个授信样式各写一条', tileCacheSize() === 2, `size=${tileCacheSize()}`);
  markStyleTrusted('imagery', false);
  check(
    '撤销授信 → 只清该样式的缓存（street 那条留着）',
    tileCacheSize() === 1 && isStyleTrusted('imagery') === false && isStyleTrusted('street') === true,
    `size=${tileCacheSize()}`
  );

  // ⑥ clearTileCache 全清
  clearTileCache();
  check('clearTileCache 清空全部', tileCacheSize() === 0);

  // ⑥-2 授信持久化（跨会话）：授信落 localStorage，30 天后回到未授信
  markStyleTrusted('street', true);
  check('授信后立即生效', isStyleTrusted('street') === true);
  check('授信有效期常量 = 30 天', TILE_TRUST_TTL_MS === 2592000000);
  clock += TILE_TRUST_TTL_MS + 1;
  check('授信超过 30 天 → 视为未授信（底图源会换，不能永久信任）', isStyleTrusted('street') === false);
  clock -= TILE_TRUST_TTL_MS + 1;
  markStyleTrusted('street', false);
  check('撤销授信后 isStyleTrusted 为假', isStyleTrusted('street') === false);

  // ⑦ 三态常量与兼容语义
  check('MAP_MODE 三态取值固定', MAP_MODE.MAP === 'map' && MAP_MODE.GRID === 'grid' && MAP_MODE.NO_MAP === 'no-map');
  setNoMapMode(true);
  check('setNoMapMode(true) → no-map 且 isNoMapMode() 为真', mapMode() === 'no-map' && isNoMapMode() === true);
  setNoMapMode(false);
  check('setNoMapMode(false) → map 且 isNoMapMode() 为假', mapMode() === 'map' && isNoMapMode() === false);
  degradeMapMode([{ ok: true }, { ok: false }]);
  check('grid 状态下 isNoMapMode() 仍为 false（网格算有底图）', mapMode() === 'grid' && isNoMapMode() === false);
  // grid 必须在健康层看得见：否则 isNoMapMode() 为 false → overallMode 落到 live，
  // 出现「底图几乎全空却显示一切正常」的静默降级
  health.resetHealth();
  check('grid 态 → overallMode() 给 partial（绝不落到 live）', health.overallMode() === 'partial', health.overallMode());
  // 主页面必须探多块：单块时 0 < ok < 1 是空集，grid 永远不可达
  check('单块探测下 grid 不可达（故主页面必须探 ≥2 块）', degradeMapMode([{ ok: false }]) === 'no-map');
  setNoMapMode(false);

  Date.now = REAL_NOW;
  clearTileCache();
  markStyleTrusted('street', false);

  /* ---------- 汇总 ---------- */
  const total = PASS + FAIL;
  process.stdout.write(`\n${'-'.repeat(52)}\n`);
  process.stdout.write(`通过 ${PASS}/${total}\n`);
  if (FAIL > 0) {
    process.stdout.write(`失败 ${FAIL} 项：\n`);
    FAILURES.forEach((f) => process.stdout.write(`  - ${f}\n`));
  } else {
    process.stdout.write('失败 0 项\n');
  }
  process.stdout.write(`${'-'.repeat(52)}\n`);
  return FAIL === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`smoke crashed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  }
);
