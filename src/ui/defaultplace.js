/**
 * 「默认地点」卡的决策层（设置页「我的」里的那张卡，见 ui/settings.js）。
 *
 * 职责：只回答**事实与转换**——出厂默认那份是什么、一次定位结果能不能当成「我的位置」
 * 写进去、GPS 结果 / 收藏项怎么变成可写入 store 的 place 对象、某个 place 是不是出厂
 * 那份。**一个 DOM 都不建、一句可见文案都不出**（可见文案全在 settings.js 走 t()），
 * 所以它也能被 Node 侧单测直接加载，不必先装假 DOM 与假 i18n。
 *
 * ★★本模块的第一条纪律：定位兜底出来的北京天安门**不是用户的位置**。
 *   它是 `core/geo.js` 在「拒绝 / 超时 / 环境不支持」时拿来让此刻屏还能渲染的**占位**，
 *   出厂那一版的名字就写在那里（`DEFAULT_PLACE_NAME`）。把它写进用户的默认地点，
 *   等于把一句假话持久化进备份 JSON —— 而且会随导出 / 导入带到别的设备上，
 *   到了那边它照样冒充「你的位置」。所以：
 *     1) `canAdoptGps()` 只认 `source === 'gps'`（真拿到了系统定位），其余一律 false；
 *     2) `adoptGps()` 在 `canAdoptGps()` 为假时返回 null —— 拿不到就不给东西写；
 *     3) `adoptFavorite()` 找不到就返回 null，**不回退出厂默认**
 *        （「没找到」与「用默认值」是两件完全不同的事，后者正是上面那句假话）。
 *
 * ★第二条纪律：出厂那份只能**以副本形式**出去（`factoryDefault()`）。
 *   直接把 `DEFAULT_PLACE` 交出去，调用方（或未来的调用方）改一个字段就会把全模块的
 *   兜底坐标改掉，而这种改动不会有任何报错。
 *
 * 依赖方向：ui → core（`core/geo.js` 的坐标常量与 round4、`core/format.js` 的坐标格式
 * 化）。本模块**不** import `core/store.js`（谁去读写 store 是 settings.js 的事，
 * 本模块只产出可以写进去的值），也不 import `src/i18n/`（core 不许反向到 ui，
 * 而本模块根本不出文案）。
 */

import { DEFAULT_PLACE, DEFAULT_PLACE_NAME, round4 } from '../core/geo.js';
import { coord as formatCoord } from '../core/format.js';

/**
 * 判断一个值是不是「能用的有限数字」。
 *
 * ★`Number(null) === 0`：本项目在这上面踩过四次。先排除 null / undefined / 空串，
 *   再判 `Number.isFinite` —— 否则「没给坐标」会被当成 (0, 0)（几内亚湾，一片海），
 *   而且**不会报错**，只是悄悄写进备份。
 *
 * @param {*} v 任意值。
 * @returns {boolean} 是有限数字则 true。
 */
function _finite(v) {
  if (v === null || v === undefined || v === '') return false;
  return Number.isFinite(Number(v));
}

/**
 * 由一条收藏造出可写入 store 的 place 对象（坐标一律 round4，与缓存键同一口径）。
 *
 * 收藏项没有名字时（用户收藏时没拿到地名）退回格式化坐标串 —— 那至少是真的坐标，
 * 不是某个不相干的地名。
 *
 * @param {Object} f 收藏项。
 * @returns {{lat:number, lon:number, name:string}|null} place 对象；坐标非法时 null。
 */
function _placeFrom(f) {
  if (!f || typeof f !== 'object') return null;
  if (!_finite(f.lat) || !_finite(f.lon)) return null;
  const lat = round4(f.lat);
  const lon = round4(f.lon);
  const raw = typeof f.name === 'string' ? f.name.trim() : '';
  return { lat, lon, name: raw || formatCoord(lat, lon) };
}

/**
 * 出厂默认地点的**副本**。
 *
 * ★必须给副本：`DEFAULT_PLACE` 是模块级常量，把原对象交出去，调用方改一个字段
 *   就会改掉全模块的定位兜底（不报错、只悄悄生效）。
 *
 * @returns {{lat:number, lon:number, name:string}} 出厂默认地点副本。
 */
