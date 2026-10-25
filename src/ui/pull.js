/**
 * 取数 → 记账 → 溯源（气候页与地理页共用的**唯一**实现）
 *
 * 为什么必须抽出来：`_pull()` 曾经在 `src/ui/app.js` 与 `src/ui/compass.js` 各有一份
 * 21~22 行的副本（2026-10-17 地理页装配时复制过去的）。同一逻辑两份实现在本项目里已经
 * 咬过不止一次，而副本最坏的地方是**光靠测试钉不住行为**：一条「两处字段集合一致」的
 * 用例钉得住字段名，钉不住「记不记健康 / 什么时候记 / 有没有把 stale 当 fresh」——
 * 将来有人只改 A 处，B 处不会红，坏的是某一页的溯源气泡与顶部降级判定，
 * 属于最忌讳的静默断线。所以这里是唯一实现，两页各自 import。
 *
 * 三条契约（改之前先读，两页都靠它）：
 *   1) **每一路都必须 `recordResult()`**：它决定 `overallMode()`（顶部降级横幅与自检页
 *      都读它）。少了这一句，某一页会永远显示「全部正常」—— 而它不报错。
 *   2) **`res.stale` 必须翻成 `state:'stale'`**：ok=false 时 data 可能是陈旧兜底值，
 *      溯源气泡要靠 state 区分「刚取的」和「旧的」，一律写 fresh 就是说谎。
 *   3) **只有真拿到 data 才记溯源**：data 为 null / undefined 时不进气泡 ——
 *      一条没有数据的溯源条目等于告诉用户「这一路在线」，其实没取到。
 *
 * ★**不在**自检单文件产物的闭包内：只被两个页面入口 `src/ui/app.js` 与
 *   `src/ui/compass.js` import，两者都不在 `tools/build-standalone.mjs` 的 ORDER 里。
 *   ⚠️ 谁让 `src/ui/now.js` 或任何闭包内模块 import 本文件，谁就把这个模块拖进那个
 *   诊断页 —— 直接违反那边的硬闸（见 ORDER 之后那段「产物体积口径」）。
 *
 * 依赖方向：ui ← data（`sources.js` / `health.js`）/ core（`http.js`）。
 */

import { request } from '../core/http.js';
// log() 供 safePull() 写「渲染兜底也失败」这类诊断（与 data/tiles.js 同一条来路）。
import { log } from '../core/store.js';
import { getSource } from '../data/sources.js';
import { recordResult } from '../data/health.js';

/**
 * 拉取一路源并写回快照（记录健康 + 溯源气泡）。
 *
 * @param {Object} snapshot 页面快照（原地修改：`provenance` 追加一条）。
 * @param {string} sourceId 源 id（须在 `data/sources.js` 登记）。
 * @param {Object} ctx 上下文（如 `{lat, lon}`）。
 * @param {(data:*) => void} apply 解析结果写回函数（只在真拿到 data 时调用）。
 * @param {{fetch?:(sourceId:string, ctx:Object) => Promise<Object>}} [opts] 选项。
 *   `opts.fetch` 可注入取数函数（默认 `core/http.js` 的 `request`）——
 *   ★可注入是测试的前提：不然这个「记账 + 溯源」契约只能在真网络下测，
 *   而真网络测不出「stale 有没有被翻成 state」这类分支。
 * @returns {Promise<Object>} SourceResult。
 */
export async function pullSource(snapshot, sourceId, ctx, apply, opts = {}) {
  const conf = opts && typeof opts === 'object' ? opts : {};
  const fetchFn = typeof conf.fetch === 'function' ? conf.fetch : request;
  const spec = getSource(sourceId);
  const res = await fetchFn(sourceId, ctx);
  // ★每一路都必须记账：overallMode() 靠它判「整体降级态」，漏了就永远显示正常
  recordResult(res);

  // res.stale 是显式标记：ok=false 时 data 可能是陈旧兜底值，不能当成功数据用
  const state = res.stale ? 'stale' : 'fresh';
  // ★2026-10 真机缺陷：fresh 缓存命中时 `core/http.js` 根本**没发请求**，
  //   它把 `meta.latencyMs` 置 0（见 http.js「fresh 缓存命中：不发请求」那一支）。
  //   0 ms 上屏会被读成「从网络取回耗时 0 毫秒」——那是把「没测」说成「测到 0」，
  //   正是本项目最忌讳的一类表述。所以这里分两件事：
  //   - `fromCache`：明说这一条是缓存命中；
  //   - `latencyMs` 在命中时置 **null**（`format.latency(null)` 出「—」= 没测），
  //     ★不许再写回 0 —— 0 是数字，会被当成实测值一路渲染出去。
  const fromCache = !!(res.meta && res.meta.fromCache === true);
  if (res.data !== null && res.data !== undefined) {
    apply(res.data);
    snapshot.provenance.push({
      sourceId,
      label: spec ? spec.label : sourceId,
      url: res.meta.requestUrl,
      latencyMs: fromCache ? null : res.meta ? res.meta.latencyMs : null,
      fromCache,
      fetchedAt: res.meta.finishedAt,
      state,
      attribution: spec ? spec.attribution : '',
    });
  }
  return res;
}

/**
 * 带兜底的拉取：单路源抛异常时只废掉自己那张卡，不打断后续源。
 *
 * ★渲染回调里的异常也要吞掉：渲染失败不该把「取数成功」这件事也否定掉 ——
 *   溯源与健康账已经记过了，卡片画不出来是另一回事，日志里能查到。
 *
 * @param {Object} snapshot 页面快照。
 * @param {string} sourceId 源 id。
 * @param {Object} ctx 上下文。
 * @param {(data:*) => void} apply 写回函数。
 * @param {(res:Object|null) => void} render 渲染回调（成功给 SourceResult，失败给 null ——
 *   **必须都调一次**，否则某一路失败时那张卡会永远停在骨架）。
 * @param {{fetch?:(sourceId:string, ctx:Object) => Promise<Object>}} [opts] 选项（见
 *   {@link pullSource}）。
 * @returns {Promise<Object|null>} SourceResult；抛错时为 null。
 */
export async function safePull(snapshot, sourceId, ctx, apply, render, opts = {}) {
  try {
    const res = await pullSource(snapshot, sourceId, ctx, apply, opts);
    try {
      render(res);
    } catch (renderErr) {
      log(`${sourceId} render failed`, renderErr && renderErr.message);
    }
    return res;
  } catch (err) {
    // 解析或网络抛错：记日志（debug 关闭时静默），继续跑下一路
    log(`${sourceId} pull failed`, err && err.message);
    try {
      render(null);
    } catch (renderErr) {
      /* 渲染兜底也失败时不再抛出，保证后续源继续 */
    }
    return null;
  }
}
