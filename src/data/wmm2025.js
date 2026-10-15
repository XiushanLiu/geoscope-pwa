/**
 * WMM2025 世界地磁模型系数（内嵌，离线可用）
 *
 * 数据来源：NOAA NCEI 与英国地质调查局（BGS）联合发布的 World Magnetic Model 2025（WMM2025）。
 *   DOI：10.25921/aqfd-sd83。本文件由仓库内的官方原始系数文件 docs/data/WMM2025.COF
 *   在**离线**状态下逐行展开生成（首行 `2025.0            WMM-2025     11/13/2024`，共 90 组系数，n = 1..12），
 *   运行时既不读文件也不发网络请求，保证「零依赖 + 隐私红线 + 断网可用」。
 *
 * 配套：官方测试值见 docs/data/WMM2025_TEST_VALUES.txt，由 tests/wmm2025.test.mjs 逐行比对。
 *
 * 索引约定（Schmidt 半归一化球谐系数）：
 *   记号 g_n^m / h_n^m 为高斯系数，n 为阶（1..12）、m 为次（0..n）。
 *   存储为「行 = n、列 = m」的二维表：G[n][m] 即 g_n^m，行 0 为占位（恒 0）。
 *   于是 U[n][m] 含义统一，不会因为缺少 m > n 的项而错位。单位：nT（dg/dh 为 nT/年）。
 *
 * 有效期：epoch = 2025.0，模型有效期 2025.0 – 2030.0。
 *   超出有效期必须换模型；2029 年底 WMM 会发布新版本，届时：
 *   1) 下载新的 *2025*.COF（或后续版本）放到 docs/data/；
 *   2) 重新生成本文件的四张系数表与 WMM_MODEL 元信息；
 *   3) 用新模型的 TEST_VALUES 文件重跑 tests/wmm2025.test.mjs。
 *
 * 红线：本模块是纯数据与装配，不做任何 IO，只 import core 层的纯算法（可被任意层安全 import）。
 */

import { createMagneticModel, decimalYearFromDate } from '../core/mag.js';

/** 模型元信息：UI 需要显示模型版本与到期提示，统一从这里取。 */
export const WMM_MODEL = Object.freeze({
  /** 模型名称。 */
  name: 'WMM-2025',
  /** 系数历元（十进制年）。 */
  epoch: 2025.0,
  /** 有效期起点（含）。 */
  validFrom: 2025.0,
  /** 有效期终点（含）：超过此年份模型不再可靠，必须提示用户。 */
  validUntil: 2030.0,
  /** 最高阶数。 */
  maxDegree: 12,
  /** 官方发布日（YYYY-MM-DD）。 */
  releasedAt: '2024-11-13',
  /** 数据来源机构。 */
  source: 'NOAA NCEI / BGS',
  /** 数据集 DOI。 */
  doi: '10.25921/aqfd-sd83',
  /** 本文件对应的原始系数文件路径（仓库内，便于溯源）。 */
  generatedFrom: 'docs/data/WMM2025.COF',
});

/** 磁势参考球半径（km）：官方 WMM 系数以该半径为参考球面。 */
export const REFERENCE_RADIUS_KM = 6371.2;

/** 最高阶数（= WMM_MODEL.maxDegree），单独导出避免每次取属性。 */
export const MAX_DEGREE = 12;

/** 系数历元（十进制年），年变率线性外推的时间基准。 */
export const EPOCH = 2025;

/** 有效系数项数：Σ(n=1..12)(n+1) = 90。 */
export const COEFFICIENT_COUNT = 90;

/** g_n^m：主磁场高斯系数（nT），行 = n，列 = m（0..n）。 */
export const G = Object.freeze([
  [0], // n=0：占位行（球谐从 n=1 开始），保证行下标 = n
  [-29351.8, -1410.8], // n=1：m = 0..1
  [-2556.6, 2951.1, 1649.3], // n=2：m = 0..2
  [1361, -2404.1, 1243.8, 453.6], // n=3：m = 0..3
  [895, 799.5, 55.7, -281.1, 12.1], // n=4：m = 0..4
  [-233.2, 368.9, 187.2, -138.7, -142, 20.9], // n=5：m = 0..5
  [64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7], // n=6：m = 0..6
  [79.5, -77, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2], // n=7：m = 0..7
  [23.2, 10.8, -17.5, 2, -21.7, 16.9, 15, -16.8, 0.9], // n=8：m = 0..8
  [4.6, 7.8, 3, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9], // n=9：m = 0..9
  [-1.3, -6.4, 0.2, 2, -1, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9], // n=10：m = 0..10
  [2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6], // n=11：m = 0..11
  [-2, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7], // n=12：m = 0..12
]);

/** h_n^m：主磁场高斯系数（nT），行 = n，列 = m（0..n）。 */
export const H = Object.freeze([
  [0], // n=0：占位行（球谐从 n=1 开始），保证行下标 = n
  [0, 4545.4], // n=1：m = 0..1
  [0, -3133.6, -815.1], // n=2：m = 0..2
  [0, -56.6, 237.5, -549.5], // n=3：m = 0..3
  [0, 278.6, -133.9, 212, -375.6], // n=4：m = 0..4
  [0, 45.4, 220.2, -122.9, 43, 106.1], // n=5：m = 0..5
  [0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7], // n=6：m = 0..6
  [0, -48.9, -14.4, -1, 23.4, -7.4, -25.1, -2.3], // n=7：m = 0..7
  [0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9], // n=8：m = 0..8
  [0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10], // n=9：m = 0..9
  [0, 3.3, 0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1], // n=10：m = 0..10
  [0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3], // n=11：m = 0..11
  [0, -1.3, 0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1, 0.2], // n=12：m = 0..12
]);

