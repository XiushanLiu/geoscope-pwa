/**
 * 求路坐标的**发出前防御**（`src/data/osrm.js::buildRouteRequest`）
 *
 * 为什么单独钉这一件事：真机报障「数据源返回 HTTP 400」。我拿真实坐标 curl 直打
 * OSRM 公共实例实测出两个 400 来源（2026-10-15）：
 *   · URL 里含 `0.000000,0.000000` → 400 `InvalidUrl`
 *   · 纬度越界（如 lat=121，经纬度取反的典型症状）→ 400 `InvalidValue`
 *   对照组（正常两点 / 四点含必经点 / `overview=full` / 起终点相同）一律 200 ——
 *   所以不是服务不可用、不是参数写错、不是 URL 太长。
 *
 * 原先的行为是「坏点被 filter **悄悄丢掉**，凑不够两个就报 needMorePoints」——
 * 用户明明填了 4 个点却看到「点数不足」，既骗人，又让他完全无从自查。
 * 现在要求：有点但坐标不可用时报 `rt.err.badCoord`，**且一个请求都不发**。
 *
 * 环境：纯 data 层，零第三方依赖（node:test + node:assert）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteRequest } from '../src/data/osrm.js';

/** 两个正常坐标（成都 / 北京）。 */
const CD = { lat: 30.5728, lon: 104.0665 };
const BJ = { lat: 39.9042, lon: 116.4074 };

test('★纬度越界（lat=121，经纬度取反的症状）必须在发请求前拦住', () => {
  assert.throws(
    () => buildRouteRequest({ points: [{ lat: 121.4737, lon: 31.2304 }, BJ] }),
    (err) => err && err.messageKey === 'rt.err.badCoord',
    '越界坐标必须报 badCoord —— 实测 OSRM 对它回 HTTP 400 InvalidValue'
  );
});

test('★(0,0) 等同于没坐标：必须拦，不许把 0.000000 拼进 URL', () => {
  assert.throws(
    () => buildRouteRequest({ points: [{ lat: 0, lon: 0 }, BJ] }),
    (err) => err && err.messageKey === 'rt.err.badCoord',
    '(0,0) 必须报 badCoord —— 实测 OSRM 对它回 HTTP 400 InvalidUrl'
  );
});

test('★坏点必须报「坐标不可用」，不许谎报「点数不足」', () => {
  assert.throws(
    () => buildRouteRequest({ points: [CD, { lat: 121, lon: 31 }, { lat: 0, lon: 0 }, BJ] }),
    (err) => err && err.messageKey === 'rt.err.badCoord' && err.messageParams.n === 2,
    '四个点里两个坏：必须报 badCoord，且把坏点数（2）带进 messageParams.n'
  );
});

test('★真的点数不足时仍报 needMorePoints（这条不许被上面的防御挤掉）', () => {
  assert.throws(
    () => buildRouteRequest({ points: [CD] }),
    (err) => err && err.messageKey === 'rt.err.needMorePoints',
    '只有一个好点、没有任何坏点 → 仍然是 needMorePoints'
  );
});

test('★正常坐标照常构造 URL，且经度在前（防御不许误伤）', () => {
  const spec = buildRouteRequest({ points: [CD, BJ] });
  assert.match(
    spec.url,
    /\/driving\/104\.066500,30\.572800;116\.407400,39\.904200$/,
    '正常两点必须原样进 URL，且是 {lon},{lat} 顺序'
  );
});

test('★边界值必须放行：±90 纬度 / ±180 经度是合法坐标，不是「越界」', () => {
  const spec = buildRouteRequest({ points: [{ lat: 90, lon: 180 }, { lat: -90, lon: -180 }] });
  assert.match(spec.url, /\/driving\/180\.000000,90\.000000;-180\.000000,-90\.000000$/);
});
