/**
 * 此刻屏渲染（纯渲染层）
 *
 * 职责：把 NowSnapshot 转成 DOM。网络、缓存、健康判定全部在上游完成，本模块只做
 * 「数据 → 节点」，不发起任何请求，保证可离线单测。
 *
 * 渲染策略：骨架先上屏（不转圈等待网络），随后按 [weather → air → elevation] 顺序
 * 逐卡增量替换；reverse（地名）与瓦片探测在首屏渲染完成后后台补齐。
 * 降级原则：有任何陈旧数据就上屏并标注陈旧时长，**绝不显示空白**。
 */

import { t } from '../i18n/zh.js';
import * as fmt from '../core/format.js';
import { wmo, aqi, uv, windDir16, beaufort } from '../core/wmo.js';
import { isDaylight } from '../core/sun.js';
// 收藏状态读写走 store（唯一真相源）。依赖方向 ui → core，与 settings.js 一致。
import { isFavorite, addFavorite, removeFavorite } from '../core/store.js';

/** 收藏反馈文案的停留时长（毫秒）：给一眼就够，不长驻、不挡内容。 */
const FAV_HINT_MS = 2000;

/**
 * 把静态 HTML 里带 data-i18n 的占位节点替换成真实文案。
 *
 * 目的：HTML 外壳不硬编码任何中文，文案统一由 i18n/zh.js 提供（架构约定第 11 条）。
 *
 * @param {ParentNode} [root] 根节点，默认 document。
 * @returns {void}
 */
export function applyI18n(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
}

/**
 * 极简 DOM 构造器（零依赖替代 JSX / 模板引擎）。
 *
 * @param {string} tag 标签名。
 * @param {Object} [props] 属性表；class / text 有专门处理。
 * @param {Array<Node|string>|string} [children] 子节点。
 * @returns {HTMLElement} 元素。
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  Object.keys(props || {}).forEach((k) => {
    const v = props[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  });
  const list = typeof children === 'string' ? [children] : children || [];
  list.forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return el;
}

/**
 * 清空并写入容器。
 *
 * @param {HTMLElement} box 容器。
 * @param {Array<Node>} nodes 子节点。
 * @returns {void}
 */
function _fill(box, nodes) {
  if (!box) return;
  box.textContent = '';
  nodes.forEach((n) => n && box.appendChild(n));
}

/**
 * 取（或创建）卡片容器，保证增量渲染时位置稳定。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} id 卡片 id（不含 'card-' 前缀）。
 * @returns {HTMLElement} 容器元素。
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
 * @param {string} key 标签文案。
 * @param {string} value 值文案。
 * @param {string} [mod] 修饰类：'hot' | 'cold' | 'alert' | ''。
 * @returns {HTMLElement} kv-item。
 */
function _kv(key, value, mod = '') {
  return h('div', { class: 'kv-item' }, [
    h('span', { class: 'kv-k', text: key }),
    h('span', { class: mod ? `kv-v kv-v--${mod}` : 'kv-v', text: value }),
  ]);
}

/**
 * 状态徽标。
 *
 * @param {string} status 状态词：ok | stale | degraded | failed | offline | idle。
 * @returns {HTMLElement} chip。
 */
function _chip(status) {
  return h('span', { class: `chip chip--${status}` }, [
    h('span', { class: `badge badge--${status}` }),
    t(`status.${status}`),
  ]);
}

/* ------------------------------------------------------------------ */
/* 骨架屏                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染骨架屏（立即出，不转圈等待网络）。
 *
 * @param {HTMLElement} root 根容器。
 * @returns {void}
 */
