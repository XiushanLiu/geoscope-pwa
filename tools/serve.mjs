/**
 * 本地静态服务器（零依赖）
 *
 * 职责：为开发期提供一个最小 http 服务。原生 ES Module 必须经 http(s) 协议加载，
 * 直接双击 index.html（file://）会因 CORS 与模块解析规则而失败，故本脚本是本地运行的必经入口。
 *
 * 用法（端口优先级从高到低）：--port 参数 → PORT 环境变量 → 位置参数 → 默认 8080
 *   node tools/serve.mjs                 → http://127.0.0.1:8080
 *   node tools/serve.mjs --port 8123     → http://127.0.0.1:8123
 *   node tools/serve.mjs --port=8123     → 同上
 *   PORT=8123 node tools/serve.mjs       → http://127.0.0.1:8123
 *   node tools/serve.mjs 3000            → http://127.0.0.1:3000（位置参数，兼容旧写法）
 *
 * 安全：仅绑定 127.0.0.1（不对外暴露）；路径穿越（..）一律拒绝；只服务仓库目录内文件。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件所在目录的上一级）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 默认端口。 */
const DEFAULT_PORT = 8080;

/** 默认绑定地址：只监听本机回环，不对外暴露。 */
const HOST = '127.0.0.1';

/** 启动后要打印的两个入口页（用户会直接点）。 */
const ENTRIES = [
  { path: 'index.html', label: '此刻屏' },
  { path: 'selfcheck.html', label: '数据源自检页' },
];

/** 扩展名 → MIME。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 解析请求路径为磁盘绝对路径，并做穿越防护。
 *
 * @param {string} urlPath URL 路径。
 * @returns {string|null} 绝对路径；非法时 null。
 */
function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch (err) {
    return null;
  }
  if (decoded.indexOf('\0') !== -1) return null;
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  // 必须仍在仓库目录内
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

/**
 * 从命令行参数里取端口：支持 `--port 8123` 与 `--port=8123` 两种写法。
 *
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {{raw:string|null, positional:string|null}} 显式给出的端口原值与第一个位置参数。
 */
function readArgs(argv) {
  let raw = null;
  let positional = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i] || '');
    if (a === '--port' || a === '-p') {
      if (i + 1 < argv.length) raw = String(argv[i + 1]);
      i += 1;
      continue;
    }
    if (a.indexOf('--port=') === 0) {
      raw = a.slice('--port='.length);
      continue;
    }
    if (a.indexOf('-p=') === 0) {
      raw = a.slice('-p='.length);
      continue;
    }
    if (a.charAt(0) !== '-' && positional === null) positional = a;
  }
  return { raw, positional };
}

/**
 * 校验并归一化端口字符串。
 *
 * @param {*} raw 端口原值。
 * @returns {number|null} 合法端口号；非法时 null。
 */
function parsePort(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * 决定实际监听端口。
 *
 * 优先级：`--port` 参数 → `PORT` 环境变量 → 位置参数 → 默认 8080。
 * 显式给出却非法时给出中文提示并回落到默认端口，不抛英文堆栈。
 *
 * @param {string[]} argv 命令行参数。
 * @returns {number} 端口号。
 */
export function resolvePort(argv = []) {
  const { raw, positional } = readArgs(argv);
  // 1) --port：显式给了却解析不出来，说明是手滑（--port abc / --port 0），提示清楚后回落默认端口
  if (raw !== null) {
    const p = parsePort(raw);
    if (p !== null) return p;
    process.stderr.write(`[GeoScope] --port 的值「${raw}」不是合法端口（需 1–65535 的整数），已回落到 ${DEFAULT_PORT}\n`);
    return DEFAULT_PORT;
  }
  // 2) PORT 环境变量（便于在托管脚本 / CI 里覆盖）
  const fromEnv = parsePort(process.env.PORT);
  if (fromEnv !== null) return fromEnv;
  // 3) 位置参数（兼容 node tools/serve.mjs 3000 的旧写法）
  const fromPos = parsePort(positional);
  if (fromPos !== null) return fromPos;
  return DEFAULT_PORT;
}

/**
 * 创建服务器。
 *
 * @returns {import('node:http').Server} http 服务器实例。
 */
export function createServer() {
  return http.createServer((req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('405 Method Not Allowed');
      return;
    }

    const abs = resolveSafe(req.url || '/');
    if (abs === null) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 Forbidden');
      return;
    }

    let target = abs;
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      target = path.join(target, 'index.html');
      try {
        stat = fs.statSync(target);
      } catch (err) {
        stat = null;
      }
    }
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 Not Found: ${req.url}`);
      return;
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      // 开发期禁用缓存，避免改了文件不生效
      'Cache-Control': 'no-store',
      // 允许同源 SW 注册（本目录即 scope）
      'Service-Worker-Allowed': '/',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(target)
      .on('error', () => {
        res.end();
      })
      .pipe(res);
  });
}

/**
 * 启动服务（CLI 入口）。
 *
 * @returns {void}
 */
export function start() {
  const usePort = resolvePort(process.argv.slice(2));
  const server = createServer();
  server.listen(usePort, HOST, () => {
    const base = `http://${HOST}:${usePort}`;
    process.stdout.write(`GeoScope 本地服务已启动 → ${base}/\n`);
    ENTRIES.forEach((e) => process.stdout.write(`  ${e.label}：${base}/${e.path}\n`));
    process.stdout.write(`root: ${ROOT}\n`);
    process.stdout.write('Ctrl+C 停止\n');
  });
  server.on('error', (err) => {
    const next = usePort < 65535 ? usePort + 1 : 1025;
    if (err && err.code === 'EADDRINUSE') {
      // 端口被占是自用 PWA 最常见的「第一步就卡住」，必须说人话 + 给出两条可复制的换法
      process.stderr.write(`[GeoScope] 端口 ${usePort} 已被其它程序占用，服务没起来。\n`);
      process.stderr.write(`  换端口重跑：node tools/serve.mjs --port ${next}\n`);
      process.stderr.write(`  或用环境变量：set PORT=${next} && node tools/serve.mjs\n`);
      process.exit(1);
    }
    if (err && err.code === 'EACCES') {
      process.stderr.write(`[GeoScope] 端口 ${usePort} 无权限监听（1024 以下通常需要管理员权限），请换成 ${next} 或更大的端口。\n`);
      process.exit(1);
    }
    process.stderr.write(`[GeoScope] 启动失败：${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

// 直接 node tools/serve.mjs 时启动；被 import 时不自动启动
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start();
}
