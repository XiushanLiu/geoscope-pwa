/**
 * 定位与坐标工具
 *
 * 职责：封装浏览器定位（WGS84）、坐标四舍五入（toFixed(4) ≈ 11 m）、缓存键片段生成、
 * 两点球面距离，以及 **GCJ-02 ↔ WGS84 双向纠偏**。
 *
 * ★坐标系方向（改代码前先读）：本模块的**内部与对外口径一律是 WGS84**。
 *   - `wgs84ToGcj02()`：把 WGS84 加偏成 GCJ-02（只在「要按中国法规提交给国内服务」时用）；
 *   - `gcj02ToWgs84()`：把 GCJ-02 反解回 WGS84（**国内来源的 POI 真正要用的方向** ——
 *     国内服务返回的 POI 是 GCJ-02，必须转回 WGS84 才能和 Esri 底图画在同一张图上）。
 *   两者**不是**同一个函数，方向搞反会把点位挪到几百米外（架构 §2.2：天安门处经度偏移
 *   可达 531 m），属于「看起来正常但错了」的最坏一类 bug。
 *
 * ★境外（含港澳台以外的中国境外偏移区）一律**原样返回、不纠偏**，由 `isInOffsetZone()`
 *   判定（实测口径：东京坐标经 gcj02ToWgs84 返回原值）。
 *
 * 算法说明（不是本仓库自创）：GCJ-02 加偏使用官方公布的克拉索夫斯基椭球参数与三角级数，
 * 反解（GCJ-02 → WGS84）用 **5 次定常迭代反演** —— 偏移量本身只有几百米、梯度平缓，
 * 迭代 5 次后往返残差已远小于 1 m。
 * ★2026-10-17 自驾下线：这里原本钉着「往返残差」的 6 个样本断言，它们住在自驾那批
 *   测试里、随自驾一起删除了。删除后这两个函数今天**没有自动化断言**守着（唯一在用的
 *   调用方是 data/tiles.js），属于已知覆盖缺口 —— 不假装有人守。
 *   要补就在 core 自己的测试里补，别靠一个已删除的测试假装它还在。
 *
 * 红线：内部坐标一律 WGS84；绝不上传用户坐标到数据源以外的任何地方。
 */

/** 定位超时（毫秒）：超时即降级为默认地点，不阻塞首屏。 */
export const GEO_TIMEOUT_MS = 8000;

/**
 * 出厂默认地点的**标记名**。
 *
 * ★它是一个**地名**，界面上必须跟着语言走（英文界面下要写成 "Beijing · Tian'anmen"），
 *   而 core 不许读 locale 表 —— 所以这里存的是**中文那一份原文**，UI 层拿它和
 *   `place.default` 这条文案键对应起来（src/ui/locale.js 的 placeDisplayName()）。
 *   不改成一个抽象标记（比如 'default'）的理由：这个名字会被**写进备份 JSON**，
 *   换成一个标记会让老备份里的默认地点显示成一个词不是地名的值。
 */
export const DEFAULT_PLACE_NAME = '北京 · 天安门';

/** 定位被拒 / 超时 / 无权限时的默认地点：北京天安门（WGS84）。 */
export const DEFAULT_PLACE = { lat: 39.9087, lon: 116.3975, name: DEFAULT_PLACE_NAME };

/**
 * 四位小数取整（≈11 m），用于缓存键与对外传参。
 *
 * @param {number|string} n 数值。
 * @returns {number} 四位小数数字。
 */
export function round4(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 1e4) / 1e4;
}

/**
 * 坐标整体四位小数归一。
 *
 * @param {{lat:number, lon:number}} c 坐标。
 * @returns {{lat:number, lon:number}} 归一后的坐标。
 */
export function roundCoord(c) {
  return { lat: round4(c.lat), lon: round4(c.lon) };
}

/**
 * 生成缓存键坐标片段 '39.9087:116.3975'。
 *
 * @param {number} lat 纬度。
 * @param {number} lon 经度。
 * @returns {string} 键片段。
 */
export function coordKey(lat, lon) {
  return `${round4(lat).toFixed(4)}:${round4(lon).toFixed(4)}`;
}

