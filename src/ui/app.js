/**
 * 此刻屏入口装配
 *
 * 职责：把 core / data / ui 三层串起来 —— 注册 Service Worker、读本机状态、取定位、
 * 串行拉取首屏三源（weather → air → elevation，逐卡增量渲染），首屏完成后后台补齐
 * reverse（地名）与瓦片探测，最后按 overallMode() 上顶部降级横幅。
 *
 * 首屏顺序（主理人拍板 5）：[weather → air → elevation] 串行先渲染；reverse 与瓦片
 * 放在首屏渲染完成**之后**后台补齐，避免拖长可交互时间。
 * 定位策略（拍板 4）：被拒 / 超时 / 无权限 → 北京天安门 39.9087,116.3975，界面说明
 * 「未取得定位，正在显示默认地点」，无定位也渲染此刻屏。
 *
 * 三条关键不变量（QA 缺陷回改后固化，勿回退）：
 *   1) **单卡失败不拖垮整屏**：三路首屏源各自 try/catch，失败只废自己那张卡（必修 6）；
 *   2) **无地图模式不可 sticky**：每轮 boot 依据本次探测结果双向置位（必修 2）；
 *   3) **竞态靠 epoch 丢弃**：refresh 不切断串行队列链，而是让上一轮在飞结果回来后被丢弃（必修 7）。
 *
 * 注意：本模块顶层不触碰 DOM，所有 DOM 访问都在 boot() 内，便于 Node 侧语法/引用检查。
 */

import { t } from '../i18n/zh.js';
import {
  getDefaultPlace,
  getLastSnapshot,
  setLastSnapshot,
  log,
} from '../core/store.js';
import { getCurrentPosition } from '../core/geo.js';
import { getWithState } from '../core/cache.js';
import { request, isOnline } from '../core/http.js';
import { getSource } from '../data/sources.js';
import { recordResult, overallMode, resetHealth } from '../data/health.js';
import { probeTile, sampleTiles, setNoMapMode, degradeMapMode, mapMode, MAP_MODE } from '../data/tiles.js';
import {
  renderSkeleton,
  renderHeader,
  renderWeatherCard,
  renderAirCard,
  renderPlaceCard,
  renderProvenance,
  renderBanner,
  renderEmptyState,
  renderSlotEmpty,
  renderSnapshot,
  applyI18n,
} from './now.js';
import { renderMapCard, renderMapSkeleton } from './map.js';

/** 定位超时（毫秒）。 */
const GEO_TIMEOUT_MS = 8000;

/**
 * 后台瓦片探测块数。
 *
 * ★必须 ≥ 2：`degradeMapMode()` 的 grid 分支是「0 < 成功数 < 总数」，
 * 只喂一块时该区间是空集 → grid 永远不可达 → 「一次慢请求就把整张地图打没」这个
 * 本轮要消除的行为会原封不动留着，而三态契约、i18n 文案、裁决函数又都写齐了，
 * 形成「已修复」的假象。取 3 与 `sampleTiles()` 的取样数一致（真机中位 693 ms，
 * 第二轮起命中缓存接近零成本）。
 */
export const TILE_PROBE_COUNT = 3;

/**
 * 整批瓦片探测的**时间预算**（毫秒）。
 *
 * 背景：三块是逐块串行、每块超时 `TILE_TIMEOUT_MS`（6 s），而且全部走 `http.js` 的
 * 全局串行队列（并发恒为 1）。最坏情况 3 × 6 s = **18 s 占用队列** —— 这段时间里用户
 * 手动刷新，新请求会排在探测后面干等。真机实测瓦片中位 693 ms、峰值 3198 ms，
 * 峰值确实能到秒级，弱网下这条路径会碰到。
 *
 * 取值 8000：真机峰值 3198 ms，8 s 足够三块在正常情况跑完（3 × 693 ≈ 2.1 s，
 * 即使三块都走到峰值也 9.6 s —— 个别块被收紧超时而失败是可接受的代价）；同时把
 * 最坏占用从 18 s 砍到 8 s。**每块的超时按剩余预算收紧**，见 `probeTileBatch()`。
 *
 * 为什么不做旁路队列或队列让步点：全局并发 1 是当初为弱网稳定刻意定的，旁路等于拆掉它；
 * 让步点要改 `http.js` 的队列实现，风险都大于收益。
 */
