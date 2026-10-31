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
 * 注意：本模块顶层只碰两处 DOM —— 主题引导（把 themeMode 写到 <html data-theme>）与
 * 字号档位引导（把 fontScale 写到 <html data-fs>），两者都是全站属性、见 ui/theme.js；
 * 其余 DOM 访问都在 boot() 内，便于 Node 侧语法/引用检查。
 */

import { t } from '../i18n/index.js';
import {
  getDefaultPlace,
  getLastSnapshot,
  setLastSnapshot,
  getThemeMode,
  getFontScale,
  getLocale,
  log,
} from '../core/store.js';
// ★parsePlaceParam / resolveCoord 2026-10-17 从本模块迁到 core/geo.js（地理页 compass.js
//   要用同一套严格解析，留在 ui 层就得让一个 ui 模块 import 另一个 ui 模块）。
import { getCurrentPosition, parsePlaceParam, resolveCoord } from '../core/geo.js';
import { getWithState } from '../core/cache.js';
import { request, isOnline } from '../core/http.js';
import { getSource } from '../data/sources.js';
// recordResult 不再由本模块直接调用：它活在 `ui/pull.js` 的 pullSource() 里（唯一实现）。
import { overallMode, resetHealth } from '../data/health.js';

// 壳更新提示条：任何页面都要能看见「有新版本」（详见 shellupdate.js 文件头）。
import { watchShellUpdate } from './shellupdate.js';
// ★probeTileBatch / TILE_PROBE_COUNT / TILE_PROBE_BUDGET_MS 2026-10-17 从本模块迁到
//   data/tiles.js（同一条理由：地理页也要用，且它本来就是瓦片层的事）。
import {
  sampleTiles,
  setNoMapMode,
  degradeMapMode,
  mapMode,
  MAP_MODE,
  probeTileBatch,
  TILE_PROBE_COUNT,
  TILE_PROBE_BUDGET_MS,
} from '../data/tiles.js';
import {
  renderSkeleton,
  renderHeader,
  renderWeatherCard,
  renderAirCard,
  renderProvenance,
  renderBanner,
  renderEmptyState,
  renderSlotEmpty,
  renderSnapshot,
  renderClimateCard,
  applyI18n,
} from './now.js';
// ★「取数 → 记账 → 溯源」的唯一实现：与地理页 `compass.js` 共用，不许在这里再抄一份
//   （2026-10-17 之前这两页各有一份副本，靠测试钉不住行为，见 ui/pull.js 文件头）。
import { pullSource, safePull } from './pull.js';
import { applyThemeMode, applyFontScale } from './theme.js';
// 错误文案（把 core/http.js 的 messageKey 翻成人话）：气候常态卡要用它显示失败原因。
import { errorText } from './errtext.js';
// 语言引导：与主题 / 字号同构，本页入口必须在 module 求值那一刻就切好 i18n
// （四个独立 HTML、靠 <a href> 跳转，没有共享 bootstrap，谁也不能替谁写）。
import { applyLocale, placeDisplayName } from './locale.js';

// ★主题引导（模块顶层）：主题是全站属性，不是设置页的属性。本页是四个入口之一，
// 必须在 module 求值那一刻就把 store 里的 themeMode 写到 <html data-theme> 上 ——
// 挪进 boot() 或任何 await 之后，用户会先看到一帧系统色的背景。
// 实现与「没有 [data-theme='dark'] 规则块」等四组合语义见 ui/theme.js 文件头。
applyThemeMode(getThemeMode());
// ★字号档位引导（模块顶层，与主题同一时机）：字号同样是全站属性，用户在「我的」页
// 选的档位在本页必须一样生效。放大乘数在 styles/tokens.css（--fs-scale），
// 这里只落属性；默认的 'normal' 是**移除** data-fs，语义同 data-theme 的 'system'。
applyFontScale(getFontScale());
applyLocale(getLocale());

/** 定位超时（毫秒）。 */
const GEO_TIMEOUT_MS = 8000;

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
 * ★注册之后**主动催一次更新**并让等待中的新壳立刻接管 —— 只看 register() 是不够的：
 *   浏览器默认只在导航时顺便查一次 sw.js，而真机可以几周都停在旧壳上（有用户报的
 *   bug 最后查出来就是设备跑着两周前的副本：线上文件全是新的，本机那份不是）。
 *   装上新壳之后它默认停在 waiting 等旧页面全部关闭，所以这里补一句
 *   `postMessage({type:'skip-waiting'})`，让 activate 立刻发生。
 *
 * ★这里**故意不加 location.reload()**：自动重载会把用户正在输入的搜索词冲掉，
 *   风险大于收益。本单只做到「让新壳尽快接管，下次进入即是新版」；想立刻看新版的用户
 *   可以在「我的」页那张壳版本卡上点「检查更新」，结果文案会如实告诉他。
 *
 * @returns {void}
 */
