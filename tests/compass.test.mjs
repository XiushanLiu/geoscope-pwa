/**
 * 方位屏（`src/ui/compass.js` + `compass.html`）的行为契约。
 *
 * 压住五件必测的事（数值来自 WMM2025 官方测试值口径，不是拍脑袋定的）：
 *   ① 北京 2025 → D ≈ −7.49°（负 = 西偏）、I ≈ 59.31°、F ≈ 54895 nT；
 *   ② 超期年份（2035）**仍返回数值**，但 level='error' / expired=true / overshootYears≈5；
 *   ③ 真 ↔ 磁方位换算严格互逆；
 *   ④ 无方向传感器时降级（给出降级文案），绝不白屏；
 *   ⑤ 米 → 千米换算正确（WMM 要千米，项目通用海拔是米）。
 *
 * 另外压住两条红线：
 *   - 界面不得出现任何「精度 / 误差 ±X°」字样（模型不导出不确定度，写了就是编的）；
 *   - 不得直接渲染 `warning` 原文（那是非 UI 层的中文串，上屏文案必须走 i18n）。
 *
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs。
 */

import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createFakeDom, installNavigator, installStorage, FakeStorage, text } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true, userAgent: 'QA-FakeBrowser/1.0' });
const dom = createFakeDom([{ id: 'app' }, { id: 'banner' }]);
// 置为 loading：避免 compass.js 顶层自启动，用例里显式 boot()
dom.document.readyState = 'loading';

const compass = await import('../src/ui/compass.js');
const { WMM_MODEL } = await import('../src/data/wmm2025.js');
const { normalizeSignedAngle } = await import('../src/core/mag.js');
const { t } = await import('../src/i18n/index.js');
const fmt = await import('../src/core/format.js');

/** 北京天安门（WGS84），与 geo.js 的 DEFAULT_PLACE 一致。 */
const BEIJING = { lat: 39.9087, lon: 116.3975 };

/** 十进制年 2025.0 整（UTC 元旦），与官方测试值口径一致。 */
const AT_2025 = Date.UTC(2025, 0, 1);

/** 十进制年 2035.0 整：超出 WMM2025 有效期（至 2030.0）5 年。 */
const AT_2035 = Date.UTC(2035, 0, 1);

/**
 * 造一份已算好的方位屏状态。
 *
 * @param {number} atMs 计算时刻。
 * @param {{lat:number,lon:number}} [coord] 坐标。
 * @returns {Object} snapshot。
 */
function snapshotAt(atMs, coord = BEIJING) {
  const snapshot = compass.createSnapshot(coord, { atMs });
  const res = compass.computeAt(coord, { altitudeM: 0, atMs });
  snapshot.mag = res.mag;
  snapshot.error = res.error;
  return snapshot;
}

beforeEach(() => {
  compass.resetSensor();
});

test('北京 2025：D ≈ −7.49°（西偏）、I ≈ 59.31°、F ≈ 54895 nT', () => {
  const res = compass.computeAt(BEIJING, { altitudeM: 0, atMs: AT_2025 });
  assert.equal(res.error, null, '北京这组入参不该抛异常');
  assert.ok(res.mag, '必须算出结果');

  // 官方值：D = -7.49°、I = 59.31°、F = 54895 nT（H = 28015 nT 一并压住）
  assert.ok(Math.abs(res.mag.declination - -7.49) < 0.02, `D 应 ≈ −7.49°，实际 ${res.mag.declination}`);
  assert.ok(Math.abs(res.mag.inclination - 59.31) < 0.02, `I 应 ≈ 59.31°，实际 ${res.mag.inclination}`);
  assert.ok(Math.abs(res.mag.total - 54895) < 5, `F 应 ≈ 54895 nT，实际 ${res.mag.total}`);
  assert.ok(Math.abs(res.mag.horizontal - 28015) < 10, `H 应 ≈ 28015 nT，实际 ${res.mag.horizontal}`);

  // 东偏为正，负值必须读成「西偏」，不能直愣愣显示 -7.49°
  assert.equal(compass.declinationText(res.mag.declination), '西偏 7.49°');
  assert.equal(compass.declinationText(7.49), '东偏 7.49°');
  assert.equal(compass.declinationText(0.01), t('compass.noDeclination'));
  assert.equal(compass.declinationText(null), '—');
});

