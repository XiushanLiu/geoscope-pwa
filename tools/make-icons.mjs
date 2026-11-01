/**
 * 生成应用图标（4 个 PNG）。
 *
 * ★为什么自己写：本仓红线是「零 npm / 零 CDN / 无构建步骤」，所以**不能**引
 *   canvas / sharp / pngjs / ImageMagick。这里只用 Node 内置的 `node:fs` / `node:zlib`
 *   / `node:path`，光栅化与 PNG 编码全部手写（签名 + IHDR/IDAT/IEND，扫描线走
 *   `zlib.deflateSync`，CRC32 自己算）。
 *
 * ★为什么不能只留 SVG：PWA 安装横幅、Android 桌面图标、iOS 主屏图标都只认位图
 *   （manifest 里给 SVG 在安装流程上是会被跳过的），所以必须出真 PNG。
 *
 * 图形：品牌青满铺底 + 白色细环 + 斜指右上的双色罗盘针（指向那半纯白、尾半 55% 白）。
 * ★不用红色：红在本项目里是「磁北针 / 失败态」的语义色，图标里出现红会与它打架。
 *
 * 用法：node tools/make-icons.mjs
 * 产物：icons/icon-192.png / icon-512.png / icon-maskable-512.png / apple-touch-icon-180.png
 *
 * ★本模块被 `tests/icons.test.mjs` import（复用同一套几何常量做独立断言），
 *   所以 `main()` 只在**直接运行**时执行 —— 否则跑测试就会顺手重新生成一遍图标。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

/* ------------------------------------------------------------------ */
/* 图形常量（归一化：1.0 = 图标边长）                                   */
/* ------------------------------------------------------------------ */

/** 品牌青 #1E9C8C（与 styles/tokens.css 的 --c-brand、manifest.theme_color 同色）。 */
export const TEAL = [30, 156, 140];

/** 白。 */
export const WHITE = [255, 255, 255];

/** 针尾那半的白色不透明度（指向那半是 100%）。 */
export const TAIL_ALPHA = 0.55;

/** 外圈半径（占边长）。 */
export const RING_R = 0.34;

/** 外圈线宽（占边长）。 */
export const RING_W = 0.04;

/** 罗盘针半长（沿 45° 轴），菱形总长 = 2×。 */
export const NEEDLE_L = 0.26;

/** 罗盘针半宽（细长菱形）。 */
export const NEEDLE_W = 0.065;

/**
 * 中心白圆点半径。
 *
 * ★必须**大于**针的半宽（NEEDLE_W = 0.065）：小于它时圆点只盖住菱形腰的一半，
 *   会在针尾（55% 白）上咬出一个「缺口」状的伪影；盖过整段腰，它才读作一枚轴心。
 */
export const DOT_R = 0.075;

/**
 * maskable 版的内容缩放：整体缩到中心 80% 的安全区。
 *
 * ★为什么必须是 0.8：Android 会把 `purpose: maskable` 的图标按圆形/水滴形裁切，
 *   安全区是直径 80% 的内切圆（半径 0.4）。画到边上的内容会被切掉 —— 所以外圈要
 *   留白，而不是贴边。tests/icons.test.mjs 拿它做独立断言。
 */
export const MASKABLE_SAFE_SCALE = 0.8;

/** 非 maskable 版：内容占满整幅（iOS 自己加圆角，给了反而出现双圆角）。 */
export const FULL_SCALE = 1.0;

/** 超采样倍数（4× = 每边 4 个亚采样点，共 16 点/像素）。小图标不超采就是锯齿。 */
export const SUPERSAMPLE = 4;

/** 针的朝向：右上 45°（屏幕坐标 y 向下，所以 y 分量取负）。 */
const AXIS_X = Math.SQRT1_2;
const AXIS_Y = -Math.SQRT1_2;

/* ------------------------------------------------------------------ */
/* 光栅化                                                              */
/* ------------------------------------------------------------------ */

/**
 * 判断点是否落在三角形内（重心坐标符号法，边界按「在内」处理）。
 *
 * @param {number} px 点 x。
 * @param {number} py 点 y。
 * @param {number[]} a 顶点 A。
 * @param {number[]} b 顶点 B。
 * @param {number[]} c 顶点 C。
 * @returns {boolean} 在内为 true。
 */
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 罗盘针的四个顶点（内容空间，中心恒为 0.5/0.5）。
 *
 * @returns {{tip:number[], tail:number[], sideA:number[], sideB:number[]}} 四个顶点。
 */
function needlePoints() {
  const cx = 0.5;
  const cy = 0.5;
  // 垂直于轴的单位向量
  const vx = -AXIS_Y;
  const vy = AXIS_X;
  const tip = [cx + AXIS_X * NEEDLE_L, cy + AXIS_Y * NEEDLE_L];
  const tail = [cx - AXIS_X * NEEDLE_L, cy - AXIS_Y * NEEDLE_L];
  const sideA = [cx + vx * NEEDLE_W, cy + vy * NEEDLE_W];
  const sideB = [cx - vx * NEEDLE_W, cy - vy * NEEDLE_W];
  return { tip, tail, sideA, sideB };
}

/**
 * 对内容空间里的一点求色（不含抗锯齿：单点采样）。
 *
 * 叠放顺序：青底 → 针尾（55% 白）→ 针尖（纯白）→ 中心白点 → 外圈白环。
 * 针长 0.26 < 环内径 0.32，所以针与环**不重叠**，顺序只影响中心那一小块。
 *
 * @param {number} nx 归一化 x（0..1）。
 * @param {number} ny 归一化 y（0..1）。
 * @returns {number[]} [r,g,b]。
 */
