/**
 * 地理屏渲染与装配（地点 + 底图 + 方位 + 完整罗盘）
 *
 * ★2026-10-17 导航重构：本模块从「方位屏」扩成**地理屏**（三 tab 的「地理」）。气候页
 *   瘦身时搬出来的三块 —— 地点卡（海拔/坐标/地名）、底图卡（Esri 瓦片三态）、方位卡
 *   （磁偏角一个数）—— 与原有的完整罗盘四块（磁偏角主卡 / 模型卡 / 换算卡 / 传感器罗盘）
 *   摊在**同一页**上。原来方位卡里那颗「打开罗盘」按钮因此从跨页链接变成同页锚点。
 *
 * 骨架槽位硬契约（顺序由首次 appendChild 决定，建错就再也挪不回去）：
 *   `header → search → place → map → bearing → declination → model → convert → compass → prov`
 *   ⚠️ 改 `renderSkeleton()` 必须**一口气按上表建完**，不许「先建 declination 再插 place」。
 *
 * 职责：把「本机算出来的地磁要素」以及定位 / 海拔 / 地名 / 瓦片探测的结果变成 DOM。
 * 模型计算走 `src/data/wmm2025.js`（本地系数、不发请求），所以**磁偏角那几块断网可用**；
 * 底图与逆地理反查要联网，失败走各自的三态降级，不让整页跟着塌。
 *
 * 三条不变量（勿回退）：
 *   1) **不编造精度**：WMM 的 COF 里没有误差模型，模块也不导出任何不确定度字段。
 *      界面上能诚实展示的只有「模型版本 + 有效期 + 是否超期」、`overshootYears`（距失效年数）
 *      与 `symbolRates.dD`（年变率，换算成分/年）。任何「误差 ±X°」都是假的，不许写。
 *      docs 里那条「与官方 100 行测试值最大残差 D/I ≤ 5.0e-3°」是**与官方参考实现的吻合度**，
 *      不是相对真实磁场的精度，绝不能当精度指标搬到界面上。
 *   2) **不渲染 `warning` 原文**：它是非 UI 层返回的中文串，上屏文案一律取 `src/i18n/zh.js`。
 *      这里只读 `level` / `expired` / `ahead` / `overshootYears` 自己拼。
 *   3) **超期照样显示数值**：用户此时仍需要一个近似值。数值不隐藏，只把卡的信任等级降下来
 *      （同一张卡挂告警态 + `.chip--failed`），不能和有效期内渲染成同一个样子。
 *
 * 单位契约（错一个就返工）：
 *   - `computeGeomagnetic` 的角度**全是度**，不是弧度；
 *   - `altitudeKm` 是**千米且是椭球高**，而项目通用单位里海拔是**米**，所以 UI 拿到米必须 /1000；
 *   - `decimalYear` 不传会按历元 2025.0 算而不是今天，必须显式传 `decimalYearFromDate(new Date())`；
 *   - 可能抛 `RangeError`（纬度越界）/ `TypeError`（NaN/字符串）→ try/catch 降级，不许白屏。
 *
 * 依赖方向：ui ← data（`wmm2025.js` / `tiles.js` / `sources.js` / `health.js`）
 * / core（`mag.js` `geo.js` `format.js` `store.js` `http.js`）。
 * ★`src/ui/map.js`（20.3 KB）**只由本模块 import**：气候页入口 `app.js` 在瘦身时已不再
 *   用它，而 `now.js` **不许** import 它（`map.js` 要用 `now.js` 的 `h()`，反向依赖成环）。
 *   本模块不在自检单文件产物的闭包内，所以 map.js 也进不去 —— 与 `build-standalone.mjs`
 *   的 ORDER 现状一致（那里故意不登记 map.js）。
 * 顶层只碰三处 DOM —— 主题引导（把 themeMode 写到 <html data-theme>）、字号档位引导
 * （把 fontScale 写到 <html data-fs>）与语言引导，三者都是全站属性，见 `theme.js`；
 * 其余 DOM 访问都在 boot / render 内，便于 Node 侧检查与单测。
 */

import { t } from '../i18n/index.js';
import * as fmt from '../core/format.js';
import {
  getDefaultPlace,
  getThemeMode,
  getFontScale,
  getLocale,
  log,
} from '../core/store.js';
import { getCurrentPosition, parsePlaceParam, resolveCoord } from '../core/geo.js';
import { isOnline } from '../core/http.js';
// getSource / recordResult / request 都不再由本模块直接用：它们活在 `ui/pull.js`
// 的 pullSource() 里（气候页与地理页共用的唯一实现），本页只留 overallMode / resetHealth。
import { overallMode, resetHealth } from '../data/health.js';
import { computeGeomagnetic, WMM_MODEL } from '../data/wmm2025.js';
import {
  sampleTiles,
  mapMode,
  MAP_MODE,
  degradeMapMode,
  setNoMapMode,
  probeTileBatch,
  TILE_PROBE_COUNT,
  TILE_PROBE_BUDGET_MS,
} from '../data/tiles.js';
import {
  decimalYearFromDate,
  trueBearingFromMagnetic,
  magneticBearingFromTrue,
  normalizeSignedAngle,
  normalizeBearing,
} from '../core/mag.js';
// ★`declinationText` 从 now.js 取，不在这里自己实现一份：它是全仓唯一的「磁偏角读法」，
//   三处（本页大号数字 / 设置页 / 此刻页方位卡）共用。放在 now.js 是因为**本页不在自检页
//   单文件产物的闭包里**，而 now.js 在 —— 反过来让 now.js import 本页会把 mag.js（26.6 KB）
//   拖进那个诊断页。这里 re-export 只为保持既有 import 路径（tests/compass.test.mjs）。
// ★地理页要用 now.js 的三张共用卡：地点卡、溯源气泡，以及搜索面板（放大镜）。
//   `renderSearchPanel` / `searchButton` 原本是 now.js 的私有函数，2026-10-17 为地理页
//   导出 —— 不复制一份，避免两套搜索面板各自漂移。
import {
  h,
  applyI18n,
  declinationText,
  renderPlaceCard,
  renderProvenance,
  renderBanner,
  renderSearchPanel,
  searchButton,
  setSearchTarget,
} from './now.js';
export { declinationText };
import { applyThemeMode, applyFontScale } from './theme.js';
// 底图卡：只由本页 import（气候页已不再显示底图，now.js 也不许 import 它，见文件头）。
import { renderMapCard, renderMapSkeleton } from './map.js';
// ★「取数 → 记账 → 溯源」的唯一实现：与气候页 `app.js` 共用，不许再抄一份副本
//   （副本最坏的地方是「两处一致」这类用例钉得住字段名、钉不住行为）。
import { pullSource, safePull } from './pull.js';
// 语言引导：与主题 / 字号同构，本页入口必须在 module 求值那一刻就切好 i18n
// （四个独立 HTML、靠 <a href> 跳转，没有共享 bootstrap，谁也不能替谁写）。
import { applyLocale, placeDisplayName } from './locale.js';