/** dg_n^m：g 的年变率（nT/年），索引同 G。 */
export const DG = Object.freeze([
  [0], // n=0：占位行（球谐从 n=1 开始），保证行下标 = n
  [12, 9.7], // n=1：m = 0..1
  [-11.6, -5.2, -8], // n=2：m = 0..2
  [-1.3, -4.2, 0.4, -15.6], // n=3：m = 0..3
  [-1.6, -2.4, -6, 5.6, -7], // n=4：m = 0..4
  [0.6, 1.4, 0, 0.6, 2.2, 0.9], // n=5：m = 0..5
  [-0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9], // n=6：m = 0..6
  [0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8], // n=7：m = 0..7
  [-0.1, 0.2, 0, 0.5, -0.1, 0.3, 0.2, 0, 0.2], // n=8：m = 0..8
  [0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1], // n=9：m = 0..9
  [0.1, 0, 0.1, 0.1, 0, -0.3, 0, -0.1, -0.1, 0, 0], // n=10：m = 0..10
  [0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1], // n=11：m = 0..11
  [0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0, -0.1], // n=12：m = 0..12
]);

/** dh_n^m：h 的年变率（nT/年），索引同 H。 */
export const DH = Object.freeze([
  [0], // n=0：占位行（球谐从 n=1 开始），保证行下标 = n
  [0, -21.5], // n=1：m = 0..1
  [0, -27.7, -12.1], // n=2：m = 0..2
  [0, 4, -0.3, -4.1], // n=3：m = 0..3
  [0, -1.1, 4.1, 1.6, -4.4], // n=4：m = 0..4
  [0, -0.5, 2.2, 0.4, 1.7, 1.9], // n=5：m = 0..5
  [0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9], // n=6：m = 0..6
  [0, 0.6, 0.5, -0.8, 0, -1, 0.6, -0.2], // n=7：m = 0..7
  [0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2], // n=8：m = 0..8
  [0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1], // n=9：m = 0..9
  [0, 0, 0, -0.2, 0.1, -0.1, 0.1, 0, -0.1, 0.2, 0], // n=10：m = 0..10
  [0, 0, 0.1, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0], // n=11：m = 0..11
  [0, 0, 0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1], // n=12：m = 0..12
]);

/**
 * 用上面的系数装配出可直接调用的模型实例。
 *
 * 依赖方向：data 层 import core 层（与本仓库既有约定一致，core 层不反向依赖 data 层）。
 * 换模型时只需替换本文件的四张系数表与 WMM_MODEL，这里的代码无需改动。
 */
export const WMM2025 = createMagneticModel({
  model: WMM_MODEL,
  maxDegree: MAX_DEGREE,
  epoch: EPOCH,
  referenceRadiusKm: REFERENCE_RADIUS_KM,
  g: G,
  h: H,
  dg: DG,
  dh: DH,
});

/**
 * 计算给定地点与年份的地磁要素与年变率（面向 UI 的唯一入口）。
 *
 * @param {{latitude:number, longitude:number, altitudeKm?:number, decimalYear?:number}} params 入参。
 * @returns {ReturnType<typeof WMM2025['compute']>} 七要素 / 七年变率 / 有效期标记。
 */
export const computeGeomagnetic = (params) => WMM2025.compute(params);

/**
 * 只取磁偏角（度，东偏为正）。
 *
 * @param {object} params 同 computeGeomagnetic 的入参。
 * @returns {number} 磁偏角。
 */
export const geomagneticDeclination = (params) => WMM2025.declination(params);

/**
 * **UI 层的统一入口**：按「米 + 日期」口径算磁偏角（度，东偏为正）。
 *
 * ★为什么要有这一层：WMM 的入参有三个已知的单位坑，写错不会报错、只会给错值 ——
 *   ① `altitudeKm` 是**千米**且是椭球高，而项目通用单位是**米** → 必须 /1000；
 *   ② 不传 `decimalYear` 会按历元 2025.0 算，2029 年打开就拿到 2025 年的值；
 *   ③ 计算可能抛 RangeError / TypeError（越界、非数值）→ 必须兜住，不许白屏。
 *   此前 settings.js（导出 CSV）与 compass.js 各写了一份，现在 UI 侧统一走这里。
 *
 * @param {{lat:number|null, lon:number|null}} coord 坐标（度）。
 * @param {{altitudeM?:number|null, atMs?:number}} [opts] 海拔（**米**）与时刻。
 * @returns {number|null} 磁偏角（度）；坐标缺失或计算失败一律 null（调用方显示「—」）。
 */
export function declinationDegAt(coord, opts = {}) {
  const lat = coord ? Number(coord.lat) : NaN;
  const lon = coord ? Number(coord.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altM = Number(opts.altitudeM);
  try {
    const deg = geomagneticDeclination({
      latitude: lat,
      longitude: lon,
      altitudeKm: Number.isFinite(altM) ? altM / 1000 : 0,
      decimalYear: decimalYearFromDate(new Date(Number(opts.atMs) || Date.now())),
    });
    return Number.isFinite(deg) ? deg : null;
  } catch (err) {
    // 不许把异常抛给渲染层 —— 一页白屏比一个「—」糟得多
    console.warn('[wmm] declination failed:', err && err.message);
    return null;
  }
}

/**
 * 判定给定十进制年是否在有效期内（含中文提示文案）。
 *
 * @param {number} decimalYear 十进制年。
 * @returns {ReturnType<typeof WMM2025['validity']>} 判定结果。
 */
export const modelValidity = (decimalYear) => WMM2025.validity(decimalYear);
