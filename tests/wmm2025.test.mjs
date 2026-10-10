/**
 * WMM2025 地磁模型的权威验证
 *
 * 覆盖三条主线：
 *   1) **内嵌系数必须与官方 COF 逐项一致**：防止「抄系数」时的手滑，也防止将来换模型换错地方。
 *   2) **100 行官方测试值逐行比对**：docs/data/WMM2025_TEST_VALUES.txt 的 18 列（时间/高度/经纬度 +
 *      七要素 + 七个年变率）全部参与比对，逐个分量断言最大残差 —— 这是本模块的**验收标准**，
 *      容差按「官方发布值的量化精度 + 双精度级余量」设定，不放宽来迁就实现。
 *   3) **边界与换算**：南北极点、经度归一、高度单位（km）、有效期标记、真北换算符号。
 *
 * 依赖方向：src/core/mag.js 是纯算法（不含系数），src/data/wmm2025.js 负责把 WMM2025 系数注入进去。
 * 因此本测试的调用入口是 data 层导出的 computeGeomagnetic，算法本身则仍由 core 层提供。
 *
 * 运行：node --test "tests/*.test.mjs"
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mag = await import('../src/core/mag.js');
const data = await import('../src/data/wmm2025.js');

/** data 层装配好的 WMM2025 模型实例。 */
const wmm = data.WMM2025;

/** 本文件所在目录。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录。 */
const ROOT = path.resolve(HERE, '..');

/** 官方系数文件路径（离线校验基准）。 */
const COF_PATH = path.join(ROOT, 'docs', 'data', 'WMM2025.COF');

/** 官方测试值文件路径（离线验收基准）。 */
const TEST_VALUES_PATH = path.join(ROOT, 'docs', 'data', 'WMM2025_TEST_VALUES.txt');

/**
 * 容差（不放水，按官方发布精度加双精度级余量）：
 *   - D / I：官方值只保留小数两位 → 量化误差上限 ±0.005°，取 0.006°。
 *   - H / X / Y / Z / F：官方值保留小数六位（±5e-7）；实测残差约 7e-4 nT，
 *     来自不同实现在「大地 → 地心」旋转上的双精度级差异，取 0.002 nT。
 *   - 年变率：官方值保留小数六位；实测残差约 1e-6，取 1e-3（nT/年）与 1e-4（度/年）。
 */
const TOLERANCE = {
  D: 0.006,
  I: 0.006,
  H: 0.002,
  X: 0.002,
  Y: 0.002,
  Z: 0.002,
  F: 0.002,
  dD: 1e-4,
  dI: 1e-4,
  dH: 1e-3,
  dX: 1e-3,
  dY: 1e-3,
  dZ: 1e-3,
  dF: 1e-3,
};

/** 官方测试值的七个要素记号（对应文件第 5–11 列）。 */
const ELEMENT_KEYS = ['D', 'I', 'H', 'X', 'Y', 'Z', 'F'];

/** 官方测试值的七个年变率记号（对应文件第 12–18 列）。 */
const RATE_KEYS = ['dD', 'dI', 'dH', 'dX', 'dY', 'dZ', 'dF'];

/**
 * 解析官方系数文件的 90 行系数（`n m g h dg dh`）。
 *
 * @returns {{n:number, m:number, g:number, h:number, dg:number, dh:number}[]} 系数行。
 */
function readCofRows() {
  const lines = fs.readFileSync(COF_PATH, 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines.slice(1)) {
    const text = line.trim();
    if (text === '') continue;
    if (/^9+$/.test(text)) break; // 官方哨兵行
    const parts = text.split(/\s+/).map(Number);
    rows.push({ n: parts[0], m: parts[1], g: parts[2], h: parts[3], dg: parts[4], dh: parts[5] });
  }
  return rows;
}

/**
 * 解析官方测试值文件（跳过 `#` 开头的列说明行）。
 *
 * @returns {number[][]} 每行 18 个数：decimalYear, altitudeKm, lat, lon, D…F, dD…dF。
 */
function readTestValueRows() {
  const lines = fs.readFileSync(TEST_VALUES_PATH, 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) continue;
    const cols = text.split(/\s+/).map(Number);
    if (cols.some((v) => !Number.isFinite(v))) throw new Error(`测试值行无法解析：${text}`);
    rows.push(cols);
  }
  return rows;
}