test('超期年份（2035）：仍返回数值，level=error / expired=true / overshoot≈5', () => {
  const res = compass.computeAt(BEIJING, { altitudeM: 0, atMs: AT_2035 });
  assert.ok(res.mag, '超期也必须算出结果 —— 用户此时仍需要一个近似值');
  assert.equal(res.mag.expired, true);
  assert.equal(res.mag.ahead, false);
  assert.equal(res.mag.level, 'error');
  assert.ok(Math.abs(res.mag.overshootYears - 5) < 0.01, `overshoot 应 ≈ 5，实际 ${res.mag.overshootYears}`);
  assert.ok(Number.isFinite(res.mag.declination), '超期不得返回 NaN');
  // 数值确实随年份外推变化了（不是悄悄退回历元值）
  const base = compass.computeAt(BEIJING, { altitudeM: 0, atMs: AT_2025 });
  assert.notEqual(res.mag.declination, base.mag.declination);
});

test('超期时数值照常上屏，只把卡挂告警态（且不渲染 warning 原文）', () => {
  const snapshot = snapshotAt(AT_2035);
  compass.renderSnapshot(dom.byId.app, snapshot);
  const txt = text(dom.byId.app);

  // ① 数字还在（不是被隐藏成「—」）
  assert.ok(txt.includes('-7.87'), `超期也要显示磁偏角数值，实际文本：${txt.slice(0, 120)}`);
  assert.ok(txt.includes('西偏 7.87°'), '读法也要照常给');

  // ② 但这张卡必须挂上告警态，不能和有效期内长得一样可信
  const alertCards = dom.byId.app.querySelectorAll('.card--alert');
  assert.equal(alertCards.length, 1, '超期时磁偏角卡必须挂 .card--alert');
  assert.ok(
    dom.byId.app.querySelectorAll('.chip--failed').length >= 1,
    '超期提示必须走 .chip--failed（状态色作填充，不作文字色）'
  );

  // ③ 不得把非 UI 层的 warning 原文直接搬上屏
  assert.ok(snapshot.mag.warning, '模型确实产出了 warning 原文（用于确认这条断言不是空跑）');
  assert.ok(!txt.includes(snapshot.mag.warning), 'warning 是非 UI 层中文串，必须由 t() 自拼文案，不得直出');
  assert.ok(txt.includes(t('compass.modelExpired', { years: '5.0' })), '应显示自拼的超期提示');
});

test('有效期内不挂告警态，给出距失效年数', () => {
  const snapshot = snapshotAt(AT_2025);
  const status = compass.modelStatus(snapshot.mag);
  assert.equal(status.level, 'ok');
  assert.equal(status.chip, 'ok');
  assert.equal(status.text, t('compass.modelLeft', { years: '5.0' }));

  compass.renderSnapshot(dom.byId.app, snapshot);
  assert.equal(dom.byId.app.querySelectorAll('.card--alert').length, 0, '有效期内不得挂告警态');
});

test('真 ↔ 磁方位换算严格互逆（东偏为正，返回值归一到 [0,360)）', () => {
  const declinations = [-7.49, 0, 12.3, 90, 179.9, -180];
  const bearings = [0, 45, 180, 270, 359, 360, -30];
  for (const decl of declinations) {
    for (const bearing of bearings) {
      const mag = compass.convertTrueToMag(bearing, decl);
      const back = compass.convertMagToTrue(mag, decl);
      assert.ok(mag >= 0 && mag < 360, `磁方位必须归一到 [0,360)，实际 ${mag}`);
      assert.ok(
        Math.abs(normalizeSignedAngle(back - bearing)) < 1e-9,
        `真→磁→真 不闭合：${bearing} → ${mag} → ${back}（D=${decl}）`
      );
      // 反向同样成立
      const tru = compass.convertMagToTrue(bearing, decl);
      const back2 = compass.convertTrueToMag(tru, decl);
      assert.ok(
        Math.abs(normalizeSignedAngle(back2 - bearing)) < 1e-9,
        `磁→真→磁 不闭合：${bearing} → ${tru} → ${back2}（D=${decl}）`
      );
    }
  }
  assert.equal(compass.convertTrueToMag('abc', 1), null, '非数字入参返回 null，不产生 NaN');
  assert.equal(compass.convertMagToTrue(null, 1), null);
});

