/**
 * data/sources.js 契约验证 + i18n 完整性
 *
 * 覆盖：六源的 timeoutMs / retry / ttlMs 与架构文档逐项比对（直接断言数值，防改错）/
 * 缓存键格式 / build() 产出 URL 与参数 /  forbid http·外域名红线 /
 * t() 对缺失 key、缺参数、参数类型不对的行为 / 代码中引用的 key 是否都存在。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { SOURCES, SOURCE_LIST, getSource, criticalSourceIds } = await import('../src/data/sources.js');
const { t, hasKey, allKeys, ZH } = await import('../src/i18n/index.js');

const ROOT = path.resolve(process.cwd());
const WALK = ['src', 'sw.js', 'index.html', 'selfcheck.html', 'styles', 'manifest.webmanifest'];

/**
 * 递归收集待扫描文件。
 *
 * @param {string} rel 相对路径。
 * @returns {string[]} 文件列表。
 */
function collect(rel) {
  const abs = path.resolve(ROOT, rel);
  if (fs.statSync(abs).isFile()) return [rel];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    out.push(...collect(path.posix.join(rel, name)));
  }
  return out;
}

/** @type {string[]} 全部待扫描源文件。 */
const FILES = WALK.flatMap((w) => collect(w));

test('六源契约值逐项比对架构文档 §3.1（timeoutMs / retry / ttlMs / cacheable）', () => {
  const contract = [
    ['weather', 6000, 1, 600000, true],
    ['air', 6000, 1, 600000, true],
    ['geocode', 6000, 1, 86400000, true],
    ['elevation', 6000, 1, 604800000, true],
    ['reverse', 6000, 1, 604800000, true],
    ['tile', 6000, 0, 0, false],
  ];
  for (const [id, timeoutMs, retry, ttlMs, cacheable] of contract) {
    const s = SOURCES[id];
    assert.ok(s, `缺少源 ${id}`);
    assert.equal(s.timeoutMs, timeoutMs, `${id}.timeoutMs`);
    assert.equal(s.retry, retry, `${id}.retry`);
    assert.equal(s.ttlMs, ttlMs, `${id}.ttlMs`);
    assert.equal(s.cacheable, cacheable, `${id}.cacheable`);
    assert.equal(s.id, id, 'id 必须与键名一致');
  }
  assert.equal(SOURCE_LIST.length, 6, '必须恰好六路源');
  assert.equal(getSource('nope'), null);
  assert.deepEqual(criticalSourceIds(), ['weather', 'air']);
});

test('缓存键符合 gs:v1:<id>:<参数>（坐标 toFixed(4)、关键词 encodeURIComponent）', () => {
  assert.equal(SOURCES.weather.cacheKey({ lat: 39.90873, lon: 116.39748 }), 'gs:v1:weather:39.9087:116.3975');
  assert.equal(SOURCES.air.cacheKey({ lat: -33.86882, lon: 151.20929 }), 'gs:v1:air:-33.8688:151.2093');
  assert.equal(SOURCES.reverse.cacheKey({ lat: 39.9087, lon: 116.3975 }), 'gs:v1:reverse:39.9087:116.3975');
  assert.equal(SOURCES.geocode.cacheKey({ keyword: '北京 天安门', lang: 'zh' }), `gs:v1:geocode:${encodeURIComponent('北京 天安门')}:zh`);
  // 缺 lang 时有默认值，缺 lat/lon 时不崩
  assert.equal(SOURCES.geocode.cacheKey({ keyword: 'x' }), 'gs:v1:geocode:x:zh');
  assert.equal(SOURCES.weather.cacheKey({}), 'gs:v1:weather:0.0000:0.0000');
  // tile 键含样式与瓦片坐标
  assert.equal(SOURCES.tile.cacheKey({ styleId: 'dark', z: 12, x: 1, y: 2 }), 'gs:v1:tile:dark:12:1:2');
});

