/**
 * 运行时静态验证：本地服务 + ES Module 导入闭包 + sw.js 清单双向一致 + 无 JS 兜底 + 依赖方向
 *
 * 这一组用例验证「跑起来是否真的是那么回事」：所有静态资源可 200 拿到、
 * 两个 HTML 的 import 闭包完整、sw.js 预缓存清单与实际文件双向一致、
 * 无 JS 环境下仍有兜底文本（断网首次打开不白屏）、依赖方向单向。
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

/** 静态路由指向的根：与 tools/serve.mjs 的 ROOT 一致。 */
const { createServer } = await import('../tools/serve.mjs');

/** @type {import('node:http').Server} 临时服务实例。 */
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
/** @type {string} 服务地址。 */
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

after(() => server.close());

/**
 * 取资源状态与文本。
 *
 * @param {string} p 路径。
 * @returns {Promise<{status:number, text:string, type:string|null}>} 响应。
 */
async function getAsset(p) {
  const res = await fetch(`${ORIGIN}${p}`);
  const type = res.headers.get('content-type');
  return { status: res.status, text: await res.text(), type };
}

/**
 * 从 JS 源码里抽出静态 import/export-from 的相对 SPECIFIER。
 *
 * @param {string} src 源码。
 * @returns {string[]} 模块路径列表。
 */
function extractImports(src) {
  const out = [];
  const re = /(?:^|[\s;}])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) out.push(m[1]);
  // 裸 import './x.js'
  for (const m of src.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out.filter((s) => s.startsWith('.'));
}

/**
 * 递归求某个静态资源的「导入闭包」（含自身）。
 *
 * @param {string} entry 入口路径（以 / 开头）。
 * @returns {Promise<{ok:string[], missing:string[], checked:string[]}>} 结果。
 */
async function closure(entry) {
  /** @type {Set<string>} 已成功。 */
  const ok = new Set();
  /** @type {string[]} 缺失。 */
  const missing = [];
  /** @type {Set<string>} 已访问。 */
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const res = await getAsset(cur);
    if (res.status !== 200) {
      missing.push(`${cur} → ${res.status}`);
      continue;
    }
    ok.add(cur);
    const dir = path.posix.dirname(cur);
    const specs = extractImports(res.text);
    if (cur.endsWith('.html')) {
      // HTML：额外抽取 <script src> 与 <link rel=stylesheet href>
      for (const m of res.text.matchAll(/<script[^>]+src="([^"]+)"/g)) specs.push(m[1]);
      for (const m of res.text.matchAll(/<link[^>]+href="([^"]+)"/g)) {
        if (m[1].startsWith('http') || m[1].startsWith('data:')) continue;
        specs.push(m[1]);
      }
      if (/href="manifest.webmanifest"/.test(res.text)) specs.push('manifest.webmanifest');
    }
    for (const spec of specs) {
      queue.push(path.posix.normalize(path.posix.join(dir, spec)));
    }
  }
  return { ok: Array.from(ok).sort(), missing, checked: Array.from(seen) };
}

test('index.html 与其 ES Module 导入闭包全部 200（无 404）', async () => {
  const entry = await getAsset('/index.html');
  assert.equal(entry.status, 200, 'index.html 必须 200');
  const c = await closure('/index.html');
  assert.deepEqual(c.missing, [], `导入闭包里存在不可达资源：\n${c.missing.join('\n')}`);
  // 闭包必须覆盖此刻屏用到的所有模块
  for (const need of ['/src/ui/app.js', '/src/ui/now.js', '/src/core/http.js', '/src/core/cache.js', '/src/core/store.js', '/src/core/geo.js', '/src/core/sun.js', '/src/core/wmo.js', '/src/core/format.js', '/src/data/sources.js', '/src/data/openmeteo.js', '/src/data/photon.js', '/src/data/tiles.js', '/src/data/health.js', '/src/i18n/zh.js', '/src/i18n/en.js', '/src/i18n/index.js']) {
    assert.ok(c.ok.includes(need), `index.html 的导入闭包缺少 ${need}`);
  }
});