function shade(nx, ny) {
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const d2 = dx * dx + dy * dy;

  /** 白色覆盖度。 */
  let a = 0;

  const { tip, tail, sideA, sideB } = needlePoints();
  if (inTriangle(nx, ny, tail, sideA, sideB)) a = TAIL_ALPHA;
  if (inTriangle(nx, ny, tip, sideA, sideB)) a = 1;
  if (d2 <= DOT_R * DOT_R) a = 1;

  const d = Math.sqrt(d2);
  if (Math.abs(d - RING_R) <= RING_W / 2) a = 1;

  return [
    TEAL[0] * (1 - a) + WHITE[0] * a,
    TEAL[1] * (1 - a) + WHITE[1] * a,
    TEAL[2] * (1 - a) + WHITE[2] * a,
  ];
}

/**
 * 光栅化一枚方形图标。
 *
 * @param {number} size 边长（px）。
 * @param {number} scale 内容缩放（1.0 满幅 / 0.8 maskable 安全区）。
 * @returns {Buffer} RGB 逐行像素（无 alpha：底色满铺，不留透明边）。
 */
export function rasterize(size, scale) {
  const ss = SUPERSAMPLE;
  const samples = ss * ss;
  const raw = Buffer.alloc(size * (1 + size * 3), 0);
  const inv = 1 / size;

  for (let y = 0; y < size; y += 1) {
    const rowAt = y * (1 + size * 3);
    raw[rowAt] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        const py = (y + (sy + 0.5) / ss) * inv;
        for (let sx = 0; sx < ss; sx += 1) {
          const px = (x + (sx + 0.5) / ss) * inv;
          // 输出像素 → 内容空间：maskable 把内容往中心收，其余满幅
          const nx = (px - 0.5) / scale + 0.5;
          const ny = (py - 0.5) / scale + 0.5;
          const c = shade(nx, ny);
          sr += c[0];
          sg += c[1];
          sb += c[2];
        }
      }
      const at = rowAt + 1 + x * 3;
      raw[at] = Math.round(sr / samples);
      raw[at + 1] = Math.round(sg / samples);
      raw[at + 2] = Math.round(sb / samples);
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* PNG 编码（零依赖手写）                                              */
/* ------------------------------------------------------------------ */

/** PNG 文件签名（8 字节，固定）。 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32 表（IEEE 802.3 多项式 0xEDB88320，与 zlib 同一套）。 */
const CRC_TABLE = (() => {
  /** @type {number[]} */
  const table = new Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * 计算 CRC32（PNG 每个 chunk 的校验字段）。
 *
 * @param {Buffer} buf 参与校验的字节（chunk type + data）。
 * @returns {number} 无符号 32 位 CRC。
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 组装一个 PNG chunk（长度 + 类型 + 数据 + CRC）。
 *
 * @param {string} type 四字符 chunk 类型。
 * @param {Buffer} data chunk 数据。
 * @returns {Buffer} 完整 chunk 字节。
 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGB 逐行像素编成一份完整的 PNG 字节流。
 *
 * 色彩类型 2（truecolor，8 bit）—— 底色是满铺的，四枚图标都不需要 alpha 通道
 * （★刻意不留透明角：透明角在 Android 上会被填成任意底色，在 iOS 上会出现双圆角）。
 *
 * @param {number} width 宽。
 * @param {number} height 高。
 * @param {Buffer} raw 逐行像素（`filter: None`，每行前导一个 0 字节）。
 * @returns {Buffer} PNG 字节流。
 */
export function encodePng(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive（每行的 filter 字节已写在 raw 里）
  ihdr[12] = 0; // interlace: none
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* 产物清单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 四枚图标的规格。
 *
 * @type {{file:string, size:number, scale:number, purpose:string}[]}
 */
export const ICON_SPECS = [
  // `any`：浏览器 / 安装横幅用，满幅铺底
  { file: 'icon-192.png', size: 192, scale: FULL_SCALE, purpose: 'any' },
  { file: 'icon-512.png', size: 512, scale: FULL_SCALE, purpose: 'any' },
  // `maskable`：Android 会裁成圆形/水滴形，内容必须缩进安全区
  { file: 'icon-maskable-512.png', size: 512, scale: MASKABLE_SAFE_SCALE, purpose: 'maskable' },
  // iOS 主屏：不透明、满幅、无圆角（系统自己加圆角）
  { file: 'apple-touch-icon-180.png', size: 180, scale: FULL_SCALE, purpose: 'apple-touch' },
];

/**
 * 生成一枚图标并落盘。
 *
 * @param {{file:string, size:number, scale:number}} spec 图标规格。
 * @returns {{file:string, bytes:number}} 文件名与写入字节数。
 */
function writeIcon(spec) {
  const png = encodePng(spec.size, spec.size, rasterize(spec.size, spec.scale));
  const target = join(OUT_DIR, spec.file);
  writeFileSync(target, png);
  return { file: spec.file, bytes: png.length };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 主流程：建 icons/ 目录并写出四枚 PNG。
 *
 * @returns {void}
 */
function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const spec of ICON_SPECS) {
    const done = writeIcon(spec);
    process.stdout.write(`  ${done.file}  ${spec.size}×${spec.size}  ${done.bytes} B\n`);
  }
  process.stdout.write(`已生成 ${ICON_SPECS.length} 枚图标 → ${OUT_DIR}\n`);
}

// ★只在「直接运行本文件」时执行：tests/icons.test.mjs 会 import 这里的几何常量，
//   若不加这道门，每次跑测试都会顺手把图标重新生成一遍。
const invokedDirectly =
  Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main();
}
