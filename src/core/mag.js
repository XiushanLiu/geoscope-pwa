/**
 * 地磁球谐综合（BGS / NOAA 口径的 WMM 族算法）
 *
 * 职责：提供**纯算法**——给定一套高斯系数（g/h 及其年变率），算出地磁七要素与七个年变率；
 * 并提供「磁方位 ↔ 真方位」换算。不持有任何具体模型的系数，系数由调用方注入
 * （见 {@link createMagneticModel}），因此本模块不知道也不关心当前用的是 WMM2025 还是别的版本。
 *
 * 依赖方向：**本层不得 import src/data/**，具体模型的装配放在数据层（src/data/wmm2025.js），
 * 与本仓库既有的「data 层 import core 层」单向规则一致。
 *
 * 算法要点（与 NOAA / BGS 的 WMM 参考实现等价，由 docs/data/WMM2025_TEST_VALUES.txt 逐行比对验证）：
 *   1) 输入是**大地坐标**（WGS84 椭球面为基准），必须先换算成**地心坐标**（球坐标）再代入球谐级数；
 *      漏掉这一步会造成几十 nT 级的系统误差，是最常见的坑。
 *   2) 缔合勒让德函数用 **Schmidt 半归一化**（地球物理约定，不含 Condon–Shortley 相位），全程递推，
 *      递推系数在装配模型时预计算一次，运行时不再开方、不再算阶乘。
 *   3) 为避免极点处 sin(theta) = 0 除零，递推对象拆成「剥掉 sin^m(theta) 因子的 U 表」，
 *      最后再按 m 乘回幂次；整个算法除参考半径比外不做任何除法，南北极点也不会出现 NaN。
 *   4) 年变率走官方的**线性外推**：g(t) = g + dg·(t − epoch)。磁场关于系数是线性的，
 *      因此把 (g, h) 与 (dg, dh) 两套系数各综合一次，直接得到 B(t) 与 dB/dt，
 *      派生量的年变率再按解析式推导（见 {@link _deriveRates}）。
 *
 * 符号约定（极易搞反，统一在这里定死）：
 *   - D 磁偏角（磁差）：**东偏为正**。水平分量相对真北向东偏 → D > 0。
 *   - X 向北为正、Y 向东为正、Z **向下为正**（南半球常见 Z < 0）。
 *   - H 水平强度 = sqrt(X² + Y²) ≥ 0；F 总强度 = sqrt(H² + Z²)。
 *   - I 磁倾角：向下为正（北半球为正、南半球为负）。
 *   - 单位：分量 nT、角度度、年变率 nT/年 或 度/年。
 *
 * 换算约定：真方位 = 磁方位 + 磁偏角（东偏为正）；反向为 磁方位 = 真方位 − 磁偏角。
 *
 * 红线：纯计算，不读文件、不发请求、不碰任何浏览器全局。
 */

/** 度 → 弧度。 */
const DEG_TO_RAD = Math.PI / 180;

/** 弧度 → 度。 */
const RAD_TO_DEG = 180 / Math.PI;

/** WGS84 椭球长半轴（km）。 */
const WGS84_A_KM = 6378.137;

/** WGS84 扁率。 */
const WGS84_F = 1 / 298.257223563;

/** WGS84 椭球短半轴（km）。 */
const WGS84_B_KM = WGS84_A_KM * (1 - WGS84_F);

/** WGS84 第一偏心率平方 e² = f(2 − f)。 */
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** 水平强度退化为 0 的阈值（nT）：低于它视为落在磁极，D / dD/dt 取 0 而非 NaN。 */
const HORIZONTAL_EPS = 1e-9;

/** 总强度退化为 0 的阈值（nT）：正常地磁道上不会发生，纯防御。 */
const TOTAL_EPS = 1e-9;

/**
 * WGS84 椭球参数（对外只读）。
 *
 * @type {{semiMajorAxisKm:number, semiMinorAxisKm:number, flattening:number, eccentricitySquared:number}}
 */
export const WGS84 = Object.freeze({
  semiMajorAxisKm: WGS84_A_KM,
  semiMinorAxisKm: WGS84_B_KM,
  flattening: WGS84_F,
  eccentricitySquared: WGS84_E2,
});