function _registerSW() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  if (typeof location === 'undefined') return;
  // 本地 http / https 均可；file:// 下 serviceWorker 不存在，已在上面短路
  navigator.serviceWorker
    .register('sw.js')
    .then((reg) => {
      if (!reg) return;
      log('sw registered');
      // 默认只在导航时查一次，这里手动催一次（失败无所谓：下次导航还会再查）
      if (typeof reg.update === 'function') reg.update().catch(() => {});
      // 已经有新壳在等（比如上次进来时装好的）：让它立刻接管
      if (reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' });
      if (typeof reg.addEventListener !== 'function') return;
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // 装完且已经进 waiting 才催：installed 但没进 waiting 的新壳催了也没用
          if (sw.state === 'installed' && reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' });
        });
      });
    })
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
    // 离线也把气候常态卡画成 idle：按钮在，点了会拿到「设备离线，未发起请求」——
    // 比整张卡缺席诚实（离线不是「这个地点没有气候常态」）。
    _renderClimate(root, snapshot);
    return;
  }

  // 2) 退本机最近一次快照
  const cached = getLastSnapshot();
  if (cached && cached.weather) {
    const merged = { ...snapshot, ...cached };
    renderSnapshot(root, merged, { isDefaultPlace });
    renderBanner(bannerEl, 'offline', { staleAgeMs: Date.now() - (cached.atMs || Date.now()) });
    _renderClimate(root, merged);
    return;
  }

  // 3) 真·空数据：空态 + 重试（不转圈）
  renderBanner(bannerEl, 'offline');
  renderEmptyState(root, t('mode.offline'), () => {
    if (typeof window !== 'undefined' && window.location) window.location.reload();
  });
}

/**
 * 气候常态卡的状态（**不进 store**：它是「此刻页的一次性查阅物」，不是用户数据，
 *   既不该被备份导出，也不该在「我的」页出现）。
 *
 * 只存聚合结果（几百字节），不存 30 年逐日数组（303 KB）—— 见 data/climate.js 文件头。
 */
const _climate = { status: 'idle', data: null, text: '', lat: null, lon: null };

/**
 * 渲染气候常态卡（按当前 `_climate` 状态）。
 *
 * ★坐标守卫：卡里若是**别处**的 ready 数据就退回 idle。场景很窄但真实 ——
 *   本页是四个独立 HTML 之一，同页内 refresh() 会复用这个模块级状态；
 *   与其显示一个「看起来很有道理其实是另一个地方」的月平均，不如退回未取。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot（提供坐标；无坐标时按钮不绑回调）。
 * @returns {void}
 */
function _renderClimate(root, snapshot) {
  const c = snapshot && snapshot.coord ? snapshot.coord : null;
  if (c && _climate.status === 'ready') {
    const dLat = Math.abs(Number(_climate.lat) - Number(c.lat));
    const dLon = Math.abs(Number(_climate.lon) - Number(c.lon));
    if (!(dLat <= 1e-6) || !(dLon <= 1e-6)) {
      _climate.status = 'idle';
      _climate.data = null;
      _climate.text = '';
    }
  }
  renderClimateCard(root, _climate, c ? () => _loadClimate(root, snapshot) : null);
}

/**
 * 取气候常态（30 年 ERA5 再分析 → 本地按月聚合），**只由用户点击按钮触发**。
 *
 * ★三条刻意的「不」：
 *   1) **不调 `recordResult()`，也不参与 `overallMode()`**：climate 不在自检六路内
 *      （它进的是 `SOURCE_TABLE` 全量表），进了健康台账就会污染「整体降级态」——
 *      用户没点按钮、根本没请求过这一路，整屏却显示「部分数据源不可用」，那是假话。
 *   2) **不进首屏取数链路**：单次响应 303 KB（**gzip 后 62.7 KB**，浏览器必带 gzip，
 *      真机走的是这一档；服务端 `generationtime_ms` 实测 20.36 ms，算力不是瓶颈，
 *      耗时几乎全是传输），且 http.js 的 `_chain` 是**全局并发 1**，最坏会独占队列
 *      约 10 s（timeoutMs 10000 + retry 0）。那 10 s 里天气刷新 / 空气 / 地名 / 瓦片
 *      全排在它后面，所以它必须是「用户点按钮才发起」的惰性请求，首屏三路跑在它之前。
 *   3) **失败只废这一张卡**：整屏不报错、其余卡片不动。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot（提供坐标）。
 * @returns {Promise<void>}
 */