export const TILE_PROBE_BUDGET_MS = 8000;

/**
 * 剩余预算低于这个值就不再发起新块（毫秒）。
 *
 * 瓦片中位 693 ms，剩几百毫秒发起的块注定超时 —— 白占队列，还多喂一条必然失败的样本
 * 去污染 `degradeMapMode()` 的裁决（成功率是唯一的判决依据）。
 */
const TILE_PROBE_MIN_SLOT_MS = 300;

/**
 * 轮次号：每次 boot() 自增。
 *
 * 用途：refresh() 不切断串行队列（那会让在飞任务与新任务并行，破坏「全局并发 1」），
 * 而是让上一轮仍在飞的结果返回时发现 epoch 已变，直接丢弃、不再渲染。
 */
let _epoch = 0;

/**
 * 注册 Service Worker（失败静默：file:// 或非安全上下文下不可用）。
 *
 * @returns {void}
 */
function _registerSW() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  if (typeof location === 'undefined') return;
  // 本地 http / https 均可；file:// 下 serviceWorker 不存在，已在上面短路
  navigator.serviceWorker
    .register('sw.js')
    .then(() => log('sw registered'))
    .catch((err) => log('sw register failed', err && err.message));
}

/**
 * 构造空快照骨架。
 *
 * @param {{lat:number, lon:number, source:string, name?:string|null}} coord 坐标。
 * @returns {Object} NowSnapshot。
 */
function _blankSnapshot(coord) {
  return {
    atMs: null,
    coord: { lat: coord.lat, lon: coord.lon, source: coord.source },
    placeName: coord.name || null,
    elevationM: null,
    weather: null,
    air: null,
    provenance: [],
  };
}

/**
 * 拉取一路源并写回快照（记录健康 + 溯源气泡）。
 *
 * @param {Object} snapshot NowSnapshot（原地修改）。
 * @param {string} sourceId 源 id。
 * @param {Object} ctx 上下文。
 * @param {(data:*) => void} apply 解析结果写回函数。
 * @returns {Promise<Object>} SourceResult。
 */
