/**
 * 主题引导必须覆盖全部手写入口（<html data-theme>）
 *
 * 背景：commit a0dde93 加了三档主题切换，写属性的 `applyThemeMode()` 只活在
 * src/ui/settings.js 里，而且只有那一页在模块顶层调用过。src/ui/app.js（index.html）、
 * selfcheck.js、compass.js 三个入口的 import 清一色是 i18n / core / data，**没有一个引入
 * 主题引导**。后果按 styles/tokens.css 的规则推：
 *   - 用户选「浅色」、系统偏好深色 → 三页 <html> 上没有 data-theme，媒体块
 *     `@media (prefers-color-scheme: light) :root:not([data-theme='dark'])` 不触发 → 仍是深色；
 *   - 用户选「深色」、系统偏好浅色 → 三页没有 data-theme='dark' 去挡媒体块 → 变浅色。
 * 而 src/i18n/zh.js 的 settings.themeHint 承诺的是「手动指定后会一直保持」。
 *
 * 本文件钉死的契约：**仅完成 import、不调 boot() / init()**，`<html data-theme>` 就已经
 * 按 `getThemeMode()` 落好 —— 也就是主题引导必须写在模块顶层，不能塞进启动函数里。
 * 手写入口逐一验，只验一个等于没验（漏的就是没验的那个）。
 *
 * ★曾经漏过两个：`compare.html` 与（已下线的）`roadtrip.html` 都在这里**没有条目**，而文件头上
 *   那句「必须与 check.mjs 的 ENTRY_OF_PAGE 保持一致」是散文 —— 它不会变红。
 *   这两个页面的入口本来就在模块顶层引导主题，check.mjs 第 11 节的源码扫描也早就
 *   覆盖了它们，所以缺的那六条用例从来没有报过警（「不加也绿」）。2026-10 补上。
 * 手法：ES module 是**缓存**的，同一个说明符第二次 import 不会重新求值、顶层代码不会再
 * 跑。所以每个用例给入口模块加一个唯一的 `?theme-case=N` 查询串，强制 Node 重新求值该
 * 模块（其依赖仍命中缓存，store 的内存态因此得以保留，setThemeMode 才有效）。
 *
 * 零第三方依赖：node:test + node:assert + tests/harness.mjs 的极简假 DOM。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installNavigator, installStorage, installFetch, FakeStorage } from './harness.mjs';

// 全局必须在 import 被测模块**之前**装好（store.js 在加载期决定走内存还是 localStorage）
installStorage(new FakeStorage());
installNavigator({ online: true });
installFetch();
const dom = createFakeDom([{ id: 'app' }, { id: 'banner' }]);
/** 主题属性写在 <html> 上，即 document.documentElement。 */
const root = dom.html;

const { getThemeMode, setThemeMode } = await import('../src/core/store.js');
const { applyThemeMode } = await import('../src/ui/theme.js');

/**
 * 手写入口 → 入口模块。必须与 tools/check.mjs 的 ENTRY_OF_PAGE **除生成产物之外的部分**
 * 保持一致（check.mjs 第 11 节用源码扫描钉死「每个入口都引导」，本文件钉死「引导真的
 * 生效」—— 两件事，缺一不可）。
 *
 * ★`selfcheck-standalone.html` 故意不在内：它是打包产物，入口写在内联脚本里、
 * 由浏览器原生解析，Node 侧 import 不到，且与 selfcheck.js 是同一个模块（重复验）。
 *
 * @type {Array<{page:string, entry:string}>}
 */
const ENTRIES = [
  { page: 'index.html', entry: '../src/ui/app.js' },
  { page: 'selfcheck.html', entry: '../src/ui/selfcheck.js' },
  { page: 'compass.html', entry: '../src/ui/compass.js' },
  { page: 'settings.html', entry: '../src/ui/settings.js' },
  // 下面这个**不进 tabbar**（底部胶囊在 320px 屏上三个 tab 是安全上限，加第四项必断行），
  // 但它同样是手写入口、同样有独立的一份「引导」，漏掉就等于默认它可以不引导。
  // ★2026-10-17 自驾下线：原 `roadtrip.html` → `../src/ui/roadtrip.js` 一条已删除
  //   （页面与入口模块一起下线，留着会直接 import 失败）。
  { page: 'compare.html', entry: '../src/ui/compare.js' },
];

/** 期望的 <html data-theme> 值：system 是**没有**这个属性（null），不是字符串。 */
const EXPECT_ATTR = { system: null, light: 'light', dark: 'dark' };

/** @type {number} 唯一化 import 说明符用的自增序号。 */
let seq = 0;

for (const { page, entry } of ENTRIES) {
  for (const mode of ['light', 'dark', 'system']) {
    test(`${page}：仅 import ${entry}（不调 boot()/init()）— data-theme 已按 ${mode} 落好`, async () => {
      seq += 1;
      setThemeMode(mode);
      assert.equal(getThemeMode(), mode, `前置条件：store 里的主题应为 ${mode}`);

      // 先把属性设成**与期望相反**的初值：否则「属性恰好没被写过」也会通过断言。
      // system 期望没有属性 → 先写 light；light/dark 期望有属性 → 先写另一个 / 移除。
      if (mode === 'system') applyThemeMode('light');
      else applyThemeMode(mode === 'light' ? 'dark' : 'light');

      await import(`${entry}?theme-case=${seq}`);

      assert.equal(
        root.getAttribute('data-theme'),
        EXPECT_ATTR[mode],
        `${page} 顶层未把主题落成 ${mode}（实际 ${JSON.stringify(root.getAttribute('data-theme'))}）`
      );
      assert.equal(
        root.hasAttribute('data-theme'),
        mode !== 'system',
        `${page} 在 ${mode} 下 data-theme 的存在性不对（system 必须移除属性）`
      );
    });
  }
}

test('手写入口的引导是同一个实现（applyThemeMode 唯一，语义一致）', async () => {
  // 三档语义逐值过一遍：这是全部手写入口共用同一实现的兜底断言，
  // 防止将来某个入口自己抄一份、把 system 写成 "system"（那会挡掉 :not() 守卫 → 永远深色）。
  for (const mode of ['light', 'dark', 'system']) {
    assert.equal(applyThemeMode(mode), mode, `applyThemeMode(${mode}) 应回显 ${mode}`);
    assert.equal(root.getAttribute('data-theme'), EXPECT_ATTR[mode], `${mode} 的属性值不对`);
  }
});
