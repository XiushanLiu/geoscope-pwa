/**
 * 指标释义（图例）+ Pad 横屏布局
 *
 * 背景：界面上一堆专业数字（AQI / UV / 蒲福风级 / 气压 / 能见度…）没人解释就等于数据
 * 垃圾，所以此刻页底部加了「指标释义」面板；同时 390px 的单列布局在 ≥768px 的横屏上
 * 会拉成一条窄长条，追加了一个纯 CSS 的横屏媒体块。
 *
 * 本文件钉死四条：
 *   1) 入口**能被打开**：默认收起 → 点一下 → 面板出现且内容非空、含关键指标条目；
 *   2) **阈值不是编的**：档位行里的每个数字都与 src/core/wmo.js 的换算表对拍；
 *   3) 代码里**没有现成分档**的指标，不许出现档位行（气温 / 湿度 / 气压 / 能见度 / 污染物…）；
 *   4) 横屏媒体块不得破坏 `.tabbar` 的 shrink-to-fit 假设（给 .tabbar 设 width 会重演
 *      真机上「四个 tab 文字断成两行」那个 bug，见 commit fa1ec49）。
 *
 * 断言风格沿用 grid-banner.test.mjs：渲染行为走运行时假 DOM，装配约定走源码级 match。
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createFakeDom, uninstallDom, text } from './harness.mjs';
import { t, hasKey } from '../src/i18n/index.js';
import { beaufortScale, aqiScale, uvScale, windRose16 } from '../src/core/wmo.js';
import { renderLegend, legendModel, isLegendOpen } from '../src/ui/legend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const appCss = readFileSync(join(ROOT, 'styles/app.css'), 'utf8');

/** 模块加载那一刻的展开态 —— 必须是「收起」，且不随后续用例的点击而改变。 */
const INITIAL_OPEN = isLegendOpen();

/** 界面上真实出现的指标 id（renderWeatherCard / renderAirCard / renderPlaceCard）。 */
const KEY_IDS = [
  // 'pop'（降水概率）随「降水概率上屏」那批改动加入：界面上新增了一个数，
  // 释义表里就该多一条 —— 少登记等于那条断言对新增条目视而不见。
  'temp', 'feels', 'humidity', 'precip', 'pop', 'wind', 'beaufort', 'winddir',
  'pressure', 'visibility', 'uv', 'sun', 'dayLength', 'today', 'wmo', 'observedAt',
  'aqi', 'pollutants', 'elevation', 'coord', 'tz',
];

/** 代码里没有现成分档、因此**不许**出现档位行的指标。 */
const NO_SCALE_IDS = [
  'temp', 'feels', 'humidity', 'precip', 'pop', 'wind', 'pressure', 'visibility',
  'sun', 'dayLength', 'today', 'wmo', 'observedAt', 'pollutants',
  'elevation', 'coord', 'tz',
];

/**
 * 建一棵假 DOM、渲染图例，并归一到「收起」态。
 *
 * @returns {{root:Object, btn:() => Object}} 句柄（btn 每次重新查询：整槽重建会换节点）。
 */
function mount() {
  createFakeDom();
  const root = document.createElement('main');
  renderLegend(root);
  const btn = () => root.querySelector('.legend-toggle');
  if (isLegendOpen()) btn().click(); // 上一个用例可能把它点开了，先归位
  return { root, btn };
}

/**
 * 扁平化条目模型。
 *
 * @returns {Object} id → 条目。
 */
function byId() {
  const out = {};
  for (const g of legendModel()) for (const it of g.items) out[it.id] = it;
  return out;
}

test('① 默认收起：不占首屏，且没有面板节点', () => {
  assert.equal(INITIAL_OPEN, false, '模块加载时必须是收起的');
  const { root, btn } = mount();
  assert.equal(root.querySelectorAll('.legend-panel').length, 0, '收起时不应有面板节点');
  assert.equal(btn().getAttribute('aria-expanded'), 'false', '收起时 aria-expanded 应为 false');
  uninstallDom();
});

