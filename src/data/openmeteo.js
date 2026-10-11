/**
 * Open-Meteo 四路适配器
 *
 * 职责：只做两件事 —— 构造请求（RequestSpec）与解析响应（→ 内部模型）。
 * 不发请求（统一由 core/http.js 出口）、不读缓存（统一由 core/cache.js 管理）、不渲染。
 *
 * 覆盖：forecast（天气）/ air-quality（空气）/ geocoding（地名搜索）/ elevation（海拔）。
 * URL 与参数为实测定稿值，**不得改动**；新增字段需同步到 README 的数据源契约表。
 */

import { round4 } from '../core/geo.js';
import { sunriseSunset } from '../core/sun.js';

/** 各服务基址（仅 https，禁止降级 http）。 */
export const WEATHER_HOST = 'https://api.open-meteo.com';
export const AIR_HOST = 'https://air-quality-api.open-meteo.com';
export const GEOCODE_HOST = 'https://geocoding-api.open-meteo.com';
export const ELEVATION_HOST = 'https://api.open-meteo.com';

/** 许可署名（数据源归属，界面溯源气泡与导出报告共用）。 */
export const OPENMETEO_ATTRIBUTION = 'Open-Meteo.com（CC-BY 4.0）';

/** forecast 请求字段（实测定稿，不可增删）。 */
export const WEATHER_CURRENT_FIELDS =
  'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,visibility';
export const WEATHER_DAILY_FIELDS =
  'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum';
export const WEATHER_HOURLY_FIELDS = 'temperature_2m,precipitation_probability,weather_code';

/** air-quality 请求字段。 */
export const AIR_CURRENT_FIELDS = 'european_aqi,pm10,pm2_5,ozone,nitrogen_dioxide';

/**
 * 把 Open-Meteo 的「本地 ISO 时间串」转成 UTC 毫秒。
 *
 * 背景：timezone=auto 时返回串不带时区偏移（形如 '2025-01-05T07:12'），
 * 需按响应里的 utc_offset_seconds 还原成 UTC 毫秒，避免被浏览器本地时区误解析。
 *
 * @param {string|null} s 时间串。
 * @param {number} offsetSec 数据源返回的 utc_offset_seconds。
 * @returns {number|null} ms epoch 或 null。
 */
export function localIsoToMs(s, offsetSec = 0) {
  if (!s) return null;
  let str = String(s);
  // 'YYYY-MM-DDTHH:MM' → 补秒，保证 Date.parse 稳定
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)) str = `${str}:00`;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(str);
  const ms = Date.parse(hasZone ? str : `${str}Z`);
  if (!Number.isFinite(ms)) return null;
  return hasZone ? ms : ms - (Number(offsetSec) || 0) * 1000;
}

/**
 * 安全取数组首元素。
 *
 * @param {Array|undefined} arr 数组。
 * @param {number} [i=0] 下标。
 * @returns {*} 元素或 undefined。
 */
function _at(arr, i = 0) {
  return Array.isArray(arr) && arr.length > i ? arr[i] : undefined;
}

/**
 * 取数字或 null。
 *
 * @param {*} v 值。
 * @returns {number|null} 数字或 null。
 */
