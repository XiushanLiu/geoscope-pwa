/**
 * 二十四山（罗盘 24 向）静态表与角度换算。
 *
 * 山序自磁北「子」起、顺时针每山 15°：
 *   子 癸 丑 艮 寅 甲 卯 乙 辰 巽 巳 丙 午 丁 未 坤 申 庚 酉 辛 戌 乾 亥 壬
 * 三个校验点：卯 = 90°（索引 6）、午 = 180°（索引 12）、酉 = 270°（索引 18）。
 * 「子」跨 −7.5°～+7.5°，所以 355° 与 0° 都归「子」、345° 归「壬」。
 *
 * 纯数据 + 纯函数：不碰 DOM、不发请求，UI 与单测可共用同一份表。
 */

/** 24 山名称，索引 i 对应中心角 i×15°。 */
export const SHAN24 = Object.freeze([
  '子', '癸', '丑', '艮', '寅', '甲',
  '卯', '乙', '辰', '巽', '巳', '丙',
  '午', '丁', '未', '坤', '申', '庚',
  '酉', '辛', '戌', '乾', '亥', '壬',
]);

/** 每山跨度（度）。 */
const SPAN_DEG = 15;

/**
 * 角度 → 山索引（0..23）；非法入参返回 −1。
 *
 * @param {number|string} deg 方位角（度，任意实数，内部归一到 [0,360)）。
 * @returns {number} 索引；非数字 / NaN / Infinity / 空串 / null 返回 −1。
 */
export function shanIndexOf(deg) {
  // 先挡掉 null / undefined / 布尔 / 数组：Number(null) === 0 会把「没有角度」当成正北
  if (deg === null || deg === undefined || typeof deg === 'boolean' || Array.isArray(deg)) return -1;
  if (typeof deg === 'string' && deg.trim() === '') return -1;
  if (typeof deg !== 'number' && typeof deg !== 'string') return -1;
  const n = Number(deg);
  if (!Number.isFinite(n)) return -1;
  const d = ((n % 360) + 360) % 360; // 归一到 [0,360)，负角同样适用
  return Math.floor(((d + SPAN_DEG / 2) % 360) / SPAN_DEG);
}

/**
 * 角度 → 山信息（名称与中心角）；非法入参返回 null。
 *
 * @param {number|string} deg 方位角（度）。
 * @returns {{index:number, name:string, centerDeg:number}|null} 山信息。
 */
export function shanOf(deg) {
  const index = shanIndexOf(deg);
  if (index < 0) return null;
  return { index, name: SHAN24[index], centerDeg: index * SPAN_DEG };
}