/**
 * 取当前位置。
 *
 * 行为：优先 navigator.geolocation（超时 8 s）；无权限 / 拒绝 / 超时 / 环境不支持时，
 * 一律降级为 DEFAULT_PLACE，并标记 source='default'，保证此刻屏始终可渲染。
 *
 * 附带海拔：`coords.altitude` 是**高于 WGS84 椭球面的高度（米）**，正好是 WMM 需要的
 * 那个「椭球高」定义（不是海拔高，两者可差几十米；磁偏角对这个量不敏感，够用）。
 * 拿不到就是 null，消费侧必须能接受缺失（方位屏按 0 参与计算）。
 *
 * @param {{timeoutMs?:number, enableHighAccuracy?:boolean}} [opts] 定位参数。
 * @returns {Promise<{lat:number, lon:number, source:'gps'|'default', accuracyM:number|null, altitudeM:number|null, name:string|null}>} 坐标结果。
 */
export function getCurrentPosition(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || GEO_TIMEOUT_MS;
  const enableHighAccuracy = opts.enableHighAccuracy !== false;

  const fallback = () => ({
    lat: DEFAULT_PLACE.lat,
    lon: DEFAULT_PLACE.lon,
    source: 'default',
    accuracyM: null,
    altitudeM: null,
    name: DEFAULT_PLACE.name,
  });

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(fallback());
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // 硬超时：定位回调迟迟不返回时也要放行首屏
    const timer = setTimeout(() => finish(fallback()), timeoutMs);

    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          clearTimeout(timer);
          const coords = pos && pos.coords ? pos.coords : null;
          if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
            finish(fallback());
            return;
          }
          finish({
            lat: round4(coords.latitude),
            lon: round4(coords.longitude),
            source: 'gps',
            accuracyM: Number.isFinite(coords.accuracy) ? Math.round(coords.accuracy) : null,
            altitudeM: Number.isFinite(coords.altitude) ? Math.round(coords.altitude) : null,
            name: null,
          });
        },
        () => {
          // 拒绝 / 不可用 / 位置信息缺失：统一降级
          clearTimeout(timer);
          finish(fallback());
        },
        {
          enableHighAccuracy,
          timeout: timeoutMs,
          maximumAge: 600000, // 10 分钟内复用系统缓存，减少定位耗电
        }
      );
    } catch (err) {
      clearTimeout(timer);
      finish(fallback());
    }
  });
}

/**
 * 两点球面距离（Haversine），单位 km（阶段二「附近」能力预留）。
 *
 * @param {{lat:number, lon:number}} a 起点。
 * @param {{lat:number, lon:number}} b 终点。
 * @returns {number} 距离 km。
 */
export function distanceKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/* ------------------------------------------------------------------ */
/* GCJ-02 纠偏（官方算法常量 + 双向变换）                                */
/* ------------------------------------------------------------------ */

/** GCJ-02 加偏所用椭球的长半轴（克拉索夫斯基 1940，单位：米）。 */
const GCJ_A = 6378245.0;

/** 该椭球的第一偏心率平方。 */
const GCJ_EE = 0.00669342162296594323;

/** 圆周率：与公开实现保持一致，改精度会让结果差出米级。 */
const GCJ_PI = 3.1415926535897932384626;

/** GCJ-02 施加偏移的经度范围（中国大陆的粗略外包框，境外一律不纠偏）。 */
const OFFSET_LON_MIN = 72.004;
const OFFSET_LON_MAX = 137.8347;
/** GCJ-02 施加偏移的纬度范围。 */
const OFFSET_LAT_MIN = 0.8293;
const OFFSET_LAT_MAX = 55.8271;

/**
 * 安全取有限数字（缺失一律 null，绝不变成 0）。
 *
 * ★为什么不能直接 `Number(v)`：`Number(null) === 0`、`Number('') === 0` —— 于是
 *   「没有坐标」会被变成「几内亚湾 0,0」，再经过加偏计算后看起来是一个合法的中国境外
 *   坐标，错得悄无声息。口径与 core/format.js 的 `_num()` 完全一致。
 *
 * @param {*} v 任意值。
 * @returns {number|null} 有限数字或 null。
 */
