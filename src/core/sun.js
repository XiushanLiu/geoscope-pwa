/**
 * 日出日落本地算法（NOAA 近似，纯函数、离线可用）
 *
 * 职责：在无网络或上游 daily 缺失时兜底计算 sunrise / sunset / solarNoon / dayLength。
 * 纯函数、零依赖、零网络：不读时钟以外任何全局（Date.now() 仅由调用方传入 dateUTC 决定）。
 *
 * 算法：NOAA Solar Calculator（太阳天顶角 90.833°，含大气折射与日面半径修正）。
 * 返回均为 **ms epoch（UTC 语义）**；显示层按 utc_offset_seconds 转本地时间。
 * 极区可能出现 cosH 越界：cosH > 1 → 极夜，cosH < -1 → 极昼，此时 sunrise/sunset 为 null。
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const DAY_MS = 86400000;

/**
 * 归一化到 [0, 360)。
 *
 * @param {number} deg 角度。
 * @returns {number} 归一化角度。
 */
function _norm360(deg) {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

/**
 * 归一化到 [0, 24)。
 *
 * @param {number} h 小时。
 * @returns {number} 归一化小时。
 */
function _norm24(h) {
  let v = h % 24;
  if (v < 0) v += 24;
  return v;
}

/**
 * 把 dateUTC 入参归一化成 ms epoch。
 *
 * 接受三种形态：ms epoch 数字、Date 实例、可被 Date.parse 解析的字符串（如 ISO 8601）。
 * 直接 Number('2025-06-21T00:00:00Z') 会得到 NaN，从而把「格式不同」误判成「算不出来」，
 * 所以字符串必须走 Date.parse；解析失败返回 NaN，由调用方的有限性校验统一降级为 null。
 *
 * @param {*} v 入参。
 * @returns {number} ms epoch；无法解析时为 NaN。
 */
function _toMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

/**
 * 取 UTC 年内的第几天（1 月 1 日 = 1）。
 *
 * @param {Date} d UTC 日期对象。
 * @returns {number} 天序号。
 */
function _dayOfYear(d) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor((today - start) / DAY_MS) + 1;
}

/**
 * 计算日出日落。
 *
 * @param {{lat:number, lon:number, dateUTC:number, zenith?:number}} args 入参。
 *   lat 纬度（-90..90）；lon 经度（-180..180）；
 *   dateUTC 基准时刻，支持 ms epoch / Date / ISO 字符串三种形态（无法解析则整体降级为 null）；
 *   zenith 太阳天顶角（默认 90.833；显式传 0 生效，非数字 / 未提供回落默认值）；
 * @returns {{sunriseAt:number|null, sunsetAt:number|null, solarNoonAt:number, dayLengthMs:number|null,
 *            polar:'none'|'polar-day'|'polar-night'}} 结果（ms epoch，UTC 语义）。
 */
