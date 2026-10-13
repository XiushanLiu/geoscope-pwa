/**
 * 高德 Web 服务 Key 的本机存取（**孤儿存储**）
 *
 * 职责：读写、掩码、清空一个字符串 —— 高德 Web 服务 API 的 Key。单一职责，别往里塞别的。
 *
 * ★为什么**不**放进 `core/store.js` 的 prefs（改代码前先读这段）：
 *   prefs 是 `core/backup.js` 的 `exportBackup()` 的原料，导出 JSON 是一份要搬家、
 *   可能被发给别人的文件。**明文密钥不该进备份**。而一旦塞进 prefs，`replaceState()` /
 *   `applyBackup()` 与 prefs 既有的「本机属性不进备份」契约（themeMode / fontScale /
 *   locale 那套）全部要跟着改一遍，回归面比本模块大两个数量级。
 *   独立成模块后：对 store / backup **零改动、零回归面**，且备份里天然不含密钥。
 *
 * ★它是「孤儿存储」：在本机缓存里占一个 `gs:v1:amapkey:v1` 的键，与 store 的 prefs
 *   平级、互不干涉。随之而来的两条诚实标注：
 *   1) `core/cache.js` 的 `evictOldest()` / `prune()` 在配额吃紧时会按 `storedAt` 淘汰
 *      最旧条目 —— 本条目理论上也可能被淘汰。Key 丢了的表现是「候选不可用，提示去设置页
 *      重填」，是**看得见的失败**（不是静默降级），可接受；用户重填一次即可。
 *   2) 本机缓存**不是**安全存储。Key 明文躺在 localStorage 里，任何能打开开发者工具的人
 *      都能读到。这是「用户自填、自己承担」的前提，页面必须写明（架构 §10 Q2）。
 *
 * 分层：core 层，只 import 同层的 cache.js。**不 import i18n**（core 不许读 locale 表），
 * 因此本模块不产出任何面向用户的句子；「未填 Key」这句人话由 data 层抛
 * `rt.amap.noKey`、UI 层 `tr()` 出来。
 */

import { get, set, clearPrefix, makeKey } from './cache.js';

/** Key 长度上限（字符数）。高德 Web 服务 Key 实为 32 位十六进制串，留一倍余量。 */
export const KEY_MAX_LEN = 64;

/** 持久化键：与 store 的 prefs / snapshot 平级，互不影响。 */
const KEY_AMAP = makeKey('amapkey', 'v1');

/** TTL：十年（读用 get() 不做三态判定，TTL 无实际影响，仅保持与 store 同形状）。 */
const KEY_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

/**
 * 归一 Key 字符串。
 *
 * 宽容到什么程度：只做 trim 与三项硬性拒绝 —— 空、超长、含空白字符。
 * **不**校验字符集（高德 Key 的形态将来可能变，且校验错了会把一个合法 Key 拒之门外，
 * 用户根本无从知道为什么填不进去）。真正的合法性由**服务端**判定，失败会带着
 * infocode 回来（架构 §8 的 `rt.amap.invalidKey`），那才是权威结论。
 *
 * @param {*} v 原始输入。
 * @returns {string|null} 归一后的 Key；非法返回 null。空串也返回 null（清空走 clearAmapKey）。
 */
function normalizeKey(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  if (s.length > KEY_MAX_LEN) return null;
  if (/\s/.test(s)) return null;
  return s;
}

/**
 * 读取当前 Key。
 *
 * @returns {string} Key 原文；未配置返回空串（不是 null —— 空串在条件判断里更不容易被漏判）。
 */
export function getAmapKey() {
  const entry = get(KEY_AMAP);
  if (entry === null || entry === undefined) return '';
  const v = entry.value;
  return typeof v === 'string' ? v : '';
}

/**
 * 是否已配置 Key。
 *
 * @returns {boolean} 已填返回 true。
 */
export function hasAmapKey() {
  return getAmapKey() !== '';
}

/**
 * 写入 Key。
 *
 * @param {*} key 待写入的 Key（会 trim）。
 * @returns {boolean} 写入成功返回 true；非法（空 / 超长 / 含空白）或落盘失败返回 false。
 *          ★失败必须是**看得见的**：调用方（设置页）据此提示，不许静默当成功。
 */
export function setAmapKey(key) {
  const v = normalizeKey(key);
  if (v === null) return false;
  return set(KEY_AMAP, v, KEY_TTL_MS);
}

/**
 * 清空 Key（用户主动「不再使用」）。
 *
 * @returns {boolean} 清掉了返回 true；本来就没配则返回 false（同样如实，不假称成功）。
 */
export function clearAmapKey() {
  if (!hasAmapKey()) return false;
  return clearPrefix(KEY_AMAP) > 0;
}

/**
 * 掩码显示：'b3f1************************9a2c'（中间一律星号）。
 *
 * 用途：设置页要把「当前填的是哪一个 Key」给人看，但**不能**整串回显 —— 那等于把密钥
 * 摆在一块可能被截图、被投屏的屏幕上。短串（≤8 字符）整串打星，避免「首尾各留 4 位」
 * 在短串上等于全露。
 *
 * @param {*} key 原始 Key。
 * @returns {string} 掩码串；空值返回空串。
 */
export function maskKey(key) {
  const v = typeof key === 'string' ? key.trim() : '';
  if (v === '') return '';
  if (v.length <= 8) return '*'.repeat(v.length);
  return `${v.slice(0, 4)}${'*'.repeat(v.length - 8)}${v.slice(-4)}`;
}