/**
 * 生成 n = 0..maxDegree 的三角表：行 n 的长度为 n + 1，下标即 m，初值全 0。
 *
 * 注意：由于行长度严格为 n + 1，m > n 的访问会返回 undefined 而不是 0；
 * 调用侧必须显式判断（如 n − 2 >= m），否则会悄悄算出 NaN。
 *
 * @param {number} maxDegree 最高阶数。
 * @returns {number[][]} 三角表。
 */
function _triangularTable(maxDegree) {
  const table = new Array(maxDegree + 1);
  for (let n = 0; n <= maxDegree; n += 1) {
    table[n] = new Array(n + 1).fill(0);
  }
  return table;
}

/**
 * 预计算缔合勒让德递推里只依赖 (n, m) 的三个常数表。
 *
 * 记 x = cos(theta)、U 为「剥离了 sin^m(theta) 因子」的 Schmidt 半归一化缔合勒让德函数，则：
 *   U_{n,m} = A[n][m]·x·U_{n−1,m} − B[n][m]·U_{n−2,m}     （n > m）
 *   U_{n,n} = C[n]·U_{n−1,n−1}                             （扇谐项，n ≥ 2；n = 1 时 U_{1,1} = 1）
 *
 * A、B 由相邻阶 Schmidt 归一化因子的比值化简得到，避免了阶乘。
 *
 * @param {number} maxDegree 最高阶数。
 * @returns {{A:number[][], B:number[][], C:number[]}} 三个常数表。
 */
function _buildRecursionTables(maxDegree) {
  const A = _triangularTable(maxDegree);
  const B = _triangularTable(maxDegree);
  const C = new Array(maxDegree + 1).fill(0);
  for (let n = 1; n <= maxDegree; n += 1) {
    C[n] = Math.sqrt((2 * n - 1) / (2 * n));
    for (let m = 0; m < n; m += 1) {
      A[n][m] = (2 * n - 1) / Math.sqrt((n - m) * (n + m));
      B[n][m] = Math.sqrt(((n + m - 1) * (n - m - 1)) / ((n + m) * (n - m)));
    }
  }
  return { A, B, C };
}

/**
 * 强制入参为有限数字。
 *
 * @param {*} value 入参。
 * @param {string} label 参数名（用于报错文案）。
 * @returns {number} 有限数字。
 * @throws {TypeError} 非有限数字时抛出。
 */
function _finite(value, label) {
  const v = Number(value);
  if (!Number.isFinite(v)) {
    throw new TypeError(`mag: ${label} 必须是有限数字，收到 ${JSON.stringify(value)}`);
  }
  return v;
}

/**
 * 把经度归一到 (−180, 180]。
 *
 * @param {number} lonDeg 经度（度）。
 * @returns {number} 归一化后的经度。
 */
export function wrapLongitude(lonDeg) {
  let lon = lonDeg % 360;
  if (lon > 180) lon -= 360;
  else if (lon <= -180) lon += 360;
  return lon;
}

/**
 * 把方位角归一到 [0, 360)。
 *
 * @param {number} deg 角度（度）。
 * @returns {number} 归一化后的角度；非有限值返回 0。
 */
export function normalizeBearing(deg) {
  const v = Number(deg);
  if (!Number.isFinite(v)) return 0;
  let b = v % 360;
  if (b < 0) b += 360;
  return b;
}

/**
 * 把角度差归一到 (−180, 180]，用于「偏角随经度旋转」这类差值判定。
 *
 * @param {number} diffDeg 角度差（度）。
 * @returns {number} 归一化差值。
 */
export function normalizeSignedAngle(diffDeg) {
  let v = diffDeg % 360;
  if (v > 180) v -= 360;
  else if (v <= -180) v += 360;
  return v;
}

/**
 * 大地坐标（WGS84 椭球面为基准）转地心球坐标。
 *
 * 高度沿椭球法线量取，这是官方测试值里 altitude 的定义；单位 km。
 * 经度在两个坐标系下相同，无需转换。
 *
 * @param {number} latitudeRad 大地纬度（弧度）。
 * @param {number} altitudeKm 高于椭球面的高度（km）。
 * @returns {{latitude:number, radiusKm:number}} 地心纬度（弧度）与地心半径（km）。
 */
function _geodeticToGeocentric(latitudeRad, altitudeKm) {
  const sinLat = Math.sin(latitudeRad);
  const cosLat = Math.cos(latitudeRad);
  // 卯酉圈曲率半径 N
  const primeVertical = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const horizontal = (primeVertical + altitudeKm) * cosLat;
  const vertical = (primeVertical * (1 - WGS84_E2) + altitudeKm) * sinLat;
  const radiusKm = Math.hypot(horizontal, vertical);
  const latitude = Math.atan2(vertical, horizontal);
  return { latitude, radiusKm };
}

