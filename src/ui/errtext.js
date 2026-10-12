/**
 * 错误文案：把 core/http.js 的 SourceError 翻成人话
 *
 * 为什么单独一个文件：core/http.js 的 makeError() 只给 `messageKey` + `messageParams`
 * （core 不许 import i18n，理由见那个模块的 JSDoc），把键翻成话是 UI 层的事。
 * 而「翻」这件事在四个地方都要做（对比页 / 地点搜索 / 自检页 / 设置页），
 * 各写一遍 `tr({ key: err.messageKey, params: err.messageParams })` 等于把
 * SourceError 的字段形状抄四份 —— 哪天字段名改了，总有一处会漏。
 *
 * ★顺带处理一类真实情况：`catch (err)` 里接到的**不一定是** SourceError。
 *   它可能是 request() 之外的意外（TypeError / 我们自己抛的 Error），那些只有
 *   `message`（开发者的英文诊断串），没有 messageKey。这里按「有键就用键、没键才
 *   退回 message」的顺序来 —— 绝不反过来：反过来会把中文界面里那条**唯一该显示中文**
 *   的错误提示换成一段英文，而用户根本看不懂。
 *
 * 依赖方向：ui → i18n/index.js。非浏览器安全（不碰 DOM）。
 */

import { t, tr } from '../i18n/index.js';

/**
 * 取一个错误对象的可读文案（永不抛异常）。
 *
 * @param {*} err 错误对象（SourceError 或任意 Error 或 null）。
 * @param {string} [fallbackKey='app.unknown'] 万不得已时的兜底文案键。
 * @returns {string} 可读文案；拿不到任何东西时返回 fallbackKey 对应的文案。
 */
export function errorText(err, fallbackKey = 'app.unknown') {
  if (!err || typeof err !== 'object') return t(fallbackKey);

  // ① SourceError（core/http.js）：有键，走 i18n —— 这是**正常路径**
  if (typeof err.messageKey === 'string' && err.messageKey) {
    const text = tr({ key: err.messageKey, params: err.messageParams });
    // tr() 缺键时返回键本身；那种情况下宁可退回兜底，也不要把 'error.HTTP' 甩给用户看
    if (text && text !== err.messageKey) return text;
  }

  // ② 普通 Error / 意外抛出：只有开发者诊断串。它本来就不是给最终用户看的，
  //    但也不是空的 —— 显示出来至少能让用户照着报障，比一句「未知」有用。
  if (typeof err.message === 'string' && err.message.trim() !== '') return err.message;

  return t(fallbackKey);
}

/**
 * 取「失败结果对象」的原因文案（永不抛异常）。
 *
 * 与 errorText() 的区别：errorText() 吃的是**错误对象**（字段叫 messageKey），
 * 本函数吃的是 core/backup.js 那类**结果对象**（字段叫 reasonKey）——
 * 两者都只产键、由 UI 成句，但字段形状不同，混用只会让某一处悄悄拿到空串。
 *
 * @param {*} res 结果对象（含 reasonKey / reasonParams，或 null）。
 * @param {string} [fallbackKey='app.unknown'] 万不得已时的兜底文案键。
 * @returns {string} 可读原因文案。
 */
export function reasonText(res, fallbackKey = 'app.unknown') {
  if (!res || typeof res !== 'object') return t(fallbackKey);
  if (typeof res.reasonKey === 'string' && res.reasonKey) {
    const text = tr({ key: res.reasonKey, params: res.reasonParams });
    if (text && text !== res.reasonKey) return text;
  }
  // 老备份 / 手工构造的结果可能仍带成品串 reason，照用，别让用户看见空白
  if (typeof res.reason === 'string' && res.reason.trim() !== '') return res.reason;
  return t(fallbackKey);
}