// 壳更新提示条：任何页面都要能看见「有新版本」（详见 shellupdate.js 文件头）。
import { watchShellUpdate } from './shellupdate.js';

// ★主题引导（模块顶层）：本页是四个入口之一，必须在 module 求值那一刻就把 store 里的
// themeMode 写到 <html data-theme> 上，不能等 boot() —— 否则用户会先看到一帧系统色。
// 实现与四组合语义见 ui/theme.js 文件头。
applyThemeMode(getThemeMode());
// ★字号档位引导（模块顶层，与主题同一时机）：字号是全站属性，本页那个大号磁偏角
// 与一堆要素数字同样要跟着放大档走。乘数在 styles/tokens.css，这里只落属性。
applyFontScale(getFontScale());
applyLocale(getLocale());

// ★搜索结果点了以后跳**回本页**（地理页），不是跳气候页。默认目标是 index.html，
//   不设的话用户在「地理」tab 搜完地点会被甩到「气候」tab —— 一次搜索顺手换了个 tab。
setSearchTarget('compass.html');

/** 定位超时（毫秒）：与此刻屏一致，超时即降级为默认地点，不阻塞渲染。 */
const GEO_TIMEOUT_MS = 8000;

/**
 * 轮次号：每次 boot() 自增。
 *
 * 用途与气候页 `app.js` 同一套：refresh() 不切断 `http.js` 的全局串行队列（那会让在飞任务
 * 与新任务并行，破坏「全局并发 1」），而是让上一轮仍在飞的结果返回时发现 epoch 已变，
 * 直接丢弃、不再渲染。
 */
let _epoch = 0;

/**
 * 传感器等待上限（毫秒）。
 *
 * 桌面浏览器（以及部分安卓 WebView）定义了 `DeviceOrientationEvent` 却永远不派发数据，
 * 挂上监听后界面会一直停在「等待中」。这里给一个上限：超时还没收到第一条有效数据就
 * 判定为「本机无方向传感器」并降级，绝不让用户对着一个空指针等下去。
 */
const SENSOR_WAIT_MS = 2500;

/**
 * 传感器运行时状态（模块级：DOM 事件监听与超时守卫要跨渲染存活）。
 *
 * @type {{state:'idle'|'waiting'|'on'|'denied'|'unsupported', headingMagDeg:number|null, detach:(()=>void)|null, timer:any}}
 */
const _sensor = {
  state: 'idle',
  headingMagDeg: null,
  detach: null,
  timer: null,
  // 「回到前台再重等一轮」用的 visibilitychange 摘除钩子（与 detach 分开：
  // 它挂在 document 上、只在隐藏态那一轮存在，不是每次 attach 都有）
  detachVis: null,
};

/* ------------------------------------------------------------------ */
/* 纯计算（可单测，不碰 DOM）                                            */
/* ------------------------------------------------------------------ */

/**
 * 米 → 千米（WMM 的 `altitudeKm` 要千米，而项目通用海拔单位是米）。
 *
 * 缺失 / 非数字一律按 0（椭球面）处理 —— 海拔对磁偏角的影响很小，
 * 但传 NaN 会让整个结果变成 NaN，那才是真正的坏后果。
 *
 * @param {*} altitudeM 海拔（米）。
 * @returns {number} 千米；非有限值返回 0。
 */
export function altitudeKmFromM(altitudeM) {
  if (altitudeM === null || altitudeM === undefined) return 0;
  if (typeof altitudeM === 'boolean' || Array.isArray(altitudeM)) return 0;
  if (typeof altitudeM === 'string' && altitudeM.trim() === '') return 0;
  const m = Number(altitudeM);
  if (!Number.isFinite(m)) return 0;
  return m / 1000;
}

/**
 * 计算某地点的地磁要素（UI 侧唯一入口）。
 *
 * ★三处容易错的地方都在这里收口：米→千米、`decimalYear` 必须显式传、异常要吞掉降级。
 *
 * @param {{lat:number, lon:number}} coord 坐标（WGS84，度）。
 * @param {{altitudeM?:number|null, atMs?:number}} [opts] 海拔（米）与计算时刻（ms）。
 * @returns {{mag:Object|null, error:string|null}} 成功给要素对象，失败给错误名（如 'RangeError'）。
 */
export function computeAt(coord, opts = {}) {
  if (!coord || !Number.isFinite(Number(coord.lat)) || !Number.isFinite(Number(coord.lon))) {
    return { mag: null, error: 'TypeError' };
  }
  try {
    const mag = computeGeomagnetic({
      latitude: Number(coord.lat),
      longitude: Number(coord.lon),
      altitudeKm: altitudeKmFromM(opts.altitudeM),
      // ★不传会按历元 2025.0 算而不是「今天」—— 2029 年打开就会拿到 2025 年的值
      decimalYear: decimalYearFromDate(new Date(Number(opts.atMs) || Date.now())),
    });
    return { mag, error: null };
  } catch (err) {
    const name = err && err.name ? err.name : 'Error';
    log('compass: compute failed', name, err && err.message);
    return { mag: null, error: name };
  }
}

/**
 * 安全取角度：非数字一律返回 null（与 `format.js` 的 `_num` 同一套口径）。
 *
 * ★必须显式拦下 `null`：`Number(null) === 0`，不拦就会把「没输入」当成「输入了 0°」，
 * 换算出一个看起来很有道理的假结果 —— 这比显示占位符危险得多。
 *
 * @param {*} v 入参。
 * @returns {number|null} 有限数字或 null。
 */
function _angleOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || Array.isArray(v)) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 真方位 → 磁方位。
 *
 * @param {number} trueDeg 真方位（度）。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {number|null} 磁方位（[0,360)）；入参缺失或非数字返回 null。
 */
export function convertTrueToMag(trueDeg, declinationDeg) {
  const v = _angleOrNull(trueDeg);
  const d = _angleOrNull(declinationDeg);
  if (v === null || d === null) return null;
  return normalizeBearing(magneticBearingFromTrue(v, d));
}

/**
 * 磁方位 → 真方位（{@link convertTrueToMag} 的逆）。
 *
 * @param {number} magDeg 磁方位（度）。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {number|null} 真方位（[0,360)）；入参缺失或非数字返回 null。
 */
export function convertMagToTrue(magDeg, declinationDeg) {
  const v = _angleOrNull(magDeg);
  const d = _angleOrNull(declinationDeg);
  if (v === null || d === null) return null;
  return normalizeBearing(trueBearingFromMagnetic(v, d));
}

/**
 * 模型有效期提示（**不自拼中文**，只挑文案键 + 参数）。
 *
 * @param {Object} mag `computeGeomagnetic` 的返回。
 * @returns {{level:string, chip:'ok'|'failed', text:string}} 提示。
 */