/**
 * 取某点的完整结果（缺省高度 0 km、缺省年份为模型历元）。
 *
 * @param {number} lat 纬度。
 * @param {number} lon 经度。
 * @param {object} [extra] 额外入参。
 * @returns {ReturnType<typeof data.computeGeomagnetic>} 结果。
 */
const at = (lat, lon, extra = {}) => data.computeGeomagnetic({ latitude: lat, longitude: lon, ...extra });

/* ---------------------------- 1. 内嵌系数 ---------------------------- */

test('内嵌系数与官方 COF 逐项一致（90 组 g/h/dg/dh）', () => {
  const rows = readCofRows();
  assert.equal(rows.length, 90, `官方 COF 应有 90 组系数，实际 ${rows.length}`);
  assert.equal(rows.length, data.COEFFICIENT_COUNT, '内嵌模块声明的项数应与 COF 一致');

  for (const row of rows) {
    // 官方 COF 里存在 "-0.0"，Number 后为 −0；与内嵌表里的 0 数值等价（=== 成立），
    // 但 Object.is 视为不同，因此用 === 语义比较，避免把 −0 / 0 判成不一致。
    assert.ok(data.G[row.n][row.m] === row.g, `g(${row.n},${row.m}) 与 COF 不一致`);
    assert.ok(data.H[row.n][row.m] === row.h, `h(${row.n},${row.m}) 与 COF 不一致`);
    assert.ok(data.DG[row.n][row.m] === row.dg, `dg(${row.n},${row.m}) 与 COF 不一致`);
    assert.ok(data.DH[row.n][row.m] === row.dh, `dh(${row.n},${row.m}) 与 COF 不一致`);
  }
});

test('系数表形状：行 = n、列 = m（0..n），多余位置不可读写为 0', () => {
  assert.equal(data.G.length, data.MAX_DEGREE + 1, '行数应为 maxDegree + 1');
  for (let n = 0; n <= data.MAX_DEGREE; n += 1) {
    for (const table of [data.G, data.H, data.DG, data.DH]) {
      assert.equal(table[n].length, n + 1, `第 ${n} 行长度应为 ${n + 1}`);
      for (let m = 0; m <= n; m += 1) {
        assert.ok(Number.isFinite(table[n][m]), `(${n},${m}) 必须是有限数字`);
      }
    }
    // m = 0 的 h 系列恒为 0（官方约定）
    assert.equal(data.H[n][0], 0, `h(${n},0) 官方约定恒为 0`);
    assert.equal(data.DH[n][0], 0, `dh(${n},0) 官方约定恒为 0`);
  }
});

test('模型元信息完整且指向 WMM-2025 / 2025.0–2030.0', () => {
  const model = data.WMM_MODEL;
  assert.equal(model.name, 'WMM-2025');
  assert.equal(model.epoch, 2025.0);
  assert.equal(model.validFrom, 2025.0);
  assert.equal(model.validUntil, 2030.0);
  assert.equal(model.maxDegree, 12);
  assert.equal(model.releasedAt, '2024-11-13');
  assert.equal(model.doi, '10.25921/aqfd-sd83');
  assert.ok(model.generatedFrom.endsWith('WMM2025.COF'), '必须记录原始系数文件路径');

  // 装配结果：同一份元信息、同一份参考半径
  assert.equal(wmm.model, model, '装配后的实例应透传同一份元信息');
  assert.equal(wmm.maxDegree, 12);
  assert.equal(wmm.epoch, 2025.0);
  assert.equal(wmm.referenceRadiusKm, 6371.2);
  assert.equal(typeof wmm.compute, 'function');
  assert.equal(typeof wmm.validity, 'function');
  assert.equal(typeof mag.createMagneticModel, 'function', '工厂必须留在 core 层');
});

/* ---------------------------- 2. 官方测试值逐行比对 ---------------------------- */

