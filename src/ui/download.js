/**
 * 本地文件下载（Blob + <a download>）
 *
 * 职责：把一段数据当成文件保存到用户设备上。项目里两处在用 —— 自检页导出报告 JSON、
 * 设置页导出备份 JSON —— 两处的下载手法必须完全一致，所以集中在这里，不再各自抄一份。
 *
 * ⚠️ 那个 `setTimeout(revoke, 2000)` 不是随手写的，删掉会让部分浏览器下载失败：
 *   `a.click()` 返回时，浏览器只是**接受了**下载任务，真正的读取（去 Blob URL 取字节）
 *   随后才由浏览器的下载线程做。此刻立刻 `URL.revokeObjectURL()` 等于把文件抽走 ——
 *   桌面上多数浏览器赶得及，移动端 WebView 与部分安卓浏览器会静默失败：不报错、不弹窗、
 *   下载列表里凭空少一个文件，用户只会以为「导出坏了」。
 *   延后 2000 ms 释放是给浏览器留出这段窗口，代价是一个 URL 对象多活两秒。
 *   将来若有人想把它改成「更干净的立即 revoke」，请先拿真机验一遍再动手。
 */

/** Object URL 的释放延迟（毫秒）。理由见文件头注释，改这个值等于改下载成功率。 */
const REVOKE_DELAY_MS = 2000;

/**
 * 把数据以 JSON 文件的形式下载到本地。
 *
 * 全程在本机完成：不联网、不上传、`objectURL` 用完即释放。调用方负责取好文件名。
 *
 * @param {string} name 文件名（含扩展名）。
 * @param {*} data 任意可 JSON 序列化的数据。
 * @returns {boolean} 是否成功触发下载（false 表示环境不支持 Blob / objectURL，需调用方提示）。
 */
export function downloadJson(name, data) {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof document === 'undefined') return false;
  try {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // ★不要改成立即 revoke —— 理由见文件头（点完就释放会让移动端 WebView 静默下载失败）
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
    return true;
  } catch (err) {
    return false;
  }
}