export function modelStatus(mag) {
  if (!mag) return { level: 'ok', chip: 'failed', text: t('compass.na') };
  if (mag.expired) {
    return {
      level: 'error',
      chip: 'failed',
      text: t('compass.modelExpired', { years: fmt.num(Math.abs(mag.overshootYears), 1) }),
    };
  }
  if (mag.ahead) {
    return {
      level: 'error',
      chip: 'failed',
      text: t('compass.modelAhead', { years: fmt.num(Math.abs(mag.overshootYears), 1) }),
    };
  }
  const leftYears = Number(WMM_MODEL.validUntil) - Number(mag.decimalYear);
  return {
    level: 'ok',
    chip: 'ok',
    text:
      leftYears >= 0
        ? t('compass.modelLeft', { years: fmt.num(leftYears, 1) })
        : t('compass.modelOk'),
  };
}

/* ------------------------------------------------------------------ */
/* 传感器                                                               */
/* ------------------------------------------------------------------ */

/**
 * 探测方向传感器能力。
 *
 * @returns {'unsupported'|'available'|'needs-permission'} 能力。
 */
export function sensorSupport() {
  if (typeof window === 'undefined' || !window) return 'unsupported';
  const Ctor = window.DeviceOrientationEvent;
  if (typeof Ctor === 'undefined' || Ctor === null) return 'unsupported';
  // iOS 13+：必须经用户手势调用 requestPermission()，否则永远拿不到数据
  if (typeof Ctor.requestPermission === 'function') return 'needs-permission';
  return 'available';
}

/**
 * 当前传感器状态（供渲染与测试读取）。
 *
 * @returns {{state:string, headingMagDeg:number|null}} 状态快照。
 */
export function sensorState() {
  return { state: _sensor.state, headingMagDeg: _sensor.headingMagDeg };
}

/**
 * 复位传感器状态（测试用）。
 *
 * @returns {void}
 */
export function resetSensor() {
  if (_sensor.detach) {
    try {
      _sensor.detach();
    } catch (err) {
      log('compass: detach failed', err && err.message);
    }
  }
  if (_sensor.timer) clearTimeout(_sensor.timer);
  // ★连同 visibilitychange 一起摘：它挂在 **document** 上，`_sensor.detach` 只管
  //   window 上的 deviceorientation。漏摘就是一次真实的监听泄漏 —— 而且泄漏的对象是
  //   全局 document，将来任何「只挂一次」的断言都会被它污染。
  _disarmVisibility();
  _sensor.state = 'idle';
  _sensor.headingMagDeg = null;
  _sensor.detach = null;
  _sensor.timer = null;
}

/**
 * 挂上 `deviceorientation` 监听，并起一个「等不到数据就降级」的超时守卫。
 *
 * @param {() => void} [onChange] 数据变化时的重渲染回调。
 * @returns {void}
 */
function _attachSensor(onChange) {
  const handler = (ev) => {
    const alpha = Number(ev && ev.alpha);
    const compass = Number(ev && ev.webkitCompassHeading);
    // iOS 的 webkitCompassHeading 已经是磁方位；其余内核用 360 − alpha 折算
    const heading = Number.isFinite(compass) ? compass : Number.isFinite(alpha) ? 360 - alpha : NaN;
    if (!Number.isFinite(heading)) return;
    if (_sensor.timer) {
      clearTimeout(_sensor.timer);
      _sensor.timer = null;
    }
    _sensor.headingMagDeg = normalizeBearing(heading);
    _sensor.state = 'on';
    if (typeof onChange === 'function') onChange();
  };
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('deviceorientation', handler, true);
    _sensor.detach = () => window.removeEventListener('deviceorientation', handler, true);
  }
  _armWait(onChange);
}

/**
 * 页面此刻是不是在后台（隐藏）。
 *
 * ★为什么必须问这一句：方向事件按规范**只在页面可见时派发**，页面隐藏期间一条都不会来。
 *   「等满一轮没数据」在后台根本不是证据 —— 那段时间本来就该是空的。
 *
 * @returns {boolean} 隐藏为 true；拿不到 document（Node 侧检查 / 老内核）时为 false。
 */
function _isDocumentHidden() {
  return typeof document !== 'undefined' && document && document.hidden === true;
}

/**
 * 摘掉「回到前台再重等一轮」那个 visibilitychange 监听（重入安全）。
 *
 * @returns {void}
 */
function _disarmVisibility() {
  const fn = _sensor.detachVis;
  if (!fn) return;
  _sensor.detachVis = null;
  try {
    fn();
  } catch (err) {
    log('compass: visibility detach failed', err && err.message);
  }
}

/**
 * 起一轮「等不到方向数据就降级」的等待（可重入：每轮先清掉上一轮的定时器）。
 *
 * @param {() => void} [onChange] 状态变化时的重渲染回调。
 * @returns {void}
 */
function _armWait(onChange) {
  if (_sensor.timer) clearTimeout(_sensor.timer);
  _sensor.state = 'waiting';
  // 桌面内核常「定义了事件却永远不派发」→ 到点没数据就判定无传感器，降级而非空等
  _sensor.timer = setTimeout(() => {
    _sensor.timer = null;
    if (_sensor.headingMagDeg !== null) return;
    // ★2026-10 真机缺陷：页面在后台时（锁屏 / 切到别的 App）方向事件**规范上不派发**，
    //   所以这段时间一条数据都收不到是**正常的**。原来的代码在这里直接置
    //   'unsupported'，界面于是显示「本机无方向传感器」—— 那是**假的**：机器有传感器，
    //   只是页面不在前台（正是「界面说的和实际发生的不一样」那一类毛病）。
    //   所以：状态**保持 'waiting'**（「正在等待方向数据…」在后台期间本来就是实话，
    //   ★因此不需要新增状态、也不需要新增文案），回到前台再重等一轮。
    if (_isDocumentHidden()) {
      _armVisibilityRewait(onChange);
      return;
    }
    _sensor.state = 'unsupported';
    if (typeof onChange === 'function') onChange();
  }, SENSOR_WAIT_MS);
}

/**
 * 等待期间页面切走了：挂一个 visibilitychange，回到前台再重等一轮。
 *
 * ★只挂一次（`_sensor.detachVis` 非空就直接返回）—— 每超时一次叠一个监听，
 *   回到前台就会同时重等好几轮，定时器互相清掉，行为变得不可预测。
 *
 * @param {() => void} [onChange] 状态变化时的重渲染回调。
 * @returns {void}
 */
function _armVisibilityRewait(onChange) {
  if (_sensor.detachVis) return;
  const doc = typeof document !== 'undefined' && document ? document : null;
  if (!doc || typeof doc.addEventListener !== 'function') {
    // 拿不到 visibilitychange（Node 侧检查等环境）：没有「回到前台」这条路可等，
    //   只能按眼前的事实降级 —— 与上面「真没传感器」同一档处置。
    _sensor.state = 'unsupported';
    if (typeof onChange === 'function') onChange();
    return;
  }
  const handler = () => {
    if (_isDocumentHidden()) return; // 只是换了一种隐藏方式，还没真的回到前台
    _disarmVisibility();
    _armWait(onChange);
    if (typeof onChange === 'function') onChange();
  };
  _sensor.detachVis = () => {
    if (typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', handler, true);
    }
  };
  doc.addEventListener('visibilitychange', handler, true);
}

