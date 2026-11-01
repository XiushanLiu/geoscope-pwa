/**
 * 应用图标门禁（任务 C：通用十字准星 → 自有罗盘图标）。
 *
 * 四条防线，各管一件事：
 *   1. 四枚 PNG 真实存在且是**合法 PNG**（签名 + IHDR 尺寸对得上 + 不是几百字节的空壳）；
 *   2. manifest 的每个 `src` 都指向真实存在的文件（★指着不存在的文件，安装横幅直接不弹）；
 *   3. 5 个页面的 head 都换成真实 PNG 引用 —— 而**单文件诊断产物必须仍然是内联
 *      data-URI**（它没有服务器可回退，这是它的自包含红线）；
 *   4. maskable 安全区算式独立断言（Android 会把 maskable 图标裁成圆形，画到边上的
 *      内容会被切掉 —— 这条不是「照抄实现」，是照 Android 的裁切规则独立算一遍）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG_SIGNATURE, ICON_SPECS, MASKABLE_SAFE_SCALE, RING_R, RING_W, NEEDLE_L, DOT_R } from '../tools/make-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库根目录下读文件。 */
const read = (rel) => readFileSync(join(ROOT, rel));
const exists = (rel) => existsSync(join(ROOT, rel));

/** 五个手写页面（单文件诊断产物单独验，规约不同）。 */
const PAGES = ['index.html', 'compass.html', 'settings.html', 'compare.html', 'selfcheck.html'];

/**
 * 解析 PNG 的 IHDR 字段。
 *
 * @param {Buffer} buf PNG 字节流。
 * @returns {{width:number, height:number, bitDepth:number, colorType:number}} IHDR 字段。
 */
function parseIhdr(buf) {
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

/* ------------------------------------------------------------------ */
/* 1. 四枚 PNG 必须是真实位图                                          */
/* ------------------------------------------------------------------ */

test('★四枚图标 PNG 真实存在：签名正确、IHDR 宽高对得上、不是空壳', () => {
  for (const spec of ICON_SPECS) {
    assert.ok(exists(`icons/${spec.file}`), `icons/${spec.file} 必须存在（先跑 node tools/make-icons.mjs）`);
    const buf = read(`icons/${spec.file}`);

    // ① PNG 签名（8 字节）
    assert.ok(
      buf.subarray(0, 8).equals(PNG_SIGNATURE),
      `${spec.file} 的文件头必须是 PNG 签名 89 50 4E 47 0D 0A 1A 0A，实际：${buf.subarray(0, 8).toString('hex')}`
    );

    // ② IHDR 宽高与规格一致（写 512 就得真是 512，manifest 的 sizes 说谎会拖垮安装判定）
    const ihdr = parseIhdr(buf);
    assert.equal(ihdr.width, spec.size, `${spec.file} 的 IHDR 宽必须 = ${spec.size}`);
    assert.equal(ihdr.height, spec.size, `${spec.file} 的 IHDR 高必须 = ${spec.size}`);
    assert.equal(ihdr.bitDepth, 8, `${spec.file} 必须是 8 bit/通道`);

    // ③ 不是空壳：纯色块 deflate 后也在 1 KB 以内，真图形不可能这么小
    assert.ok(
      buf.length > 1000,
      `${spec.file} 只有 ${buf.length} B —— 空壳 / 纯色块，图形没画出来`
    );
  }
});

/* ------------------------------------------------------------------ */
/* 2. manifest 图标登记                                                */
/* ------------------------------------------------------------------ */

test('★manifest.webmanifest：图标全部指向真实文件，且必须有 maskable 位图', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  const icons = manifest.icons;

  assert.ok(Array.isArray(icons) && icons.length >= 3, `manifest 必须登记 ≥3 枚图标，实际 ${icons.length}`);
  for (const icon of icons) {
    // ★不许回到 data-URI：安装流程要的是可被桌面进程读取的真位图
    assert.ok(!String(icon.src).startsWith('data:'), '图标不许用 data-URI（安装流程拿不到）');
    assert.ok(exists(icon.src), `manifest 图标 ${icon.src} 指向的文件必须真实存在`);
    const ihdr = parseIhdr(read(icon.src));
    const [w, h] = String(icon.sizes).split('x').map(Number);
    assert.equal(ihdr.width, w, `${icon.src} 的实际宽度必须与 sizes 声明一致`);
    assert.equal(ihdr.height, h, `${icon.src} 的实际高度必须与 sizes 声明一致`);
    assert.equal(icon.type, 'image/png', `${icon.src} 必须声明 image/png`);
  }

  const purposes = icons.map((i) => i.purpose);
  assert.ok(purposes.includes('any'), '必须有 purpose: any（安装横幅）');
  assert.ok(purposes.includes('maskable'), '必须有 purpose: maskable（Android 会裁圆）');
});

/* ------------------------------------------------------------------ */
/* 3. 页面 head 接线                                                   */
/* ------------------------------------------------------------------ */

test('★5 个页面：icon 与 apple-touch-icon 都指向真实 PNG（不许再是占位 SVG）', () => {
  for (const page of PAGES) {
    const src = read(page).toString('utf8');
    assert.ok(
      src.includes('<link rel="icon" href="icons/icon-192.png" />'),
      `${page} 的 <link rel="icon"> 必须指向 icons/icon-192.png`
    );
    assert.ok(
      src.includes('<link rel="apple-touch-icon" href="icons/apple-touch-icon-180.png" />'),
      `${page} 必须给 iOS 一行 apple-touch-icon`
    );
    assert.ok(
      !src.includes('rel="icon" href="data:image/svg+xml'),
      `${page} 不许再挂通用十字准星占位 SVG`
    );
  }
});

test('★selfcheck-standalone.html：favicon 必须仍然是内联 data-URI（自包含红线）', () => {
  const src = read('selfcheck-standalone.html').toString('utf8');
  assert.ok(
    /<link rel="icon" href="data:image\/svg\+xml/.test(src),
    '单文件产物没有服务器可回退，favicon 必须内联，不许指向 icons/*.png'
  );
  assert.ok(!/icons\//.test(src), '单文件产物不许引用任何 icons/ 外部文件');
  assert.ok(
    !/apple-touch-icon/.test(src),
    '单文件产物用不上 iOS 主屏图标，apple-touch-icon 必须被构建脚本剥掉'
  );
});

/* ------------------------------------------------------------------ */
/* 4. maskable 安全区（独立算式）                                      */
/* ------------------------------------------------------------------ */

test('★maskable 安全区：内容最外沿必须缩进 Android 安全区（半径 0.4）以内', () => {
  // Android 的 maskable 安全区 = 直径 80% 的内切圆，即半径 0.4（0.5 × 0.8）。
  // maskable 版内容整体乘 MASKABLE_SAFE_SCALE，最外沿是外圈的外缘。
  const outermost = Math.max(RING_R + RING_W / 2, NEEDLE_L, DOT_R) * MASKABLE_SAFE_SCALE;
  assert.ok(
    outermost <= 0.4,
    `maskable 内容最外沿 ${outermost.toFixed(3)} 必须落进安全区半径 0.4 以内，否则会被裁切`
  );
  // ★缩放必须真的小于 1：scale = 1 的 maskable 版会被裁掉外圈（变异验证 ② 的锚点）
  assert.ok(MASKABLE_SAFE_SCALE < 1, 'maskable 内容缩放必须 < 1（画满幅 = 外圈被 Android 裁掉）');
});
