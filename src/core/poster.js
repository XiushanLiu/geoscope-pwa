/**
 * 分享海报绘制（纯 Canvas 2D 绘制层）
 *
 * 只做「数据 → 像素」：不读 DOM、不读 i18n、不发请求，文案一律由调用方
 * （`ui/now.js`）按当前语言组装好传进来，因此可以注入假 ctx 单测。
 *
 * 依赖红线：本模块被 `ui/now.js` import，而 now.js 在「数据源自检页」
 * 单文件产物的依赖闭包里（见 tools/build-standalone.mjs 的 ORDER）——
 * 所以这里**不许**引任何数据源模块，保持零依赖，否则诊断页会被塞进死重量。
 */

/** 海报尺寸：750×1000（常见的社交分享竖版长宽比，3 倍图下也够清晰）。 */
export const POSTER_W = 750;
export const POSTER_H = 1000;

/* 海报是位图，不跟随界面主题：固定深底 + 品牌青，白字对比度稳定在 4.5:1 以上。 */
const BG_TOP = '#0b1a1c';
const BG_BOTTOM = '#123a35';
const BRAND = '#2bb6a3';
const TEXT = '#ffffff';
const SUB = 'rgba(255,255,255,0.74)';
const LINE = 'rgba(255,255,255,0.14)';
/** 中英文都能落到系统里已有的字重，避免 750px 宽的海报出现缺字方框。 */
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,-apple-system,sans-serif';

/** 边距（左右统一 64px，与 750 宽成比例）。 */
const PAD = 64;

/**
 * 把过长的文本裁到指定宽度，超出部分以省略号收尾。
 *
 * 用 measureText 逐字回退而不是按字数估算：中英混排 + emoji 的宽度差很大，
 * 按字数截会把「乌鲁木齐地窝堡国际机场」这类长地名切得莫名其妙。
 *
 * @param {CanvasRenderingContext2D} ctx 2D 上下文。
 * @param {string} text 原文。
 * @param {number} maxW 允许的最大宽度。
 * @returns {string} 放得下的文本。
 */
function _fit(ctx, text, maxW) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s || typeof ctx.measureText !== 'function') return s;
  if (ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * 绘制一张分享海报。
 *
 * 布局（自上而下）：品牌条 → 地点/坐标 → 大号温度 → 天气与体感 → 分隔线 →
 * 四项指标（今日最高/最低、降水概率、湿度）→ 页脚来源。
 *
 * @param {CanvasRenderingContext2D} ctx 2D 上下文。
 * @param {Object} model 海报数据；缺字段画占位符「—」，绝不抛异常。
 * @param {Object} [opts] 可选尺寸。
 * @returns {boolean} 是否真的画了（ctx 不可用时返回 false）。
 */
export function drawPoster(ctx, model, opts = {}) {
  // 假 ctx / 老浏览器：宁可什么都不画，也不让调用方在点击后拿到异常
  if (!ctx || typeof ctx.fillText !== 'function' || typeof ctx.fillRect !== 'function') return false;

  const W = Number(opts.width) || POSTER_W;
  const H = Number(opts.height) || POSTER_H;
  const m = model || {};
  const s = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));

  ctx.save();

  // 背景：竖向渐变；没有渐变能力（假 ctx）就退回纯色
  if (typeof ctx.createLinearGradient === 'function') {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, BG_TOP);
    g.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = BG_TOP;
  }
  ctx.fillRect(0, 0, W, H);

  // 顶部品牌青细条：比加载 logo 图更可靠（离线可用）
  ctx.fillStyle = BRAND;
  ctx.fillRect(0, 0, W, 8);

  // 品牌名（左）与观测时刻（右）
  ctx.textAlign = 'left';
  ctx.fillStyle = BRAND;
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText(s(m.brand), PAD, 92);
  ctx.textAlign = 'right';
  ctx.fillStyle = SUB;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(s(m.date), W - PAD, 92);

  // 地点与坐标
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.font = `700 62px ${FONT}`;
  ctx.fillText(_fit(ctx, s(m.place), W - PAD * 2), PAD, 236);
  ctx.fillStyle = SUB;
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(_fit(ctx, s(m.coord), W - PAD * 2), PAD, 286);

  // 大号温度：数字与单位分开画，避免「23°°C」这类重复单位
  const tempText = s(m.temp);
  ctx.fillStyle = TEXT;
  ctx.font = `700 180px ${FONT}`;
  ctx.fillText(tempText, PAD, 486);
  const tempW = typeof ctx.measureText === 'function' ? ctx.measureText(tempText).width : 0;
  ctx.fillStyle = SUB;
  ctx.font = `500 64px ${FONT}`;
  ctx.fillText(s(m.unit), PAD + tempW + 12, 486);

  // 天气现象与体感
  ctx.fillStyle = TEXT;
  ctx.font = `500 42px ${FONT}`;
  ctx.fillText(_fit(ctx, s(m.desc), W - PAD * 2), PAD, 576);
  ctx.fillStyle = SUB;
  ctx.font = `400 28px ${FONT}`;
  ctx.fillText(_fit(ctx, s(m.feels), W - PAD * 2), PAD, 624);

  // 分隔线
  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, 668, W - PAD * 2, 1);

  // 四项指标：2×2 网格（标签在上、数值在下）
  const stats = Array.isArray(m.stats) ? m.stats.slice(0, 4) : [];
  const colW = (W - PAD * 2) / 2;
  stats.forEach((item, i) => {
    const x = PAD + (i % 2) * colW;
    const y = 742 + Math.floor(i / 2) * 96;
    ctx.textAlign = 'left';
    ctx.fillStyle = SUB;
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText(_fit(ctx, s(item && item.label), colW - 16), x, y);
    ctx.fillStyle = TEXT;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(_fit(ctx, s(item && item.value), colW - 16), x, y + 48);
  });

  // 页脚：来源说明（左）与署名（右）
  ctx.fillStyle = LINE;
  ctx.fillRect(PAD, 912, W - PAD * 2, 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = SUB;
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText(_fit(ctx, s(m.footer), W - PAD * 2 - 160), PAD, 956);
  ctx.textAlign = 'right';
  ctx.fillStyle = BRAND;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(s(m.brand), W - PAD, 956);

  ctx.restore();
  return true;
}