/**
 * 构造一次求值所需的几何缓存：U / dU 表、sin^m 幂表、(a/r)^(n+2) 表、cos/sin(m·lon) 表。
 *
 * 统一约定：theta 为**地心余纬**，故 cos(theta) = sin(地心纬度)、sin(theta) = cos(地心纬度)。
 *
 * @param {{maxDegree:number, recursion:{A:number[][], B:number[][], C:number[]}, referenceRadiusKm:number}} ctx 模型上下文。
 * @param {number} sinTheta sin(theta) = cos(地心纬度)。
 * @param {number} cosTheta cos(theta) = sin(地心纬度)。
 * @param {number} lonRad 经度（弧度）。
 * @param {number} radiusKm 地心半径（km）。
 * @returns {{U:number[][], dU:number[][], sinPow:number[], radiusPower:number[], cosMLon:number[], sinMLon:number[], sinTheta:number, cosTheta:number}} 几何缓存。
 */
function _buildGeometry(ctx, sinTheta, cosTheta, lonRad, radiusKm) {
  const { maxDegree, recursion, referenceRadiusKm } = ctx;
  const { A, B, C } = recursion;
  const U = _triangularTable(maxDegree);
  const dU = _triangularTable(maxDegree);

  // sin^m(theta) 幂表：最后统一乘回，避免每项现算 pow
  const sinPow = new Array(maxDegree + 1).fill(1);
  for (let m = 1; m <= maxDegree; m += 1) sinPow[m] = sinPow[m - 1] * sinTheta;

  U[0][0] = 1;
  dU[0][0] = 0;
  for (let n = 1; n <= maxDegree; n += 1) {
    for (let m = 0; m <= n; m += 1) {
      if (m === n) {
        if (n === 1) {
          // S_1^1 = sin(theta)，剥掉因子后 U_1^1 ≡ 1，对 theta 求导恒为 0
          U[1][1] = 1;
          dU[1][1] = 0;
        } else {
          U[n][n] = C[n] * U[n - 1][n - 1];
          dU[n][n] = C[n] * dU[n - 1][n - 1];
        }
        continue;
      }
      const prev = U[n - 1][m];
      const prevD = dU[n - 1][m];
      // n − 2 < m 时 U_{n−2,m} 不存在，按 0 处理（此时 B[n][m] 也恰为 0）
      const prev2 = n - 2 >= m ? U[n - 2][m] : 0;
      const prev2D = n - 2 >= m ? dU[n - 2][m] : 0;
      const a = A[n][m];
      const b = B[n][m];
      U[n][m] = a * cosTheta * prev - b * prev2;
      // dx/dθ = −sinθ，Leibniz 展开：d(x·U)/dθ = −sinθ·U + cosθ·dU/dθ
      dU[n][m] = a * (-sinTheta * prev + cosTheta * prevD) - b * prev2D;
    }
  }

  // (参考半径 / 地心半径)^(n+2)：沿阶递推，避免幂运算
  const radiusPower = new Array(maxDegree + 1).fill(0);
  const ratio = referenceRadiusKm / radiusKm;
  let scale = ratio * ratio;
  for (let n = 1; n <= maxDegree; n += 1) {
    scale *= ratio;
    radiusPower[n] = scale;
  }

  const cosMLon = new Array(maxDegree + 1).fill(1);
  const sinMLon = new Array(maxDegree + 1).fill(0);
  const cosLon = Math.cos(lonRad);
  const sinLon = Math.sin(lonRad);
  for (let m = 1; m <= maxDegree; m += 1) {
    cosMLon[m] = cosMLon[m - 1] * cosLon - sinMLon[m - 1] * sinLon;
    sinMLon[m] = sinMLon[m - 1] * cosLon + cosMLon[m - 1] * sinLon;
  }

  return { U, dU, sinPow, radiusPower, cosMLon, sinMLon, sinTheta, cosTheta };
}