/**
 * 启用方向传感器（**必须由用户手势触发**，iOS 的硬要求）。
 *
 * @param {() => void} [onChange] 状态变化时的重渲染回调。
 * @returns {string} 调用后的状态。
 */
export function enableSensor(onChange) {
  const support = sensorSupport();
  if (support === 'unsupported') {
    _sensor.state = 'unsupported';
    if (typeof onChange === 'function') onChange();
    return _sensor.state;
  }
  if (support === 'needs-permission') {
    _sensor.state = 'waiting';
    try {
      Promise.resolve(window.DeviceOrientationEvent.requestPermission()).then(
        (res) => {
          if (res === 'granted') {
            _attachSensor(onChange);
          } else {
            _sensor.state = 'denied';
            if (typeof onChange === 'function') onChange();
          }
        },
        () => {
          _sensor.state = 'denied';
          if (typeof onChange === 'function') onChange();
        }
      );
    } catch (err) {
      _sensor.state = 'denied';
      if (typeof onChange === 'function') onChange();
    }
    return _sensor.state;
  }
  _attachSensor(onChange);
  return _sensor.state;
}

/* ------------------------------------------------------------------ */
/* DOM 小工具（与 now.js 同构：整槽替换，不做局部 diff）                  */
/* ------------------------------------------------------------------ */

/**
 * 清空并写入容器。
 *
 * @param {HTMLElement} box 容器。
 * @param {Array<Node|null>} nodes 子节点。
 * @returns {void}
 */
function _fill(box, nodes) {
  if (!box) return;
  box.textContent = '';
  nodes.forEach((n) => n && box.appendChild(n));
}

/**
 * 取（或创建）卡片槽位，保证增量渲染时位置稳定。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} id 槽位 id。
 * @returns {HTMLElement} 容器。
 */
function _slot(root, id) {
  const domId = `card-${id}`;
  let box = root.querySelector(`#${domId}`);
  if (!box) {
    box = h('div', { class: 'card-slot', id: domId });
    root.appendChild(box);
  }
  return box;
}

/**
 * 键值项。
 *
 * @param {string} key 标签。
 * @param {string} value 值。
 * @returns {HTMLElement} kv-item。
 */
function _kv(key, value) {
  return h('div', { class: 'kv-item' }, [
    h('span', { class: 'kv-k', text: key }),
    h('span', { class: 'kv-v', text: value }),
  ]);
}

/**
 * 状态胶囊（文字色恒为 `--c-text-1`，状态色只做填充与徽点）。
 *
 * @param {'ok'|'failed'|'offline'|'idle'} status 状态。
 * @param {string} text 文案。
 * @returns {HTMLElement} chip。
 */
function _chip(status, text) {
  return h('span', { class: `chip chip--${status}` }, [
    h('span', { class: `badge badge--${status}` }),
    text,
  ]);
}

/* ------------------------------------------------------------------ */
/* 各卡片                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染页头（地点名 / 坐标 / 默认地点提示 / 搜索入口）。
 *
 * ★第一行是**地名**，不是页面标题：本页是「地理」页，用户要看的是「这是哪儿」。
 *   地名由逆地理反查补（后台补齐），没拿到之前显示坐标，再没有才显示「未知」——
 *   绝不拿页面标题去占位（那会让人以为「方位 · 磁偏角」是个地名）。
 *
 * ★搜索放大镜与气候页同一颗（now.js 的 `searchButton`），不在这里另写一份：
 *   两套搜索入口必然漂移，而漂移的表现是「一边能搜一边不能搜」，很难查。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 地理屏状态。
 * @returns {void}
 */
export function renderHeader(root, snapshot) {
  const hd = root.querySelector('.hd');
  if (!hd) return;
  const coordText = snapshot.coord
    ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon)
    : t('app.unknown');
  _fill(hd, [
    h('div', {}, [
      h('div', { class: 'hd-place-row' }, [
        h('h1', { class: 'hd-place', text: fmt.placeTitle(snapshot.placeName || coordText) }),
        searchButton(root),
      ]),
      h('p', { class: 'hd-coord num', text: snapshot.coord ? coordText : t('app.dash') }),
      snapshot.isDefaultPlace ? h('p', { class: 'hd-coord', text: t('compass.defaultPlaceNotice') }) : null,
    ]),
    h('div', { class: 'hd-time', text: t('compass.subtitle') }),
  ]);
  // 搜索面板挂独立槽位（不在 .hd 里，否则整槽重建会把面板连根拔掉）
  renderSearchPanel(root);
}

/**
 * 渲染磁偏角主卡（D / I / F / H + 年变率）。
 *
 * 超期时**数值照常显示**，只把卡片挂上 `.card--alert` 与 `.chip--failed`
 * —— 用户此刻仍需要一个近似值，但不能让它看起来和有效期内一样可信。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @returns {void}
 */
export function renderDeclinationCard(root, snapshot) {
  const box = _slot(root, 'declination');
  const status = modelStatus(snapshot.mag);

  if (!snapshot.mag) {
    _fill(box, [
      h('div', { class: 'card' }, [
        h('div', { class: 'card--row' }, [
          h('p', { class: 'card-title', text: t('card.declination') }),
          _chip('failed', t('compass.na')),
        ]),
        h('p', {
          class: 'card-note',
          text: t('compass.unavailable', { reason: snapshot.error || t('app.unknown') }),
        }),
      ]),
    ]);
    return;
  }

  const m = snapshot.mag;
  const rateMinutes = Math.abs(Number(m.symbolRates.dD) * 60);
  _fill(box, [
    h('div', { class: status.level === 'error' ? 'card card--alert' : 'card' }, [
      h('div', { class: 'card--row' }, [
        h('p', { class: 'card-title', text: t('card.declination') }),
        _chip(status.chip, status.text),
      ]),
      // 大数字是「读法」（西偏 7.49°），旁边再给原始有符号值，避免只看到绝对值丢了方向
      h('div', { class: 'compass-hero' }, [
        h('span', { class: 'compass-hero-num num', text: declinationText(m.declination) }),
        h('span', { class: 'compass-hero-signed num', text: `${fmt.num(m.declination, 2)}°` }),
      ]),
      h('div', { class: 'kv' }, [
        _kv(t('compass.d'), `${fmt.num(m.declination, 2)}°`),
        _kv(t('compass.i'), `${fmt.num(m.inclination, 2)}°`),
        _kv(t('compass.f'), fmt.num(m.total, 0, 'nT')),
        _kv(t('compass.h'), fmt.num(m.horizontal, 0, 'nT')),
      ]),
      // 年变率是模型自带的量（dD 度/年 → 分/年），不是精度指标
      h('p', { class: 'card-note num', text: t('compass.rateD', { min: fmt.num(rateMinutes, 1) }) }),
      h('p', { class: 'card-note', text: t('compass.calcNote') }),
    ]),
  ]);
}

