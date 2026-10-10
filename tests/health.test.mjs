/**
 * data/health.js 独立验证
 *
 * 覆盖：overallMode 五种态的判定顺序（offline > empty > stale > partial > no-map > live）/
 * 陈旧时长与 isStale 标记 / 样本聚合 / 各状态机分支 / resetHealth 幂等。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installNavigator } from './harness.mjs';

installNavigator({ online: true });

const health = await import('../src/data/health.js');
const tiles = await import('../src/data/tiles.js');

const metaOk = (extra = {}) => ({ finishedAt: Date.now(), latencyMs: 120, attempts: 1, cacheState: 'miss', staleAgeMs: 0, ...extra });
const metaOffline = { finishedAt: Date.now(), latencyMs: 0, attempts: 0, cacheState: 'miss', staleAgeMs: 0 };
const errNetwork = { code: 'NETWORK', retriable: true, httpStatus: null, sourceId: 'weather' };
const errOffline = { code: 'OFFLINE', retriable: false, httpStatus: null, sourceId: 'weather' };

beforeEach(() => {
  health.resetHealth();
  tiles.setNoMapMode(false);
  globalThis.navigator.onLine = true;
});

test('live：全部源成功且无陈旧、未进入无地图模式', () => {
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  health.recordSuccess('elevation', metaOk());
  health.recordSuccess('reverse', metaOk());
  assert.equal(health.overallMode(), 'live');
});

test('offline 优先级最高：即使所有源都成功，离线也必须压过其它态', () => {
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  tiles.setNoMapMode(true);
  globalThis.navigator.onLine = false;
  assert.equal(health.overallMode(), 'offline');
});

test('empty：关键源（weather/air）全部彻底失败且无陈旧兜底', () => {
  health.recordFailure('weather', metaOk(), errNetwork);
  health.recordFailure('air', metaOk(), errNetwork);
  assert.equal(health.overallMode(), 'empty');
  // 已知行为（架构口径 gap，见报告观察项）：partial 只统计「非关键源」，
  // 因此「weather 正常 + air 彻底失败」会落到 live —— 顶部横幅不会给出任何降级提示，
  // 只有空气卡自己显示空态。这与 health.js 注释里的口径一致，属设计取舍而非实现偏离。
  health.recordSuccess('weather', metaOk());
  assert.equal(health.overallMode(), 'live', 'air 单独失败不会触发 partial（关键源不参与 partial 统计）');
});

test('empty 优先于 stale：关键源全失败的同时还有其它源陈旧，仍判 empty', () => {
  health.recordFailure('weather', metaOk(), errNetwork);
  health.recordFailure('air', metaOk(), errNetwork);
  health.recordSuccess('elevation', metaOk({ cacheState: 'stale', staleAgeMs: 999 }));
  assert.equal(health.overallMode(), 'empty', 'empty 必须压过 stale');
});

test('从未发起过任何请求（attempts=0）时不判 empty', () => {
  assert.equal(health.overallMode(), 'live', '一次都没请求的冷启动不得显示「暂无可用数据」');
});

test('stale：任一源（含非关键源）处于陈旧态即上横幅', () => {
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  health.recordSuccess('elevation', metaOk({ cacheState: 'stale', staleAgeMs: 610000 }));
  assert.equal(health.overallMode(), 'stale');

  const h = health.getHealth('elevation');
  assert.equal(h.isStale, true);
  assert.equal(h.staleAgeMs, 610000, '陈旧时长必须记录到 SourceHealth');
  assert.equal(h.status, 'stale');
});

test('关键源失败但有陈旧兜底 → 该源记 degraded/stale（不判 failed）', () => {
  health.recordFailure('weather', metaOk({ cacheState: 'stale', staleAgeMs: 30000 }), errNetwork);
  assert.equal(health.getHealth('weather').status, 'stale', '有旧值时必须标 stale 而非 failed');
  assert.equal(health.getHealth('weather').isStale, true);
});

test('partial：非关键 API 源失败（瓦片不算）', () => {
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  health.recordFailure('elevation', metaOk(), errNetwork);
  assert.equal(health.getHealth('elevation').status, 'degraded');
  assert.equal(health.overallMode(), 'partial');

  // 单 reverse 失败也算 partial
  health.resetHealth();
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  health.recordFailure('reverse', metaOk(), errNetwork);
  assert.equal(health.overallMode(), 'partial');
});

test('no-map：仅瓦片失败（其余 API 源全部正常）时才轮到 no-map', () => {
  health.recordSuccess('weather', metaOk());
  health.recordSuccess('air', metaOk());
  health.recordSuccess('elevation', metaOk());
  health.recordSuccess('reverse', metaOk());
  tiles.setNoMapMode(true);
  assert.equal(health.overallMode(), 'no-map');
  assert.equal(health.isMapDisabled(), true);
  // partial 优先于 no-map
  health.recordFailure('elevation', metaOk(), errNetwork);
  assert.equal(health.overallMode(), 'partial', 'partial 必须压过 no-map');
});

test('recordFailure(OFFLINE) → 该源状态 offline；不再按 critical 判 failed', () => {
  health.recordFailure('weather', metaOffline, errOffline);
  assert.equal(health.getHealth('weather').status, 'offline');
  assert.equal(health.getHealth('weather').lastError.code, 'OFFLINE');
});

test('recordSuccess/recordFailure 字段写入正确；fromCache 不覆盖时延', () => {
  const before = Date.now();
  health.recordSuccess('weather', metaOk({ latencyMs: 321, finishedAt: before }));
  let h = health.getHealth('weather');
  assert.equal(h.attempts, 1);
  assert.equal(h.latencyMs, 321);
  assert.equal(h.lastSuccessAt, before);
  assert.equal(h.lastError, null);

  health.recordSuccess('weather', metaOk({ latencyMs: 999, fromCache: true, finishedAt: before + 1000 }));
  h = health.getHealth('weather');
  assert.equal(h.latencyMs, 321, '缓存命中（latencyMs=0）不得把最近成功时延冲掉');
  assert.equal(h.attempts, 2);

  health.recordFailure('weather', metaOk({ finishedAt: before + 2000 }), errNetwork);
  h = health.getHealth('weather');
  assert.equal(h.lastAttemptAt, before + 2000);
  assert.notEqual(h.lastError, null);
  assert.equal(h.status, 'failed', '关键源彻底失败且无兜底 → failed');
});

test('addSample 聚合自检取样样本；resetHealth 清空且幂等', () => {
  health.addSample('weather', 100);
  health.addSample('weather', 300);
  health.addSample('weather', Number.NaN); // 脏样本不得入库
  assert.deepEqual(health.getHealth('weather').samples, [100, 300]);
  health.resetHealth();
  assert.deepEqual(health.getHealth('weather').samples, []);
  assert.equal(health.getHealth('weather').status, 'idle');
  health.resetHealth();
  assert.equal(health.allHealth().length, 6, '必须按 SOURCE_LIST 建出 6 个槽位');
});

test('getHealth 对未知 sourceId 返回 idle 占位且不抛', () => {
  const h = health.getHealth('does-not-exist');
  assert.equal(h.status, 'idle');
  assert.equal(h.sourceId, 'does-not-exist');
  assert.deepEqual(h.samples, []);
});

test('allHealth 顺序与 SOURCE_LIST 一致（此刻屏与自检页口径一致的前提）', () => {
  const ids = health.allHealth().map((h) => h.sourceId);
  assert.deepEqual(ids, ['weather', 'air', 'geocode', 'elevation', 'reverse', 'tile']);
  assert.deepEqual(health.criticalIds(), ['weather', 'air']);
});

test('recordResult 按 SourceResult 自动分流成功/失败', () => {
  health.recordResult({ ok: true, sourceId: 'air', error: null, meta: metaOk() });
  assert.equal(health.getHealth('air').status, 'ok');
  health.recordResult({ ok: false, sourceId: 'air', error: errNetwork, meta: metaOk() });
  assert.equal(health.getHealth('air').status, 'failed');
  health.recordResult(null);
  health.recordResult(undefined);
});
