/**
 * Photon 逆地理反查适配器
 *
 * 职责：把坐标反查成人类可读地名（区 / 街道 / 名称层级）。只做「构造请求 + 解析响应」，
 * 网络与缓存分别由 core/http.js 与 core/cache.js 负责。
 *
 * 端点：https://photon.komoot.io/reverse?lat=&lon=&lang=default（实测定稿，不得改动）。
 */

import { round4 } from '../core/geo.js';

/** Photon 服务基址。 */
export const PHOTON_HOST = 'https://photon.komoot.io';

/** 许可署名。 */
export const PHOTON_ATTRIBUTION = 'Photon by Komoot（基于 OpenStreetMap，ODbL）';

/**
 * 构造逆地理反查请求。
 *
 * @param {{lat:number, lon:number}} ctx 上下文。
 * @returns {{url:string, params:Object, responseType:'json'}} RequestSpec。
 */
export function buildReverseRequest(ctx) {
  return {
    url: `${PHOTON_HOST}/reverse`,
    params: {
      lat: round4(ctx.lat).toFixed(4),
      lon: round4(ctx.lon).toFixed(4),
      lang: 'default',
    },
    responseType: 'json',
  };
}

/**
 * 解析 Photon 响应 → 地名层级。
 *
 * Photon 返回 GeoJSON FeatureCollection；本阶段只取首个 feature 的 properties，
 * 拼出「名称 / 街道 / 区 / 市 / 国家」层级文本，供此刻屏标题与位置卡使用。
 *
 * @param {Object} json 响应 JSON。
 * @param {{lat:number, lon:number}} [ctx] 上下文（未命中时用于回退占位）。
 * @returns {{placeName:string|null, name:string|null, street:string|null, district:string|null,
 *            city:string|null, state:string|null, country:string|null, osmKey:string|null}} 地名对象。
 */
export function parseReverse(json, ctx) {
  const features = (json && json.features) || [];
  if (!Array.isArray(features) || features.length === 0) {
    return {
      placeName: null,
      name: null,
      street: null,
      district: null,
      city: null,
      state: null,
      country: null,
      osmKey: null,
    };
  }
  const p = (features[0] && features[0].properties) || {};

  const name = p.name ? String(p.name) : null;
  const street = p.street ? String(p.street) : null;
  const district = p.district ? String(p.district) : null;
  const city = p.city ? String(p.city) : null;
  const state = p.state ? String(p.state) : null;
  const country = p.country ? String(p.country) : null;
  const osmKey = p.osm_key ? String(p.osm_key) : null;

  // 层级去重后拼接：越靠前越具体
  const parts = [name, street, district, city, state, country].filter(
    (v, i, arr) => v !== null && v !== '' && arr.indexOf(v) === i
  );

  return {
    placeName: parts.length > 0 ? parts.join(' · ') : null,
    name,
    street,
    district,
    city,
    state,
    country,
    osmKey,
  };
}