/**
 * 渲染模型信息卡（版本 / 历元 / 有效期 / 来源 + 到期提示）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @returns {void}
 */
export function renderModelCard(root, snapshot) {
  const box = _slot(root, 'model');
  const status = modelStatus(snapshot.mag);
  const range = t('compass.modelRange', {
    from: fmt.num(WMM_MODEL.validFrom, 1),
    until: fmt.num(WMM_MODEL.validUntil, 1),
  });
  _fill(box, [
    h('div', { class: 'card' }, [
      h('div', { class: 'card--row' }, [
        h('p', { class: 'card-title', text: t('card.model') }),
        _chip(status.chip, status.text),
      ]),
      h('div', { class: 'kv' }, [
        _kv(t('compass.modelName'), WMM_MODEL.name),
        _kv(t('compass.modelEpoch'), fmt.num(WMM_MODEL.epoch, 1)),
        _kv(t('compass.modelRangeLabel'), range),
        _kv(t('compass.modelSource'), WMM_MODEL.source),
        _kv(t('compass.modelDoi'), WMM_MODEL.doi),
        // ★2026-10 真机缺陷：这里原来标 `card.magnetic`（「地磁要素」），值是小数年 ——
        //   界面读到「地磁要素 2026.82」，标签张冠李戴（地磁要素指 D/I/F/H 那些量）。
        //   ★如实记录一处副作用：这一行本来是 `card.magnetic` 在 src 里的**唯一**引用点，
        //   换键之后它在 src 里确实没有引用了 —— 但**不是孤儿**：`tests/compass.test.mjs`
        //   拿它当反向锚点（「不许再借『地磁要素』当这一行的标签」），删了那条断言会
        //   静默失效。按裁决「不许动 card.magnetic」保留原样，用途写在 i18n 表该键旁边。
        _kv(
          t('compass.modelAt'),
          snapshot.mag ? fmt.num(snapshot.mag.decimalYear, 2) : t('app.dash')
        ),
      ]),
    ]),
  ]);
}

/**
 * 渲染真/磁方位换算卡（手动输入，双向，不依赖传感器）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @returns {void}
 */
export function renderConvertCard(root, snapshot) {
  const box = _slot(root, 'convert');
  const decl = snapshot.mag ? snapshot.mag.declination : null;

  if (decl === null || decl === undefined || !Number.isFinite(Number(decl))) {
    _fill(box, [
      h('div', { class: 'card' }, [
        h('p', { class: 'card-title', text: t('card.convert') }),
        h('p', { class: 'card-note', text: t('compass.convertUnavailable') }),
      ]),
    ]);
    return;
  }

  _fill(box, [
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('card.convert') }),
      _convertRow('true', Number(decl)),
      _convertRow('mag', Number(decl)),
      h('p', { class: 'card-note num', text: t('compass.convertHint') }),
    ]),
  ]);
}

/**
 * 一行换算输入（输入一侧 → 输出另一侧）。
 *
 * @param {'true'|'mag'} dir 输入的是哪一侧。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {HTMLElement} 一整行。
 */
function _convertRow(dir, declinationDeg) {
  const isTrue = dir === 'true';
  const out = h('span', { class: 'compass-out num', text: t('app.dash') });
  const input = h('input', {
    class: 'compass-input num',
    type: 'number',
    inputmode: 'decimal',
    step: 'any',
    placeholder: isTrue ? t('compass.inputTrueHint') : t('compass.inputMagHint'),
    'aria-label': isTrue ? t('compass.trueBearing') : t('compass.magBearing'),
  });
  input.addEventListener('input', () => {
    const raw = input.value === '' || input.value === null ? NaN : Number(input.value);
    if (!Number.isFinite(raw)) {
      out.textContent = t('compass.inputInvalid');
      return;
    }
    const converted = isTrue
      ? convertTrueToMag(raw, declinationDeg)
      : convertMagToTrue(raw, declinationDeg);
    out.textContent = converted === null ? t('app.dash') : `${fmt.num(converted, 1)}°`;
  });

  return h('div', { class: 'field' }, [
    h('span', { class: 'field-label', text: isTrue ? t('compass.trueBearing') : t('compass.magBearing') }),
    h('div', { class: 'field compass-row' }, [
      input,
      h('span', { class: 'compass-arrow', text: '→' }),
      out,
    ]),
  ]);
}

/**
 * 罗盘指针盘面（有传感器时才画）。
 *
 * @param {number} headingMagDeg 设备当前朝向（磁方位）。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {HTMLElement} 盘面节点。
 */
function _dial(headingMagDeg, declinationDeg) {
  // 盘面转 −heading：设备朝向始终指向盘顶；真北针再相对磁北针转一个磁偏角
  const roseStyle = `transform: rotate(${(-Number(headingMagDeg)).toFixed(1)}deg)`;
  const trueStyle = `transform: rotate(${normalizeSignedAngle(Number(declinationDeg)).toFixed(1)}deg)`;
  return h('div', { class: 'compass-dial' }, [
    h('span', { class: 'compass-mark compass-mark--n', text: 'N' }),
    h('span', { class: 'compass-mark compass-mark--e', text: 'E' }),
    h('span', { class: 'compass-mark compass-mark--s', text: 'S' }),
    h('span', { class: 'compass-mark compass-mark--w', text: 'W' }),
    h('div', { class: 'compass-rose', style: roseStyle }, [
      h('span', { class: 'compass-needle compass-needle--mag' }),
      h('span', { class: 'compass-needle compass-needle--true', style: trueStyle }),
    ]),
  ]);
}

/**
 * 指针配色图例：两个色点 + 文字，回答「哪根针是磁北、哪根针是真北」。
 *
 * ★真机反馈：盘面上红（磁北）青（真北）两支针长得一模一样，只差颜色，用户分不出谁是谁。
 *
 * ★色点的颜色**不许在这里写死**：本函数只挂 `class`，取色全交给 styles/app.css 的
 *   `.compass-dot--mag` / `.compass-dot--true`，而那两条规则用的是**与针完全相同**的 token
 *   （`var(--c-state-failed)` / `var(--c-brand)`）。在这里复制一份十六进制，就等于埋一颗
 *   「token 改了、图例还在撒谎」的雷 —— 而且这种雷不会报错，只会指错方向。
 *
 * ★文字只用 `.card-note`（已有的一条小字样式）：本节**不新增任何 color 声明** ——
 *   `tools/contrast-audit.mjs` 全量扫的就是 styles/app.css 里的 `color:`。
 *
 * @returns {HTMLElement} 图例节点。
 */