test('官方测试值逐行比对：七要素 + 七个年变率', () => {
  const rows = readTestValueRows();
  assert.equal(rows.length, 100, `官方测试值应有 100 行，实际 ${rows.length}`);

  const maxResidual = {};
  for (const key of [...ELEMENT_KEYS, ...RATE_KEYS]) maxResidual[key] = 0;
  let worstRow = 0;
  let worstKey = '';
  let worstResidual = 0;

  for (const row of rows) {
    const [year, altitudeKm, lat, lon, ...expected] = row;
    const got = data.computeGeomagnetic({ latitude: lat, longitude: lon, altitudeKm, decimalYear: year });
    ELEMENT_KEYS.forEach((key, i) => {
      const residual = Math.abs(got.symbols[key] - expected[i]);
      if (residual > maxResidual[key]) maxResidual[key] = residual;
      if (residual > worstResidual) {
        worstResidual = residual;
        worstKey = key;
        worstRow = row;
      }
    });
    RATE_KEYS.forEach((key, i) => {
      const residual = Math.abs(got.symbolRates[key] - expected[ELEMENT_KEYS.length + i]);
      if (residual > maxResidual[key]) maxResidual[key] = residual;
    });
  }

  process.stdout.write('  官方测试值比对：最大绝对残差（100 行）\n');
  for (const key of ELEMENT_KEYS) {
    process.stdout.write(`    ${key.padEnd(3)} ${maxResidual[key].toExponential(4)}  （容差 ${TOLERANCE[key]}）\n`);
  }
  for (const key of RATE_KEYS) {
    process.stdout.write(`    ${key.padEnd(3)} ${maxResidual[key].toExponential(4)}  （容差 ${TOLERANCE[key]}）\n`);
  }
  process.stdout.write(`  最差项：${worstKey}，行 ${worstRow.slice(0, 4).join(' / ')}，残差 ${worstResidual.toExponential(4)}\n`);

  for (const key of ELEMENT_KEYS) {
    assert.ok(
      maxResidual[key] <= TOLERANCE[key],
      `${key} 最大残差 ${maxResidual[key].toExponential(4)} 超过容差 ${TOLERANCE[key]}`
    );
  }
  for (const key of RATE_KEYS) {
    assert.ok(
      maxResidual[key] <= TOLERANCE[key],
      `${key} 最大残差 ${maxResidual[key].toExponential(4)} 超过容差 ${TOLERANCE[key]}`
    );
  }
});

test('官方测试值覆盖到模型末期与非历元年份（0.5 年步长）', () => {
  const rows = readTestValueRows();
  const years = [...new Set(rows.map((r) => r[0]))].sort((a, b) => a - b);
  assert.equal(years[0], 2025.0, '最小年份应为历元 2025.0');
  assert.equal(years[years.length - 1], 2029.5, '最大年份应为 2029.5');
  assert.equal(years.length, 10, `应有 10 个不同年份（0.5 年步长），实际 ${years.length}`);
  const altitudes = rows.map((r) => r[1]);
  assert.ok(Math.min(...altitudes) >= 0 && Math.max(...altitudes) <= 100, '高度应在 0–100 km');
  const lats = rows.map((r) => r[2]);
  assert.ok(Math.max(...lats.map(Math.abs)) >= 89, '应覆盖近极区纬度');
  assert.ok(rows.some((r) => r[2] === 0), '应覆盖赤道');
  assert.ok(rows.some((r) => r[3] > 0) && rows.some((r) => r[3] < 0), '应覆盖东西半球');
});

/* ---------------------------- 3. 边界：极区 / 单位 / 归一 ---------------------------- */

test('南北极点：不产生 NaN，且 F / H / I / Z 与经度无关', () => {
  for (const lat of [90, -90]) {
    const base = at(lat, 0, { altitudeKm: 0, decimalYear: 2025 });
    for (const key of ['D', 'I', 'H', 'X', 'Y', 'Z', 'F']) {
      assert.ok(Number.isFinite(base.symbols[key]), `纬度 ${lat} 的 ${key} 必须是有限值`);
    }
    for (const lon of [45, 90, 135, -180]) {
      const other = at(lat, lon, { altitudeKm: 0, decimalYear: 2025 });
      assert.ok(Math.abs(other.total - base.total) < 1e-6, `极点总强度应与经度无关（lat=${lat}, lon=${lon}）`);
      assert.ok(Math.abs(other.horizontal - base.horizontal) < 1e-6, '极点水平强度应与经度无关');
      assert.ok(Math.abs(other.inclination - base.inclination) < 1e-6, '极点磁倾角应与经度无关');
    }
    // 与近极点连续：0.0001° ≈ 11 m，要素不应跳变
    const near = at(lat > 0 ? 89.9999 : -89.9999, 0, { altitudeKm: 0, decimalYear: 2025 });
    assert.ok(Math.abs(near.total - base.total) < 0.2, `极点与 89.9999° 的总强度差应 < 0.2 nT，实际 ${Math.abs(near.total - base.total)}`);
  }
  // 南北半球的垂直符号约定：北半球向下为正、南半球向上为负
  assert.ok(at(90, 0).vertical > 0, '北极点 Z 应向下为正');
  assert.ok(at(-90, 0).vertical < 0, '南极点 Z 应向上为负');
});