async function _loadClimate(root, snapshot) {
  if (!snapshot || !snapshot.coord) return;
  const lat = Number(snapshot.coord.lat);
  const lon = Number(snapshot.coord.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  _climate.status = 'loading';
  _climate.text = '';
  _renderClimate(root, snapshot);

  let res = null;
  try {
    res = await request('climate', { lat, lon });
  } catch (err) {
    log('climate pull failed', err && err.message);
    res = null;
  }

  if (res && res.ok && res.data && Array.isArray(res.data.months) && res.data.months.length > 0) {
    _climate.status = 'ready';
    _climate.data = res.data;
    _climate.text = '';
    _climate.lat = lat;
    _climate.lon = lon;
  } else {
    _climate.status = 'error';
    _climate.data = null;
    // 离线时 http.js 会给 error.OFFLINE；其余走 errtext 的通用兜底
    _climate.text = errorText(res && res.error, 'climate.err');
  }
  _renderClimate(root, snapshot);
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
    await pullSource(snapshot, 'reverse', { lat: snapshot.coord.lat, lon: snapshot.coord.lon }, (data) => {
      if (data && data.placeName) {
        snapshot.placeName = data.placeName;
      }
    });
    if (epoch !== _epoch) return; // 已被新一轮覆盖，丢弃结果
    // 地名进页头（气候页没有地点卡了）
    renderHeader(root, snapshot, { isDefaultPlace });
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
    // ★2026-10-17：气候页自己不再显示底图，所以探测完**不重画任何卡片**
    //   （原来这里会重画地点卡）。探测结论仍喂给 degradeMapMode()，
    //   由横幅与地理页共用同一份三态。
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
  // 紧跟注册：新壳可能早在 waiting 里躺着（2026-10-31 事故的实际情形）
  watchShellUpdate();
  resetHealth();

  // 骨架屏立即上屏（不转圈等待定位与网络）
  // ★2026-10-17 导航重构：底图卡已随「地点卡」一起搬到地理页（compass.js），
  //   气候页的骨架只剩 search→weather→air→climate→prov→legend，不再建 map 槽、
  //   也不再有 renderMapSkeleton() 这一步。
  renderSkeleton(root);

  // ① URL 指定地点（从收藏列表跳过来）优先：用户已经明确选了这个地点，
  //    再去要一次系统定位既慢（最多 8 s）又是和用户意图对着干 —— 直接跳过 geo.js。
  //    参数缺失/非法时 parsePlaceParam 返回 null，退回原有定位流程，行为不变。
  const fromUrl = parsePlaceParam();
  const coord = fromUrl || (await getCurrentPosition({ timeoutMs: GEO_TIMEOUT_MS }));
  if (epoch !== _epoch) return; // 定位期间已被新一轮接管

  const { base, isDefaultPlace } = resolveCoord(coord);
  if (fromUrl) log('coord from url param', base.lat, base.lon, base.name);

  const snapshot = _blankSnapshot(base);
  renderHeader(root, snapshot, { isDefaultPlace });
  // 气候常态卡：骨架期就画成 **idle**（标题 + 如实标注 + 「查看月平均」按钮）。
  // ★不在这里取数 —— 30 年再分析是用户点按钮才发起的懒加载，见 _loadClimate。
  _renderClimate(root, snapshot);

  // 离线：不发任何请求
  if (!isOnline()) {
    _renderOffline(root, bannerEl, snapshot, isDefaultPlace);
    return;
  }

  const ctx = { lat: snapshot.coord.lat, lon: snapshot.coord.lon };
  const staleAgeOf = (res) => (res && res.meta ? res.meta.staleAgeMs || 0 : 0);

  // ---- 首屏串行：weather → air → elevation，出一张渲染一张 ----
  // 每路都独立 try/catch：任一源抛错只废自己那张卡，绝不留下永久骨架屏。
  await safePull(
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

  await safePull(
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

  await safePull(
    snapshot,
    'elevation',
    ctx,
    (data) => {
      snapshot.elevationM = data && data.elevationM !== undefined ? data.elevationM : null;
    },
    () => {
      // ★2026-10-17：地点卡搬去了地理页，气候页不再有 place 槽。
      //   海拔改为**页头**显示（设计文档 §4.2 的表：elevationM 在气候页走页头），
      //   所以无论成功失败都要重画一次页头 —— 失败时那一行就不出现，也不谎报数字。
      renderHeader(root, snapshot, { isDefaultPlace });
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