test('selfcheck.html 与其 ES Module 导入闭包全部 200（无 404）', async () => {
  const c = await closure('/selfcheck.html');
  assert.deepEqual(c.missing, [], `导入闭包里存在不可达资源：\n${c.missing.join('\n')}`);
  for (const need of ['/src/ui/selfcheck.js', '/src/ui/now.js', '/src/data/sources.js', '/src/data/tiles.js', '/src/i18n/zh.js', '/src/i18n/en.js', '/src/i18n/index.js']) {
    assert.ok(c.ok.includes(need), `selfcheck.html 的导入闭包缺少 ${need}`);
  }
});

test('两个 HTML 引用的 CSS 与 manifest 均可 200', async () => {
  for (const p of ['/styles/tokens.css', '/styles/app.css', '/manifest.webmanifest', '/sw.js']) {
    const res = await getAsset(p);
    assert.equal(res.status, 200, `${p} 必须 200`);
    assert.ok(res.type && res.type.length > 0, `${p} 必须带 Content-Type`);
  }
});

test('sw.js 预缓存清单 → 实际文件：清单里的每一项都必须真实可达', async () => {
  const src = fs.readFileSync(path.resolve(ROOT, 'sw.js'), 'utf8');
  const block = src.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(block, '未能从 sw.js 解析出 SHELL_ASSETS 清单');
  const assets = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  assert.ok(assets.length >= 20, `预缓存清单条目过少（${assets.length}）`);

  for (const rel of assets) {
    const normalized = rel === './' ? '/index.html' : rel.replace(/^\.\//, '/');
    const res = await getAsset(normalized);
    assert.equal(res.status, 200, `sw.js 预缓存了不可达的资源 ${rel}（${normalized} → ${res.status}）`);
  }
});

test('实际文件 → sw.js 预缓存清单：仓库里每个运行时静态资源都被预缓存（双向一致）', async () => {
  const src = fs.readFileSync(path.resolve(ROOT, 'sw.js'), 'utf8');
  const block = src.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  const assets = Array.from(block[1].matchAll(/'([^']+)'/g)).map((m) => m[1].replace(/^\.\//, ''));

  /** @type {string[]} 仓库内需要离线可用的运行时资源。 */
  const runtimeFiles = [
    'index.html', 'selfcheck.html', 'compass.html', 'settings.html', 'compare.html', 'manifest.webmanifest',
    'styles/tokens.css', 'styles/app.css',
    'src/i18n/zh.js',
    'src/i18n/en.js',
    'src/i18n/index.js',
    'src/ui/locale.js',
    'src/ui/errtext.js',
    'src/core/http.js', 'src/core/cache.js', 'src/core/store.js', 'src/core/geo.js', 'src/core/sun.js', 'src/core/wmo.js', 'src/core/format.js',
    'src/core/mag.js', 'src/core/backup.js', 'src/core/csv.js',
    // ★新增 src 模块要同步三处清单 —— sw.js 的 SHELL_ASSETS、
    //   tools/build-standalone.mjs 的 ORDER、以及这里。漏任何一处都会在**不同的地方**红：
    //   sw 漏 → check.mjs 第 6 节报红；ORDER 漏 → 打包直接中止；这里漏 → 新模块没人守。
    //   （2026-10-17 自驾下线：原「自驾模块（T01/T02）」那一组 10 项已整组删除。）
    'src/data/sources.js', 'src/data/openmeteo.js', 'src/data/photon.js', 'src/data/tiles.js', 'src/data/health.js',
    'src/data/wmm2025.js',
    // v99：别名表收口为唯一 JS 数据源（原 search-alias.json 已删除）
    'src/data/search-alias.js',
    'src/ui/app.js', 'src/ui/now.js', 'src/ui/selfcheck.js', 'src/ui/compass.js', 'src/ui/map.js',
    'src/ui/settings.js', 'src/ui/download.js', 'src/ui/pull.js',
  ];
  for (const f of runtimeFiles) {
    assert.ok(fs.existsSync(path.resolve(ROOT, f)), `清单引用了不存在的文件 ${f}`);
    assert.ok(assets.includes(f), `运行时资源 ${f} 未被 sw.js 预缓存（双向不一致）`);
  }
  // 反向：清单里不应有已不在仓库里的文件
  for (const a of assets) {
    if (a === './' || a === '') continue;
    assert.ok(fs.existsSync(path.resolve(ROOT, a)), `sw.js 清单里的 ${a} 在磁盘上不存在`);
  }
});

test('sw.js 只预缓存同源静态资源，不得把任何 API/瓦片域名写进清单', () => {
  const src = fs.readFileSync(path.resolve(ROOT, 'sw.js'), 'utf8');
  assert.ok(!/https?:\/\/[a-z]/i.test(src), 'sw.js 预缓存清单里不得出现绝对外链');
  assert.ok(src.includes('caches.open'), '必须实现 install 预缓存');
  assert.ok(src.includes('origin !== self.location.origin'), '跨域请求必须直接放行');
  assert.ok(src.includes("request.method !== 'GET'"), '非 GET 必须放行');
});

test('无 JS 兜底：三个 HTML 都自带可见文案（断网首次打开不得白屏）', () => {
  for (const page of ['index.html', 'selfcheck.html', 'compass.html']) {
    const html = fs.readFileSync(path.resolve(ROOT, page), 'utf8');
    // 去掉 <script> 块后仍必须剩下可见文本
    const noScript = html.replace(/<script[\s\S]*?<\/script>/g, '');
    const textNodes = noScript.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.ok(textNodes.length >= 10, `${page} 在无 JS 环境下几乎没有可见文本（会白屏），实际：${textNodes.slice(0, 80)}`);
    if (page === 'index.html') {
      assert.ok(textNodes.includes('正在装载') || textNodes.includes('地候'), 'index.html 必须自带装载提示文本');
      assert.ok(textNodes.includes('关于与边界'), 'index.html 必须自带「关于与边界」板块');
    } else if (page === 'selfcheck.html') {
      assert.ok(textNodes.includes('数据源自检'), 'selfcheck.html 必须自带标题');
      assert.ok(textNodes.includes('开始自检'), 'selfcheck.html 必须自带的「开始自检」按钮文案');
    } else {
      // 2026-10-17：compass.html 已扩成「地理」页，<title> 文案随之改掉 —— 这里钉的是
      // 「无 JS 时也有可见标题」这件事，不是某一句具体文案。
      assert.ok(textNodes.includes('地理'), 'compass.html 必须自带标题（无 JS 时也不该是空白页）');
      assert.ok(textNodes.includes('正在装载'), 'compass.html 必须自带装载提示文本');
    }
    // 挂载点必须有内容
    assert.ok(/<main[^>]*id="app"[\s\S]*?>[^<]/.test(html) || /id="src-list"[\s\S]*?>/.test(html), `${page} 缺少容器挂载点`);
  }
});

test('index.html 挂载点 #app 与降级横幅 #banner 存在（app.js 的硬依赖）', () => {
  const html = fs.readFileSync(path.resolve(ROOT, 'index.html'), 'utf8');
  assert.ok(/id="app"/.test(html), '缺少 #app');
  assert.ok(/id="banner"/.test(html), '缺少 #banner（renderBanner 会静默失效）');
  assert.ok(/<script[^>]+type="module"[^>]+src="src\/ui\/app.js">/.test(html), '必须以 module 方式引入 app.js');
});

test('selfcheck.html 的交互元素 id 与 selfcheck.js 的 _el() 调用完全对齐', () => {
  const html = fs.readFileSync(path.resolve(ROOT, 'selfcheck.html'), 'utf8');
  const js = fs.readFileSync(path.resolve(ROOT, 'src/ui/selfcheck.js'), 'utf8');
  const ids = new Set(Array.from(html.matchAll(/id="([^"]+)"/g)).map((m) => m[1]));
  const wanted = new Set(Array.from(js.matchAll(/_el\('([^']+)'\)/g)).map((m) => m[1]));
  assert.ok(wanted.size >= 8, '未能从 selfcheck.js 提取到足够的 _el 目标');
  for (const id of wanted) {
    assert.ok(ids.has(id), `selfcheck.js 取用了 HTML 里不存在的 id：#${id}（事件/渲染会静默失效）`);
  }
});

test('selfcheck.html 的分段控件带 data-value，且默认选中 unknown / 3 次', () => {
  const html = fs.readFileSync(path.resolve(ROOT, 'selfcheck.html'), 'utf8');
  const values = Array.from(html.matchAll(/data-value="([^"]+)"/g)).map((m) => m[1]);
  for (const v of ['wifi', 'cellular', 'unknown', '1', '3', '5']) {
    assert.ok(values.includes(v), `分段控件缺少 data-value="${v}"（_bindSeg 依赖它回传选中值）`);
  }
  // 默认选中 unknown 与 3
  assert.ok(/data-value="unknown"[^>]*class="[^"]*seg-btn--active/.test(html) || /class="[^"]*seg-btn--active"[^>]*data-value="unknown"/.test(html), '网络类型默认应选 unknown');
  assert.ok(/class="[^"]*seg-btn--active"[^>]*data-value="3"|data-value="3"[^>]*class="[^"]*seg-btn--active/.test(html), '取样次数默认应选 3');
});

test('依赖方向单向：core 不得 import data/ui；data 不得 import ui', () => {
  const violations = [];
  const dirs = [
    { dir: 'src/core', banned: ['../data/', '../ui/'] },
    { dir: 'src/data', banned: ['../ui/'] },
  ];
  for (const { dir, banned } of dirs) {
    for (const name of fs.readdirSync(path.resolve(ROOT, dir))) {
      if (!name.endsWith('.js')) continue;
      const src = fs.readFileSync(path.resolve(ROOT, dir, name), 'utf8');
      for (const b of banned) {
        if (src.includes(`from '${b}`)) violations.push(`${dir}/${name} 依赖了 ${b}`);
      }
    }
  }
  assert.deepEqual(violations, [], `依赖方向被破坏：\n${violations.join('\n')}`);
});

test('零第三方依赖：无 require / 无 CDN / package.json 无 dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.deepEqual(pkg.devDependencies || {}, {});
  assert.equal(pkg.type, 'module');

  const walk = (rel) => {
    const abs = path.resolve(ROOT, rel);
    if (fs.statSync(abs).isFile()) return [rel];
    return fs.readdirSync(abs).flatMap((n) => walk(path.posix.join(rel, n)));
  };
  for (const rel of [...walk('src'), 'sw.js', 'index.html', 'selfcheck.html']) {
    const src = fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
    assert.ok(!/\brequire\s*\(/.test(src), `${rel} 不得使用 require()`);
  }
});

test('静态服务安全：路径穿越被拒绝（用裸 HTTP 报文，避免客户端先做 URL 归一化）', async () => {
  const net = await import('node:net');
  const [host, port] = ['127.0.0.1', server.address().port];
  /**
   * 发送一条原始 HTTP 请求报文。
   *
   * @param {string} rawPath 请求行里的原始路径。
   * @returns {Promise<number>} 状态码。
   */
  const raw = (rawPath) =>
    new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => {
        sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        buf += d;
      });
      sock.on('end', () => resolve(Number((buf.match(/^HTTP\/1\.1 (\d+)/) || [0, 0])[1])));
      sock.on('error', reject);
    });

  assert.equal(await raw('/../package.json'), 403, '路径穿越 /../package.json 必须被 403 拒绝');
  assert.equal(await raw('/../../etc/passwd'), 403, '多级穿越必须被 403 拒绝');
  assert.equal(await raw('/nope.js'), 404, '不存在的资源应返回 404');
  assert.equal(await raw('/index.html'), 200, '正常资源必须 200');
});