test('磁偏角在极点随经度线性旋转（每向东 1° 偏角 +1°）', () => {
  const d0 = at(90, 0).declination;
  const d90 = at(90, 90).declination;
  assert.ok(Math.abs(mag.normalizeSignedAngle(d90 - d0) - 90) < 1e-6, `极点处经度 +90° 应使偏角 +90°，实际 ${mag.normalizeSignedAngle(d90 - d0)}`);
});

test('高度单位确为 km：100 km 高度使场强明显衰减', () => {
  const ground = at(39.9087, 116.3975, { altitudeKm: 0, decimalYear: 2025 });
  const oneKm = at(39.9087, 116.3975, { altitudeKm: 1, decimalYear: 2025 });
  const hundredKm = at(39.9087, 116.3975, { altitudeKm: 100, decimalYear: 2025 });
  assert.ok(ground.total > oneKm.total, '升高 1 km 总强度应减小');
  assert.ok(ground.total - oneKm.total < 100, '升高 1 km 的衰减应为几十 nT 量级（防止把 km 当作 m）');
  assert.ok(hundredKm.total < ground.total * 0.97, '升高 100 km 总强度应衰减 > 3%');
});

test('经度归一：190° 与 −170° 等价，范围落回 (−180, 180]', () => {
  const a = at(20, 190, { altitudeKm: 10, decimalYear: 2026 });
  const b = at(20, -170, { altitudeKm: 10, decimalYear: 2026 });
  assert.equal(a.location.longitude, -170);
  assert.ok(Math.abs(a.declination - b.declination) < 1e-12, '同一经度的两种写法结果必须一致');
  const c = at(20, 550, { altitudeKm: 10, decimalYear: 2026 });
  assert.ok(Math.abs(c.declination - a.declination) < 1e-12, '550°（≡190°≡−170°）也应归一到同一结果');
  const antipode = data.computeGeomagnetic({ latitude: 20, longitude: 180, altitudeKm: 0, decimalYear: 2026 });
  assert.equal(antipode.location.longitude, 180, '180° 保持在 (−180, 180] 的右端');
});

test('大地 → 地心换算：北半球地心纬度小于大地纬度，半径落在椭球范围内', () => {
  const r = at(45, 30, { altitudeKm: 0, decimalYear: 2025 });
  assert.ok(r.location.geocentricLatitude < 45 && r.location.geocentricLatitude > 44.5, `45°N 的地心纬度应≈44.808°，实际 ${r.location.geocentricLatitude}`);
  assert.ok(r.location.geocentricRadiusKm > 6356 && r.location.geocentricRadiusKm < 6379, '地表地心半径应落在极半径与赤道半径之间');
  const south = at(-45, 30, { altitudeKm: 0, decimalYear: 2025 });
  assert.ok(south.location.geocentricLatitude > -45, '南半球地心纬度应大于（绝对值更小）大地纬度');
});

/* ---------------------------- 4. 有效期与线性外推 ---------------------------- */

test('有效期内不带警告；边界年份 2025.0 / 2030.0 均视为有效', () => {
  for (const year of [2025.0, 2026.5, 2029.9, 2030.0]) {
    const r = at(39.9, 116.4, { altitudeKm: 0, decimalYear: year });
    assert.equal(r.valid, true, `${year} 应在有效期内`);
    assert.equal(r.expired, false);
    assert.equal(r.ahead, false);
    assert.equal(r.warning, null);
    assert.equal(r.level, 'ok');
    assert.ok(Number.isFinite(r.total), '有效期内必须给出数值结果');
  }
});

