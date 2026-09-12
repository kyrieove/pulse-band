/**
 * 表盘卡片纯逻辑测试（层 1）
 * 运行方式：node --test scripts/test-watchface-utils.mjs
 *
 * 覆盖边界：只覆盖无 React / 无 DOM 的纯函数。卡片实际渲染尺寸与观感
 * 需要真机 + 手环连接才能验收，不在本文件范围内。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWatchfaceColor,
  isSupportedImageFileName,
  watchfaceDisplayName,
  WATCHFACE_CANVAS_WIDTH,
  WATCHFACE_CANVAS_HEIGHT,
} from '../src/renderer/components/pulse/watchface-utils.ts';

test('normalizeWatchfaceColor: 接受常见 hex 形状，统一成小写 #rrggbb', () => {
  assert.equal(normalizeWatchfaceColor('#1A2B3C'), '#1a2b3c');
  assert.equal(normalizeWatchfaceColor('1a2b3c'), '#1a2b3c');
  assert.equal(normalizeWatchfaceColor('0x1A2B3C'), '#1a2b3c');
  assert.equal(normalizeWatchfaceColor('  #abc '), '#abc');
  assert.equal(normalizeWatchfaceColor('#11223344'), '#11223344');
});

test('normalizeWatchfaceColor: 非法值一律 null，交给调用方回退中性底色', () => {
  assert.equal(normalizeWatchfaceColor(''), null);
  assert.equal(normalizeWatchfaceColor('   '), null);
  assert.equal(normalizeWatchfaceColor(undefined), null);
  assert.equal(normalizeWatchfaceColor(null), null);
  assert.equal(normalizeWatchfaceColor(123), null);
  assert.equal(normalizeWatchfaceColor('red'), null);
  assert.equal(normalizeWatchfaceColor('rgb(1,2,3)'), null);
  assert.equal(normalizeWatchfaceColor('#12345'), null);
  assert.equal(normalizeWatchfaceColor('url(x)'), null);
  assert.equal(normalizeWatchfaceColor('expression(alert(1))'), null);
});

test('isSupportedImageFileName: 只看后缀，大小写不敏感', () => {
  assert.equal(isSupportedImageFileName('a.png'), true);
  assert.equal(isSupportedImageFileName('a.JPEG'), true);
  assert.equal(isSupportedImageFileName('my.face.webp'), true);
  assert.equal(isSupportedImageFileName('a.gif'), true);
  assert.equal(isSupportedImageFileName('a.bin'), false);
  assert.equal(isSupportedImageFileName('noext'), false);
  assert.equal(isSupportedImageFileName('a.png.exe'), false);
});

test('watchfaceDisplayName: 名字为空时回退 id，不产生无标签卡片', () => {
  assert.equal(watchfaceDisplayName('BetaUI-黑塔', '976603977'), 'BetaUI-黑塔');
  assert.equal(watchfaceDisplayName('  ', '976603977'), '976603977');
  assert.equal(watchfaceDisplayName(undefined, '976603977'), '976603977');
  assert.equal(watchfaceDisplayName(null, '976603977'), '976603977');
});

test('卡片画布常量与手环屏一致（竖长条）', () => {
  assert.equal(WATCHFACE_CANVAS_WIDTH, 192);
  assert.equal(WATCHFACE_CANVAS_HEIGHT, 490);
  assert.ok(WATCHFACE_CANVAS_HEIGHT > WATCHFACE_CANVAS_WIDTH, '手环屏必须是竖长条');
});
