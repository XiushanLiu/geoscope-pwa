/**
 * 方位屏渲染与装配（磁偏角 WMM2025 + 罗盘）
 *
 * 职责：把「本机算出来的地磁要素」变成 DOM。网络、定位、传感器状态全部在上游完成，
 * 本模块只做「数据 → 节点」；模型计算走 `src/data/wmm2025.js`（本地系数、不发请求），
 * 所以本屏**断网可用** —— 这是它与此刻屏最大的区别。
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
 * 依赖方向：ui ← data（`wmm2025.js`）/ core（`mag.js` `geo.js` `format.js` `store.js`）。
 * 顶层只碰两处 DOM —— 主题引导（把 themeMode 写到 <html data-theme>）与字号档位引导
 * （把 fontScale 写到 <html data-fs>），两者都是全站属性，见 `theme.js`；
 * 其余 DOM 访问都在 boot / render 内，便于 Node 侧检查与单测。
 */

import { t } from '../i18n/index.js';
import * as fmt from '../core/format.js';
import {
  getThemeMode,
  getFontScale,
  getLocale,
  log,
} from '../core/store.js';
import { getCurrentPosition } from '../core/geo.js';
import { computeGeomagnetic, WMM_MODEL } from '../data/wmm2025.js';
import {
  decimalYearFromDate,
  trueBearingFromMagnetic,
  magneticBearingFromTrue,
  normalizeSignedAngle,
  normalizeBearing,
} from '../core/mag.js';
import { h, applyI18n } from './now.js';
import { applyThemeMode, applyFontScale } from './theme.js';
// 语言引导：与主题 / 字号同构，本页入口必须在 module 求值那一刻就切好 i18n
// （四个独立 HTML、靠 <a href> 跳转，没有共享 bootstrap，谁也不能替谁写）。
import { applyLocale } from './locale.js';

// ★主题引导（模块顶层）：本页是四个入口之一，必须在 module 求值那一刻就把 store 里的
// themeMode 写到 <html data-theme> 上，不能等 boot() —— 否则用户会先看到一帧系统色。
// 实现与四组合语义见 ui/theme.js 文件头。
applyThemeMode(getThemeMode());
// ★字号档位引导（模块顶层，与主题同一时机）：字号是全站属性，本页那个大号磁偏角
// 与一堆要素数字同样要跟着放大档走。乘数在 styles/tokens.css，这里只落属性。
applyFontScale(getFontScale());
applyLocale(getLocale());

/** 定位超时（毫秒）：与此刻屏一致，超时即降级为默认地点，不阻塞渲染。 */
const GEO_TIMEOUT_MS = 8000;

/**
 * 传感器等待上限（毫秒）。
 *
 * 桌面浏览器（以及部分安卓 WebView）定义了 `DeviceOrientationEvent` 却永远不派发数据，
 * 挂上监听后界面会一直停在「等待中」。这里给一个上限：超时还没收到第一条有效数据就
 * 判定为「本机无方向传感器」并降级，绝不让用户对着一个空指针等下去。
 */
const SENSOR_WAIT_MS = 2500;

/** 磁偏角小于这个度数就读成「正北（不偏）」（度）。 */
const DECLINATION_FLAT_EPS = 0.05;

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
 * 磁偏角的**读法**（不是数字）：东偏为正，负数要读成「西偏 N°」。
 *
 * @param {number|null} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {string} 如「西偏 7.49°」；缺失返回占位符。
 */