export function factoryDefault() {
  return {
    lat: DEFAULT_PLACE.lat,
    lon: DEFAULT_PLACE.lon,
    name: DEFAULT_PLACE.name,
  };
}

/**
 * 一次定位结果能不能当成「我的位置」写进默认地点。
 *
 * ★判据只有一条：`coord.source === 'gps'`（真拿到了系统定位）。
 *   被拒 / 超时 / 环境不支持，在 `core/geo.js` 里统统降级成 `source: 'default'` 那一
 *   兜底坐标 —— 那个坐标是**占位**，不是用户的位置（见本模块文件头第一条纪律）。
 *   顺带再挡一道坐标有限性：真 GPS 也可能给出 NaN，写了照样是假话。
 *
 * @param {{lat:number, lon:number, source:string, name?:string|null}} coord 定位结果。
 * @returns {boolean} 可以采用则 true。
 */
export function canAdoptGps(coord) {
  const c = coord && typeof coord === 'object' ? coord : null;
  if (!c) return false;
  if (c.source !== 'gps') return false;
  return _finite(c.lat) && _finite(c.lon);
}

/**
 * 由一次**成功的**定位结果造出可写入 store 的 place 对象。
 *
 * 名字优先用 `coord.name`（真拿到了地名时由上游给），为空则退回格式化坐标串 ——
 * 坐标串是真话，凭空补一个地名不是。
 *
 * ★调用方必须先用 `canAdoptGps()` 把关：本函数对「非 GPS 结果」同样返回 null，
 *   两道门是同一条纪律，不是重复 —— 它们是**双保险**，任何一道被拆掉另一道还在。
 *
 * @param {{lat:number, lon:number, source:string, name?:string|null}} coord 定位结果。
 * @returns {{lat:number, lon:number, name:string}|null} place 对象；不可采用时 null。
 */
export function adoptGps(coord) {
  if (!canAdoptGps(coord)) return null;
  const lat = round4(coord.lat);
  const lon = round4(coord.lon);
  const raw = typeof coord.name === 'string' ? coord.name.trim() : '';
  return { lat, lon, name: raw || formatCoord(lat, lon) };
}

/**
 * 从收藏里按下标取一条，造出可写入 store 的 place 对象。
 *
 * ★只认下标，不认「收藏项自带的 id 字段」—— 本仓的收藏项**没有 id 字段**
 *   （store 的 addFavorite 推入 `{ lat, lon, name }`，去重靠 lat + lon 精确相等），
 *   为它留一条匹配分支就是一条**永远不会走到的死代码**；更糟的是它埋了个类型陷阱：
 *   入参既能当 id 又能当下标时，将来收藏项真有了 id 字段，传下标 `1` 会被拿去和
 *   `String(f.id)` 比，可能命中错误的条目。等真有了 id 再说，现在不许提前实现。
 *
 * ★找不到就返回 null，**不回退出厂默认**：「没找到」与「用默认值」是两件事，
 *   后者会把北京天安门写成用户的位置（见本模块文件头第一条纪律）。
 *
 * @param {Array<Object>} favorites 收藏列表。
 * @param {string|number} index 收藏在列表里的下标（界面传字符串，纯逻辑可传数字）。
 * @returns {{lat:number, lon:number, name:string}|null} place 对象；下标非法 / 越界时 null。
 */
export function adoptFavorite(favorites, index) {
  const list = Array.isArray(favorites) ? favorites : [];
  // ★`Number(null)` 与 `Number('')` 都是 0：不先排除 null / undefined / 空串，
  //   「没传下标」会命中列表第 0 条 —— 表现为「什么都没选却选中了第一个收藏」。
  let at = null;
  if (typeof index === 'number') {
    if (Number.isInteger(index)) at = index;
  } else if (typeof index === 'string' && index.trim() !== '') {
    const n = Number(index.trim());
    if (Number.isInteger(n)) at = n;
  }
  if (at === null || at < 0 || at >= list.length) return null;
  return _placeFrom(list[at]);
}

/**
 * 某个 place 是不是**出厂那份**默认地点（而不是用户自己设的）。
 *
 * 判据是名字等于 `DEFAULT_PLACE_NAME`：出厂那份的名字是写死的中文原文（它要进备份
 * JSON，见 core/geo.js 那条注释），用户自己设的位置不会叫这个名字。
 * 界面据此决定要不要标注「这是出厂默认，不是你的位置」—— 不标注的话，用户看着
 * 一行「北京 · 天安门」会以为自己什么时候设过它。
 *
 * @param {{lat:number, lon:number, name?:string|null}|null} place 地点对象。
 * @returns {boolean} 是出厂那份则 true。
 */