test('② 点一下能打开：面板内容非空', () => {
  const { root, btn } = mount();
  btn().click();
  assert.equal(isLegendOpen(), true, '点一下应展开');

  const panel = root.querySelector('.legend-panel');
  assert.ok(panel, '展开后必须能查到 .legend-panel');
  const body = text(panel);
  assert.ok(body.length > 200, `面板内容不应是空的（实际 ${body.length} 字）`);
  assert.ok(root.querySelectorAll('.legend-item').length > 0, '至少要有条目');
  uninstallDom();
});

test('③ 关键指标条目齐全，且每条都有「名字 + 单位 + 正文」', () => {
  const { root, btn } = mount();
  btn().click();
  const model = byId();

  for (const id of KEY_IDS) {
    assert.ok(model[id], `图例缺少指标条目：${id}`);
    assert.ok(model[id].title.length > 0, `${id} 缺标题`);
    assert.ok(model[id].unit.length > 0, `${id} 缺单位`);
    assert.ok(model[id].body.length > 0, `${id} 缺正文`);
    // 拿到键名 = 那条文案没进 ZH 表（t() 缺失时返回 key 本身）
    assert.ok(!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/i.test(model[id].title), `${id} 标题没翻译：${model[id].title}`);
    assert.ok(!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/i.test(model[id].body), `${id} 正文没翻译：${model[id].body}`);
  }
  assert.equal(root.querySelectorAll('.legend-item').length, KEY_IDS.length, '条目数与模型应一致');
  uninstallDom();
});

test('④ 蒲福风级 13 级：级数 / 级名 / 阈值全部与 beaufortScale() 对拍', () => {
  const bf = beaufortScale();
  const rows = byId().beaufort.rows;
  assert.equal(rows.length, bf.length, `蒲福应有 ${bf.length} 级，实际 ${rows.length}`);
  bf.forEach((r, i) => {
    assert.ok(rows[i].includes(`${r.level} 级`), `第 ${i} 行缺级数：${rows[i]}`);
    assert.ok(rows[i].includes(t(r.key)), `第 ${i} 行缺级名「${t(r.key)}」：${rows[i]}`);
    if (i < bf.length - 1) {
      assert.ok(rows[i].includes(String(Number(r.maxMs))), `第 ${i} 行缺上限 ${r.maxMs}：${rows[i]}`);
    } else {
      assert.ok(rows[i].includes(String(Number(bf[i - 1].maxMs))), `末行缺下界：${rows[i]}`);
    }
  });
});

test('⑤ 欧洲 AQI 六档 / UV 五档：档名 + 下界 + 建议全部对拍', () => {
  const model = byId();

  const aqi = aqiScale();
  const aqiRows = model.aqi.rows;
  assert.equal(aqiRows.length, aqi.length, `AQI 应有 ${aqi.length} 档`);
  aqi.forEach((r, i) => {
    const min = i === 0 ? 0 : aqi[i - 1].max + 1;
    assert.ok(aqiRows[i].includes(t(r.levelKey)), `AQI 第 ${i} 行缺档名「${t(r.levelKey)}」：${aqiRows[i]}`);
    assert.ok(aqiRows[i].includes(String(min)), `AQI 第 ${i} 行缺下界 ${min}：${aqiRows[i]}`);
    assert.ok(aqiRows[i].includes(t(r.adviceKey)), `AQI 第 ${i} 行缺建议：${aqiRows[i]}`);
  });

  const uv = uvScale();
  const uvRows = model.uv.rows;
  assert.equal(uvRows.length, uv.length, `UV 应有 ${uv.length} 档`);
  uv.forEach((r, i) => {
    const min = i === 0 ? 0 : uv[i - 1].max + 1;
    assert.ok(uvRows[i].includes(t(r.levelKey)), `UV 第 ${i} 行缺档名「${t(r.levelKey)}」：${uvRows[i]}`);
    assert.ok(uvRows[i].includes(String(min)), `UV 第 ${i} 行缺下界 ${min}：${uvRows[i]}`);
  });
});

test('⑥ 风向 16 方位与 windRose16() 逐项对拍', () => {
  const rose = windRose16();
  const rows = byId().winddir.rows;
  assert.equal(rows.length, rose.length, `风向应有 ${rose.length} 个方位`);
  // windRose16() 给的是 16 个方位**键**，图例那一行由 legend.js 补上「风」这个字
  rose.forEach((key, i) => {
    const want = t('w.windFrom', { dir: t(key) });
    assert.ok(rows[i].includes(want), `风向第 ${i} 项应为「${want}」：${rows[i]}`);
  });
});