test('换算卡：手动输入双向可用，非法输入给提示而不是 NaN', async () => {
  const snapshot = snapshotAt(AT_2025);
  compass.renderSnapshot(dom.byId.app, snapshot);

  const inputs = dom.byId.app.querySelectorAll('.compass-input');
  assert.equal(inputs.length, 2, '应有两行输入：真→磁 与 磁→真');

  // 第一行：输入真方位 45° → 出磁方位 = 45 − (−7.49) = 52.49°
  inputs[0].value = '45';
  await inputs[0].fire('input');
  const outs = dom.byId.app.querySelectorAll('.compass-out');
  assert.equal(outs[0].textContent, '52.5°', `真 45° → 磁应 ≈ 52.5°，实际 ${outs[0].textContent}`);

  // 第二行：输入磁方位 52.49° → 出真方位 45°
  inputs[1].value = '52.49';
  await inputs[1].fire('input');
  assert.equal(outs[1].textContent, '45.0°', `磁 52.49° → 真应 ≈ 45.0°，实际 ${outs[1].textContent}`);

  // 非法输入：给提示，绝不显示 NaN
  inputs[0].value = 'abc';
  await inputs[0].fire('input');
  assert.equal(outs[0].textContent, t('compass.inputInvalid'));
});

test('无方向传感器：降级文案到位且不白屏（含端到端 boot）', async () => {
  // Node 侧没有 window → sensorSupport() = 'unsupported'，正好是「桌面 / 无传感器」这条路径
  assert.equal(compass.sensorSupport(), 'unsupported');

  const snapshot = snapshotAt(AT_2025);
  compass.renderSnapshot(dom.byId.app, snapshot);
  const txt = text(dom.byId.app);

  assert.ok(txt.includes(t('compass.sensorUnsupported')), `必须给出降级文案，实际：${txt.slice(0, 200)}`);
  assert.ok(txt.includes('西偏'), '降级时计算值照常显示 —— 不是白屏');
  assert.ok(txt.length > 100, '降级态必须有实质内容');
  // 没有传感器就不该摆一个点不动的按钮。
  // ★2026-10-17：地理页扩了槽位之后，页面上本来就有别的两颗 .btn（页头的搜索放大镜、
  //   方位卡里那颗进完整罗盘的锚点），所以这里不能数 `.btn` 的总数 —— 数总数会把
  //   「多了一颗搜索按钮」误报成「无传感器却给了启用按钮」。只钉启用按钮本身。
  const enableBtns = dom.byId.app
    .querySelectorAll('.btn')
    .filter((n) => text(n).includes(t('compass.sensorEnable')));
  assert.equal(enableBtns.length, 0, '无传感器时不该给「启用方向传感器」按钮');

  // 端到端：boot() 走完定位降级（无 geolocation → 默认地点）也必须出内容
  await compass.boot();
  const bootTxt = text(dom.byId.app);
  assert.ok(bootTxt.includes('西偏'), 'boot() 后必须显示磁偏角');
  assert.ok(bootTxt.includes(t('compass.defaultPlaceNotice')), '默认地点必须给出说明');
});

test('有方向传感器：挂上监听并收到数据后才画指针盘（磁北 + 真北两支针）', () => {
  /** 极简 window 替身：只实现 compass.js 真正用到的那三个入口。 */
  const listeners = new Map();
  globalThis.window = {
    DeviceOrientationEvent: function DeviceOrientationEvent() {},
    addEventListener: (type, fn) => listeners.set(String(type), fn),
    removeEventListener: () => {},
  };
  try {
    assert.equal(compass.sensorSupport(), 'available');
    compass.resetSensor();

    const snapshot = snapshotAt(AT_2025);
    compass.enableSensor(() => compass.renderSnapshot(dom.byId.app, snapshot));
    assert.equal(compass.sensorState().state, 'waiting', '刚挂上监听时应为等待态');

    const handler = listeners.get('deviceorientation');
    assert.ok(handler, '必须挂上 deviceorientation 监听');
    // iOS 的 webkitCompassHeading 已经是磁方位
    handler({ webkitCompassHeading: 90 });
    assert.equal(compass.sensorState().headingMagDeg, 90);

    compass.renderSnapshot(dom.byId.app, snapshot);
    const txt = text(dom.byId.app);
    assert.ok(txt.includes(t('compass.headingMag', { deg: '90' })), `应显示当前朝向，实际：${txt.slice(0, 160)}`);
    assert.ok(txt.includes(t('compass.headingTrue', { deg: '83' })), '真方位 = 磁方位 + 磁偏角（−7.49°）≈ 82.5°');

    const rose = dom.byId.app.querySelectorAll('.compass-rose');
    assert.equal(rose.length, 1, '有数据时才画盘面');
    assert.match(rose[0].getAttribute('style'), /rotate\(-90\.0deg\)/, '盘面应转 −heading，让设备朝向指向盘顶');
    assert.equal(dom.byId.app.querySelectorAll('.compass-needle').length, 2, '磁北针 + 真北针');
  } finally {
    compass.resetSensor();
    delete globalThis.window;
  }
});