export function declinationText(declinationDeg) {
  if (declinationDeg === null || declinationDeg === undefined || !Number.isFinite(Number(declinationDeg))) {
    return t('app.dash');
  }
  const d = normalizeSignedAngle(Number(declinationDeg));
  if (Math.abs(d) < DECLINATION_FLAT_EPS) return t('compass.noDeclination');
  const abs = fmt.num(Math.abs(d), 2);
  return d > 0 ? t('compass.east', { deg: abs }) : t('compass.west', { deg: abs });
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
  _sensor.state = 'waiting';
  // 桌面内核常「定义了事件却永远不派发」→ 到点没数据就判定无传感器，降级而非空等
  _sensor.timer = setTimeout(() => {
    _sensor.timer = null;
    if (_sensor.headingMagDeg === null) {
      _sensor.state = 'unsupported';
      if (typeof onChange === 'function') onChange();
    }
  }, SENSOR_WAIT_MS);
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
 * 渲染标题区（地点 / 坐标 / 默认地点提示）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @returns {void}
 */
export function renderHeader(root, snapshot) {
  const hd = root.querySelector('.hd');
  if (!hd) return;
  const placeName = snapshot.coord
    ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon)
    : t('app.unknown');
  _fill(hd, [
    h('div', {}, [
      h('h1', { class: 'hd-place', text: t('compass.title') }),
      h('p', { class: 'hd-coord num', text: placeName }),
      snapshot.isDefaultPlace ? h('p', { class: 'hd-coord', text: t('compass.defaultPlaceNotice') }) : null,
    ]),
    h('div', { class: 'hd-time', text: t('compass.subtitle') }),
  ]);
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
        _kv(
          t('card.magnetic'),
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
    const nodes = [
      title,
      _dial(headingMag, Number.isFinite(Number(decl)) ? Number(decl) : 0),
      h('p', { class: 'compass-heading num', text: t('compass.headingMag', { deg: fmt.num(headingMag, 0) }) }),
    ];
    if (Number.isFinite(Number(decl))) {
      nodes.push(
        h('p', {
          class: 'compass-heading num',
          text: t('compass.headingTrue', { deg: fmt.num(convertMagToTrue(headingMag, Number(decl)), 0) }),
        })
      );
    }
    nodes.push(h('p', { class: 'card-note', text: t('compass.compassNote') }));
    _fill(box, [h('div', { class: 'card' }, nodes)]);
    return;
  }

  // 先看「有没有」再看「开没开」：本机压根没有方向传感器时（含 Node 侧与桌面内核），
  // 直接说「本机无方向传感器」，而不是「未启用」—— 后者会让人以为点一下就有。
  const support = sensorSupport();
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
  const canAsk = support !== 'unsupported' && _sensor.state !== 'waiting';
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
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderSkeleton(root) {
  if (!root) return;
  root.textContent = '';
  root.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [h('h1', { class: 'hd-place', text: t('compass.title') })]),
      h('div', { class: 'hd-time', text: t('app.loading') }),
    ])
  );
  root.appendChild(_slot(root, 'declination')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'model'));
  root.appendChild(_slot(root, 'convert'));
  root.appendChild(_slot(root, 'compass'));
}

/**
 * 一次性完整渲染。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot 方位屏状态。
 * @param {{onChange?:() => void}} [opts] 选项。
 * @returns {void}
 */
export function renderSnapshot(root, snapshot, opts = {}) {
  if (!root) return;
  if (!root.querySelector('.hd')) renderSkeleton(root);
  renderHeader(root, snapshot);
  renderDeclinationCard(root, snapshot);
  renderModelCard(root, snapshot);
  renderConvertCard(root, snapshot);
  renderCompassCard(root, snapshot, opts);
}

/**
 * 构造一份空状态（字段齐全，避免渲染时到处判空）。
 *
 * @param {{lat:number, lon:number}|null} coord 坐标。
 * @param {{altitudeM?:number|null, isDefaultPlace?:boolean, atMs?:number}} [opts] 附加字段。
 * @returns {Object} 状态对象。
 */
export function createSnapshot(coord, opts = {}) {
  return {
    coord: coord ? { lat: Number(coord.lat), lon: Number(coord.lon) } : null,
    altitudeM: Number.isFinite(Number(opts.altitudeM)) ? Number(opts.altitudeM) : null,
    isDefaultPlace: opts.isDefaultPlace === true,
    atMs: Number(opts.atMs) || Date.now(),
    mag: null,
    error: null,
  };
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
 * 方位屏启动流程。
 *
 * @returns {Promise<void>}
 */
export async function boot() {
  const root = typeof document !== 'undefined' && document ? document.getElementById('app') : null;
  if (!root) return;

  applyI18n(document);

  const snapshot = createSnapshot(null);
  // ★走 createCompassRenderer，不许退化成 renderSnapshot(root, snapshot)：
  //   后者会让罗盘卡的「启用方向传感器」按钮拿到空 onChange，点了零重渲染。
  const { rerender } = createCompassRenderer(root, snapshot);
  rerender();

  const coord = await getCurrentPosition({ timeoutMs: GEO_TIMEOUT_MS });

  snapshot.coord = { lat: coord.lat, lon: coord.lon };
  snapshot.altitudeM = Number.isFinite(Number(coord.altitudeM)) ? Number(coord.altitudeM) : null;
  // ★只认 `source === 'default'`，不能写成 `coord.source !== 'gps'`：
  // 方位页的 coord 今天只来自 geo.js（'gps' / 'default' 两种），两种写法**恰好**等价；
  // 但那靠的是「没有第三个 source」，不是靠写法本身成立。哪天给方位页加
  // 「收藏地 / 搜索地从这里看磁偏角」（source:'explicit'，很自然的下一步），`!== 'gps'`
  // 会立刻把它判成「未取得定位，正在显示默认地点」—— 一句假话，且没有测试拦得住。
  // 与 app.js 的 resolveCoord() 同口径（那里也是 `base.source === 'default'`）。
  snapshot.isDefaultPlace = coord.source === 'default';
  snapshot.atMs = Date.now();

  const res = computeAt(snapshot.coord, { altitudeM: snapshot.altitudeM, atMs: snapshot.atMs });
  snapshot.mag = res.mag;
  snapshot.error = res.error;

  rerender();
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