export function isFactoryDefault(place) {
  const p = place && typeof place === 'object' ? place : null;
  if (!p) return false;
  return typeof p.name === 'string' && p.name === DEFAULT_PLACE_NAME;
}

/**
 * 这个环境**有没有**浏览器定位能力（只问有没有，不问权限、不问结果）。
 *
 * 与 `canAdoptGps()` 是两件事：本函数回答「能不能问」，那个回答「问回来的结果能不能用」。
 * 分开的意义在失败文案上 —— 「这个环境根本没有定位」和「定位被你拒了」对用户是
 * 两种完全不同的下一步。
 *
 * @returns {boolean} 有 geolocation 且带 getCurrentPosition 则 true。
 */
export function gpsSupported() {
  const nav = typeof navigator !== 'undefined' && navigator ? navigator : null;
  const geo = nav && nav.geolocation ? nav.geolocation : null;
  return Boolean(geo && typeof geo.getCurrentPosition === 'function');
}

/**
 * 问一句系统对定位权限的裁决（问不到就返回 null，不猜）。
 *
 * ★`navigator.permissions.query()` 是**可选能力**：Safari 与部分安卓 WebView 没有它，
 *   权限 API 也可能因为 `name` 不被识别而 reject。这些情况下一律返回 null ——
 *   拿不到裁决就如实说拿不到，由 `classifyGpsFailure()` 落到「原因不明」那一档，
 *   绝不把 null 当成「没被拒绝」进而编出「已授权」。
 *
 * @returns {Promise<'granted'|'denied'|'prompt'|null>} 权限状态；不可用时 null。
 */
export async function queryGpsPermission() {
  const nav = typeof navigator !== 'undefined' && navigator ? navigator : null;
  const perms = nav && nav.permissions ? nav.permissions : null;
  if (!perms || typeof perms.query !== 'function') return null;
  try {
    const status = await perms.query({ name: 'geolocation' });
    const state = status && status.state;
    return state === 'granted' || state === 'denied' || state === 'prompt' ? state : null;
  } catch (err) {
    // 不认这个 name / 不支持这个权限名时会抛 —— 那只是「这条信号拿不到」
    return null;
  }
}

/**
 * 把一次**失败的**定位归成一类，供界面挑文案（界面自己不造文案，见 settings.js）。
 *
 * 四类，按顺序判：
 *   1) `unsupported`：环境根本没有 geolocation —— 问都没处问；
 *   2) `denied`：权限 API 明确说被拒（这条信号最硬，优先于耗时推断）；
 *   3) `timeout`：耗时已经顶到定位超时上限（说明是在等，等到超时）；
 *   4) `other`：拿不到裁决、又不是超时 —— 如实说原因不明，不猜成「被拒」。
 *
 * ★为什么第 4 类不能合并进第 2 类：`core/geo.js` 把「拒绝 / 不可用 / 位置信息缺失」
 *   三种错误回调统一降级，拿到的结果里**分不出**是哪一种（它不回传原因）。把
 *   「不知道」说成「你拒绝了」是一句假话 —— 用户会去找权限设置，而真正的毛病在别处。
 *
 * @param {{supported?:boolean, permission?:string|null, elapsedMs?:number|null, timeoutMs?:number|null}} ctx 失败现场。
 * @returns {'unsupported'|'denied'|'timeout'|'other'} 归类的原因。
 */
export function classifyGpsFailure(ctx = {}) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  if (c.supported === false) return 'unsupported';
  if (c.permission === 'denied') return 'denied';
  // ★又是 `Number(null) === 0`：不先排除 null / undefined，「没传 elapsedMs」会变成
  //   「耗时 0 ms」→ 判成 not timeout；「没传 timeoutMs」会变成「上限 0 ms」→ 判成超时。
  if (!_finite(c.elapsedMs) || !_finite(c.timeoutMs)) return 'other';
  return Number(c.elapsedMs) >= Number(c.timeoutMs) ? 'timeout' : 'other';
}
