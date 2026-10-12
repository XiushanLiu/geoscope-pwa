/**
 * core/http.js 独立验证
 *
 * 覆盖：串行队列并发恒为 1 / 队列顺序 / 队列异常不卡死 / AbortController 超时 /
 * 重试 1 次与 0 次的差别 / 4xx 不重试·5xx 重试·429 重试 / 离线短路零请求 / force 语义 /
 * fresh 缓存短路 / 破坏串行保证的 resetQueue 风险 / SourceError 形状。
 *
 * 环境在模块顶层一次性安装（必须在 import 被测模块之前，否则 cache.js 会退回内存态）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFetch, installNavigator, installStorage, FakeStorage } from './harness.mjs';

const DEFAULT_CTX = { lat: 39.9087, lon: 116.3975 };

installStorage(new FakeStorage());
installNavigator({ online: true });
const fetchMock = installFetch();

const http = await import('../src/core/http.js');
const { t } = await import('../src/i18n/index.js');
await import('../src/data/sources.js'); // 注入 sourceResolver

beforeEach(() => {
  localStorage.clear();
  fetchMock.reset();
  fetchMock.clearHandler();
  fetchMock.setFallback({ status: 200, json: { ok: true } });
  http.resetQueue();
  globalThis.navigator.onLine = true;
});

test('队列并发恒为 1：6 个任务同时入队，瞬时并发 ≤1 且严格按入队顺序完成', async () => {
  let running = 0;
  let maxRunning = 0;
  const order = [];

  const tasks = [0, 1, 2, 3, 4, 5].map((i) =>
    http.enqueue(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      order.push(i);
      return i;
    }, { name: `t${i}` })
  );

  const out = await Promise.all(tasks);
  assert.equal(maxRunning, 1, `瞬时并发必须恒为 1，实际 ${maxRunning}`);
  assert.equal(order.join(','), '0,1,2,3,4,5', '必须按入队顺序串行完成');
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
  assert.equal(http.queueLength(), 0, '全部完成后队列长度必须归零');
});

test('队列中某个任务抛错，后续任务仍继续执行（队列不卡死）', async () => {
  const order = [];
  const p1 = http
    .enqueue(() => {
      throw new Error('boom');
    }, { name: 'bad' })
    .catch(() => 'caught');
  const p2 = http.enqueue(async () => {
    order.push('second');
    return 'ok';
  }, { name: 'good' });
  const p3 = http.enqueue(async () => {
    order.push('third');
    return 'ok';
  }, { name: 'good2' });

  assert.equal(await p1, 'caught');
  assert.equal(await p2, 'ok');
  assert.equal(await p3, 'ok');
  assert.deepEqual(order, ['second', 'third']);
  assert.equal(http.queueLength(), 0);
});

test('超时（AbortController）：retry=0 只尝试 1 次，错误码 TIMEOUT 且可重试', async () => {
  fetchMock.setFallback({ hang: true });
  const t0 = Date.now();
  const r = await http.requestRaw('https://example.invalid/x', { timeoutMs: 60, retry: 0 });
  const cost = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'TIMEOUT');
  assert.equal(r.error.retriable, true, 'TIMEOUT 必须可重试');
  assert.equal(r.meta.attempts, 1);
  assert.equal(fetchMock.count, 1, 'retry=0 时 fetch 只能被调用 1 次');
  assert.ok(cost < 400, `retry=0 超时应在一个 timeoutMs 量级内，实际 ${cost}ms`);
});

test('超时：retry=1 共 2 次尝试，总耗时 ≤ timeoutMs*(retry+1)+100ms（重试前不额外退避）', async () => {
  fetchMock.setFallback({ hang: true });
  const t0 = Date.now();
  const r = await http.requestRaw('https://example.invalid/x', { timeoutMs: 60, retry: 1 });
  const cost = Date.now() - t0;

  assert.equal(r.error.code, 'TIMEOUT');
  assert.equal(r.meta.attempts, 2);
  assert.equal(fetchMock.count, 2);
  assert.ok(cost <= 60 * 2 + 100, `两次尝试合计不得超过 timeoutMs*2+100ms，实际 ${cost}ms`);
});

test('HTTP 语义：404 不重试 / 503 重试 / 429 视为可重试；状态透传且不可重试的不重试', async () => {
  fetchMock.setFallback({ status: 404, json: { error: 'not found' } });
  const r404 = await http.requestRaw('https://example.invalid/a', { timeoutMs: 300, retry: 1 });
  assert.equal(r404.error.code, 'HTTP');
  assert.equal(r404.error.retriable, false, '4xx 必须不可重试');
  assert.equal(r404.meta.attempts, 1, '4xx 不得重试');
  assert.equal(r404.meta.httpStatus, 404);
  assert.equal(r404.error.httpStatus, 404);

  fetchMock.reset();
  fetchMock.setFallback({ status: 503, json: {} });
  const r503 = await http.requestRaw('https://example.invalid/b', { timeoutMs: 300, retry: 1 });
  assert.equal(r503.error.retriable, true, '5xx 必须可重试');
  assert.equal(r503.meta.attempts, 2);
  assert.equal(fetchMock.count, 2);

  fetchMock.reset();
  fetchMock.setFallback({ status: 429, json: {} });
  const r429 = await http.requestRaw('https://example.invalid/c', { timeoutMs: 300, retry: 1 });
  assert.equal(r429.error.retriable, true, '429 必须可重试');
  assert.equal(r429.meta.attempts, 2);
});

test('EMPTY / PARSE 均不可重试，且只尝试一次', async () => {
  fetchMock.setFallback({ status: 200, body: '   ' });
  const empty = await http.requestRaw('https://example.invalid/e', { timeoutMs: 300, retry: 1 });
  assert.equal(empty.error.code, 'EMPTY');
  assert.equal(empty.error.retriable, false);
  assert.equal(empty.meta.attempts, 1);

  fetchMock.reset();
  fetchMock.setFallback({ status: 200, body: '{broken' });
  const parse = await http.requestRaw('https://example.invalid/p', { timeoutMs: 300, retry: 1 });
  assert.equal(parse.error.code, 'PARSE');
  assert.equal(parse.error.retriable, false);
  assert.equal(parse.meta.attempts, 1);
});

test('网络异常可重试，第二次成功即返回 ok 并给出 attempts=2', async () => {
  fetchMock.once({ throwNet: true });
  fetchMock.once({ status: 200, json: { fine: 1 } });
  const r = await http.requestRaw('https://example.invalid/n', { timeoutMs: 300, retry: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.meta.attempts, 2);
  assert.deepEqual(r.data, { fine: 1 });
});

test('离线短路：onLine=false 时零请求、返回 OFFLINE（优先于任何缓存判定）', async () => {
  // 先写入一份 fresh 缓存，验证离线短路优先级高于 fresh 命中
  fetchMock.setFallback({ status: 200, json: { elevation: [43] } });
  await http.request('elevation', DEFAULT_CTX);
  fetchMock.reset();

  globalThis.navigator.onLine = false;
  const r = await http.request('elevation', DEFAULT_CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OFFLINE');
  assert.equal(fetchMock.count, 0, '离线必须一次请求都不发');
  assert.equal(r.meta.fromCache, false, '离线短路不得伪装成缓存命中');
  assert.equal(http.isOnline(), false);
});

test('force=true 跳过离线短路与 fresh 缓存短路', async () => {
  fetchMock.setFallback({ status: 200, json: { elevation: [43] } });
  await http.request('elevation', DEFAULT_CTX);
  assert.equal(fetchMock.count, 1);

  const cached = await http.request('elevation', DEFAULT_CTX);
  assert.equal(cached.meta.fromCache, true);
  assert.equal(cached.meta.attempts, 0, 'fresh 命中 attempts 必须为 0');
  assert.equal(cached.meta.latencyMs, 0, 'fresh 命中 latencyMs 必须为 0');
  assert.equal(cached.meta.cacheState, 'fresh');
  assert.equal(fetchMock.count, 1, 'fresh 命中不得再发请求');

  const forced = await http.request('elevation', DEFAULT_CTX, { force: true });
  assert.equal(forced.meta.fromCache, false);
  assert.equal(fetchMock.count, 2, 'force 必须重新发起请求');

  globalThis.navigator.onLine = false;
  const forcedOffline = await http.request('elevation', DEFAULT_CTX, { force: true });
  assert.equal(forcedOffline.ok, true, 'force 必须能跳过离线短路');
  assert.equal(fetchMock.count, 3);
});

test('未注册的 sourceId → UNSUPPORTED，不进队列、不发请求', async () => {
  const r = await http.request('nope-not-exist', DEFAULT_CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNSUPPORTED');
  assert.equal(r.meta.cacheState, 'n/a');
  assert.equal(fetchMock.count, 0);
});

test('bytes 响应类型：返回 ArrayBuffer、meta.bytes=字节数、contentType 透传', async () => {
  fetchMock.setFallback({ arrayBuffer: new Uint8Array([1, 2, 3, 4, 5]), headers: { 'content-type': 'image/png' } });
  const r = await http.requestRaw('https://example.invalid/t.png', { timeoutMs: 300, retry: 0, responseType: 'bytes' });
  assert.equal(r.ok, true);
  assert.equal(r.meta.bytes, 5);
  assert.ok(r.data && r.data.byteLength === 5);
});

test('每次请求都携带 AbortSignal（超时中断的前提）', async () => {
  await http.requestRaw('https://example.invalid/s', { timeoutMs: 300, retry: 0 });
  const last = fetchMock.meta[fetchMock.meta.length - 1];
  assert.ok(last.signal, '必须带上 AbortSignal');
  assert.equal(typeof last.signal.addEventListener, 'function');
});

test('buildUrl：无参 / 空参 / 带 ? / 多参数编码', async () => {
  assert.equal(http.buildUrl({ url: 'https://a.b/c' }), 'https://a.b/c');
  assert.equal(http.buildUrl({ url: 'https://a.b/c', params: {} }), 'https://a.b/c');
  assert.equal(
    http.buildUrl({ url: 'https://a.b/c', params: { z: 1, q: '北京 x' } }),
    'https://a.b/c?z=1&q=%E5%8C%97%E4%BA%AC%20x'
  );
  assert.equal(http.buildUrl({ url: 'https://a.b/c?seed=1', params: { z: 2 } }), 'https://a.b/c?seed=1&z=2');
});

test('8 个错误码均可构造，字段齐全且文案键可被 i18n 翻译（无残留占位符）', async () => {
  // ★core/http.js 现在只给 messageKey + messageParams，不给已成文本的 message
  // （core 不许 import i18n）。翻成人话是 UI 层 ui/errtext.js 的事，这里用 t() 代劳。
  const codes = ['OFFLINE', 'TIMEOUT', 'HTTP', 'NETWORK', 'PARSE', 'ABORT', 'EMPTY', 'UNSUPPORTED'];
  for (const code of codes) {
    const e = http.makeError(code, 'weather', { httpStatus: 500, params: { timeoutMs: 6000 } });
    assert.equal(e.code, code);
    assert.equal(e.sourceId, 'weather');
    assert.equal(typeof e.retriable, 'boolean');
    assert.equal(e.messageKey, `error.${code}`);
    const text = t(e.messageKey, e.messageParams);
    assert.ok(typeof text === 'string' && text.length > 0, `${code} 必须有非空文案`);
    assert.ok(!text.includes('{'), `${code} 的文案不得残留占位符：${text}`);
    // 刻意不给 message 字段：留着它等于留一条「不切语言也能显示」的捷径，
    // 那条捷径会让英文包漏翻时静默显示中文。
    assert.equal(e.message, undefined, 'SourceError 不得再带已成文本的 message 字段');
  }
  assert.ok(t(http.makeError('TIMEOUT', 'w', { params: { timeoutMs: 6000 } }).messageKey,
    http.makeError('TIMEOUT', 'w', { params: { timeoutMs: 6000 } }).messageParams).includes('6000'));
  assert.ok(t(http.makeError('HTTP', 'w', { httpStatus: 502 }).messageKey,
    http.makeError('HTTP', 'w', { httpStatus: 502 }).messageParams).includes('502'));
  // 已知行为（建议项）：HTTP 码缺失 status 时占位符 {status} 会原样留在句子里。
  // 当前所有 HTTP 调用点都带上了 httpStatus（仅 http.js:271），故不可达；此处固化行为。
  const noStatus = http.makeError('HTTP', 'w', {});
  assert.ok(t(noStatus.messageKey, noStatus.messageParams).includes('{status}'), '缺失 status 时保留占位符（已知行为）');
});

test('契约缺口：requestRaw 不检查 isOnline，离线时非自检调用方仍会发请求', async () => {
  globalThis.navigator.onLine = false;
  const r = await http.requestRaw('https://example.invalid/raw', { timeoutMs: 300, retry: 0 });
  assert.equal(r.ok, true);
  assert.equal(fetchMock.count, 1, 'requestRaw 绕过了离线短路（契约第 6.9 条：离线禁止发请求）');
});

test('风险：resetQueue 打断在飞任务的串行链，可导致瞬间并发 >1', async () => {
  fetchMock.setFallback({ hang: true });
  const p1 = http.requestRaw('https://example.invalid/1', { timeoutMs: 200, retry: 0 });
  http.resetQueue();
  const p2 = http.requestRaw('https://example.invalid/2', { timeoutMs: 200, retry: 0 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fetchMock.count, 2, 'resetQueue 后新旧任务并行 → 并发不再是 1');
  await Promise.all([p1, p2]);
});
