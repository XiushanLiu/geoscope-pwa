/**
 * 定位与坐标工具
 *
 * 职责：封装浏览器定位（WGS84）、坐标四舍五入（toFixed(4) ≈ 11 m）、缓存键片段生成，
 * 并提供 GCJ-02 纠偏的**占位**实现（阶段二实现，业务层本阶段禁止调用）。
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

/**
 * WGS84 → GCJ-02 纠偏。
 *
 * 阶段二实现。当前为**空实现（原值返回）**，并明确注释：本阶段业务层禁止调用本函数，
 * 显示层不做任何坐标变换，界面坐标即数据源返回的 WGS84 原值。
 *
 * @param {number} lat WGS84 纬度。
 * @param {number} lon WGS84 经度。
 * @returns {{lat:number, lon:number}} GCJ-02 坐标（当前等于入参）。
 */
export function wgs84ToGcj02(lat, lon) {
  // 阶段二实现：需引入加密纠偏算法（含中国境外不纠偏的边界判断）。
  // 本阶段保持恒等返回，避免误以为已纠偏。
  return { lat: Number(lat), lon: Number(lon) };
}

/**
 * GCJ-02 → WGS84 逆变换。
 *
 * 阶段二实现；当前为空实现（原值返回）。
 *
 * @param {number} lat GCJ-02 纬度。
 * @param {number} lon GCJ-02 经度。
 * @returns {{lat:number, lon:number}} WGS84 坐标（当前等于入参）。
 */
export function gcj02ToWgs84(lat, lon) {
  // 阶段二实现。
  return { lat: Number(lat), lon: Number(lon) };
}