export function renderSkeleton(root) {
  if (!root) return;
  root.textContent = '';

  root.appendChild(
    h('div', { class: 'hd' }, [
      h('div', {}, [h('h1', { class: 'hd-place', text: t('app.tagline') })]),
      h('div', { class: 'hd-time', text: t('app.loading') }),
    ])
  );
  root.appendChild(_slot(root, 'weather')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'air')).appendChild(h('div', { class: 'sk' }));
  root.appendChild(_slot(root, 'place')).appendChild(h('div', { class: 'sk' }));
  // 底图槽：这里**只建槽不填内容**，由 ui/map.js 的 renderMapSkeleton / renderMapCard 填充
  // （now.js 不 import map.js —— map.js 要用 now.js 的 h()，反方向依赖会成环）。
  // ★顺序必须在 prov 之前建：槽位顺序由首次创建那一刻决定，建错位置就再也挪不回去。
  root.appendChild(_slot(root, 'map'));
  root.appendChild(_slot(root, 'prov'));
}

/* ------------------------------------------------------------------ */
/* 降级横幅                                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染顶部降级横幅。
 *
 * @param {HTMLElement} bannerEl 横幅容器。
 * @param {'live'|'stale'|'partial'|'grid'|'offline'|'no-map'|'empty'} mode 整体降级态。
 * @param {{staleAgeMs?:number}} [extra] 附加信息。
 * @returns {void}
 */
export function renderBanner(bannerEl, mode, extra = {}) {
  if (!bannerEl) return;
  if (!mode || mode === 'live') {
    bannerEl.hidden = true;
    bannerEl.textContent = '';
    return;
  }
  bannerEl.hidden = false;
  // 变体名直接由 mode 拼出：grid → .banner--grid，因此 app.css 必须为
  // renderBanner 能拿到的每个 mode 都备一条 .banner--* 规则，否则样式会静默退回基础横幅。
  bannerEl.className = `banner banner--${mode}`;
  // 徽点只有 offline / stale 两色。grid 与 partial 都复用琥珀点（--c-state-stale）：
  // 三者同属「降级」语义，不必为每种降级配一个色值；真正区分它们的是横幅底色与文案。
  const nodes = [h('span', { class: `badge badge--${mode === 'offline' ? 'offline' : 'stale'}` })];
  nodes.push(h('span', { text: t(`mode.${mode}`) }));
  if (extra.staleAgeMs && extra.staleAgeMs > 0) {
    nodes.push(h('span', { class: 'num', text: `（${fmt.staleFor(extra.staleAgeMs)}）` }));
  }
  _fill(bannerEl, nodes);
}

/* ------------------------------------------------------------------ */
/* 顶部标题                                                             */
/* ------------------------------------------------------------------ */

/**
 * 收藏按钮（toggle：已收藏再点一次就是取消）。
 *
 * 三件事必须同时成立，缺一个这颗按钮就是死的：
 *   1) **状态从 store 读**（isFavorite），不是从上次渲染的记忆里读 —— 标题区会被
 *      renderHeader 整槽重建多次，靠记忆会与 store 漂移；
 *   2) **点了就地翻转**（改文案 / 改配色 / 改 aria-pressed），用户立刻看得见；
 *   3) **aria-pressed** 跟着状态走，读屏软件才知道这是开关而不是普通按钮。
 *
 * 配色两态复用既有的 `.btn`（未收藏）与 `.btn--primary`（已收藏）—— 这两条规则的
 * 白字/实心底组合已经过 tools/contrast-audit.mjs，不新增任何 color 声明。
 *
 * @param {{lat:number, lon:number, name:string}} place 要收藏的地点。
 * @returns {HTMLElement} 按钮容器（按钮 + 行内反馈）。
 */