export function sunriseSunset(args) {
  const lat = Number(args && args.lat);
  const lon = Number(args && args.lon);
  // ★显式传 0 必须生效：旧写法 `Number(...) || 90.833` 会把 0 当成「未提供」。
  //   但也不能直接换成 `??` —— Number(undefined) 是 NaN，而 NaN **不是** nullish，
  //   那样「没传」反而不回落默认值，静默把整条计算送进 NaN。所以两步分开：
  //   ① 先判「未提供」（null / undefined / 空串）→ 用默认值；
  //   ② 再把非数字（含 NaN、Infinity）也挡回默认值，保留原来 `||` 的容错。
  const zenithRaw = args && args.zenith;
  const zenithNum = (zenithRaw === null || zenithRaw === undefined || zenithRaw === '')
    ? 90.833
    : Number(zenithRaw);
  const zenith = Number.isFinite(zenithNum) ? zenithNum : 90.833;
  // dateUTC 三种形态一视同仁：ms epoch / Date / ISO 字符串；解析不出时间就降级为 NaN，
  // 由下面的有限性校验统一返回 null（绝不抛异常，调用方是首屏渲染路径）。
  const dateUTC = _toMs(args && args.dateUTC);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(dateUTC)) {
    return { sunriseAt: null, sunsetAt: null, solarNoonAt: NaN, dayLengthMs: null, polar: 'none' };
  }

  const d = new Date(dateUTC);
  const N = _dayOfYear(d);
  const midnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const lngHour = lon / 15;

  // 太阳平近点角与时间角参数（日出用 6h、日落用 18h）
  const tRise = N + (6 - lngHour) / 24;
  const tSet = N + (18 - lngHour) / 24;

  const M = (0.9856 * tRise) - 3.289;

  // 太阳真黄经
  let L = M + (1.916 * Math.sin(M * RAD)) + (0.020 * Math.sin(2 * M * RAD)) + 282.634;
  L = _norm360(L);

  // 太阳赤经（与 L 同象限）后折算为小时
  let RA = Math.atan(0.91764 * Math.tan(L * RAD)) * DEG;
  RA = _norm360(RA);
  const LQ = Math.floor(L / 90) * 90;
  const RAQ = Math.floor(RA / 90) * 90;
  RA = (RA + (LQ - RAQ)) / 15;

  // 太阳赤纬
  const sinDec = 0.39782 * Math.sin(L * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));

  // 时角余弦
  const cosH =
    (Math.cos(zenith * RAD) - sinDec * Math.sin(lat * RAD)) / (cosDec * Math.cos(lat * RAD));

  // 极昼 / 极夜
  if (cosH > 1) {
    return { sunriseAt: null, sunsetAt: null, solarNoonAt: midnightUtc + 12 * 3600000, dayLengthMs: 0, polar: 'polar-night' };
  }
  if (cosH < -1) {
    return { sunriseAt: null, sunsetAt: null, solarNoonAt: midnightUtc + 12 * 3600000, dayLengthMs: DAY_MS, polar: 'polar-day' };
  }

  const H = Math.acos(cosH) * DEG;
  const hRise = (360 - H) / 15;
  const hSet = H / 15;

  const tRiseUtc = _norm24(hRise + RA - 0.06571 * tRise - 6.622 - lngHour);
  const tSetUtc = _norm24(hSet + RA - 0.06571 * tSet - 6.622 - lngHour);

  const sunriseAt = midnightUtc + tRiseUtc * 3600000;
  const sunsetAt = midnightUtc + tSetUtc * 3600000;
  let dayLengthMs = sunsetAt - sunriseAt;
  if (dayLengthMs < 0) dayLengthMs += DAY_MS;
  const solarNoonAt = sunriseAt + dayLengthMs / 2;

  return { sunriseAt, sunsetAt, solarNoonAt, dayLengthMs, polar: 'none' };
}

/**
 * 正午（太阳中天）时刻。
 *
 * @param {{lat:number, lon:number, dateUTC:number}} args 入参。
 * @returns {number} ms epoch。
 */
export function solarNoon(args) {
  const r = sunriseSunset(args);
  return Number.isFinite(r.solarNoonAt) ? r.solarNoonAt : Number(args && args.dateUTC);
}

/**
 * 指定时刻是否白昼。
 *
 * @param {number} atMs 待判时刻（ms epoch）。
 * @param {{lat:number, lon:number}} pos 位置。
 * @returns {boolean} true = 白昼。
 */
export function isDaylight(atMs, pos) {
  const r = sunriseSunset({ lat: pos.lat, lon: pos.lon, dateUTC: Number(atMs) });
  if (r.polar === 'polar-day') return true;
  if (r.polar === 'polar-night') return false;
  if (r.sunriseAt === null || r.sunsetAt === null) return true;
  if (r.sunsetAt >= r.sunriseAt) {
    return atMs >= r.sunriseAt && atMs < r.sunsetAt;
  }
  // 跨日情况（高纬）：日落时刻在次日
  return atMs >= r.sunriseAt || atMs < r.sunsetAt;
}
