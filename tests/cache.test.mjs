/**
 * core/cache.js 独立验证
 *
 * 覆盖：fresh / stale / miss 三态与「恰好等于 TTL」那一点的归属 / 陈旧值可取回 /
 * 坏数据（非法 JSON、缺字段、非对象）不得抛异常 / LRU 淘汰 / prune 容量回收 /
 * 配额溢出先淘汰再重试 / 命名空间与键格式。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installStorage, FakeStorage } from './harness.mjs';

installStorage(new FakeStorage());
const cache = await import('../src/core/cache.js');

const KEY = 'gs:v1:probe:39.9087:116.3975';

beforeEach(() => {
  localStorage.clear();
});

test('命名空间与键格式固定为 gs:v1:<sourceId>:<参数>', () => {
  assert.equal(cache.NS, 'gs:v1:');
  assert.equal(cache.makeKey('weather', '39.9087', '116.3975'), 'gs:v1:weather:39.9087:116.3975');
  assert.equal(cache.makeKey('geocode', encodeURIComponent('北京'), 'zh'), `gs:v1:geocode:${encodeURIComponent('北京')}:zh`);
});

test('三态边界：ageMs < ttl 为 fresh；恰好等于 TTL 归为 stale（并给出 staleForMs=0）', () => {
  const now = 1_700_000_000_000;
  const ttl = 600_000;

  // ageMs = ttl - 1 → fresh
  localStorage.setItem(KEY, JSON.stringify({ v: { a: 1 }, t: now - ttl + 1, ttl, stale: false }));
  const realNow = Date.now;
  Date.now = () => now;
  const almost = cache.getWithState(KEY);
  Date.now = realNow;
  assert.equal(almost.state, 'fresh', 'ageMs = ttl-1 必须是 fresh');
  assert.equal(almost.ageMs, ttl - 1);
  assert.equal(almost.staleForMs, 0);

  // ageMs = ttl（恰好到期）→ stale
  localStorage.setItem(KEY, JSON.stringify({ v: { a: 1 }, t: now - ttl, ttl, stale: false }));
  Date.now = () => now;
  const exact = cache.getWithState(KEY);
  Date.now = realNow;
  assert.equal(exact.state, 'stale', '恰好等于 TTL 的这一点归为 stale（age>=ttl 即过期，符合预期）');
  assert.equal(exact.ageMs, ttl);
  assert.equal(exact.staleForMs, 0, '刚过期时 staleForMs 应为 0');
  assert.deepEqual(exact.value, { a: 1 }, 'stale 必须仍能取回旧值（绝不显示空白）');
});

test('staleForMs 随时钟增长而增长；miss 态各字段归零', () => {
  const now = 1_700_000_000_000;
  localStorage.setItem(KEY, JSON.stringify({ v: 42, t: now - 700_000, ttl: 600_000, stale: false }));
  const realNow = Date.now;
  Date.now = () => now;
  const st = cache.getWithState(KEY);
  Date.now = realNow;
  assert.equal(st.state, 'stale');
  assert.equal(st.staleForMs, 100_000, '超出 TTL 的时长必须计入 staleForMs');
  assert.equal(st.value, 42);

  assert.deepEqual(cache.getWithState('gs:v1:not-exist:x'), { state: 'miss', value: null, ageMs: 0, staleForMs: 0 });
});

test('ttlMs=0 的条目立即可读但恒为 stale（写入后马上读不会崩）', () => {
  assert.equal(cache.set('gs:v1:zero:x', { v: 1 }, 0), true);
  const st = cache.getWithState('gs:v1:zero:x');
  assert.equal(st.state, 'stale');
  assert.deepEqual(st.value, { v: 1 });
});

test('坏数据不得抛异常：非法 JSON 会被丢弃并返回 miss', () => {
  localStorage.setItem('gs:v1:broken:1', '{不是 JSON');
  assert.equal(cache.get('gs:v1:broken:1'), null, '坏 JSON 必须返回 null 而不是抛异常');
  assert.equal(localStorage.getItem('gs:v1:broken:1'), null, '坏数据应被主动清除，避免反复解析');
  assert.equal(cache.getWithState('gs:v1:broken:1').state, 'miss');
});

test('坏数据不得抛异常：缺字段 / 非对象 / null 条目', () => {
  localStorage.setItem('gs:v1:t1', JSON.stringify({ v: 1 })); // 缺 t / ttl
  const t1 = cache.get('gs:v1:t1');
  assert.equal(t1.storedAt, 0, '缺 storedAt 时归零，不得 NaN');
  assert.equal(t1.ttlMs, 0);
  assert.deepEqual(cache.getWithState('gs:v1:t1').value, 1);

  localStorage.setItem('gs:v1:t2', '"just-a-string"'); // 解析出来是字符串
  assert.equal(cache.get('gs:v1:t2'), null, '非对象条目必须返回 null');

  localStorage.setItem('gs:v1:t3', 'null'); // JSON null
  assert.equal(cache.get('gs:v1:t3'), null);

  // 数组能被 JSON.parse，但没有 v 字段 → value 为 undefined（不抛异常即为达标）
  localStorage.setItem('gs:v1:t4', '[1,2,3]');
  const arr = cache.get('gs:v1:t4');
  assert.equal(typeof arr, 'object');
  assert.equal(arr.value, undefined, '缺 v 字段时 value 为 undefined，不得抛异常');

  assert.equal(cache.get('gs:v1:永不存在'), null);
});

test('get() 对 null/undefined 条目返回 null；value 为 null 也算命中（但 http 层会判为无兜底值）', () => {
  localStorage.setItem('gs:v1:t5', JSON.stringify({ v: null, t: Date.now(), ttl: 600000 }));
  const e = cache.get('gs:v1:t5');
  assert.notEqual(e, null, '条目本身存在');
  assert.equal(e.value, null, 'value 为 null 时原样返回');
  const st = cache.getWithState('gs:v1:t5');
  assert.equal(st.state, 'fresh');
  assert.equal(st.value, null);
});

test('set 写入形状固定：{v,t,ttl,stale}；t 为 ms epoch', () => {
  cache.set(KEY, { hello: 'w' }, 1234);
  const raw = JSON.parse(localStorage.getItem(KEY));
  assert.deepEqual(Object.keys(raw).sort(), ['stale', 't', 'ttl', 'v']);
  assert.equal(raw.ttl, 1234);
  assert.equal(raw.stale, false);
  assert.ok(Math.abs(raw.t - Date.now()) < 2000, 't 必须是 ms epoch');
  assert.deepEqual(raw.v, { hello: 'w' });
});

test('markStale 只改标记不动值，且不影响后续取出（storedAt 不变 → 陈旧时长继续增长）', () => {
  const now = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  cache.set(KEY, { keep: 'yes' }, 1000);
  cache.markStale(KEY);
  const entry = cache.get(KEY);
  Date.now = realNow;
  assert.equal(entry.storedAt, now, 'markStale 不得重置 storedAt');
  assert.deepEqual(entry.value, { keep: 'yes' });
  const raw = JSON.parse(localStorage.getItem(KEY));
  assert.equal(raw.stale, true);
  // 键不存在时也不得抛
  cache.markStale('gs:v1:never:exists');
});

test('clearPrefix / clearAll 返回清除条数，且不影响非本命名空间键', () => {
  cache.set('gs:v1:a:1', 1, 1000);
  cache.set('gs:v1:a:2', 2, 1000);
  cache.set('gs:v1:b:1', 3, 1000);
  localStorage.setItem('other-app:keep', 'x');
  assert.equal(cache.clearPrefix('gs:v1:a'), 2);
  assert.equal(cache.clearPrefix('gs:v1:'), 1);
  assert.equal(localStorage.getItem('other-app:keep'), 'x', '不得越界清理其它应用的键');

  cache.set('gs:v1:c:1', 4, 1000);
  assert.equal(cache.clearAll(), 1);
  assert.equal(localStorage.length, 1);
});

test('配额溢出：第一次 set 抛异常时先淘汰最旧的一半再重试', () => {
  const base = Date.now() - 100000;
  for (let i = 0; i < 4; i += 1) {
    localStorage.setItem(`gs:v1:old:${i}`, JSON.stringify({ v: 1, t: base + i * 1000, ttl: 1 }));
  }
  // 只拒绝该键的第一次写入（模拟配额刚好打满），淘汰后重试应当成功
  let attempt = 0;
  localStorage.failOn = (key) => {
    if (key !== 'gs:v1:new:1') return false;
    attempt += 1;
    return attempt === 1;
  };

  const ok = cache.set('gs:v1:new:1', { x: 1 }, 1000);
  assert.equal(ok, true, '配额溢出应先淘汰最旧条目再重试');
  assert.equal(localStorage.getItem('gs:v1:old:0'), null, '最旧条目必须被淘汰（按 storedAt 升序）');
  assert.notEqual(localStorage.getItem('gs:v1:new:1'), null, '重试后新条目必须落盘');
  assert.equal(attempt, 2, '应恰好经历「失败 → 淘汰 → 重试成功」两次写入');
  localStorage.failOn = null;
});

test('配额持续溢出（淘汰后仍写不进）返回 false，且不向上抛异常', () => {
  localStorage.setItem('gs:v1:seed', JSON.stringify({ v: 1, t: Date.now(), ttl: 1 }));
  localStorage.failOn = (key) => key === 'gs:v1:blocked';
  const ok = cache.set('gs:v1:blocked', { y: 1 }, 1000);
  assert.equal(ok, false, '彻底写不进时必须返回 false 而非抛异常');
  localStorage.failOn = null;
});

test('prune：超过 maxBytes 时按 storedAt 升序淘汰，返回释放条数且不误删阈值内数据', () => {
  const realNow = Date.now;
  const base = realNow() - 100000;
  for (let i = 0; i < 5; i += 1) {
    localStorage.setItem(
      `gs:v1:p:${i}`,
      JSON.stringify({ v: 'x'.repeat(200), t: base + i * 1000, ttl: 600000 })
    );
  }
  // 每条约 230 字节 → 总约 1150 字节；阈值设 400，应逐条淘汰到 400 以下
  const freed = cache.prune(400);
  assert.ok(freed >= 3, `应至少淘汰 3 条，实际 ${freed}`);
  const remaining = Array.from(localStorage.keys()).filter((k) => k.startsWith('gs:v1:p:'));
  for (const k of remaining) {
    const t = JSON.parse(localStorage.getItem(k)).t;
    assert.ok(t >= base + (5 - remaining.length) * 1000, 'prune 必须从最旧开始淘汰');
  }
  // 未超限时返回 0
  assert.equal(cache.prune(10_000_000), 0);
});

test('evictOldest(ratio) 按比例淘汰，返回实际淘汰条数', () => {
  const base = Date.now() - 100000;
  for (let i = 0; i < 4; i += 1) {
    localStorage.setItem(`gs:v1:e:${i}`, JSON.stringify({ v: i, t: base + i, ttl: 1 }));
  }
  const n = cache.evictOldest(0.5);
  assert.equal(n, 2, 'ratio=0.5 × 4 条 → 淘汰 2 条');
  assert.equal(localStorage.length, 2);
});

test('byteSize 对中文按 3 字节估算（UTF-8 近似）', () => {
  assert.equal(cache.byteSize('abc'), 3);
  assert.equal(cache.byteSize('地候'), 6);
});

test('无 localStorage 环境可降级为内存存储（__useMemory 后 API 全部可用，且清空旧数据）', () => {
  cache.set('gs:v1:before', 1, 1000);
  cache.__useMemory();
  assert.equal(cache.getWithState('gs:v1:before').state, 'miss', '切到内存存储后旧数据必须清空');
  assert.equal(cache.set('gs:v1:m:1', { hi: 1 }, 1000), true);
  const st = cache.getWithState('gs:v1:m:1');
  assert.equal(st.state, 'fresh');
  assert.deepEqual(st.value, { hi: 1 });
  assert.equal(cache.clearAll(), 1);
});