function _favButton(place) {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  const name = String(place.name || '');

  const btn = h('button', { type: 'button', class: 'btn fav-btn' });
  // 反馈位用「有没有字」表示显隐，不用 hidden 属性：整槽重建后属性容易被落下，
  // 空 span 本来就不占版面，比一个可能卡住的 hidden 更省心。
  const hint = h('span', { class: 'hd-hint' });
  /** @type {any} 反馈计时器（浏览器给 number，Node 给 Timeout 对象）。 */
  let timer = null;

  /** 把按钮刷成当前收藏态。 */
  const sync = () => {
    const on = isFavorite(lat, lon);
    btn.className = on ? 'btn btn--primary fav-btn fav-btn--on' : 'btn fav-btn';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = on ? `★ ${t('fav.added')}` : `☆ ${t('fav.add')}`;
  };
  sync();

  btn.addEventListener('click', () => {
    const was = isFavorite(lat, lon);
    // toggle：已收藏 → 取消；未收藏 → 存进来。removeFavorite 的返回值区分
    // 「删掉了」与「本来就没有」，但按钮只按**最新**状态刷新，所以两种情况
    // 都会收敛到「未收藏」，不需要分支。
    if (was) removeFavorite(lat, lon);
    else addFavorite({ lat, lon, name });
    sync();

    hint.textContent = was ? t('fav.removedHint') : t('fav.addedHint');
    if (timer) clearTimeout(timer);
    // 用完就清成空串 —— 反馈不该常驻，它只是确认「这次点击生效了」
    timer = setTimeout(() => {
      hint.textContent = '';
    }, FAV_HINT_MS);
    // Node 侧（测试）挂着这个定时器会把进程多吊 2 s；浏览器返回的是数字，没有 unref。
    if (timer && typeof timer.unref === 'function') timer.unref();
  });

  return h('div', { class: 'hd-fav' }, [btn, hint]);
}

/**
 * 渲染标题区（地点名 + 坐标 + 观测时刻 + 收藏按钮）。
 *
 * 整槽替换（_fill）会重建 .hd 里的全部节点，所以按钮上的 click 监听不会重复绑定 ——
 * 每次渲染都是一颗新按钮，状态也顺带从 store 重新读一遍。
 *
 * 无坐标时不给收藏按钮：store 的收藏以 lat+lon 为身份，没有坐标就存不出一条
 * 能跳回去的收藏，放一颗点了没反应的按钮比不放更糟。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @param {{isDefaultPlace?:boolean}} [opts] 选项。
 * @returns {void}
 */