function _legend() {
  const item = (dotClass, key) =>
    h('span', { class: 'compass-legend-item' }, [
      h('span', { class: `compass-dot ${dotClass}` }),
      h('span', { text: t(key) }),
    ]);
  return h('p', { class: 'card-note compass-legend' }, [
    item('compass-dot--mag', 'compass.legendMag'),
    item('compass-dot--true', 'compass.legendTrue'),
  ]);
}

/**
 * 渲染罗盘卡（有传感器画指针，否则降级为说明文案）。
 *
 * 降级路径：不支持 / 未授权 / 等不到数据（桌面） → 一律显示
 * 「本机无方向传感器 · 仅显示计算值与手动换算」，**绝不白屏**。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @param {{onChange?:() => void}} [opts] 选项。
 * @returns {void}
 */
export function renderCompassCard(root, snapshot, opts = {}) {
  const box = _slot(root, 'compass');
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const title = h('p', { class: 'card-title', text: t('card.compass') });

  if (_sensor.state === 'on' && _sensor.headingMagDeg !== null) {
    const headingMag = _sensor.headingMagDeg;
    const decl = snapshot.mag ? snapshot.mag.declination : null;
    // ★`Number(null) === 0` —— 直接 `Number.isFinite(Number(decl))` 会把「算不出磁偏角」
    //   当成「磁偏角 = 0」，于是把磁朝向原样当成真朝向印上去（一条看着很像真的假数）。
    //   判有限性之前必须先把 null / undefined / '' 挡掉。
    const declOk =
      decl !== null && decl !== undefined && decl !== '' && Number.isFinite(Number(decl));
    const nodes = [
      title,
      _dial(headingMag, declOk ? Number(decl) : 0),
      // 图例紧贴盘面下方、两条「当前朝向」之上：先看颜色对上谁，再看数值。
      _legend(),
      h('p', { class: 'compass-heading num', text: t('compass.headingMag', { deg: fmt.num(headingMag, 0) }) }),
    ];
    if (declOk) {
      nodes.push(
        h('p', {
          class: 'compass-heading num',
          text: t('compass.headingTrue', { deg: fmt.num(convertMagToTrue(headingMag, Number(decl)), 0) }),
        }),
        // ★「两针夹角即磁偏角」只在**真有第二支针**时才说：磁偏角算不出来时盘上只有
        //   磁北针（真北针是叠在它上面的同一根），此时这句是假话。与 headingTrue 共用
        //   同一个判据，两条永远同时出现或同时不出现。
        h('p', { class: 'card-note', text: t('compass.needleHint') })
      );
    }
    nodes.push(h('p', { class: 'card-note', text: t('compass.compassNote') }));
    _fill(box, [h('div', { class: 'card' }, nodes)]);
    return;
  }

  // 先看「有没有」再看「开没开」：本机压根没有方向传感器时（含 Node 侧与桌面内核），
  // 直接说「本机无方向传感器」，而不是「未启用」—— 后者会让人以为点一下就有。
  const support = sensorSupport();

  // ★2026-10 真机问题「罗盘为什么要点一次按钮才能显示」——答案是**一半能去掉**：
  //   - iOS 13+（至今如此）：`DeviceOrientationEvent.requestPermission()` 必须在**一次
  //     点击里**调用，页面加载时调会被拒（NotAllowedError），事件永不触发。iOS 上所有
  //     浏览器都走 WebKit，无一例外 —— 那颗按钮物理上去不掉，去掉 = 指针永远不出现。
  //   - 安卓等没有 requestPermission 的内核：挂上监听就出指针，**那次点击是多余的**。
  //   所以只有 `available` 这一档自动启用；`needs-permission` 照旧画按钮。
  //   ★不要为「未来的 Chrome」写任何平台判断：Chrome 152+ 开始提供 requestPermission()
  //   且计划把默认从 allow 改成 ask，改完它会自动落到 `needs-permission` 这一档 ——
  //   `sensorSupport()` 按「有没有 requestPermission 这个方法」判，本来就自动适配。
  //
  //   ★闸门为什么用 `_sensor.state === 'idle'` 就够：`_attachSensor()` 会**同步**把状态
  //   置成 'waiting'（不是等数据回来才改），所以 `rerender()` 在首屏里连着调好几次、
  //   以及传感器回调重画罗盘卡，都只会真正挂一次监听；同时用户拒过（'denied'）或已判定
  //   无传感器（'unsupported'）后也不会再自动重试 —— 拒绝过就别再烦他。
  if (support === 'available' && _sensor.state === 'idle') {
    enableSensor(onChange);
  }

  // ★顺序：先启用再读状态。`_attachSensor()` 同步置 'waiting'，先调后读才能显示
  //   「已启用，正在等待方向数据…」而不是「未启用」—— 反过来说就成了刚启用却说没启用。
  const noteText =
    support === 'unsupported'
      ? t('compass.sensorUnsupported')
      : _sensor.state === 'denied'
        ? t('compass.sensorDenied')
        : _sensor.state === 'waiting'
          ? t('compass.sensorWaiting')
          : _sensor.state === 'unsupported'
            ? t('compass.sensorUnsupported')
            : t('compass.sensorIdle');

  const nodes = [title, h('p', { class: 'card-note', text: noteText })];
  // ★按钮只在「必须由用户手势授权」时才出现。原来不管哪一档都画，安卓上那一次点击
  //   是纯多余的；`available` 走上面的自动启用，这里只剩 iOS（以及未来的安卓 Chrome）。
  //   ★一处有意的取舍：`available` 下若等满 SENSOR_WAIT_MS 仍无数据会判成 'unsupported'，
  //   此时**不再给重试按钮** —— 已经在无干扰的情况下等满一整轮，再摆一颗按钮等于
  //   「让人以为点一下就有」，正好和上面 `sensorUnsupported` 那句文案的用意相反。
  const canAsk = support === 'needs-permission' && _sensor.state !== 'waiting';
  if (canAsk) {
    const btn = h('button', { class: 'btn btn--primary', type: 'button', text: t('compass.sensorEnable') });
    // 授权必须由用户手势触发（iOS 13+ 的硬要求），所以只能挂在点击回调里
    btn.addEventListener('click', () => {
      enableSensor(onChange);
      onChange();
    });
    nodes.push(btn);
  }
  _fill(box, [h('div', { class: 'card' }, nodes)]);
}

/* ------------------------------------------------------------------ */
/* 整屏与入口                                                           */
/* ------------------------------------------------------------------ */

