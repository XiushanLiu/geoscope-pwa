/**
 * 格式化工具（纯函数，无副作用、无网络）
 *
 * 职责：把「存储层的原始数值」转成「上屏的人类可读字符串」。单位换算只发生在展示层，
 * 存储与接口层固定使用：温度 °C / 风速 m·s⁻¹ / 风向 deg / 气压 hPa / 能见度 m /
 * 降水量 mm / 海拔 m / 污染物 µg·m⁻³ / 时延 ms / 字节 byte。
 *
 * 约束：所有函数对 null / undefined / NaN 一律返回占位符（'—'），绝不抛异常。
 */

/** 占位符：数值缺失时统一展示。 */
export const DASH = '—';

/**
 * 安全取数：非有限数字返回 null，便于上层决定显示占位符。
 *
 * @param {*} v 任意值。
 * @returns {number|null} 有限数字或 null。
 */
function _num(v) {
  // 硬规则：缺失绝不显示成 0。必须显式拦截的几类「看起来有值其实是空」的入参：
  //   - null / undefined：Number(null) === 0，不拦截就会把「没数据」渲染成 0°；
  //   - 布尔：true → 1、false → 0，同样是伪装成数值的空值；
  //   - 纯空白串 '' / ' ' / '\t' / '\n'：Number('') 与 Number(' ') 都是 0，必须先 trim 再判空；
  //   - 数组（含 [] 与 [0]）：Number([]) === 0、Number([0]) === 0，而数组从来不是标量温度。
  // 数字字符串（'23'）走正常解析，不能被误判成缺失。
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (Array.isArray(v)) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 固定小数位格式化。
 *
 * @param {*} v 数值。
 * @param {number} [digits=0] 小数位数。
 * @param {string} [unit=''] 追加单位。
 * @returns {string} 形如 '23.4 °C'；缺失时返回 '—'。
 */
export function num(v, digits = 0, unit = '') {
  const n = _num(v);
  if (n === null) return DASH;
  const s = n.toFixed(digits);
  return unit ? `${s} ${unit}` : s;
}

/** 温度：'23°'（展示层可不带 °C，单位另由标签给出）。 */
export function tempC(v, digits = 0) {
  const n = _num(v);
  if (n === null) return DASH;
  return `${n.toFixed(digits)}°`;
}

/** 体感温度：'体感 26°' 里的数值部分。 */
export function feelsC(v, digits = 0) {
  return tempC(v, digits);
}

/** 湿度：'48%'。 */
export function humidity(pct) {
  const n = _num(pct);
  if (n === null) return DASH;
  return `${Math.round(n)}%`;
}

/**
 * 通用百分比：'30%'；缺失时返回 '—'。
 *
 * 为什么单独给一个而不复用 humidity()：两者此刻的算法恰好一样（取整 + '%'），
 * 但 humidity 的语义是「相对湿度」，降水概率若借它的函数名，将来任一方改了取整
 * 口径（比如湿度保留一位小数）都会连带改错另一方 —— 语义不同就该各自有名。
 *
 * @param {*} v 百分比数值。
 * @param {number} [digits=0] 小数位数。
 * @returns {string} '30%' 或 '—'。
 */
export function percent(v, digits = 0) {
  const n = _num(v);
  if (n === null) return DASH;
  return `${n.toFixed(digits)}%`;
}

/** 降水：'0.4 mm'；0 显示为 '0 mm'。 */
export function precipMm(v) {
  const n = _num(v);
  if (n === null) return DASH;
  return `${n.toFixed(1)} mm`;
}

/** 风：'3.2 m/s · 11.5 km/h'。 */
export function wind(ms) {
  const n = _num(ms);
  if (n === null) return DASH;
  const kmh = n * 3.6;
  return `${n.toFixed(1)} m/s · ${kmh.toFixed(1)} km/h`;
}

/** 气压：'1013 hPa'。 */
export function pressure(hpa) {
  const n = _num(hpa);
  if (n === null) return DASH;
  return `${Math.round(n)} hPa`;
}

/** 能见度：≥1000 m 转 km，否则保留 m。 */
export function visibility(m) {
  const n = _num(m);
  if (n === null) return DASH;
  if (n >= 1000) return `${(n / 1000).toFixed(1)} km`;
  return `${Math.round(n)} m`;
}

/** 海拔：'43 m'。 */
export function elevationM(m) {
  const n = _num(m);
  if (n === null) return DASH;
  return `${Math.round(n)} m`;
}

/** 污染物浓度：'12.3 µg/m³'。 */
export function pollutant(v) {
  const n = _num(v);
  if (n === null) return DASH;
  return `${n.toFixed(1)} µg/m³`;
}

/** 时延：'123 ms'；≥1000 时保留整数毫秒。 */
export function latency(ms) {
  const n = _num(ms);
  if (n === null) return DASH;
  return `${Math.round(n)} ms`;
}

/** 字节：'12.3 KB'。 */
export function bytes(n) {
  const v = _num(n);
  if (v === null) return DASH;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

/** 补零两位。 */
export function pad2(n) {
  const v = _num(n);
  if (v === null) return '00';
  return String(Math.floor(v)).padStart(2, '0');
}

/**
 * 毫秒 epoch → 'HH:MM'（按给定时区偏移）。
 *
 * @param {number|null} atMs 毫秒 epoch。
 * @param {number} [offsetSec=0] 目标时区相对 UTC 的偏移秒数（东为正）。
 * @returns {string} '07:12' 或 '—'。
 */
export function hhmm(atMs, offsetSec = 0) {
  const n = _num(atMs);
  if (n === null) return DASH;
  const d = new Date(n + offsetSec * 1000);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 毫秒 epoch → 'MM-DD HH:MM'。
 *
 * @param {number|null} atMs 毫秒 epoch。
 * @param {number} [offsetSec=0] 时区偏移秒数。
 * @returns {string} '01-05 07:12' 或 '—'。
 */
export function mdHm(atMs, offsetSec = 0) {
  const n = _num(atMs);
  if (n === null) return DASH;
  const d = new Date(n + offsetSec * 1000);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 昼长毫秒 → '10 小时 32 分'。 */
export function duration(ms) {
  const n = _num(ms);
  if (n === null) return DASH;
  const totalMin = Math.round(n / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} 分`;
  return `${h} 小时 ${m} 分`;
}

/**
 * 坐标 → '39.9087°N, 116.3975°E'（WGS84，四位小数 ≈ 11 m）。
 *
 * @param {number|null} lat 纬度。
 * @param {number|null} lon 经度。
 * @returns {string} 坐标文本或 '—'。
 */
export function coord(lat, lon) {
  const la = _num(lat);
  const lo = _num(lon);
  if (la === null || lo === null) return DASH;
  const ns = la >= 0 ? 'N' : 'S';
  const ew = lo >= 0 ? 'E' : 'W';
  return `${Math.abs(la).toFixed(4)}°${ns}, ${Math.abs(lo).toFixed(4)}°${ew}`;
}

/**
 * 相对时间：'刚刚' / '3 分钟前' / '2 小时前' / '3 天前'。
 *
 * @param {number|null} atMs 过去时刻（ms epoch）。
 * @param {number} [nowMs=Date.now()] 参照时刻。
 * @returns {string} 相对时间文本或 '—'。
 */
export function relativeTime(atMs, nowMs = Date.now()) {
  const n = _num(atMs);
  if (n === null) return DASH;
  // 未来时刻（时钟漂移 / 服务端时间偏快）也按「刚刚」处理，避免出现「-3 分钟前」
  const diff = nowMs - n;
  if (diff < 60000) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  return `${month} 个月前`;
}

/**
 * 陈旧时长：供降级提示使用，与 relativeTime 同义但语义更明确。
 *
 * @param {number} staleMs 陈旧毫秒数。
 * @returns {string} '3 分钟' / '2 小时' 等。
 */
export function staleFor(staleMs) {
  const n = _num(staleMs);
  if (n === null) return DASH;
  if (n < 60000) return `${Math.max(1, Math.round(n / 1000))} 秒`;
  const min = Math.floor(n / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}

/**
 * 生成导出文件名时间戳 'YYYYMMDD-HHmm'（本地时区）。
 *
 * @param {number} [atMs=Date.now()] 时刻。
 * @returns {string} 形如 '20250105-1423'。
 */
export function stamp(atMs = Date.now()) {
  const d = new Date(atMs);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${y}${mo}${da}-${h}${mi}`;
}