test('计算失败（越界纬度 / 非数字）：降级为「暂不可用」，不白屏不抛栈', () => {
  const bad = compass.computeAt({ lat: 120, lon: 116 }, { altitudeM: 0, atMs: AT_2025 });
  assert.equal(bad.mag, null);
  assert.equal(bad.error, 'RangeError');

  const nan = compass.computeAt({ lat: 'abc', lon: null }, { altitudeM: 0, atMs: AT_2025 });
  assert.equal(nan.mag, null);
  assert.equal(nan.error, 'TypeError');

  const snapshot = compass.createSnapshot(BEIJING, { atMs: AT_2025 });
  snapshot.mag = null;
  snapshot.error = 'RangeError';
  compass.renderSnapshot(dom.byId.app, snapshot);
  const txt = text(dom.byId.app);
  assert.ok(txt.includes(t('compass.unavailable', { reason: 'RangeError' })), `应显示降级文案，实际：${txt.slice(0, 160)}`);
  assert.ok(txt.includes(t('card.convert')), '其余卡片照常渲染，不整屏塌掉');
  assert.ok(txt.includes(t('compass.convertUnavailable')), '磁偏角不可用时换算卡要明确说不能换算');
});

test('米 → 千米：单位换算正确，且真的传给了模型', () => {
  assert.equal(compass.altitudeKmFromM(1000), 1);
  assert.equal(compass.altitudeKmFromM(0), 0);
  assert.equal(compass.altitudeKmFromM(250), 0.25);
  // 缺失/脏数据一律按 0（椭球面），绝不把 NaN 喂进去
  assert.equal(compass.altitudeKmFromM(null), 0);
  assert.equal(compass.altitudeKmFromM(undefined), 0);
  assert.equal(compass.altitudeKmFromM(''), 0);
  assert.equal(compass.altitudeKmFromM('abc'), 0);
  assert.equal(compass.altitudeKmFromM([1000]), 0);

  const sea = compass.computeAt(BEIJING, { altitudeM: 0, atMs: AT_2025 });
  const up10km = compass.computeAt(BEIJING, { altitudeM: 10000, atMs: AT_2025 });
  assert.equal(up10km.mag.location.altitudeKm, 10, '10000 m 必须变成 10 km 传给模型');
  assert.ok(
    sea.mag.total - up10km.mag.total > 100,
    `抬高 10 km 总场强应明显下降，实际 ${sea.mag.total} → ${up10km.mag.total}`
  );
});