/**
 * 对一套高斯系数做球谐综合，得到**地心坐标下**的三分量（nT）。
 *
 * 记 north = X′（向北为正）、east = Y（向东为正）、down = Z′（向下为正），则
 * Z′ = −B_r、X′ = −B_theta、Y = B_phi。
 *
 * @param {{maxDegree:number}} ctx 模型上下文（需含 maxDegree）。
 * @param {{U:number[][], dU:number[][], sinPow:number[], radiusPower:number[], cosMLon:number[], sinMLon:number[], sinTheta:number, cosTheta:number}} geo `_buildGeometry` 的结果。
 * @param {number[][]} coefG g 类系数表（换成 dg 表即得年变率，磁场关于系数线性）。
 * @param {number[][]} coefH h 类系数表。
 * @returns {{north:number, east:number, down:number}} 地心三分量（nT）。
 */
function _sumComponents(ctx, geo, coefG, coefH) {
  const { maxDegree } = ctx;
  const { U, dU, sinPow, radiusPower, cosMLon, sinMLon, cosTheta } = geo;
  let north = 0;
  let east = 0;
  let down = 0;
  for (let n = 1; n <= maxDegree; n += 1) {
    const rr = radiusPower[n];
    const rowG = coefG[n];
    const rowH = coefH[n];
    for (let m = 0; m <= n; m += 1) {
      const g = rowG[m];
      const h = rowH[m];
      if (g === 0 && h === 0) continue;
      // g·cos(mλ) + h·sin(mλ)
      const base = g * cosMLon[m] + h * sinMLon[m];
      const u = U[n][m];
      const du = dU[n][m];
      // S = U·sin^m(theta)
      const s = u * sinPow[m];
      // dS/dθ = dU·sin^m + U·m·sin^(m−1)·cos(theta)
      const ds = du * sinPow[m] + (m > 0 ? u * m * sinPow[m - 1] * cosTheta : 0);
      north += rr * base * ds;
      down -= rr * (n + 1) * base * s;
      if (m > 0) {
        // (S / sinθ) = U·sin^(m−1)，极点处也不会除零
        const sOverSinTheta = u * sinPow[m - 1];
        east += rr * m * sOverSinTheta * (g * sinMLon[m] - h * cosMLon[m]);
      }
    }
  }
  return { north, east, down };
}

/**
 * 把地心坐标系下的三分量旋转到**大地（当地水平）坐标系**。
 *
 * Δ = 大地纬度 − 地心纬度：
 *   X = X′·cosΔ + Z′·sinΔ
 *   Z = Z′·cosΔ − X′·sinΔ
 *   Y 不变
 * 漏掉这一步会在中纬度引入约 0.2° 的方向偏差。
 *
 * @param {{north:number, east:number, down:number}} v 地心分量（nT）。
 * @param {number} cosDelta cos(Δ)。
 * @param {number} sinDelta sin(Δ)。
 * @returns {{north:number, east:number, down:number}} 大地分量（nT）。
 */
function _rotateToGeodetic(v, cosDelta, sinDelta) {
  return {
    north: v.north * cosDelta + v.down * sinDelta,
    east: v.east,
    down: v.down * cosDelta - v.north * sinDelta,
  };
}

/**
 * 由三分量推导七要素（D / I / H / X / Y / Z / F）。
 *
 * @param {{north:number, east:number, down:number}} v 大地分量（nT）。
 * @returns {{declination:number, inclination:number, horizontal:number, north:number, east:number, down:number, total:number}} 七要素。
 */
function _deriveElements(v) {
  const horizontal = Math.hypot(v.north, v.east);
  const total = Math.hypot(horizontal, v.down);
  const declination = horizontal > HORIZONTAL_EPS ? Math.atan2(v.east, v.north) * RAD_TO_DEG : 0;
  const inclination = Math.atan2(v.down, horizontal) * RAD_TO_DEG;
  return {
    declination,
    inclination,
    horizontal,
    north: v.north,
    east: v.east,
    down: v.down,
    total,
  };
}

/**
 * 由三分量及其年变率推导七个年变率（度/年 与 nT/年）。
 *
 * 记 H = 水平强度、F = 总强度，按解析式逐项求导：
 *   dH/dt = (X·Ẋ + Y·Ẏ) / H
 *   dF/dt = (X·Ẋ + Y·Ẏ + Z·Ż) / F
 *   dD/dt = (X·Ẏ − Y·Ẋ) / (X² + Y²)          [弧度/年 → 度/年]
 *   dI/dt = (H·Ż − Z·Ḣ) / (H² + Z²)          [弧度/年 → 度/年]
 *
 * @param {{declination:number, inclination:number, horizontal:number, north:number, east:number, down:number, total:number}} e 七要素。
 * @param {{north:number, east:number, down:number}} rate 三分量年变率（nT/年）。
 * @returns {{declination:number, inclination:number, horizontal:number, north:number, east:number, down:number, total:number}} 七个年变率。
 */