async function _pull(snapshot, sourceId, ctx, apply) {
  const spec = getSource(sourceId);
  const res = await request(sourceId, ctx);
  recordResult(res);

  // res.stale 是显式标记：ok=false 时 data 可能是陈旧兜底值，不能当成功数据用
  const state = res.stale ? 'stale' : 'fresh';
  const usedData = res.data;
  if (usedData !== null && usedData !== undefined) {
    apply(usedData);
    snapshot.provenance.push({
      sourceId,
      label: spec ? spec.label : sourceId,
      url: res.meta.requestUrl,
      latencyMs: res.meta.latencyMs,
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
 * @param {Object} snapshot NowSnapshot。
 * @param {string} sourceId 源 id。
 * @param {Object} ctx 上下文。
 * @param {(data:*) => void} apply 写回函数。
 * @param {(res:Object|null) => void} render 渲染回调（成功/失败都调一次）。
 * @returns {Promise<Object|null>} SourceResult；抛错时为 null。
 */
async function _safePull(snapshot, sourceId, ctx, apply, render) {
  try {
    const res = await _pull(snapshot, sourceId, ctx, apply);
    try {
      render(res);
    } catch (renderErr) {
      log(`${sourceId} render failed`, renderErr && renderErr.message);
    }
    return res;
  } catch (err) {
    // 解析或 DOM 抛错：记录日志（debug 关闭时静默），继续跑下一路
    log(`${sourceId} pull failed`, err && err.message);
    try {
      render(null);
    } catch (renderErr) {
      /* 渲染兜底也失败时不再抛出，保证后续源继续 */
    }
    return null;
  }
}

/**
 * 从缓存里取一路源的 fresh 或 stale 值（离线冷启动降级用）。
 *
 * @param {string} sourceId 源 id。
 * @param {Object} ctx 上下文（含 lat/lon）。
 * @returns {{value:*, state:'fresh'|'stale', ageMs:number}|null} 命中结果或 null。
 */
function _readCache(sourceId, ctx) {
  const spec = getSource(sourceId);
  if (!spec || !spec.cacheable) return null;
  const st = getWithState(spec.cacheKey(ctx));
  if (st.state === 'fresh' || st.state === 'stale') {
    if (st.value !== null && st.value !== undefined) {
      return { value: st.value, state: st.state, ageMs: st.ageMs };
    }
  }
  return null;
}

/**
 * 离线分支：优先逐源读缓存（架构 §4.1），再退本机快照，最后才空态。
 *
 * 为什么不能只读 store 快照：用户在线取数成功（缓存已写入）但在写快照前被杀进程，
 * 断网冷启动就会显示「暂无可用数据」，而 localStorage 里其实有 fresh/stale 数据。
 *
 * @param {HTMLElement} root 根容器。
 * @param {HTMLElement} bannerEl 横幅容器。
 * @param {Object} snapshot 空快照（含坐标）。
 * @param {boolean} isDefaultPlace 是否默认地点。
 * @returns {void}
 */
function _renderOffline(root, bannerEl, snapshot, isDefaultPlace) {
  const ctx = { lat: snapshot.coord.lat, lon: snapshot.coord.lon };
  let maxStaleAge = 0;

  const weather = _readCache('weather', ctx);
  const air = _readCache('air', ctx);
  const elevation = _readCache('elevation', ctx);
  const reverse = _readCache('reverse', ctx);

  if (weather) {
    snapshot.weather = weather.value;
    snapshot.atMs = (weather.value && weather.value.atMs) || snapshot.atMs || Date.now();
    if (weather.state === 'stale') maxStaleAge = Math.max(maxStaleAge, weather.ageMs);
  }
  if (air) {
    snapshot.air = air.value;
    if (air.state === 'stale') maxStaleAge = Math.max(maxStaleAge, air.ageMs);
  }
  if (elevation) {
    snapshot.elevationM = elevation.value && elevation.value.elevationM !== undefined
      ? elevation.value.elevationM
      : null;
    if (elevation.state === 'stale') maxStaleAge = Math.max(maxStaleAge, elevation.ageMs);
  }
  if (reverse && reverse.value && reverse.value.placeName) {
    snapshot.placeName = reverse.value.placeName;
    if (reverse.state === 'stale') maxStaleAge = Math.max(maxStaleAge, reverse.ageMs);
  }

  // 1) 缓存里有任何一路 → 直接渲染（有旧数据绝不显示空白）
  if (weather || air || elevation || reverse) {
    renderSnapshot(root, snapshot, { isDefaultPlace });
    renderBanner(bannerEl, 'offline', { staleAgeMs: maxStaleAge });
    return;
  }

  // 2) 退本机最近一次快照
  const cached = getLastSnapshot();
  if (cached && cached.weather) {
    const merged = { ...snapshot, ...cached };
    renderSnapshot(root, merged, { isDefaultPlace });
    renderBanner(bannerEl, 'offline', { staleAgeMs: Date.now() - (cached.atMs || Date.now()) });
    return;
  }

  // 3) 真·空数据：空态 + 重试（不转圈）
  renderBanner(bannerEl, 'offline');
  renderEmptyState(root, t('mode.offline'), () => {
    if (typeof window !== 'undefined' && window.location) window.location.reload();
  });
}

/**
 * 在**整批时间预算**内逐块探测瓦片。
 *
 * 为什么要有预算：三块串行、每块 6 s 超时，且全部走 `http.js` 的全局串行队列（并发 1），
 * 最坏情况会占住队列 18 s。预算把这个上限压到 `TILE_PROBE_BUDGET_MS`（8 s）。
 *
 * 怎么压：**每一块的超时按剩余预算收紧** —— `timeout_i = min(单块超时, 预算 - 已耗时)`，
 * 而不是每块都给满 6 s。`probeTile()` 内部还会再钳一次（只能收紧，不能放松）。
 *
 * 三条已确认的行为**不许回退**：
 *   1) `shouldStop()` 在每一块之后都检查（epoch 竞态守卫留在循环内）；
 *   2) 单块抛异常只记该块失败，不中断整批；
 *   3) 探几块仍由 `count` 决定（默认 `TILE_PROBE_COUNT = 3`），不为了省时间降到 2 ——
 *      2 只是 grid 可达的下限，3 才是「区分一块慢和普遍慢」的下限。
 *
 * 预算耗尽后**不再发起新块**，已拿到的结果照常返回，由调用方喂给 `degradeMapMode()`。
 *
 * @param {string} styleId 样式 id。
 * @param {Array<{z:number,x:number,y:number}>} tiles 候选瓦片坐标。
 * @param {{count?:number, budgetMs?:number, shouldStop?:()=>boolean}} [opts] 选项。
 * @returns {Promise<Array<Object>>} 探测结果（可能少于 count：预算耗尽或 shouldStop 时提前结束）。
 */
export async function probeTileBatch(styleId, tiles, opts = {}) {
  const count = Number.isFinite(Number(opts.count)) ? Number(opts.count) : TILE_PROBE_COUNT;
  const budgetMs = Number.isFinite(Number(opts.budgetMs)) ? Number(opts.budgetMs) : TILE_PROBE_BUDGET_MS;
  const shouldStop = typeof opts.shouldStop === 'function' ? opts.shouldStop : () => false;
  const list = Array.isArray(tiles) ? tiles.slice(0, count) : [];

  const startedAt = Date.now();
  const probes = [];

  for (const tile of list) {
    const remainMs = budgetMs - (Date.now() - startedAt);
    // 剩余预算连一块都跑不完（瓦片中位 693 ms）：发起也只是白占队列 + 多喂一条必然失败的样本
    if (remainMs < TILE_PROBE_MIN_SLOT_MS) {
      log(`tile probe budget out (${remainMs}ms left), ${probes.length}/${list.length} done`);
      break;
    }
    // 单块抛异常只记这一块失败，不让整批裁决失去证据（成功率是这轮唯一的判决依据）
    probes.push(
      await probeTile(styleId, tile, { timeoutMs: remainMs }).catch(() => ({ ok: false, styleId }))
    );
    if (shouldStop()) break; // 已被新一轮覆盖，停止继续占用队列
  }

  return probes;
}

/**
 * 后台补齐：逆地理反查（地名）+ 瓦片探测（底图可用性）。
 *
 * @param {Object} snapshot NowSnapshot（原地修改）。
 * @param {HTMLElement} root 根容器。
 * @param {HTMLElement} bannerEl 横幅容器。
 * @param {boolean} isDefaultPlace 是否默认地点。
 * @param {number} epoch 本轮轮次号。
 * @returns {Promise<void>}
 */
async function _background(snapshot, root, bannerEl, isDefaultPlace, epoch) {
  // 1) 逆地理反查：失败不影响首屏
  try {
    await _pull(snapshot, 'reverse', { lat: snapshot.coord.lat, lon: snapshot.coord.lon }, (data) => {
      if (data && data.placeName) {
        snapshot.placeName = data.placeName;
      }
    });
    if (epoch !== _epoch) return; // 已被新一轮覆盖，丢弃结果
    renderHeader(root, snapshot, { isDefaultPlace });
    renderPlaceCard(root, snapshot);
  } catch (err) {
    log('reverse failed', err && err.message);
  }

  // 2) 瓦片探测：不重试；模式由**整批**结果裁决
  //    ★探多块而不是一块（理由见 TILE_PROBE_COUNT 注释）：单块时 grid 数学上不可达。
  try {
    const tiles = sampleTiles(snapshot.coord);
    const probes = await probeTileBatch('street', tiles, {
      count: TILE_PROBE_COUNT,
      budgetMs: TILE_PROBE_BUDGET_MS,
      shouldStop: () => epoch !== _epoch, // 已被新一轮覆盖，停止继续占用队列
    });
    if (epoch !== _epoch) return;
    log(
      'tile probes',
      probes.map((p) => (p.ok ? (p.fromCache ? 'ok(cache)' : 'ok') : 'fail')).join(' / ')
    );
    // 全成 → map；全败 → no-map；部分失败 → grid（仅网格 + 坐标，先不宣布无地图）。
    // ★证据不足（预算耗尽只剩 0~1 块）时**不裁决**：单块区分不了「一块慢」和「源挂了」，
    //   那是 grid 区间为空集的同一个坑（见 TILE_PROBE_COUNT 注释），不能因为加了预算就退回去。
    if (probes.length >= 2) {
      degradeMapMode(probes);
    } else {
      log('tile probes too few to judge', String(probes.length));
    }
    renderPlaceCard(root, snapshot);
  } catch (err) {
    if (epoch !== _epoch) return;
    // 探测本身抛异常（无 probe 结果可裁决）→ 直接判无地图
    setNoMapMode(true);
    log('tile probe failed', err && err.message);
  }

  if (epoch !== _epoch) return;
  renderBanner(bannerEl, _bannerMode(), { staleAgeMs: _maxStaleAge(snapshot) });
  renderProvenance(root, snapshot);
}

/**
 * 横幅应显示的降级态。
 *
 * 与 overallMode() 只差一处：底图半残（grid）。overallMode() 对 grid 返回 'partial'，
 * 而 'partial' 的文案是「部分数据源不可用，其余数据正常」—— 这句话在 grid 场景下是**假话**：
 * 五个 API 都正常，坏的只是瓦片，用户读完会以为天气数据也坏了。
 * 所以横幅这一层单独接住 grid，换成如实的 mode.grid。
 *
 * 只在展示层分支，overallMode() 的返回值一个字都不动：自检页结论、健康层其他消费者
 * 仍然拿 'partial'，它们的语义本就是「部分不可用」，不需要知道坏的是 API 还是瓦片。
 *
 * 优先级收紧：grid 只压过 partial / no-map / live 三档（后两项目前不可达，属防御性冗余，
 * 详见函数内注释）。offline、empty、stale 都比「底图少了几块瓦片」更值得说，
 * 不能让 grid 文案把它们盖掉。
 *
 * @returns {'live'|'stale'|'partial'|'grid'|'offline'|'no-map'|'empty'} 横幅态。
 */
function _bannerMode() {
  const mode = overallMode();
  // grid 只压过这三档，其中**实际可达的只有 partial**：
  //   'no-map' —— 与 grid 互斥：两者是同一个 mapMode() 三态的不同取值，不可能同时成立；
  //   'live'   —— health.js 的 grid 分支会先返回 'partial'，轮不到 'live'。
  // 这两项是**防御性冗余**：万一将来有人调整健康层的判定顺序，这里也不会突然把 grid 吞掉。
  // 别当成死分支删掉 —— 删了以后那两档的回归没有任何提示。
  // 真正要挡住的是 offline、empty、stale：它们都比「底图少几块瓦片」值得说，grid 必须让位。
  const gridWins = mode === 'partial' || mode === 'no-map' || mode === 'live';
  if (mapMode() === MAP_MODE.GRID && gridWins) return 'grid';
  return mode;
}

/**
 * 取快照中最长的陈旧时长（毫秒）。
 *
 * @param {Object} snapshot NowSnapshot。
 * @returns {number} 陈旧毫秒数。
 */
function _maxStaleAge(snapshot) {
  let max = 0;
  for (const p of snapshot.provenance) {
    if (p.state === 'stale') {
      const age = Date.now() - (p.fetchedAt || Date.now());
      if (age > max) max = age;
    }
  }
  return max;
}

/**
 * 此刻屏启动流程。
 *
 * @returns {Promise<void>}
 */
export async function boot() {
  const root = document.getElementById('app');
  const bannerEl = document.getElementById('banner');
  if (!root) return;

  // 本轮轮次号：refresh() 会自增，让上一轮在飞结果回来后被丢弃
  const epoch = ++_epoch;

  // 静态 HTML 外壳的文案统一由 i18n 填充（HTML 内不硬编码中文）
  applyI18n(document);

  _registerSW();
  resetHealth();

  // 骨架屏立即上屏（不转圈等待定位与网络）
  renderSkeleton(root);
  // 底图骨架：槽位已在 renderSkeleton 里建好（位置卡之后、溯源之前），这里只填内容。
  // 瓦片比三路 API 慢得多（真机中位 693 ms、峰值 3198 ms），先出骨架再等字节。
  renderMapSkeleton(root);

  const coord = await getCurrentPosition({ timeoutMs: GEO_TIMEOUT_MS });
  if (epoch !== _epoch) return; // 定位期间已被新一轮接管

  const fallback = coord.source === 'default' ? getDefaultPlace() : null;
  const base = coord.source === 'default' && fallback
    ? { lat: fallback.lat, lon: fallback.lon, source: 'default', name: fallback.name }
    : coord;
  const isDefaultPlace = base.source !== 'gps';

  const snapshot = _blankSnapshot(base);
  renderHeader(root, snapshot, { isDefaultPlace });

  // 离线：不发任何请求
  if (!isOnline()) {
    _renderOffline(root, bannerEl, snapshot, isDefaultPlace);
    // 离线也把底图卡渲出来：瓦片取不到会逐块留白 + ×（GRID 呈现），
    // 比让骨架屏永久挂着诚实 —— 用户至少看得到坐标与「底图这次没取到」。
    renderMapCard(root, { coord: snapshot.coord });
    return;
  }

  const ctx = { lat: snapshot.coord.lat, lon: snapshot.coord.lon };
  const staleAgeOf = (res) => (res && res.meta ? res.meta.staleAgeMs || 0 : 0);

  // ---- 首屏串行：weather → air → elevation，出一张渲染一张 ----
  // 每路都独立 try/catch：任一源抛错只废自己那张卡，绝不留下永久骨架屏。
  await _safePull(
    snapshot,
    'weather',
    ctx,
    (data) => {
      snapshot.weather = data;
      snapshot.atMs = (data && data.atMs) || Date.now();
    },
    (res) => {
      if (res === null) {
        renderSlotEmpty(root, 'weather', t('mode.empty'), () => refresh());
      } else {
        renderHeader(root, snapshot, { isDefaultPlace });
        renderWeatherCard(root, snapshot);
        if (snapshot.weather === null) {
          renderSlotEmpty(root, 'weather', t('mode.empty'), () => refresh());
        }
      }
      if (res && !res.ok) {
        renderBanner(bannerEl, _bannerMode(), { staleAgeMs: staleAgeOf(res) });
      }
    }
  );
  if (epoch !== _epoch) return;

  await _safePull(
    snapshot,
    'air',
    ctx,
    (data) => {
      snapshot.air = data;
    },
    (res) => {
      if (res === null) renderSlotEmpty(root, 'air', t('app.na'), () => refresh());
      else renderAirCard(root, snapshot);
    }
  );
  if (epoch !== _epoch) return;

  await _safePull(
    snapshot,
    'elevation',
    ctx,
    (data) => {
      snapshot.elevationM = data && data.elevationM !== undefined ? data.elevationM : null;
    },
    (res) => {
      if (res === null) renderSlotEmpty(root, 'place', t('app.na'), () => refresh());
      else renderPlaceCard(root, snapshot);
    }
  );
  if (epoch !== _epoch) return;

  // 首屏完成：落一份本机快照，供离线冷启动降级
  setLastSnapshot(snapshot);
  renderBanner(bannerEl, _bannerMode(), { staleAgeMs: _maxStaleAge(snapshot) });
  renderProvenance(root, snapshot);

  // ---- 后台补齐 ----
  // 说明：三张首屏卡此时**已经上屏**，这里补齐的是地名与瓦片探测结论，不会再阻塞首屏观感。
  // 仍然 await 住它：保证「无地图模式」在本轮内就依据真实探测结果定下（成功复位 / 失败置位），
  // 否则下一轮读到的是上一轮的结论，横幅会一直谎称「底图不可用」。
  try {
    await _background(snapshot, root, bannerEl, isDefaultPlace, epoch);
  } catch (err) {
    log('background failed', err && err.message);
  }
  if (epoch !== _epoch) return;
  // ★底图卡放在瓦片探测**之后**渲染：三态（map / grid / no-map）由 degradeMapMode()
  //   在 _background 里按整批裁决完，此时读 mapMode() 才是本轮真实结论，
  //   而不是上一轮的残留 —— 否则会渲染出与横幅互相矛盾的地图。
  renderMapCard(root, { coord: snapshot.coord });
  setLastSnapshot(snapshot);
}

/**
 * 手动刷新入口。
 *
 * 不再调用 resetQueue()：直接切断队列链会让上一轮在飞任务与本轮任务并行，破坏「全局并发 1」。
 * 改为靠 boot() 自增的 epoch 丢弃旧结果（真正的断网恢复路径是 'online' 事件）。
 *
 * @returns {Promise<void>}
 */
export function refresh() {
  return boot();
}

// DOM 就绪后启动；非浏览器环境（Node 侧检查）不执行
if (typeof document !== 'undefined' && document !== null) {
  const start = () => {
    boot().catch((err) => log('boot failed', err && err.message));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  // 网络恢复后自动重试一次
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => {
      log('online event → refresh');
      refresh().catch((err) => log('refresh failed', err && err.message));
    });
  }
}