test('超出有效期：仍返回结果，但带 expired 标记与中文提示', () => {
  const r = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2032 });
  assert.equal(r.valid, false);
  assert.equal(r.expired, true);
  assert.equal(r.level, 'error');
  assert.ok(r.warning && r.warning.includes('WMM-2025'), '提示文案必须点明模型版本');
  assert.ok(r.warning.includes('2030.0'), '提示文案必须写明有效期终点');
  assert.ok(r.overshootYears > 1.9 && r.overshootYears < 2.1, `超出量应≈2 年，实际 ${r.overshootYears}`);
  for (const key of ['D', 'I', 'H', 'X', 'Y', 'Z', 'F']) {
    assert.ok(Number.isFinite(r.symbols[key]), `超期时 ${key} 仍应给出可展示的数值`);
  }
});

test('早于历元：带 ahead 标记（回溯推值），同样给出结果', () => {
  const r = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2024 });
  assert.equal(r.valid, false);
  assert.equal(r.ahead, true);
  assert.equal(r.expired, false);
  assert.ok(r.overshootYears < 0, `早于历元应为负超出量，实际 ${r.overshootYears}`);
  assert.ok(r.warning && r.warning.length > 0);
});

test('线性外推自洽：相邻整年差分等于年变率（X / Y / Z 精确成立）', () => {
  const y2025 = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2025 });
  const y2026 = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2026 });
  const eps = 1e-6;
  assert.ok(Math.abs((y2026.north - y2025.north) - y2025.symbolRates.dX) < eps, '差分 X 应等于 dX/dt');
  assert.ok(Math.abs((y2026.east - y2025.east) - y2025.symbolRates.dY) < eps, '差分 Y 应等于 dY/dt');
  assert.ok(Math.abs((y2026.vertical - y2025.vertical) - y2025.symbolRates.dZ) < eps, '差分 Z 应等于 dZ/dt');
  // D 的非线性来自 atan2，用左右差分逼近
  const left = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2024.999 });
  const right = at(39.9, 116.4, { altitudeKm: 0, decimalYear: 2025.001 });
  const numeric = (right.declination - left.declination) / 0.002;
  assert.ok(Math.abs(numeric - y2025.symbolRates.dD) < 1e-6, `数值 dD/dt=${numeric} 应与解析值 ${y2025.symbolRates.dD} 一致`);
});

test('decimalYearFromDate 不读时钟，换算结果与手算一致', () => {
  const y = mag.decimalYearFromDate(new Date('2025-01-01T00:00:00Z'));
  assert.ok(Math.abs(y - 2025.0) < 1e-9, `年初应为 2025.0，实际 ${y}`);
  const half = mag.decimalYearFromDate(new Date('2025-07-02T12:00:00Z'));
  assert.ok(half > 2025.49 && half < 2025.51, `年中应≈2025.5，实际 ${half}`);
  assert.throws(() => mag.decimalYearFromDate('2025-01-01'), TypeError);
});

/* ---------------------------- 5. 真北 / 磁北换算 ---------------------------- */

test('真方位 = 磁方位 + 磁偏角（东偏为正）', () => {
  // 东偏 10°：罗盘指磁北（磁方位 0°）时，真方位为 10°
  assert.equal(mag.trueBearingFromMagnetic(0, 10), 10);
  // 西偏 10°（declination = −10°）：磁方位 0° 对应真方位 350°
  assert.equal(mag.trueBearingFromMagnetic(0, -10), 350);
  assert.equal(mag.trueBearingFromMagnetic(45, 10), 55);
  assert.equal(mag.trueBearingFromMagnetic(350, -20), 330);
  assert.equal(mag.trueBearingFromMagnetic(0, -7.49), 352.51);
  // 反向必须严格还原
  for (const [bearing, declination] of [[0, 10], [33, -7.49], [359, 180], [123.456, -2.5]]) {
    assert.ok(
      Math.abs(mag.magneticBearingFromTrue(mag.trueBearingFromMagnetic(bearing, declination), declination) - bearing) < 1e-9,
      `往返换算应还原：${bearing} / ${declination}`
    );
  }
});