function _finite(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (Array.isArray(v)) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 判定一个坐标是否落在 GCJ-02 的偏移区（中国大陆粗略外包框）内。
 *
 * ★为什么是「粗略外包框」而不是精确国界：GCJ-02 的加偏范围从来没有被官方公布过精确
 *   边界，公开实现一致使用这个外包框。**框外的点一律原样返回** —— 拿一个框外的坐标去
 *   加偏/反解，会凭空制造几百米的误差，那是比不纠偏严重得多的错。
 *
 * @param {number} lat 纬度。
 * @param {number} lon 经度。
 * @returns {boolean} 落在偏移区内返回 true；非数字一律 false（宁可不纠偏，也不制造假偏移）。
 */
export function isInOffsetZone(lat, lon) {
  const la = _finite(lat);
  const lo = _finite(lon);
  if (la === null || lo === null) return false;
  if (lo < OFFSET_LON_MIN || lo > OFFSET_LON_MAX) return false;
  if (la < OFFSET_LAT_MIN || la > OFFSET_LAT_MAX) return false;
  return true;
}

/**
 * 纬度方向的加偏分量（官方算法的三角级数项）。
 *
 * @param {number} x 相对 105°E 的经度差。
 * @param {number} y 相对 35°N 的纬度差。
 * @returns {number} 以「米」为量纲的中间量，调用方再换算成角度。
 */
function _transformLat(x, y) {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * GCJ_PI) + 40.0 * Math.sin((y / 3.0) * GCJ_PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * GCJ_PI) + 320 * Math.sin((y * GCJ_PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

/**
 * 经度方向的加偏分量（官方算法的三角级数项）。
 *
 * @param {number} x 相对 105°E 的经度差。
 * @param {number} y 相对 35°N 的纬度差。
 * @returns {number} 以「米」为量纲的中间量，调用方再换算成角度。
 */
function _transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * GCJ_PI) + 20.0 * Math.sin(2.0 * x * GCJ_PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * GCJ_PI) + 40.0 * Math.sin((x / 3.0) * GCJ_PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * GCJ_PI) + 300.0 * Math.sin((x / 30.0) * GCJ_PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * WGS84 → GCJ-02 加偏。
 *
 * 用途：只在「必须按 GCJ-02 提交坐标给国内服务」时才用。本仓实际走的是**反方向**
 * （`gcj02ToWgs84`：把国内来源的 GCJ-02 点位转回 WGS84），别拿错。
 * 境内返回加偏后的坐标，境外（见 `isInOffsetZone`）原样返回。
 *
 * @param {number} lat WGS84 纬度。
 * @param {number} lon WGS84 经度。
 * @returns {{lat:number, lon:number}} GCJ-02 坐标（境外 = 入参原值）。
 */
export function wgs84ToGcj02(lat, lon) {
  const la = _finite(lat);
  const lo = _finite(lon);
  // 非数字 / 境外：原样返回（★注意返回的是**入参原值**，不是 Number() 后的 0）
  if (la === null || lo === null) return { lat, lon };
  if (!isInOffsetZone(la, lo)) return { lat: la, lon: lo };

  let dLat = _transformLat(lo - 105.0, la - 35.0);
  let dLon = _transformLon(lo - 105.0, la - 35.0);

  const radLat = (la / 180.0) * GCJ_PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * GCJ_PI);
  dLon = (dLon * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * GCJ_PI);

  return { lat: la + dLat, lon: lo + dLon };
}

/** GCJ-02 → WGS84 的反演迭代次数。 */
export const GCJ_INVERSE_ITERATIONS = 5;

/**
 * GCJ-02 → WGS84 逆变换（**本仓真正要用的方向**：国内来源点位 → WGS84）。
 *
 * 方法：定常迭代反演 —— 从一个 WGS84 猜测值出发，反复「加偏 → 用残差修正猜测值」。
 * 加偏量只有几百米且梯度平缓，5 次迭代后往返残差远小于 1 m（比 GPS 自身精度还小一个量级），
 * 再增加迭代没有实际意义。
 *
 * ★境外坐标**原样返回**（`converted` 语义由调用方据 `isInOffsetZone()` 自行标注）。
 *
 * @param {number} lat GCJ-02 纬度。
 * @param {number} lon GCJ-02 经度。
 * @returns {{lat:number, lon:number}} WGS84 坐标（境外 = 入参原值）。
 */
export function gcj02ToWgs84(lat, lon) {
  const la = _finite(lat);
  const lo = _finite(lon);
  if (la === null || lo === null) return { lat, lon };
  if (!isInOffsetZone(la, lo)) return { lat: la, lon: lo };

  let guessLat = la;
  let guessLon = lo;
  for (let i = 0; i < GCJ_INVERSE_ITERATIONS; i += 1) {
    const gcj = wgs84ToGcj02(guessLat, guessLon);
    guessLat += la - gcj.lat;
    guessLon += lo - gcj.lon;
  }
  return { lat: guessLat, lon: guessLon };
}