test('⑦ 没有现成分档的指标：一条档位行都不许有', () => {
  const model = byId();
  for (const id of NO_SCALE_IDS) {
    assert.equal(model[id].rows.length, 0, `${id} 在代码里没有现成分档，不该出现档位行`);
  }
  // 反向：有分档的必须真的有行
  for (const id of ['beaufort', 'winddir', 'aqi', 'uv']) {
    assert.ok(model[id].rows.length > 0, `${id} 的分档来自既有实现，档位行不该是空的`);
  }
});

test('⑧ 文案全走 i18n：legend.* 键都在表里', () => {
  assert.ok(hasKey('legend.title'), 'legend.title 应在文案表里');
  assert.ok(hasKey('legend.noScale'), 'legend.noScale 应在文案表里');
  assert.equal(t('legend.title'), '指标释义');
  // 模型里不允许残留未替换的 {占位符}
  for (const g of legendModel()) {
    for (const it of g.items) {
      assert.ok(!/\{\w+\}/.test(it.title), `${it.id} 标题残留占位符：${it.title}`);
      assert.ok(!/\{\w+\}/.test(it.body), `${it.id} 正文残留占位符：${it.body}`);
      for (const r of it.rows) assert.ok(!/\{\w+\}/.test(r), `${it.id} 档位行残留占位符：${r}`);
    }
  }
});

test('⑨ 展开态活过整槽重建（renderSkeleton 会重跑 renderLegend）', () => {
  const { root, btn } = mount();
  btn().click();
  assert.equal(isLegendOpen(), true);
  renderLegend(root); // 模拟 renderSkeleton 重跑
  assert.equal(root.querySelectorAll('.legend-panel').length, 1, '重建后展开态应保留');
  btn().click();
  assert.equal(isLegendOpen(), false, '再点一下应收起');
  assert.equal(root.querySelectorAll('.legend-panel').length, 0);
  uninstallDom();
});

test('⑩ app.css：图例样式齐备，且类名一律 .legend- 前缀', () => {
  for (const cls of [
    '.legend-panel', '.legend-note', '.legend-group', '.legend-group-title',
    '.legend-list', '.legend-item', '.legend-item-head', '.legend-item-name',
    '.legend-item-unit', '.legend-item-body', '.legend-scale', '.legend-scale-row',
  ]) {
    assert.ok(appCss.includes(`${cls} {`) || appCss.includes(`${cls} {`.replace(' {', '{')), `app.css 缺少 ${cls}`);
  }
});

test('⑪ 横屏：媒体块存在，且不得给 .tabbar 设 width（shrink-to-fit 假设）', () => {
  assert.ok(/@media \(min-width: 768px\)/.test(appCss), 'app.css 应追加 @media (min-width: 768px) 块');
  // .tabbar 是 position: fixed 且**没有设 width** —— 宽度由内容决定。
  // 一旦给它设 width（或改成靠边拉伸），flex-basis: 0 会重新分不到剩余空间，
  // 真机上「四个 tab 文字断成两行」那个 bug（fa1ec49）就会重演。
  const blocks = appCss.match(/\.tabbar\s*\{[^}]*\}/g) || [];
  assert.ok(blocks.length >= 1, '至少应有一条 .tabbar 规则');
  for (const b of blocks) {
    assert.ok(!/(^|[;{\s])width\s*:/.test(b), `.tabbar 不得声明 width（会破坏 shrink-to-fit）：${b}`);
  }
});

test('⑫ 横屏：不引入横向滚动的隐患（两列都用 minmax(0, 1fr)）', () => {
  const block = appCss.slice(appCss.indexOf('@media (min-width: 768px)'));
  assert.ok(block.includes('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)'), '两列必须都是 minmax(0, 1fr)');
  assert.ok(/max-width:\s*960px/.test(block), '内容区应有 max-width 上限，避免文字拉成长句');
  assert.ok(block.includes('zoom: 1.8'), '底图应整体放大（zoom 而非改宽高，理由见 app.css 注释）');
});