function _deriveRates(e, rate) {
  const x = e.north;
  const y = e.east;
  const z = e.down;
  const h = e.horizontal;
  const f = e.total;

  const horizontalRate = h > HORIZONTAL_EPS ? (x * rate.north + y * rate.east) / h : 0;
  const totalRate = f > TOTAL_EPS ? (x * rate.north + y * rate.east + z * rate.down) / f : 0;
  const declinationRate = h > HORIZONTAL_EPS ? ((x * rate.east - y * rate.north) / (h * h)) * RAD_TO_DEG : 0;
  const inclinationRate =
    h > HORIZONTAL_EPS && f > TOTAL_EPS ? ((h * rate.down - z * horizontalRate) / (f * f)) * RAD_TO_DEG : 0;

  return {
    declination: declinationRate,
    inclination: inclinationRate,
    horizontal: horizontalRate,
    north: rate.north,
    east: rate.east,
    down: rate.down,
    total: totalRate,
  };
}

/**
 * 把 Date 转成十进制年（按公历年长度比例换算，精度足够模型使用）。
 *
 * 不读时钟：`date` 必须由调用方传入，保持本模块纯函数。
 *
 * @param {Date} date 日期对象（按 UTC 换算）。
 * @returns {number} 十进制年，如 2025.37。
 */
export function decimalYearFromDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('mag: decimalYearFromDate 需要一个合法的 Date 实例');
  }
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const next = Date.UTC(year + 1, 0, 1);
  const fraction = (date.getTime() - start) / (next - start);
  return year + fraction;
}

/**
 * 用一套高斯系数装配出可用的地磁模型。
 *
 * 这是 data 层与 core 层的接缝：core 只认系数，不认模型；data 层负责把某一版模型的
 * 系数（如 WMM2025）注入进来。装配时完成系数形状校验与递推表的预计算。
 *
 * @param {object} config 系数与元信息。
 * @param {object} config.model 模型元信息，至少含 name / epoch / maxDegree，建议含 validFrom / validUntil。
 * @param {number} config.maxDegree 最高阶数。
 * @param {number} config.epoch 系数历元（十进制年），年变率线性外推的时间基准。
 * @param {number} config.referenceRadiusKm 磁势参考球半径（km，WMM 系列为 6371.2）。
 * @param {number[][]} config.g SCHMIDT 系数 g[n][m]（nT）。
 * @param {number[][]} config.h SCHMIDT 系数 h[n][m]（nT）。
 * @param {number[][]} config.dg g 的年变率 dg[n][m]（nT/年）。
 * @param {number[][]} config.dh h 的年变率 dh[n][m]（nT/年）。
 * @returns {{
 *   model:object, maxDegree:number, epoch:number, referenceRadiusKm:number,
 *   compute:(p:object)=>object, declination:(p:object)=>number, validity:(y:number)=>object
 * }} 冻结后的模型实例。
 */
