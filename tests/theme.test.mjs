/**
 * 主题落属性回归（<html data-theme>）
 *
 * 背景：写属性的代码（现为 src/ui/theme.js 的 applyThemeMode()，原本在 src/ui/settings.js）
 * 上线时**零测试覆盖**。它决定 styles/tokens.css 里两组浅色选择器命中哪一组：
 *   system → 移除属性（交给 @media prefers-color-scheme 媒体块）
 *   light  → data-theme="light"（命中属性块）
 *   dark   → data-theme="dark"（挡掉媒体查询，回落 :root 的深色默认值）
 * 写错不会报错、也不会让任何既有用例变红，只会让用户「明明选了浅色却还是深色」——
 * 这类静默失效只能靠断言钉死。
 *
 * 环境：直接复用 tests/harness.mjs 的极简假 DOM（零第三方依赖，不引入 jsdom）。
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDom, installNavigator, installStorage, FakeStorage, uninstallDom } from './harness.mjs';

installStorage(new FakeStorage());
installNavigator({ online: true });
const dom = createFakeDom([{ id: 'theme-mode' }, { id: 'theme-result' }]);
/** 主题属性写在 <html> 上，即 document.documentElement。 */
const root = dom.html;

// 必须在 import 被测模块**之前**装好全局（store.js 在加载期决定走内存还是 localStorage）
const { setThemeMode, getThemeMode } = await import('../src/core/store.js');
// applyThemeMode 已抽到 ui/theme.js（四个入口共用）；THEME_MODES 仍是设置页的界面顺序
const { applyThemeMode } = await import('../src/ui/theme.js');
const { THEME_MODES } = await import('../src/ui/settings.js');

/**
 * 取 <html data-theme> 当前值（无属性时为 null）。
 *
 * @returns {string|null} 属性值。
 */
function themeAttr() {
  return root.getAttribute('data-theme');
}

beforeEach(() => {
  setThemeMode('system');
  applyThemeMode('system');
});

test('applyThemeMode(light) → <html data-theme="light">', () => {
  assert.equal(applyThemeMode('light'), 'light');
  assert.equal(themeAttr(), 'light');
  assert.equal(root.hasAttribute('data-theme'), true);
});

test('applyThemeMode(dark) → <html data-theme="dark">', () => {
  assert.equal(applyThemeMode('dark'), 'dark');
  assert.equal(themeAttr(), 'dark');
});

test('applyThemeMode(system) → 属性被移除（交给 prefers-color-scheme）', () => {
  applyThemeMode('light');
  assert.equal(themeAttr(), 'light');
  assert.equal(applyThemeMode('system'), 'system');
  assert.equal(themeAttr(), null);
  assert.equal(root.hasAttribute('data-theme'), false);
});

test('setThemeMode(light) 经 applyThemeMode 落到 <html>：light', () => {
  setThemeMode('light');
  assert.equal(getThemeMode(), 'light');
  assert.equal(applyThemeMode(getThemeMode()), 'light');
  assert.equal(themeAttr(), 'light');
});

test('setThemeMode(system) 经 applyThemeMode 落到 <html>：属性被移除', () => {
  setThemeMode('light');
  applyThemeMode(getThemeMode());
  assert.equal(themeAttr(), 'light');
  setThemeMode('system');
  assert.equal(getThemeMode(), 'system');
  applyThemeMode(getThemeMode());
  assert.equal(themeAttr(), null);
});

test('非法值钳位为 system（宁可跟随系统，也不写 UI 认不出来的值）', () => {
  applyThemeMode('light');
  assert.equal(applyThemeMode('dark-mode'), 'system');
  assert.equal(themeAttr(), null);
  setThemeMode('LIGHT');
  assert.equal(getThemeMode(), 'system');
  setThemeMode(undefined);
  assert.equal(getThemeMode(), 'system');
});

test('THEME_MODES 三档顺序固定（界面顺序即数组顺序）', () => {
  assert.deepEqual(THEME_MODES, ['system', 'light', 'dark']);
  for (const mode of THEME_MODES) {
    assert.equal(applyThemeMode(mode), mode);
  }
});

test('无 document 时是空操作，不抛（Node 侧静态检查会 import 本模块）', () => {
  uninstallDom();
  try {
    assert.equal(applyThemeMode('light'), 'light');
    assert.equal(applyThemeMode('system'), 'system');
  } finally {
    // 还原：本文件后续不再依赖 document，但保持全局干净，避免影响同进程其它用例
    createFakeDom([{ id: 'theme-mode' }]);
  }
});