test('磁方位 = 真方位 − 磁偏角（东偏为正）', () => {
  assert.equal(mag.magneticBearingFromTrue(10, 10), 0);
  assert.equal(mag.magneticBearingFromTrue(90, -10), 100);
  assert.equal(mag.magneticBearingFromTrue(45, 15), 30);
  // 结果一律落在 [0, 360)
  for (const bearing of [-10, 350, 720, 1080.5]) {
    const r = mag.magneticBearingFromTrue(bearing, 7.49);
    assert.ok(r >= 0 && r < 360, `方位应归一到 [0,360)，实际 ${r}`);
  }
});

test('normalizeBearing 归一到 [0, 360)，非法入参退化为 0', () => {
  assert.equal(mag.normalizeBearing(0), 0);
  assert.equal(mag.normalizeBearing(-0.5), 359.5);
  assert.equal(mag.normalizeBearing(360), 0);
  assert.equal(mag.normalizeBearing(725), 5);
  assert.equal(mag.normalizeBearing(Number.NaN), 0);
});

test('北京 2025.0 基准值：西偏约 7.5°、磁倾角约 59.3°（与公开资料同量级）', () => {
  const r = at(39.9087, 116.3975, { altitudeKm: 0, decimalYear: 2025 });
  assert.ok(r.declination < -6 && r.declination > -9, `北京应为西偏约 −7.5°，实际 ${r.declination}`);
  assert.ok(r.inclination > 58 && r.inclination < 61, `北京磁倾角应≈59.3°，实际 ${r.inclination}`);
  assert.ok(r.total > 50000 && r.total < 58000, `北京总场强应≈5.5 万 nT，实际 ${r.total}`);
  assert.ok(r.horizontal > 0 && r.vertical > 0, '北半球中纬度：水平强度、向下分量均为正');
  // 与「官方测试值」同一套算法 —— 用符号冗余字段交叉校验
  assert.equal(r.symbols.D, r.declination);
  assert.equal(r.symbols.Z, r.vertical);
  assert.equal(r.symbolRates.dD, r.rates.declination);
  assert.equal(r.model.name, 'WMM-2025');
});

/* ---------------------------- 6. 入参健壮性 ---------------------------- */

test('非法入参显式报错，不返回静默的错误数值', () => {
  assert.throws(() => data.computeGeomagnetic({ latitude: 91, longitude: 0 }), RangeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: -90.5, longitude: 0 }), RangeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: 'abc', longitude: 0 }), TypeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: 0, longitude: Number.NaN }), TypeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: 0, longitude: 0, altitudeKm: 'x' }), TypeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: 0, longitude: 0, decimalYear: 'abc' }), TypeError);
  assert.throws(() => data.computeGeomagnetic({ latitude: 0, longitude: 0, decimalYear: Infinity }), TypeError);
  assert.throws(() => mag.trueBearingFromMagnetic('x', 10), TypeError);
  assert.throws(() => mag.magneticBearingFromTrue(10, Number.NaN), TypeError);
  // 装配期的形状校验：错位的系数表必须当场报错，而不是算出错误的场
  const bad = { model: data.WMM_MODEL, maxDegree: 2, epoch: 2025, referenceRadiusKm: 6371.2, g: [[0], [1, 1]], h: [[0], [0, 1]], dg: [[0], [0, 0]], dh: [[0], [0, 0]] };
  assert.throws(() => mag.createMagneticModel(bad), TypeError);
  assert.throws(() => mag.createMagneticModel({ ...bad, g: [[0], [1, 1], [1, 1, 1]], h: [[0], [0, 1], [0, 1, 1]], dg: [[0], [0, 0], [0, 0, 0]], dh: [[0], [0, 0], [0, 0, 0]], maxDegree: 0 }), RangeError);
});

test('缺省入参：高度 0 km、年份取模型历元', () => {
  const r = data.computeGeomagnetic({ latitude: 20, longitude: 30 });
  assert.equal(r.decimalYear, 2025.0);
  assert.equal(r.location.altitudeKm, 0);
  assert.ok(Number.isFinite(r.total));
  // 显式传 undefined 视为未传（走缺省），非空值必须合法
  const r2 = data.computeGeomagnetic({ latitude: 20, longitude: 30, altitudeKm: undefined, decimalYear: undefined });
  assert.equal(r2.decimalYear, 2025.0);
  assert.equal(r2.total, r.total);
});