export function createMagneticModel({ model, maxDegree, epoch, referenceRadiusKm, g, h, dg, dh }) {
  const maxDegreeValue = _finite(maxDegree, 'maxDegree');
  const epochValue = _finite(epoch, 'epoch');
  const referenceRadiusValue = _finite(referenceRadiusKm, 'referenceRadiusKm');
  if (!Number.isInteger(maxDegreeValue) || maxDegreeValue < 1) {
    throw new RangeError(`mag: maxDegree 必须是不小于 1 的整数，收到 ${maxDegreeValue}`);
  }
  for (const [name, table] of [['g', g], ['h', h], ['dg', dg], ['dh', dh]]) {
    if (!Array.isArray(table)) throw new TypeError(`mag: ${name} 必须是二维数组`);
    for (let n = 1; n <= maxDegreeValue; n += 1) {
      if (!Array.isArray(table[n]) || table[n].length !== n + 1) {
        throw new TypeError(`mag: ${name}[${n}] 长度应为 ${n + 1}`);
      }
      for (let m = 0; m <= n; m += 1) {
        if (!Number.isFinite(table[n][m])) throw new TypeError(`mag: ${name}[${n}][${m}] 必须是有限数字`);
      }
    }
  }

  /** 模型上下文：一次装配、多次复用。 */
  const ctx = {
    maxDegree: maxDegreeValue,
    recursion: _buildRecursionTables(maxDegreeValue),
    referenceRadiusKm: referenceRadiusValue,
  };

  /**
   * 判定给定年份是否落在模型有效期内，产出模型有效期提示。
   *
   * ★这里的中文是**故意留下的**，不属于本次中英改造范围，理由如下：
   *   1) `warning` 是**开发者 / 排障**看的诊断串，不是给最终用户读的界面文案 ——
   *      compass.js 被明确禁止把 warning 原样上屏（tests 里有 `!/mag\.warning/` 断言守着），
   *      真要上屏必须另走 i18n 键；
   *   2) 本模块在 core 层，**不许 import src/i18n/**（core ← data ← ui ← html 单向依赖），
   *      而 mag 的 throw 消息只在参数用错时出现（程序员的错，线上的用户永远不会触发）。
   *   把这两类串搬进文案表，只会让「漏翻即报红」的护栏多出一堆永远用不上的键，
   *   反而稀释真正要看的那 568 条。
   *
   * @param {number} decimalYear 十进制年。
   * @returns {{valid:boolean, expired:boolean, ahead:boolean, overshootYears:number, warning:string|null, level:string}} 判定结果。
   */
  function validity(decimalYear) {
    const year = _finite(decimalYear, 'decimalYear');
    const validFrom = Number.isFinite(model.validFrom) ? model.validFrom : epochValue;
    const validUntil = Number.isFinite(model.validUntil) ? model.validUntil : epochValue + 5;
    const name = model.name || '未命名模型';

    let overshootYears = 0;
    if (year > validUntil) overshootYears = year - validUntil;
    else if (year < validFrom) overshootYears = year - validFrom;

    const expired = year > validUntil;
    const ahead = year < validFrom;
    const valid = !expired && !ahead;

    let warning = null;
    let level = 'ok';
    if (expired) {
      level = 'error';
      warning = `${name} 有效期为 ${validFrom.toFixed(1)}–${validUntil.toFixed(1)}，当前 ${year.toFixed(1)} 已超出 ${overshootYears.toFixed(1)} 年，磁偏角误差可能显著增大，请更新模型。`;
    } else if (ahead) {
      level = 'error';
      warning = `${name} 有效期为 ${validFrom.toFixed(1)}–${validUntil.toFixed(1)}，当前 ${year.toFixed(1)} 早于模型历元 ${Math.abs(overshootYears).toFixed(1)} 年，结果为回溯推值，仅供参考。`;
    }
    return { valid, expired, ahead, overshootYears, warning, level };
  }

  /**
   * 计算给定地点与年份的地磁要素与年变率。
   *
   * @param {object} params 入参。
   * @param {number} params.latitude 大地纬度（度，北正，±90）。
   * @param {number} params.longitude 大地经度（度，东正，任意实数会被归一）。
   * @param {number} [params.altitudeKm=0] 高于 WGS84 椭球面的高度（km）。
   * @param {number} [params.decimalYear] 十进制年；缺省为模型历元。
   * @returns {object} 七要素（可读名 + symbols 官方记号）、七年变率（rates + symbolRates）与有效期标记。
   * @throws {RangeError} 纬度越界时抛出。
   * @throws {TypeError} 入参非有限数字时抛出。
   */
  function compute({ latitude, longitude, altitudeKm = 0, decimalYear = epochValue } = {}) {
    const latDeg = _finite(latitude, 'latitude');
    const lonDegRaw = _finite(longitude, 'longitude');
    const altKm = _finite(altitudeKm, 'altitudeKm');
    const year = _finite(decimalYear, 'decimalYear');
    if (latDeg < -90 || latDeg > 90) {
      throw new RangeError(`mag: latitude 必须在 ±90 之间，收到 ${latDeg}`);
    }
    const lonDeg = wrapLongitude(lonDegRaw);
    const latRad = latDeg * DEG_TO_RAD;
    const lonRad = lonDeg * DEG_TO_RAD;

    /* 1) 大地 → 地心 */
    const geocentric = _geodeticToGeocentric(latRad, altKm);

    /* 2) 几何缓存：theta 为地心余纬，cosθ = sin(地心纬度)、sinθ = cos(地心纬度) */
    const geo = _buildGeometry(ctx, Math.cos(geocentric.latitude), Math.sin(geocentric.latitude), lonRad, geocentric.radiusKm);

    /* 3) 双套系数综合：(g,h) 得历元场值、(dg,dh) 得年变率（nT/年） */
    const baseVec = _sumComponents(ctx, geo, g, h);
    const rateVec = _sumComponents(ctx, geo, dg, dh);

    /* 4) 线性外推到目标年份：g(t) = g + dg·(t − epoch)，分量层面同样成立 */
    const deltaYears = year - epochValue;
    const atYear = {
      north: baseVec.north + rateVec.north * deltaYears,
      east: baseVec.east + rateVec.east * deltaYears,
      down: baseVec.down + rateVec.down * deltaYears,
    };

    /* 5) 旋转到大地（当地水平）坐标系：Δ = 大地纬度 − 地心纬度 */
    const delta = latRad - geocentric.latitude;
    const cosDelta = Math.cos(delta);
    const sinDelta = Math.sin(delta);
    const field = _rotateToGeodetic(atYear, cosDelta, sinDelta);
    const rateGeodetic = _rotateToGeodetic(rateVec, cosDelta, sinDelta);

    /* 6) 七要素与七个年变率 */
    const elements = _deriveElements(field);
    const rates = _deriveRates(elements, rateGeodetic);
    const status = validity(year);

    return {
      model,
      decimalYear: year,
      location: {
        latitude: latDeg,
        longitude: lonDeg,
        altitudeKm: altKm,
        geocentricLatitude: geocentric.latitude * RAD_TO_DEG,
        geocentricRadiusKm: geocentric.radiusKm,
      },
      declination: elements.declination,
      inclination: elements.inclination,
      horizontal: elements.horizontal,
      north: elements.north,
      east: elements.east,
      vertical: elements.down,
      total: elements.total,
      rates: {
        declination: rates.declination,
        inclination: rates.inclination,
        horizontal: rates.horizontal,
        north: rates.north,
        east: rates.east,
        vertical: rates.down,
        total: rates.total,
      },
      symbols: {
        D: elements.declination,
        I: elements.inclination,
        H: elements.horizontal,
        X: elements.north,
        Y: elements.east,
        Z: elements.down,
        F: elements.total,
      },
      symbolRates: {
        dD: rates.declination,
        dI: rates.inclination,
        dH: rates.horizontal,
        dX: rates.north,
        dY: rates.east,
        dZ: rates.down,
        dF: rates.total,
      },
      valid: status.valid,
      expired: status.expired,
      ahead: status.ahead,
      overshootYears: status.overshootYears,
      warning: status.warning,
      level: status.level,
    };
  }

  /**
   * 只要磁偏角时的便捷封装。
   *
   * @param {object} params 同 {@link compute} 的入参。
   * @returns {number} 磁偏角（度，东偏为正）。
   */
  function declination(params) {
    return compute(params).declination;
  }

  return Object.freeze({ model, maxDegree: maxDegreeValue, epoch: epochValue, referenceRadiusKm: referenceRadiusValue, compute, declination, validity });
}