/**
 * 渲染骨架（立即上屏，不转圈等待定位）。
 *
 * ★槽位顺序硬契约（顺序由首次 `appendChild` 决定，建错位置就再也挪不回去）：
 *   `header → search → place → map → bearing → declination → model → convert → compass → prov`
 *   所以这 9 个槽必须**在这一个函数里按上表一口气建完**，不许「先建 declination 再插 place」
 *   那种补建写法 —— 补建出来的卡片会永久停在页面末尾。
 *   `tests/compass.test.mjs` 有一条用例逐字钉住这个顺序。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderSkeleton(root) {
  if (!root) return;
  root.textContent = '';
  root.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [h('h1', { class: 'hd-place', text: t('app.loading') })]),
      h('div', { class: 'hd-time', text: t('app.loading') }),
    ])
  );
  root.appendChild(_slot(root, 'search'));
  root.appendChild(_slot(root, 'place')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'map'));
  root.appendChild(_slot(root, 'declination')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'model'));
  root.appendChild(_slot(root, 'convert'));
  root.appendChild(_slot(root, 'compass'));
  root.appendChild(_slot(root, 'prov'));
}

/**
 * 一次性完整渲染（**不含底图卡**）。
 *
 * ★底图卡不在本函数里：`renderMapCard()` 每调一次就要重铺一遍瓦片（3×3 起，含网络），
 *   而本函数会被 `rerender()` 在首屏内连着调好几次（定位后 / 海拔回来后 / 地名回来后）。
 *   底图由 `boot()` 在骨架之后与瓦片探测裁决之后各画一次，见 `boot()` 的注释。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 地理屏状态。
 * @param {{onChange?:() => void}} [opts] 选项。
 * @returns {void}
 */
export function renderSnapshot(root, snapshot, opts = {}) {
  if (!root) return;
  if (!root.querySelector('.hd')) renderSkeleton(root);
  renderHeader(root, snapshot);
  renderPlaceCard(root, snapshot);
  // ★2026-10-26 这里原有一张「方位 · 磁偏角」概览卡（renderBearingCard），已删：
  //   它和紧接着的磁偏角详情卡把同一个数（西偏 7.60°）在一屏里说了两遍，且它那颗
  //   「看下方完整罗盘」按钮锚点指到的是 #card-declination（磁偏角详情卡，不是罗盘卡）
  //   —— 标签与目标本身就不一致。免责声明 compass.calcNote 详情卡里本来就有，没丢内容。
  renderDeclinationCard(root, snapshot);
  renderModelCard(root, snapshot);
  renderConvertCard(root, snapshot);
  renderCompassCard(root, snapshot, opts);
  renderProvenance(root, snapshot);
}

/**
 * 构造一份空状态（字段齐全，避免渲染时到处判空）。
 *
 * @param {{lat:number, lon:number}|null} coord 坐标。
 * @param {{altitudeM?:number|null, isDefaultPlace?:boolean, atMs?:number,
 *          placeName?:string|null}} [opts] 附加字段。
 * @returns {Object} 状态对象。
 */
export function createSnapshot(coord, opts = {}) {
  return {
    coord: coord ? { lat: Number(coord.lat), lon: Number(coord.lon) } : null,
    altitudeM: Number.isFinite(Number(opts.altitudeM)) ? Number(opts.altitudeM) : null,
    isDefaultPlace: opts.isDefaultPlace === true,
    atMs: Number(opts.atMs) || Date.now(),
    // 地名由逆地理反查补（后台）；没有就是 null，页头退回显示坐标
    placeName: typeof opts.placeName === 'string' && opts.placeName ? opts.placeName : null,
    // 溯源气泡：本页只消费 elevation 与 reverse 两路，条目由 `pullSource()` 追加
    provenance: [],
    mag: null,
    error: null,
  };
}

/**
 * 横幅应显示的降级态。
 *
 * 与气候页 `app.js` 的 `_bannerMode()` 同一套判定，且同样只在展示层接住 grid：
 * `overallMode()` 对「底图半残」返回 'partial'，而 'partial' 的文案是「部分数据源不可用」
 * —— 本页的六路 API 可能全正常，坏的只是瓦片，那句话就是假话。
 *
 * @returns {'live'|'stale'|'partial'|'grid'|'offline'|'no-map'|'empty'} 横幅态。
 */
function _bannerMode() {
  if (!isOnline()) return 'offline';
  const mode = overallMode();
  // grid 只压过这三档（实际可达的只有 partial，其余两项是防御性冗余，理由见 app.js 同名函数）
  const gridWins = mode === 'partial' || mode === 'no-map' || mode === 'live';
  if (mapMode() === MAP_MODE.GRID && gridWins) return 'grid';
  return mode;
}

/**
 * 造一组方位屏的重渲染回调。
 *
 * ★为什么必须有这个函数：`boot()` 曾经写成 `renderSnapshot(root, snapshot)` —— 不传第三个
 * 参数，于是 `renderCompassCard` 里 `opts` 恒为 `{}`，`onChange` 退化成空函数。点「启用方向
 * 传感器」时按钮处理器确实调了 `enableSensor(onChange)`（传感器真的挂上了、状态真的变成了
 * waiting），紧跟着的 `onChange()` 却是空函数 → 零重渲染 → 用户看到的界面纹丝不动。
 * 这个功能从进仓库起就没生效过，与机型无关，100% 复现。
 *
 * ★为什么抽出来而不是只在 boot() 里改：`boot()` 会 await 定位，整体驱动麻烦，而既有
 * 8 个测试全都**自己传了回调**（`renderSnapshot(app, snapshot)` 或
 * `enableSensor(() => renderSnapshot(...))`），覆盖的是「卡片怎么画」，不是「boot 怎么接线」
 * —— 正是这个盲区让上面那个洞一直没被发现。抽成工厂后测试能直接实例化并驱动接线本身。
 *
 * 两个回调的分工（**不许互换**）：
 *   - `rerender()`：整屏重渲染，只在「定位回来了 / 数据变了」这类低频时刻调；
 *   - `onSensorChange()`：**只重画罗盘卡**，同一帧内的连续触发合并成一次。传感器一秒能来
 *     50 次，这里绝不能接整屏重渲染（页头 + 四张卡全重建 = 每秒 50 次整页 DOM 重建）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态（就地修改，传引用是有意的）。
 * @returns {{rerender:() => void, onSensorChange:() => void}} 整屏回调与传感器回调。
 */
export function createCompassRenderer(root, snapshot) {
  /** 是否已排了一帧（合并开关）。 */
  let framePending = false;

  /** 只重画罗盘卡（廉价路径）。 */
  const paintCard = () => {
    // 卡要带着同一个回调重画：卡里的按钮是新建的 DOM，不传就又断线了
    renderCompassCard(root, snapshot, { onChange: onSensorChange });
  };

  /** 排一帧；已经排过就直接返回 —— 这就是「同一帧内的连续触发合并成一次」。 */
  const scheduleFrame = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      paintCard();
    });
  };

  /**
   * 传感器重渲染回调：只重画罗盘卡 + 合并高频触发。
   *
   * @returns {void}
   */
  function onSensorChange() {
    // Node 侧检查 / 部分测试环境没有 requestAnimationFrame —— 直接同步画。
    // ★必须做存在性守卫：缺这个守卫在 Node 下不是「不画」，而是 ReferenceError 直接崩。
    if (typeof requestAnimationFrame !== 'function') {
      paintCard();
      return;
    }
    scheduleFrame();
  }

  return {
    /**
     * 整屏重渲染（低频）。★必须带上 onSensorChange：整屏渲染里那张罗盘卡的按钮
     * 是新建的 DOM，不传回调它就又是个死按钮。
     *
     * @returns {void}
     */
    rerender: () => renderSnapshot(root, snapshot, { onChange: onSensorChange }),
    /** 传感器回调（高频：只重画罗盘卡 + 合并）。 */
    onSensorChange,
  };
}