function _n(v) {
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

/**
 * 在 hourly 序列里定位「当前时次」的下标。
 *
 * 为什么必须按**时间串**对位，而不是直接用「现在是几点」当下标：
 * `hourly.*` 是逐时序列，`current.*` 是数据源给的那个时次，两者靠 `hourly.time`
 * 对齐才是同一件事。用「本地小时数」当下标隐含两个假设 —— 序列首项恰好是当地
 * 0 点、且请求当天恰好是序列第一天；`forecast_days` 或时区一变，两个假设同时塌，
 * 取到的就是**别的时刻**的概率，而数字看起来完全正常（都是 0–100），无从发现。
 *
 * 对位口径取到小时（'YYYY-MM-DDTHH'，13 字符）：`current.time` 形如
 * '2025-06-21T14:00'，逐时串形如 '2025-06-21T14:00'，截断到小时即唯一命中。
 * 找不到（序列缺失 / 时间格式变了）返回 null，由调用方走小时数兜底或留空 ——
 * ★绝不能因为定位失败就默认取下标 0，那是拿「当地 0 点」冒充「此刻」。
 *
 * @param {Array|undefined} hourlyTimes hourly.time 数组（当地 ISO 时间串）。
 * @param {string|null|undefined} currentTime current.time（当地 ISO 时间串）。
 * @returns {number|null} 命中下标；无序列或没对上时 null。
 */
export function currentHourIndex(hourlyTimes, currentTime) {
  if (!Array.isArray(hourlyTimes) || hourlyTimes.length === 0) return null;
  const key = String(currentTime === null || currentTime === undefined ? '' : currentTime).slice(0, 13);
  // 空串 / 短串说明 current.time 整个缺失或格式不对，不拿它去比对（否则会去匹配空串）
  if (key.length < 13) return null;
  for (let i = 0; i < hourlyTimes.length; i += 1) {
    const h = String(hourlyTimes[i] === null || hourlyTimes[i] === undefined ? '' : hourlyTimes[i]).slice(0, 13);
    if (h === key) return i;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* weather                                                             */
/* ------------------------------------------------------------------ */

/**
 * 构造天气请求。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildWeatherRequest(ctx) {
  return {
    url: `${WEATHER_HOST}/v1/forecast`,
    params: {
      latitude: round4(ctx.lat).toFixed(4),
      longitude: round4(ctx.lon).toFixed(4),
      current: WEATHER_CURRENT_FIELDS,
      daily: WEATHER_DAILY_FIELDS,
      hourly: WEATHER_HOURLY_FIELDS,
      timezone: 'auto',
      forecast_days: 7,
    },
    responseType: 'json',
  };
}

/**
 * 解析天气响应 → WeatherNow（含今日 24h 序列，阶段二图表再用）。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {Object} WeatherNow（额外带 tzOffsetSec / todayMaxC / todayMinC / precipSumMm）。
 */
export function parseWeather(json, ctx) {
  const current = (json && json.current) || {};
  const daily = (json && json.daily) || {};
  const hourly = (json && json.hourly) || {};
  const offsetSec = _n(json && json.utc_offset_seconds) || 0;

  // 上游 daily 提供日出日落；缺失时用本地 NOAA 算法兜底（离线也可用）
  let sunriseAt = localIsoToMs(_at(daily.sunrise), offsetSec);
  let sunsetAt = localIsoToMs(_at(daily.sunset), offsetSec);
  if (sunriseAt === null || sunsetAt === null) {
    const fallback = sunriseSunset({
      lat: ctx.lat,
      lon: ctx.lon,
      dateUTC: Date.now(),
    });
    sunriseAt = fallback.sunriseAt;
    sunsetAt = fallback.sunsetAt;
  }

  const hourlyTempRaw = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
  const hourlyPopRaw = Array.isArray(hourly.precipitation_probability) ? hourly.precipitation_probability : [];
  const hourlyTimeRaw = Array.isArray(hourly.time) ? hourly.time : [];

  // 降水概率（precipitation_probability）是**逐时**量，界面要的是「此刻这一小时」那一个。
  // 先按 hourly.time 与 current.time 对位（见 currentHourIndex 的 JSDoc）；对不上时退到
  // 「本地小时数」这层兜底 —— 那是次优解，但比留空更有用，且兜底只在序列缺 time 时发生。
  // ★两条路都失败（返回 null / 越界）时值就是 null，界面显示占位符「—」，不填 0。
  let popIdx = currentHourIndex(hourlyTimeRaw, current.time);
  if (popIdx === null) {
    const atMs = localIsoToMs(current.time, offsetSec);
    popIdx = atMs === null ? null : new Date(atMs + offsetSec * 1000).getUTCHours();
  }
  const popNowPct = popIdx === null ? null : _n(hourlyPopRaw[popIdx]);

  return {
    atMs: localIsoToMs(current.time, offsetSec) || Date.now(),
    tzOffsetSec: offsetSec,
    tempC: _n(current.temperature_2m),
    feelsC: _n(current.apparent_temperature),
    humidityPct: _n(current.relative_humidity_2m),
    precipMm: _n(current.precipitation),
    // 降水概率（%）：与上面 precipMm（降水量 mm）是两个不同的量，界面上必须分开标注。
    // 取不到（数据源没给逐时序列 / 对位失败 / 该点为 null）时是 null，绝不退成 0 ——
    // 「0%」是「确定不会下雨」，与「不知道」是两回事。
    popNowPct,
    windMs: _n(current.wind_speed_10m),
    windDeg: _n(current.wind_direction_10m),
    pressureHpa: _n(current.surface_pressure),
    visibilityM: _n(current.visibility),
    wmoCode: _n(current.weather_code),
    sunriseAt,
    sunsetAt,
    uvMax: _n(_at(daily.uv_index_max)),
    todayMaxC: _n(_at(daily.temperature_2m_max)),
    todayMinC: _n(_at(daily.temperature_2m_min)),
    precipSumMm: _n(_at(daily.precipitation_sum)),
    dailyWmoCode: _n(_at(daily.weather_code)),
    hourlyTempC: hourlyTempRaw.slice(0, 24).map((v) => _n(v)),
    hourlyPopPct: hourlyPopRaw.slice(0, 24).map((v) => _n(v)),
  };
}

/* ------------------------------------------------------------------ */
/* air                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 构造空气质量请求。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildAirRequest(ctx) {
  return {
    url: `${AIR_HOST}/v1/air-quality`,
    params: {
      latitude: round4(ctx.lat).toFixed(4),
      longitude: round4(ctx.lon).toFixed(4),
      current: AIR_CURRENT_FIELDS,
      timezone: 'auto',
    },
    responseType: 'json',
  };
}

/**
 * 解析空气质量响应 → AirNow（单位 µg/m³）。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {Object} AirNow。
 */
export function parseAir(json, ctx) {
  const current = (json && json.current) || {};
  const offsetSec = _n(json && json.utc_offset_seconds) || 0;
  return {
    atMs: localIsoToMs(current.time, offsetSec) || Date.now(),
    europeanAqi: _n(current.european_aqi),
    pm10: _n(current.pm10),
    pm25: _n(current.pm2_5),
    ozone: _n(current.ozone),
    no2: _n(current.nitrogen_dioxide),
  };
}

/* ------------------------------------------------------------------ */
/* geocode                                                             */
/* ------------------------------------------------------------------ */

/**
 * 构造地名搜索请求。
 *
 * @param {{keyword:string, lang?:string}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildGeocodeRequest(ctx) {
  return {
    url: `${GEOCODE_HOST}/v1/search`,
    params: {
      name: String(ctx.keyword || ''),
      count: 10,
      language: ctx.lang || 'zh',
      format: 'json',
    },
    responseType: 'json',
  };
}

/**
 * 解析地名搜索响应 → Place[]。
 *
 * @param {Object} json 响应 JSON。
 * @returns {Array<{name:string, lat:number|null, lon:number|null, country:string|null,
 *                  admin1:string|null, timezone:string|null}>} 地点列表。
 */
export function parseGeocode(json) {
  const results = (json && json.results) || [];
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    name: String(r.name || ''),
    lat: _n(r.latitude),
    lon: _n(r.longitude),
    country: r.country || null,
    admin1: r.admin1 || null,
    timezone: r.timezone || null,
  }));
}

/* ------------------------------------------------------------------ */
/* elevation                                                           */
/* ------------------------------------------------------------------ */

/**
 * 构造海拔请求。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildElevationRequest(ctx) {
  return {
    url: `${ELEVATION_HOST}/v1/elevation`,
    params: {
      latitude: round4(ctx.lat).toFixed(4),
      longitude: round4(ctx.lon).toFixed(4),
    },
    responseType: 'json',
  };
}

/**
 * 解析海拔响应。
 *
 * @param {Object} json 响应 JSON。
 * @returns {{elevationM:number|null}} 海拔（米）。
 */
export function parseElevation(json) {
  const arr = (json && json.elevation) || [];
  const v = Array.isArray(arr) ? _n(arr[0]) : _n(json && json.elevation);
  return { elevationM: v };
}