/**
 * 磁方位 → 真方位。
 *
 * 约定：**真方位 = 磁方位 + 磁偏角**（磁偏角东偏为正）。
 * 例：某处磁偏角 +10°（磁北在真北以东 10°），罗盘读磁方位 0°（指向磁北）时真方位为 10°。
 *
 * @param {number} magneticBearingDeg 磁方位（度，任意实数）。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {number} 真方位（度，已归一到 [0, 360)）。
 */
export function trueBearingFromMagnetic(magneticBearingDeg, declinationDeg) {
  const bearing = _finite(magneticBearingDeg, 'magneticBearingDeg');
  const declination = _finite(declinationDeg, 'declinationDeg');
  return normalizeBearing(bearing + declination);
}

/**
 * 真方位 → 磁方位（{@link trueBearingFromMagnetic} 的逆运算）。
 *
 * 约定：**磁方位 = 真方位 − 磁偏角**（磁偏角东偏为正）。
 *
 * @param {number} trueBearingDeg 真方位（度，任意实数）。
 * @param {number} declinationDeg 磁偏角（度，东偏为正）。
 * @returns {number} 磁方位（度，已归一到 [0, 360)）。
 */
export function magneticBearingFromTrue(trueBearingDeg, declinationDeg) {
  const bearing = _finite(trueBearingDeg, 'trueBearingDeg');
  const declination = _finite(declinationDeg, 'declinationDeg');
  return normalizeBearing(bearing - declination);
}