export function renderHeader(root, snapshot, opts = {}) {
  const hd = root.querySelector('.hd');
  if (!hd) return;
  const placeName = snapshot.placeName || (snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.unknown'));
  const right = snapshot.atMs ? t('now.observeAt', { time: fmt.hhmm(snapshot.atMs, snapshot.weather && snapshot.weather.tzOffsetSec ? snapshot.weather.tzOffsetSec : 0) }) : t('app.loading');
  // 收藏的是**当前显示的地点**：坐标取 snapshot.coord，名字优先用反查出来的地名
  // （coord 自带的 name 只在收藏跳转 / 默认地点这类已知名字的场景下存在）。
  const favPlace = snapshot.coord
    ? { lat: snapshot.coord.lat, lon: snapshot.coord.lon, name: snapshot.placeName || snapshot.coord.name || '' }
    : null;

  _fill(hd, [
    h('div', {}, [
      h('h1', { class: 'hd-place', text: placeName }),
      h('p', { class: 'hd-coord num', text: snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.dash') }),
      opts.isDefaultPlace ? h('p', { class: 'hd-coord', text: t('now.defaultPlaceNotice') }) : null,
      favPlace ? _favButton(favPlace) : null,
    ]),
    h('div', { class: 'hd-time', text: right }),
  ]);
}

/* ------------------------------------------------------------------ */
/* 天气卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染天气卡（首屏第一张，出数即上屏）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderWeatherCard(root, snapshot) {
  const w = snapshot.weather;
  const box = _slot(root, 'weather');
  if (!w) {
    _fill(box, [_emptyCard(t('mode.empty'))]);
    return;
  }

  const tzOffset = Number(w.tzOffsetSec) || 0;
  const day = snapshot.atMs
    ? isDaylight(snapshot.atMs, snapshot.coord || { lat: 0, lon: 0 })
    : true;
  const desc = wmo(w.wmoCode, day);
  const wind = windDir16(w.windDeg);
  const bf = beaufort(w.windMs);
  const uvInfo = uv(w.uvMax);

  // 大数字走等宽数字，单位单独小字，避免「23°°C」重复单位
  const tempNode = h('div', { class: 'hero-temp' }, [
    fmt.num(w.tempC, 0),
    h('span', { class: 'unit', text: t('w.unitC') }),
  ]);

  const kvGrid = h('div', { class: 'kv' }, [
    _kv(t('w.feels'), fmt.tempC(w.feelsC)),
    _kv(t('w.humidity'), fmt.humidity(w.humidityPct)),
    _kv(t('w.precip'), fmt.precipMm(w.precipMm)),
    _kv(t('w.wind'), `${fmt.num(w.windMs, 1, 'm/s')} · ${wind.zh}`),
    _kv(t('w.pressure'), fmt.pressure(w.pressureHpa)),
    _kv(t('w.visibility'), fmt.visibility(w.visibilityM)),
    _kv(t('w.sunrise'), fmt.hhmm(w.sunriseAt, tzOffset)),
    _kv(t('w.sunset'), fmt.hhmm(w.sunsetAt, tzOffset)),
    _kv(t('w.dayLength'), w.sunriseAt && w.sunsetAt ? fmt.duration(w.sunsetAt - w.sunriseAt) : t('app.dash')),
    // UV：缺失仍显示占位符「—」；有值时用 displayValue（钳制负值，避免显示「低 · -3」）
    _kv(
      t('w.uv'),
      w.uvMax === null || w.uvMax === undefined
        ? fmt.num(w.uvMax, 0)
        : `${fmt.num(uvInfo.displayValue, 0)}（${uvInfo.zh}）`
    ),
    _kv(t('w.todayMax'), fmt.tempC(w.todayMaxC)),
    _kv(t('w.todayMin'), fmt.tempC(w.todayMinC)),
  ]);

  _fill(box, [
    h('div', { class: 'card card--hero' }, [
      h('p', { class: 'card-title', text: t('card.weather') }),
      h('div', { class: 'hero' }, [
        tempNode,
        h('div', { class: 'hero-desc' }, [
          h('span', { class: 'hero-wmo', text: `${desc.icon} ${desc.zh}` }),
          h('span', { class: 'hero-sub', text: `${t('w.feels')} ${fmt.tempC(w.feelsC)} · ${t('w.beaufortLevel', { zh: bf.zh, level: bf.level })}` }),
          h('span', { class: 'hero-sub', text: uvInfo.advice }),
        ]),
      ]),
      kvGrid,
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 空气卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染空气质量卡。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderAirCard(root, snapshot) {
  const a = snapshot.air;
  const box = _slot(root, 'air');
  if (!a || a.europeanAqi === null) {
    _fill(box, [_emptyCard(t('app.na'))]);
    return;
  }
  const info = aqi(a.europeanAqi);
  _fill(box, [
    h('div', { class: 'card' }, [
      h('div', { class: 'card--row' }, [
        h('p', { class: 'card-title', text: t('card.air') }),
        // AQI 用 displayValue（钳制负值），避免出现「优 · AQI -10」这类自相矛盾文案
        h('span', { class: `chip chip--${info.level === 'good' || info.level === 'fair' ? 'ok' : info.level === 'extreme' ? 'failed' : 'stale'}`, text: `${info.zh} · AQI ${info.displayValue}` }),
      ]),
      h('div', { class: 'kv' }, [
        _kv(t('w.pm10'), fmt.pollutant(a.pm10)),
        _kv(t('w.pm25'), fmt.pollutant(a.pm25)),
        _kv(t('w.ozone'), fmt.pollutant(a.ozone)),
        _kv(t('w.no2'), fmt.pollutant(a.no2)),
      ]),
      h('p', { class: 'card-title', text: info.advice }),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 位置卡                                                               */
/* ------------------------------------------------------------------ */

/**
 * 渲染位置卡（海拔 / 坐标 / 地名）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderPlaceCard(root, snapshot) {
  const box = _slot(root, 'place');
  const hasAny = snapshot.elevationM !== null || snapshot.placeName || snapshot.coord;
  if (!hasAny) {
    _fill(box, [_emptyCard(t('app.na'))]);
    return;
  }
  _fill(box, [
    h('div', { class: 'card' }, [
      h('p', { class: 'card-title', text: t('card.place') }),
      h('div', { class: 'kv' }, [
        _kv(t('w.elevation'), fmt.elevationM(snapshot.elevationM)),
        _kv(t('w.coord'), snapshot.coord ? fmt.coord(snapshot.coord.lat, snapshot.coord.lon) : t('app.dash')),
        snapshot.placeName ? _kv(t('card.place'), snapshot.placeName) : null,
      ].filter(Boolean)),
    ]),
  ]);
}

/* ------------------------------------------------------------------ */
/* 溯源气泡                                                             */
/* ------------------------------------------------------------------ */

/**
 * 渲染溯源气泡（每条来源一个胶囊：源名 / 时延 / URL）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @returns {void}
 */
export function renderProvenance(root, snapshot) {
  const box = _slot(root, 'prov');
  const list = Array.isArray(snapshot.provenance) ? snapshot.provenance : [];
  if (list.length === 0) {
    box.textContent = '';
    return;
  }
  const chips = list.map((p) =>
    h('span', { class: 'prov-item', title: `${p.label} · ${p.attribution}` }, [
      h('span', { class: `badge badge--${p.state === 'stale' ? 'stale' : 'ok'}` }),
      h('span', { text: p.label }),
      h('span', { class: 'num', text: fmt.latency(p.latencyMs) }),
      h('span', { class: 'prov-url', text: _shortUrl(p.url) }),
    ])
  );
  _fill(box, [h('p', { class: 'card-title', text: t('card.provenance') }), h('div', { class: 'prov' }, chips)]);
}

/**
 * URL 缩短（只保留协议+宿主+路径首段，避免溯源气泡撑破布局）。
 *
 * @param {string} url 完整 URL。
 * @returns {string} 短 URL。
 */
function _shortUrl(url) {
  try {
    const u = new URL(String(url));
    const seg = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return `${u.host}/${seg}`;
  } catch (err) {
    return String(url || '').slice(0, 48);
  }
}

/* ------------------------------------------------------------------ */
/* 空态 / 离线态                                                        */
/* ------------------------------------------------------------------ */

/**
 * 空态卡（文案 + 重试按钮，**不转圈**）。
 *
 * @param {string} text 提示文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {HTMLElement} 空态节点。
 */
function _emptyCard(text, onRetry) {
  const nodes = [h('span', { text })];
  if (typeof onRetry === 'function') {
    const btn = h('button', { class: 'btn btn--primary', type: 'button', text: t('app.retry') });
    btn.addEventListener('click', onRetry);
    nodes.push(btn);
  }
  return h('div', { class: 'empty' }, nodes);
}

/**
 * 渲染整屏空态（离线且无缓存时）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} text 文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {void}
 */
export function renderEmptyState(root, text, onRetry) {
  if (!root) return;
  root.textContent = '';
  root.appendChild(_emptyCard(text, onRetry));
}

/**
 * 把指定卡片槽位渲染成「失败 / 空 + 重试」态。
 *
 * 用途：单路源抛异常时只废掉这一张卡，其余卡片继续渲染，用户不会看到永久骨架屏。
 *
 * @param {HTMLElement} root 根容器。
 * @param {string} slotId 槽位 id（'weather' | 'air' | 'place'）。
 * @param {string} text 提示文案。
 * @param {() => void} [onRetry] 重试回调。
 * @returns {void}
 */
export function renderSlotEmpty(root, slotId, text, onRetry) {
  const box = _slot(root, slotId);
  _fill(box, [_emptyCard(text, onRetry)]);
}

/**
 * 一次性完整渲染（离线读缓存快照时走此路径）。
 *
 * @param {HTMLElement} root 根容器。
 * @param {Object} snapshot NowSnapshot。
 * @param {{isDefaultPlace?:boolean, staleAgeMs?:number}} [opts] 选项。
 * @returns {void}
 */
export function renderSnapshot(root, snapshot, opts = {}) {
  renderSkeleton(root);
  renderHeader(root, snapshot, opts);
  renderWeatherCard(root, snapshot);
  renderAirCard(root, snapshot);
  renderPlaceCard(root, snapshot);
  renderProvenance(root, snapshot);
}