test('build() 产出的 URL 与参数同架构文档一致（含暗色底图 goals 粗读）', () => {
  const ctx = { lat: 39.9087, lon: 116.3975 };
  assert.equal(SOURCES.weather.build(ctx).url, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(SOURCES.air.build(ctx).url, 'https://air-quality-api.open-meteo.com/v1/air-quality');
  assert.equal(SOURCES.geocode.build({ keyword: '北京' }).url, 'https://geocoding-api.open-meteo.com/v1/search');
  assert.equal(SOURCES.elevation.build(ctx).url, 'https://api.open-meteo.com/v1/elevation');
  assert.equal(SOURCES.reverse.build(ctx).url, 'https://photon.komoot.io/reverse');
  assert.equal(SOURCES.reverse.build(ctx).params.lang, 'default');
  assert.deepEqual(SOURCES.tile.build({ styleId: 'dark', z: 12, x: 1, y: 2 }).responseType, 'bytes');

  // 坐标一律 four-decimal string
  assert.equal(SOURCES.weather.build(ctx).params.latitude, '39.9087');
  assert.equal(SOURCES.weather.build(ctx).params.longitude, '116.3975');
  // 六源全部 https，且自增न्ही 不在作者禁名单
  for (const s of SOURCE_LIST) {
    const url = s.build({ ...ctx, keyword: 'k', styleId: 'street', z: 1, x: 1, y: 1 }).url;
    assert.ok(url.startsWith('https://'), `${s.id} 必须走 https：${url}`);
  }
});

/**
 * 去掉注释后再做红线扫描（注释里允许出现「已被剔除的源」的说明性文字）。
 *
 * @param {string} src 源码。
 * @returns {string} 去注释后的源码。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('隐私红线：全仓库不得出现 six 数据源以外的域名、http:// 明文、CDN 与被剔除的源', () => {
  // ★新增数据源必须同步加到这张表（与 tools/check.mjs 的 ALLOWED_HOSTS 是同一条红线的两只眼睛）
  const allowed = [
    'api.open-meteo.com', 'air-quality-api.open-meteo.com', 'geocoding-api.open-meteo.com',
    'photon.komoot.io', 'server.arcgisonline.com',
    'router.project-osrm.org', 'restapi.amap.com',
  ];
  const forbidden = ['nominatim.openstreetmap.org', 'basemaps.cartocdn.com', 'tile.openstreetmap.org', 'overpass-api.de', 'googleapis', 'gstatic', 'cdn.', 'fonts.googleapis', 'jsdelivr', 'unpkg'];
  const externalRe = /https?:\/\/([a-zA-Z0-9.-]+)/g;

  for (const rel of FILES) {
    const src = stripComments(fs.readFileSync(path.resolve(ROOT, rel), 'utf8'));
    // 明文 http:// 只允许出现在 localhost/127.0.0.1 的说明与 XML 命名空间
    for (const m of src.matchAll(/http:\/\/[a-zA-Z0-9.-]+/g)) {
      const host = m[0].slice('http://'.length);
      assert.ok(['localhost', '127.0.0.1', 'www.w3.org'].includes(host), `${rel} 出现明文 http 外链：${m[0]}`);
    }
    for (const m of src.matchAll(externalRe)) {
      // www.w3.org 只出现在内联 SVG 的 xmlns 命名空间里，不会被真的请求，故放行
      if (m[1] === 'www.w3.org') continue;
      assert.ok(allowed.includes(m[1]), `${rel} 引用了白名单外的域名 ${m[1]}（隐私红线）`);
    }
    for (const bad of forbidden) {
      assert.ok(!src.includes(bad), `${rel} 出现了已被剔除/禁止的源 ${bad}`);
    }
  }
});

test('隐私红线：不得引用外部字体或 <img src="http…">，不得有统计脚本', () => {
  for (const rel of FILES) {
    const src = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
    assert.ok(!/<script[^>]+src=["']https?:/.test(src), `${rel} 不得外链 <script src>`);
    assert.ok(!/<link[^>]+href=["']https?:/.test(src), `${rel} 不得外链 <link href>`);
    assert.ok(!/@font-face/.test(src), `${rel} 不得外链字体 @font-face`);
    assert.ok(!/<img[^>]+src=["']https?:/.test(src), `${rel} 不得外链图片`);
  }
});

test('i18n：t() 缺 key 返回 key 本身；缺参保留占位符；参数类型不对也能安全字符串化', () => {
  assert.equal(t('this.key.does.not.exist'), 'this.key.does.not.exist');
  assert.equal(t('now.updatedAt'), '更新于 {time}', '缺 {time} 参数时保留占位符');
  assert.equal(t('now.updatedAt', { time: '08:30' }), '更新于 08:30');
  assert.equal(t('now.updatedAt', { time: 123 }), '更新于 123', '数字参数应能正常替换');
  assert.equal(t('now.updatedAt', { time: null }), '更新于 {time}', 'null 参数视为缺失');
  assert.equal(t('now.updatedAt', { time: undefined }), '更新于 {time}');
  assert.equal(t('app.loading'), '正在装载…');
  assert.equal(t('app.loading', { x: 1 }), '正在装载…', '无占位符的文案不受参数影响');
});

test('i18n：所有 t() 字面量 key 与模板 key 的枚举都必须存在于文案表', () => {
  const missing = [];
  const enumMap = {
    'status.': ['idle', 'ok', 'stale', 'degraded', 'failed', 'offline', 'running'],
    'error.': ['OFFLINE', 'TIMEOUT', 'HTTP', 'NETWORK', 'PARSE', 'ABORT', 'EMPTY', 'UNSUPPORTED'],
    // ★grid：底图半残的横幅态，由 _bannerMode() 单独分支产出，也要在文案表里
    'mode.': ['live', 'stale', 'partial', 'grid', 'offline', 'no-map', 'empty'],
    'sc.net.': ['wifi', 'cellular', 'unknown'],
    'sc.verdict.': ['all-ok', 'partial', 'offline'],
    // ★阶段二补（瓦片三态降级）：底图模式文案按 mapMode() 取值展开
    'sc.mapMode.': ['map', 'grid', 'no-map'],
    'tile.': ['street', 'imagery', 'dark'],
    // 设置页主题三档：与 src/ui/settings.js 的 THEME_MODES 一一对应，
    // 那边加档位必须同步这里（多一项 → map 取值取不到 → 缺 key 测试立即报警）
    'settings.theme.': ['system', 'light', 'dark'],
    // ★无障碍字号三档：与 src/ui/settings.js 的 FONT_SCALES 一一对应（同 THEME_MODES 的道理）
    'settings.font.': ['normal', 'large', 'xlarge'],
    // ★界面语言两档：与 src/ui/settings.js 的 LOCALES 一一对应。
    //   ★注意 ['zh','en'] 这两个选项名**故意不翻译**（中文界面写着 English），
    //   所以这里查的是「两张表里都有这两条 key」，不是「英文表里写的是 English」。
    'settings.lang.': ['zh', 'en'],
    // ★自驾候选三类：与 src/core/roadtrip.js 的 CHECKIN_TYPES 一一对应
    //   （ui/poilist.js 与 ui/roadtrip.js 都用 `rt.type.${type}` 这类模板 key 取文案，
    //    少一类就有一张卡显示成键名本身）。
    'rt.type.': ['stay', 'sight', 'food'],
  };

  for (const rel of FILES.filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
    // 字面量 key：t('xxx')
    for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) {
      if (!hasKey(m[1])) missing.push(`${rel} → ${m[1]}`);
    }
    // 模板 key：t(`prefix.${v}`) → 按枚举展开
    for (const m of src.matchAll(/\bt\(\s*`([^`$]+)\$\{/g)) {
      const prefix = m[1];
      const values = enumMap[prefix];
      assert.ok(values, `${rel} 出现未登记的模板 key 前缀 ${prefix}（请在本测试中补枚举）`);
      for (const v of values) {
        if (!hasKey(prefix + v)) missing.push(`${rel} → ${prefix}${v}`);
      }
    }
  }
  assert.deepEqual(missing, [], `以下 i18n key 被代码引用但文案表中缺失：\n${missing.join('\n')}`);
});

test('i18n：HTML 里的 data-i18n 属性必须都能取到文案', () => {
  for (const rel of FILES.filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) {
      assert.ok(hasKey(m[1]), `${rel} 的 data-i18n="${m[1]}" 在文案表中不存在`);
    }
  }
});

test('i18n：文案表自身不得有空文案，且所有占位符都形如 {name}', () => {
  for (const [key, value] of Object.entries(ZH)) {
    assert.ok(typeof value === 'string' && value.trim().length > 0, `文案 ${key} 不得为空`);
    for (const m of String(value).matchAll(/\{([^}]*)\}/g)) {
      assert.ok(/^\w+$/.test(m[1]), `文案 ${key} 的占位符非法：${m[0]}`);
    }
  }
  assert.ok(allKeys().length > 100, '文案表规模应当足够覆盖界面');
});

test('每一行源都必须带中文标签与许可署名（溯源气泡与导出报告的必需字段）', () => {
  for (const s of SOURCE_LIST) {
    assert.ok(s.label && s.label.length > 0, `${s.id} 缺少中文标签`);
    assert.ok(s.attribution && s.attribution.length > 0, `${s.id} 缺少许可署名`);
    assert.ok(typeof s.priority === 'number' && s.priority >= 1 && s.priority <= 6, `${s.id} 的 priority 越界`);
    assert.equal(typeof s.build, 'function');
    assert.equal(typeof s.parse, 'function');
    assert.equal(typeof s.cacheKey, 'function');
  }
  assert.ok(typeof SOURCES.tile.fingerprint === 'function', '瓦片源必须提供 fingerprint');
});