test('诚实红线：文案表里不得出现任何精度/误差数字，源码不得直出 warning', () => {
  // ★两张表都要查：文案表现在有中英两份，「英文版里多写了一句 ±0.3°」同样是在谎报精度。
  //   （原先只查 zh.js —— 那是单语言时代的写法。）
  for (const table of ['zh', 'en']) {
    const tableSrc = readFileSync(new URL(`../src/i18n/${table}.js`, import.meta.url), 'utf8');
    const compassKeys = tableSrc
      .split('\n')
      .filter((line) => /^\s*'compass\./.test(line))
      .join('\n');
    assert.ok(compassKeys.length > 0, `${table}.js 应能取到 compass.* 文案段`);
    // 英文表里「误差 / 精度」对应的英文词同样不许出现
    assert.doesNotMatch(
      compassKeys,
      /误差|精度|±|error|accuracy|uncertainty/i,
      `${table}.js：模型不导出不确定度，界面不得宣称任何精度/误差`
    );
    assert.doesNotMatch(tableSrc, /残差/, `${table}.js：「与官方参考实现的残差」是吻合度不是精度，不得进文案表`);
  }

  const src = readFileSync(new URL('../src/ui/compass.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /mag\.warning/, '不得直接渲染 warning 原文');
  assert.match(src, /level|expired|ahead|overshootYears/, '应由 level/expired/ahead/overshootYears 自拼文案');
});

test('模型卡显示版本 / 历元 / 有效期 / 来源，且不谎报精度', () => {
  const snapshot = snapshotAt(AT_2025);
  compass.renderSnapshot(dom.byId.app, snapshot);
  const txt = text(dom.byId.app);
  assert.ok(txt.includes(WMM_MODEL.name), '必须显示模型版本');
  assert.ok(txt.includes('2025.0'), '必须显示历元与有效期');
  assert.ok(txt.includes(WMM_MODEL.source), '必须显示来源');
  assert.ok(!/误差|±/.test(txt), '界面上不得出现任何精度/误差字样');
});

test('★模型卡最后一行：标签必须是「计算时刻（小数年）」，不许再借「地磁要素」', () => {
  // 真机缺陷原样：模型卡最后一行显示「地磁要素    2026.82」——
  // 标签借的是 `card.magnetic`（地磁要素 = D/I/F/H 那几个量），值却是小数年。
  // 变异验证：把 compass.js 的 t('compass.modelAt') 改回 t('card.magnetic')，这条会红。
  const root = dom.document.createElement('div');
  const snapshot = snapshotAt(AT_2025);
  compass.renderModelCard(root, snapshot);

  const rows = root.querySelector('#card-model').querySelectorAll('.kv-item');
  assert.ok(rows.length >= 6, `模型卡至少 6 行键值，实际 ${rows.length}`);
  const last = rows[rows.length - 1];
  const k = text(last.querySelector('.kv-k'));
  const v = text(last.querySelector('.kv-v'));

  assert.equal(k, t('compass.modelAt'), `最后一行标签必须是「计算时刻」，实际：${k}`);
  assert.notEqual(k, t('card.magnetic'), '★不许再借「地磁要素」当这一行的标签（值不是地磁要素）');
  assert.equal(v, fmt.num(snapshot.mag.decimalYear, 2), `值必须是小数年本身，实际：${v}`);
  assert.notEqual(t('compass.modelAt'), t('card.magnetic'), '两条键不许合并：合并了这条断言就永远绿');
});

/* ------------------------------------------------------------------ */
/* ★传感器按钮接线（真机 bug：「点了没反应」）                            */
/*                                                                      */
/* 既有用例全都**自己传了回调**（直接 renderSnapshot(app, snapshot) 或   */
/* enableSensor(() => renderSnapshot(...))），所以「卡片怎么画」是对的、   */
/* 「boot 怎么接线」零覆盖 —— 按钮回调断成空函数这件事没人拦得住。        */
/* 下面三条压的是接线本身 + 高频回调的性能约束。                          */
/* ------------------------------------------------------------------ */

/**
 * 造一个 window 替身：定义了 DeviceOrientationEvent，并把 deviceorientation 监听
 * 存进 listeners 供测试驱动。
 *
 * 默认（不传 opts）是**安卓内核**形态：没有 requestPermission → 'available'。
 * 传 `{ needsPermission: true }` 是 **iOS 13+** 形态：构造函数上挂 requestPermission()。
 *
 * @param {{needsPermission?:boolean, permission?:string}} [opts] 选项。
 * @returns {{listeners:Map<string, Function>}} 监听表。
 */
function installSensorWindow(opts = {}) {
  const listeners = new Map();
  const Ctor = function DeviceOrientationEvent() {};
  // iOS 13+ 形态：构造函数上挂着 requestPermission()，必须由用户手势调用
  if (opts.needsPermission) {
    Ctor.requestPermission = () => Promise.resolve(opts.permission || 'granted');
  }
  globalThis.window = {
    DeviceOrientationEvent: Ctor,
    addEventListener: (type, fn) => listeners.set(String(type), fn),
    removeEventListener: () => {},
  };
  return { listeners };
}

/**
 * 装一个可控的 requestAnimationFrame 替身：帧回调先攒着，由测试手动 flush。
 *
 * 真机上帧由浏览器驱动；Node 侧没有这个 API，compass.js 必须能在没有它时同步重画
 * （不能因为缺 API 就把重画吞掉）。
 *
 * @returns {{flush:(maxRounds?:number)=>number, pending:number}} 控制器。
 */
function installRaf() {
  let queue = [];
  globalThis.requestAnimationFrame = (fn) => {
    queue.push(fn);
    return queue.length;
  };
  return {
    /** 跑掉当前排队的帧；帧回调里新排的帧留到下一轮（最多 maxRounds 轮）。 */
    flush(maxRounds = 8) {
      let rounds = 0;
      while (queue.length > 0 && rounds < maxRounds) {
        const batch = queue;
        queue = [];
        rounds += 1;
        batch.forEach((fn) => fn());
      }
      return rounds;
    },
    get pending() {
      return queue.length;
    },
  };
}

/** 罗盘卡所在槽位。 */
const compassSlot = () => dom.byId.app.querySelector('#card-compass');

/** 取槽位里所有 button 后代（假 DOM 的 querySelectorAll 只认 #id / .class）。 */
const buttonsIn = (box) => box.descendants().filter((n) => n.tagName === 'BUTTON');

test('★按钮接线：boot() 渲染出来的「启用方向传感器」点了必须真的变（不只是函数被调用）', async () => {
  const { listeners } = installSensorWindow();
  try {
    assert.equal(compass.sensorSupport(), 'available', '这个 window 替身应被判为有传感器');
    compass.resetSensor();

    // 走真实入口：它渲染出来的卡片必须自带可用回调。
    // ★这就是原 bug 的盲区 —— 自己调 renderSnapshot 传回调是测不出接线的。
    await compass.boot();
    const slot = compassSlot();
    const before = slot.textContent;
    assert.ok(before.includes(t('compass.sensorIdle')), `点之前应是未启用态，实际：${before.slice(0, 120)}`);

    const btns = buttonsIn(slot);
    assert.equal(btns.length, 1, '未启用态必须给出「启用方向传感器」按钮');

    btns[0].click();

    const after = slot.textContent;
    assert.notEqual(
      after,
      before,
      '★点了按钮罗盘卡内容必须真的变（原 bug：onChange 是空函数 → 零重渲染 → 界面纹丝不动）'
    );
    assert.ok(
      after.includes(t('compass.sensorWaiting')),
      `点完应立刻显示「正在等待方向数据」，实际：${after.slice(0, 120)}`
    );
    assert.equal(compass.sensorState().state, 'waiting', '点击后传感器应真的挂上并进入等待态');
    assert.ok(listeners.get('deviceorientation'), '必须真的挂上 deviceorientation 监听');
  } finally {
    compass.resetSensor(); // 同时清掉 SENSOR_WAIT_MS 那个降级定时器，别拖着事件循环
    delete globalThis.window;
  }
});

test('★传感器回调只重画罗盘卡，且高频触发被合并（不许接整屏重渲染）', () => {
  const { listeners } = installSensorWindow();
  const raf = installRaf();
  try {
    compass.resetSensor();
    const snapshot = snapshotAt(AT_2025);
    const renderer = compass.createCompassRenderer(dom.byId.app, snapshot);
    compass.enableSensor(renderer.onSensorChange);
    const handler = listeners.get('deviceorientation');
    assert.ok(handler, '必须挂上 deviceorientation 监听');

    const slot = compassSlot();
    slot.textContent = '';
    const declBefore = dom.byId.app.querySelector('#card-declination').children[0];

    // 「重画了几次」在 DOM 上只能间接量：重画一次 = 重新 createElement 出一整张卡。
    // 先自己量出「一次重画要造多少节点」当基线，不去写死任何数字。
    const created = { n: 0 };
    const realCreate = dom.document.createElement;
    dom.document.createElement = (tag) => {
      created.n += 1;
      return realCreate(tag);
    };
    try {
      handler({ webkitCompassHeading: 90 }); // → 状态变 on，请求一次重画
      raf.flush();
      const perPaint = created.n;
      assert.ok(perPaint > 0, '这一帧必须真的重画了一次');
      const cardAfterFirst = slot.children[0];

      created.n = 0;
      // 安卓 ~50Hz：连发 20 次（同一帧内）
      for (let i = 0; i < 20; i += 1) handler({ webkitCompassHeading: 90 });
      const pendingAfterBurst = raf.pending;
      raf.flush();

      // 先报「重画了几次」这条（信息量最大），再补一条「排出几帧」
      const paints = Math.round(created.n / perPaint);
      assert.ok(
        paints <= 2,
        `★20 次事件只该重画 1 次左右（基线 ${perPaint} 节点/次），` +
          `实际约 ${paints} 次 / 造了 ${created.n} 个节点（合并没生效 = 手机上一秒重建几十次卡）`
      );
      assert.equal(pendingAfterBurst, 1, '★20 次事件只该排出 1 帧（合并生效：同一帧内只画一次）');
      assert.equal(compass.sensorState().headingMagDeg, 90, '朝向应已写入');
      assert.notEqual(slot.children[0], cardAfterFirst, '这一帧必须真的重画了');
      assert.ok(
        slot.textContent.includes(t('compass.headingMag', { deg: '90' })),
        `合并后那一次重画必须真把朝向画出来，实际：${slot.textContent.slice(0, 120)}`
      );
      assert.equal(
        dom.byId.app.querySelector('#card-declination').children[0],
        declBefore,
        '★传感器回调只准重画罗盘卡，磁偏角卡不许被重建（不许接整屏 renderSnapshot）'
      );
    } finally {
      dom.document.createElement = realCreate;
    }
  } finally {
    compass.resetSensor();
    delete globalThis.requestAnimationFrame;
    delete globalThis.window;
  }
});

test('★没有 requestAnimationFrame（Node 侧检查 / 老内核）退化为同步重画，不静默丢弃', () => {
  const { listeners } = installSensorWindow();
  try {
    assert.equal(typeof globalThis.requestAnimationFrame, 'undefined', '本用例要的就是没有 rAF 的环境');
    compass.resetSensor();
    const snapshot = snapshotAt(AT_2025);
    const renderer = compass.createCompassRenderer(dom.byId.app, snapshot);
    compass.enableSensor(renderer.onSensorChange);
    const handler = listeners.get('deviceorientation');

    const slot = compassSlot();
    slot.textContent = '';
    handler({ webkitCompassHeading: 45 });
    // 没有 rAF 也必须在这一次调用里就把卡画出来，不能攒着等一个永远不会来的帧
    assert.ok(
      slot.textContent.includes(t('compass.headingMag', { deg: '45' })),
      `无 rAF 时必须同步重画，实际：${String(slot.textContent).slice(0, 120)}`
    );
    assert.equal(typeof renderer.onSensorChange, 'function', 'onSensorChange 必须暴露给调用方接线');
  } finally {
    compass.resetSensor();
    delete globalThis.window;
  }
});

test('★桌面内核（定义了事件但永不派发）：等满 SENSOR_WAIT_MS 后降级为「本机无方向传感器」', () => {
  const { listeners } = installSensorWindow();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    compass.resetSensor();
    const snapshot = snapshotAt(AT_2025);
    const renderer = compass.createCompassRenderer(dom.byId.app, snapshot);
    compass.enableSensor(renderer.onSensorChange);
    assert.ok(listeners.get('deviceorientation'), '监听应已挂上');

    const slot = compassSlot();
    slot.textContent = '';
    assert.equal(compass.sensorState().state, 'waiting', '刚启用时是等待态');

    // 一条事件都不派发 —— 桌面内核就是这个样子
    mock.timers.tick(2500);

    assert.equal(compass.sensorState().state, 'unsupported', '等满仍无数据必须判定为无传感器');
    assert.ok(
      slot.textContent.includes(t('compass.sensorUnsupported')),
      `★超时后必须重画成降级文案（原 bug：这个 onChange 也是空的 → 一直停在「等待中」），实际：${String(slot.textContent).slice(0, 120)}`
    );
  } finally {
    mock.timers.reset();
    compass.resetSensor();
    delete globalThis.window;
  }
});

/**
 * iOS 的 requestPermission() 是异步的：让它的 then 落地。
 *
 * @returns {Promise<void>}
 */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('★iOS 授权 granted：拿到授权后挂监听、来数据后罗盘卡真的重画', async () => {
  const { listeners } = installSensorWindow({ needsPermission: true, permission: 'granted' });
  const raf = installRaf();
  try {
    assert.equal(compass.sensorSupport(), 'needs-permission', '这个 window 替身应被判为需要授权');
    compass.resetSensor();
    const snapshot = snapshotAt(AT_2025);
    const renderer = compass.createCompassRenderer(dom.byId.app, snapshot);
    const slot = compassSlot();
    slot.textContent = '';

    assert.equal(compass.enableSensor(renderer.onSensorChange), 'waiting', 'iOS 授权未落地前是等待态');
    await flushMicrotasks();

    const handler = listeners.get('deviceorientation');
    assert.ok(handler, '★granted 之后必须真的挂上监听（不能只修安卓那条直连分支）');
    handler({ webkitCompassHeading: 120 });
    raf.flush();

    assert.equal(compass.sensorState().state, 'on');
    assert.ok(
      slot.textContent.includes(t('compass.headingMag', { deg: '120' })),
      `★granted 分支来数据后必须真的重画出朝向，实际：${String(slot.textContent).slice(0, 120)}`
    );
  } finally {
    compass.resetSensor();
    delete globalThis.requestAnimationFrame;
    delete globalThis.window;
  }
});

test('★iOS 授权 denied：被拒也要真的重画成「已拒绝」，不许停在等待态', async () => {
  const { listeners } = installSensorWindow({ needsPermission: true, permission: 'denied' });
  try {
    compass.resetSensor();
    const snapshot = snapshotAt(AT_2025);
    const renderer = compass.createCompassRenderer(dom.byId.app, snapshot);
    const slot = compassSlot();
    slot.textContent = '';

    compass.enableSensor(renderer.onSensorChange);
    await flushMicrotasks();

    assert.equal(compass.sensorState().state, 'denied', '被拒后状态应转 denied');
    assert.equal(listeners.get('deviceorientation'), undefined, '被拒就不该挂监听');
    assert.ok(
      slot.textContent.includes(t('compass.sensorDenied')),
      `★被拒后必须真的重画成拒绝文案（原 bug：回调是空的 → 一直停在「正在等待方向数据…」），实际：${String(slot.textContent).slice(0, 120)}`
    );
  } finally {
    compass.resetSensor();
    delete globalThis.window;
  }
});

/* ------------------------------------------------------------------ */
/* 地理页装配（2026-10-17 导航重构 T05）                                */
/* ------------------------------------------------------------------ */

/**
 * 读仓库里的源码文本。
 *
 * @param {string} rel 仓库相对路径。
 * @returns {string} 源码。
 */
const srcOf = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('★槽位顺序硬契约：骨架一口气建出 search→place→map→bearing→declination→model→convert→compass→prov', () => {
  const root = dom.byId.app;
  compass.renderSkeleton(root);

  // 页头必须在所有槽位之前
  assert.equal(root.children[0].className, 'hd', '页头必须是第一个子节点');

  const ids = root.querySelectorAll('.card-slot').map((n) => n.getAttribute('id'));
  assert.deepEqual(
    ids,
    [
      'card-search',
      'card-place',
      'card-map',
      'card-bearing',
      'card-declination',
      'card-model',
      'card-convert',
      'card-compass',
      'card-prov',
    ],
    `槽位顺序错了就再也挪不回去（顺序由首次 appendChild 决定），实际：${ids.join(' → ')}`
  );
});

test('★地点卡 / 底图卡 / 方位卡三块在地理页，且方位卡的罗盘入口是同页锚点', () => {
  const root = dom.byId.app;
  const snapshot = snapshotAt(AT_2025, BEIJING);
  snapshot.elevationM = 44;
  snapshot.placeName = '北京 · 天安门';
  compass.renderSnapshot(root, snapshot);

  // 三块从气候页搬过来的卡都必须真的画出来
  assert.ok(root.querySelector('#card-place').textContent.includes('44'), '地点卡必须显示海拔');
  assert.ok(root.querySelector('#card-map'), '底图槽必须存在（底图由 boot() 画，骨架只建槽）');
  const bearing = root.querySelector('#card-bearing');
  assert.ok(bearing.textContent.includes('西偏'), '方位卡必须显示磁偏角');

  // ★完整罗盘摊在同一页：那颗按钮必须是同页锚点，不是跳页
  const anchors = bearing.descendants().filter((n) => n.tagName === 'A');
  assert.equal(anchors.length, 1, '方位卡只有一颗进完整罗盘的入口');
  const href = anchors[0].getAttribute('href');
  assert.equal(href, '#card-declination', `罗盘入口必须是同页锚点，实际：${href}`);
  // 锚点目标必须真的存在，否则是个点了没反应的死链
  assert.ok(root.querySelector('#card-declination'), '锚点目标 #card-declination 必须存在');
});

test('★依赖方向：底图卡只准由地理页 import（now.js import map.js 会成环）', () => {
  const now = srcOf('src/ui/now.js');
  const compassSrc = srcOf('src/ui/compass.js');
  const map = srcOf('src/ui/map.js');

  // 反向钉：now.js 不许 import map.js —— map.js 要用 now.js 的 h()，反过来就是环
  assert.ok(
    !/from\s+['"]\.\/map\.js['"]/.test(now),
    'now.js 不许 import ui/map.js（map.js 反向依赖 now.js 的 h()，成环）'
  );
  // 正向钉：地理页是真的在用底图卡
  assert.ok(
    /from\s+['"]\.\/map\.js['"]/.test(compassSrc),
    '地理页 compass.js 必须 import ui/map.js（底图卡归它）'
  );
  // 环的另一半：map.js 确实依赖 now.js
  assert.ok(/from\s+['"]\.\/now\.js['"]/.test(map), 'map.js 依赖 now.js 的 h()（这条是上面那条反向钉的前提）');
});