/**
 * 地理屏启动流程。
 *
 * 顺序（★不许调换，理由见每一步的注释）：
 *   ① 骨架（一口气建 10 个槽）→ ② 定位 / URL 指定地点 → ③ 页头 + 除底图外的所有卡
 *   → ④ 底图首次上屏 → ⑤ 离线则到此为止 → ⑥ elevation → ⑦ reverse（地名）
 *   → ⑧ 瓦片探测与三态裁决 → ⑨ 底图按裁决结果重画 + 横幅 + 溯源气泡。
 *
 * @returns {Promise<void>}
 */
export async function boot() {
  const root = typeof document !== 'undefined' && document ? document.getElementById('app') : null;
  if (!root) return;
  const bannerEl = typeof document !== 'undefined' && document ? document.getElementById('banner') : null;

  // 本轮轮次号：refresh() 会自增，让上一轮在飞结果回来后被丢弃
  const epoch = ++_epoch;

  applyI18n(document);
  resetHealth();
  watchShellUpdate();  // 任何页面都要能看见「有新版本」，见 shellupdate.js

  const snapshot = createSnapshot(null);
  // ★走 createCompassRenderer，不许退化成 renderSnapshot(root, snapshot)：
  //   后者会让罗盘卡的「启用方向传感器」按钮拿到空 onChange，点了零重渲染。
  const { rerender } = createCompassRenderer(root, snapshot);

  // ① 骨架 + 底图占位：槽位顺序在这一刻定死，晚建的卡会永久落到页面末尾
  renderSkeleton(root);
  renderMapSkeleton(root);
  renderHeader(root, snapshot);

  // ② URL 指定地点（收藏跳转 / 搜索结果）优先：用户已经明确选了这个地点，再去要一次
  //    系统定位既慢（最多 8 s）又是和用户意图对着干。
  const fromUrl = parsePlaceParam();
  const raw = fromUrl || (await getCurrentPosition({ timeoutMs: GEO_TIMEOUT_MS }));
  if (epoch !== _epoch) return;
  const { base, isDefaultPlace } = resolveCoord(raw, {
    defaultPlace: getDefaultPlace(),
    displayName: placeDisplayName,
  });
  if (fromUrl) log('coord from url param', base.lat, base.lon, base.name);

  snapshot.coord = { lat: base.lat, lon: base.lon };
  snapshot.altitudeM = Number.isFinite(Number(raw.altitudeM)) ? Number(raw.altitudeM) : null;
  snapshot.isDefaultPlace = isDefaultPlace;
  snapshot.placeName = typeof base.name === 'string' && base.name ? base.name : null;
  snapshot.atMs = Date.now();

  const res = computeAt(snapshot.coord, { altitudeM: snapshot.altitudeM, atMs: snapshot.atMs });
  snapshot.mag = res.mag;
  snapshot.error = res.error;

  // ③ 除底图外的所有卡一次上屏（磁偏角那几块是本机算的，断网也有数）
  rerender();

  // ④ 底图首次上屏（渲染发生在探测**之前**：先按当前已知的三态出图，探测结论回来再重画）
  try {
    renderMapCard(root, { coord: snapshot.coord });
  } catch (err) {
    log('map render failed', err && err.message);
  }

  // ⑤ 离线：不发任何请求。底图判 no-map（没网就是没瓦片，这是事实不是降级猜测）
  if (!isOnline()) {
    setNoMapMode(true);
    try {
      renderMapCard(root, { coord: snapshot.coord });
    } catch (err) {
      log('map render failed (offline)', err && err.message);
    }
    renderBanner(bannerEl, 'offline');
    return;
  }

  const ctx = { lat: snapshot.coord.lat, lon: snapshot.coord.lon };

  // ⑥ 海拔：地点卡的主体之一，失败只废这一行（卡里其余两行照常显示）
  await safePull(
    snapshot,
    'elevation',
    ctx,
    (data) => {
      snapshot.elevationM = data && data.elevationM !== undefined ? data.elevationM : null;
    },
    () => {
      renderPlaceCard(root, snapshot);
    }
  );
  if (epoch !== _epoch) return;

  // ⑦ 逆地理反查：地名进页头与地点卡，失败不影响其余内容
  await safePull(
    snapshot,
    'reverse',
    ctx,
    (data) => {
      if (data && data.placeName) snapshot.placeName = data.placeName;
    },
    () => {
      renderHeader(root, snapshot);
      renderPlaceCard(root, snapshot);
    }
  );
  if (epoch !== _epoch) return;

  // ⑧ 瓦片探测：不重试；模式由**整批**结果裁决（探一块时 grid 数学上不可达）
  try {
    const tiles = sampleTiles(snapshot.coord);
    const probes = await probeTileBatch('street', tiles, {
      count: TILE_PROBE_COUNT,
      budgetMs: TILE_PROBE_BUDGET_MS,
      shouldStop: () => epoch !== _epoch,
    });
    if (epoch !== _epoch) return;
    log('tile probes', probes.map((p) => (p.ok ? (p.fromCache ? 'ok(cache)' : 'ok') : 'fail')).join(' / '));
    if (probes.length >= 2) {
      degradeMapMode(probes);
    } else {
      log('tile probes too few to judge', String(probes.length));
    }
  } catch (err) {
    if (epoch !== _epoch) return;
    // 探测本身抛异常（无 probe 结果可裁决）→ 直接判无地图
    setNoMapMode(true);
    log('tile probe failed', err && err.message);
  }

  // ⑨ 底图按裁决后的三态重画 + 横幅 + 溯源
  try {
    renderMapCard(root, { coord: snapshot.coord });
  } catch (err) {
    log('map render failed (after probe)', err && err.message);
  }
  renderBanner(bannerEl, _bannerMode());
  renderProvenance(root, snapshot);
  // 传感器回调不需要在这里接线：`rerender()` 已经把 `onSensorChange` 交给罗盘卡了
  // （见 createCompassRenderer 的注释 —— 少了这一步，那颗「启用」按钮就是死的）。
}

// DOM 就绪后启动；非浏览器环境（Node 侧检查）不执行
if (typeof document !== 'undefined' && document !== null) {
  const start = () => {
    boot().catch((err) => log('compass boot failed', err && err.message));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
