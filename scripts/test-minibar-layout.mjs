import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLLAPSED_WIDTH,
  COLLAPSED_HEIGHT,
  EXPANDED_WIDTH,
  EXPANDED_HEIGHT,
  calculateCollapsedBounds,
  calculateWindowBoundsForState,
  clampBoundsToWorkArea,
  calculateStartupPosition,
} from '../src/main/services/minibar-geometry.ts';
import { toRemainingPercent } from '../src/renderer/components/pulse/agent-quota-utils.ts';

test('1. 悬浮窗尺寸定义符合设计规格 (收起 80x340, 展开 370x340)', () => {
  assert.equal(COLLAPSED_WIDTH, 80);
  assert.equal(COLLAPSED_HEIGHT, 340);
  assert.equal(EXPANDED_WIDTH, 370);
  assert.equal(EXPANDED_HEIGHT, 340);
});

test('2. 展开与收起锚点换算: calculateCollapsedBounds 永远保持稳定的收起态右锚点', () => {
  // 收起态：宽度 80，x=1840，y=120
  const collapsed = { x: 1840, y: 120, width: 80, height: 340 };
  const anchorFromCollapsed = calculateCollapsedBounds(collapsed, false);
  assert.deepEqual(anchorFromCollapsed, { x: 1840, y: 120 });

  // 展开态：宽度 370，x=1550，y=120（右边缘 1550 + 370 = 1920）
  const expanded = { x: 1550, y: 120, width: 370, height: 340 };
  const anchorFromExpanded = calculateCollapsedBounds(expanded, true);
  // 恢复收起锚点应精确等于 1840，绝对不能保存为 1550
  assert.deepEqual(anchorFromExpanded, { x: 1840, y: 120 });
});

test('3. 向左展开几何计算: 右边缘像素在展开与收起过程中绝对零位移、零跳动', () => {
  const anchor = { x: 1840, y: 120 };

  const collapsedBounds = calculateWindowBoundsForState(anchor, false);
  const expandedBounds = calculateWindowBoundsForState(anchor, true);

  // 收起态物理边界
  assert.equal(collapsedBounds.x, 1840);
  assert.equal(collapsedBounds.width, 80);
  const collapsedRightEdge = collapsedBounds.x + collapsedBounds.width;

  // 展开态物理边界
  assert.equal(expandedBounds.x, 1840 + 80 - 370); // 1550
  assert.equal(expandedBounds.width, 370);
  const expandedRightEdge = expandedBounds.x + expandedBounds.width;

  // 核心守恒验证：右边缘屏幕绝对坐标完全相同！
  assert.equal(collapsedRightEdge, 1920);
  assert.equal(expandedRightEdge, 1920);
  assert.equal(collapsedRightEdge, expandedRightEdge);

  // 新增四向吸附：顶部/底部采用 340x56 横向胶囊，展开向屏幕内侧延伸
  const topCollapsed = calculateWindowBoundsForState({ x: 790, y: 0 }, false, 'top');
  assert.deepEqual(topCollapsed, { x: 790, y: 0, width: 340, height: 56 });
  const topExpanded = calculateWindowBoundsForState({ x: 790, y: 0 }, true, 'top');
  assert.deepEqual(topExpanded, { x: 790, y: 0, width: 340, height: 370 });

  const bottomCollapsed = calculateWindowBoundsForState({ x: 790, y: 960 }, false, 'bottom');
  assert.deepEqual(bottomCollapsed, { x: 790, y: 960, width: 340, height: 56 });
  const bottomExpanded = calculateWindowBoundsForState({ x: 790, y: 960 }, true, 'bottom');
  assert.deepEqual(bottomExpanded, { x: 790, y: 646, width: 340, height: 370 });
});

test('4. 屏幕边界夹持: 无论如何拖动，均默认吸附在工作区右侧并限制 Y 轴范围', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  // 收起态贴右边缘
  const posCollapsed = clampBoundsToWorkArea(500, 200, 80, 340, workArea, false);
  assert.equal(posCollapsed.x, 1920 - 80);
  assert.equal(posCollapsed.y, 200);

  // 展开态贴右边缘
  const posExpanded = clampBoundsToWorkArea(500, 200, 370, 340, workArea, true);
  assert.equal(posExpanded.x, 1920 - 370);
  assert.equal(posExpanded.y, 200);

  // 越界 Y 轴夹持（超出屏幕顶部）
  const posTopOverflow = clampBoundsToWorkArea(100, -50, 80, 340, workArea, false);
  assert.equal(posTopOverflow.y, 0);

  // 越界 Y 轴夹持（超出屏幕底部）
  const posBottomOverflow = clampBoundsToWorkArea(100, 1500, 80, 340, workArea, false);
  assert.equal(posBottomOverflow.y, 1040 - 340);
});

test('5. 额度数据准确性: 严格保真剩余百分比，缺失额度绝不冒充 0% 或 100%', () => {
  assert.equal(toRemainingPercent(0), 100);
  assert.equal(toRemainingPercent(25), 75);
  assert.equal(toRemainingPercent(50), 50);
  assert.equal(toRemainingPercent(80), 20);
  assert.equal(toRemainingPercent(100), 0);

  // 缺失数据必须返回 null，供前端渲染 "—" 和灰色底环
  assert.equal(toRemainingPercent(null), null);
  assert.equal(toRemainingPercent(undefined), null);
  assert.equal(toRemainingPercent(NaN), null);
});

test('6. 安全与敏感信息隔离扫描: 新增与修改模块严禁暴露任何敏感凭证或物理地址', () => {
  const filesToScan = [
    path.join('src', 'renderer', 'components', 'minibar', 'MiniBar.tsx'),
    path.join('src', 'main', 'minibar-window.ts'),
    path.join('src', 'main', 'services', 'minibar-geometry.ts'),
  ];

  const forbiddenPatterns = [
    /\btoken\b\s*[:=]\s*['"`][a-zA-Z0-9_-]{16,}['"`]/i,
    /\bsecret\b\s*[:=]/i,
    /\bcredential\b\s*[:=]/i,
    /\bprivateKey\b\s*[:=]/i,
    /\bmac\b\s*[:=]\s*['"`](?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}['"`]/i,
    /\bdeviceAddress\b\s*[:=]/i,
    /install\.local/i,
  ];

  for (const f of filesToScan) {
    const fullPath = path.resolve(f);
    assert.ok(fs.existsSync(fullPath), `文件必须存在: ${f}`);
    const content = fs.readFileSync(fullPath, 'utf-8');
    for (const pat of forbiddenPatterns) {
      assert.ok(!pat.test(content), `文件 ${f} 触发了敏感词规则: ${pat.toString()}`);
    }
  }
});

test('7. 边缘标签与侧栏锚点双向转换无损守恒 (左右吸附均零漂移)', async () => {
  const {
    EDGE_TAB_WIDTH,
    EDGE_TAB_HEIGHT,
    calculateEdgeTabBounds,
    restoreAnchorFromEdgeTab,
  } = await import('../src/main/services/minibar-geometry.ts');

  assert.equal(EDGE_TAB_WIDTH, 18);
  assert.equal(EDGE_TAB_HEIGHT, 48);

  // 右侧吸附场景 (原侧栏锚点 x=1840, y=100)
  const rightAnchor = { x: 1840, y: 100 };
  const tabBoundsRight = calculateEdgeTabBounds(rightAnchor, 'right');
  // 右吸附时标签应贴在 1840 + 80 - 18 = 1902，Y 轴纵向居中：100 + (340 - 48)/2 = 246
  assert.equal(tabBoundsRight.x, 1902);
  assert.equal(tabBoundsRight.y, 246);
  assert.equal(tabBoundsRight.width, 18);
  assert.equal(tabBoundsRight.height, 48);

  // 原路恢复侧栏锚点
  const restoredRight = restoreAnchorFromEdgeTab(tabBoundsRight, 'right');
  assert.deepEqual(restoredRight, rightAnchor);

  // 左侧吸附场景 (原侧栏锚点 x=0, y=100)
  const leftAnchor = { x: 0, y: 100 };
  const tabBoundsLeft = calculateEdgeTabBounds(leftAnchor, 'left');
  assert.equal(tabBoundsLeft.x, 0);
  assert.equal(tabBoundsLeft.y, 246);

  // 原路恢复侧栏锚点
  const restoredLeft = restoreAnchorFromEdgeTab(tabBoundsLeft, 'left');
  assert.deepEqual(restoredLeft, leftAnchor);
});

test('8. 中文重置时间解析: 层次分明，缺失时间标为未知，绝不伪造', async () => {
  const { parseResetTimeInfo } = await import('../src/renderer/components/pulse/agent-quota-utils.ts');

  // parseResetTimeInfo 会按「当前时间 + 相对倒计时」判断今天/明天，必须注入固定时刻，
  // 否则断言结果随跑测试的钟点变化（傍晚跑就会跨天变成「明天」）。
  const NOON = new Date(2026, 0, 15, 12, 0, 0);

  // 1. 包含相对倒计时和绝对钟点：`51min · 18:40`
  const t1 = parseResetTimeInfo('51min · 18:40', NOON);
  assert.equal(t1.countdownText, '51 分钟后重置');
  assert.equal(t1.absoluteTimeText, '重置于 今天 18:40');

  // 2. 包含复合倒计时：`4h 22min · 20:15`
  const t2 = parseResetTimeInfo('4h 22min · 20:15', NOON);
  assert.equal(t2.countdownText, '4 小时 22 分钟后重置');
  assert.equal(t2.absoluteTimeText, '重置于 今天 20:15');

  // 2b. 相对倒计时跨过午夜时必须标「明天」，不能再无条件写「今天」
  const t2b = parseResetTimeInfo('5h · 0:11', new Date(2026, 0, 15, 19, 11, 0));
  assert.equal(t2b.absoluteTimeText, '重置于 明天 0:11');

  // 3. 仅有天和小时：`2d 7h`（无绝对钟点）
  const t3 = parseResetTimeInfo('2d 7h');
  assert.equal(t3.countdownText, '2 天 7 小时后重置');
  assert.equal(t3.absoluteTimeText, null);

  // 4. 等待额度刷新：`ready`
  const t4 = parseResetTimeInfo('ready');
  assert.equal(t4.countdownText, '等待额度刷新');
  assert.equal(t4.absoluteTimeText, null);

  // 5. 缺失或占位：null, undefined, '', '--'
  const t5 = parseResetTimeInfo(null);
  assert.equal(t5.countdownText, '重置时间未知');
  assert.equal(t5.absoluteTimeText, null);

  const t6 = parseResetTimeInfo('--');
  assert.equal(t6.countdownText, '重置时间未知');
  assert.equal(t6.absoluteTimeText, null);
});

test('9. 右键菜单闭环验证: 窗口失焦、捕获拦截与焦点 IPC 绑定', () => {
  const minibarWinPath = path.resolve('src/main/minibar-window.ts');
  const preloadPath = path.resolve('src/preload/index.ts');
  const miniBarComponentPath = path.resolve('src/renderer/components/minibar/MiniBar.tsx');

  const minibarWinContent = fs.readFileSync(minibarWinPath, 'utf-8');
  const preloadContent = fs.readFileSync(preloadPath, 'utf-8');
  const componentContent = fs.readFileSync(miniBarComponentPath, 'utf-8');

  // 主进程必须监听 blur 并通知渲染进程
  assert.ok(minibarWinContent.includes("minibarWin.on('blur'"), '主进程缺少 minibarWin blur 事件监听');
  assert.ok(minibarWinContent.includes("'minibar:window-blur'"), '主进程未派发 minibar:window-blur 消息');
  assert.ok(minibarWinContent.includes("'minibar:menu-open'"), '主进程缺少 minibar:menu-open 焦点 IPC');

  // Preload 必须暴露 onWindowBlur 和 notifyMenuOpen
  assert.ok(preloadContent.includes('notifyMenuOpen:'), 'Preload 未暴露 notifyMenuOpen');
  assert.ok(preloadContent.includes('onWindowBlur:'), 'Preload 未暴露 onWindowBlur');

  // 组件必须在捕获阶段拦截 pointerdown 并响应 onWindowBlur
  assert.ok(componentContent.includes("window.codeisland?.onWindowBlur"), '组件未接入 onWindowBlur 监听');
  assert.ok(componentContent.includes("window.addEventListener('pointerdown', handleCapturePointerDown, { capture: true })"), '组件未在捕获阶段监听 pointerdown');
  assert.ok(componentContent.includes("window.codeisland?.notifyMenuOpen?.()"), '组件打开菜单未通知主进程聚焦');
});

test('10. 侧栏轮廓与几何对齐: S 曲线两端切入且内容中心线共线', () => {
  const miniBarComponentPath = path.resolve('src/renderer/components/minibar/MiniBar.tsx');
  const componentContent = fs.readFileSync(miniBarComponentPath, 'utf-8');

  // 验证用户调校的 S 曲线贝塞尔路径
  const rightPath = 'M 80,0 C 80,22 21,18 21,40 L 21,300 C 21,322 80,318 80,340 Z';
  const leftPath = 'M 0,0 C 0,22 59,18 59,40 L 59,300 C 59,322 0,318 0,340 Z';
  assert.ok(componentContent.includes(rightPath), '右吸附缺少调校后的 S 曲线路径');
  assert.ok(componentContent.includes(leftPath), '左吸附缺少调校后的 S 曲线路径');

  // 验证主体宽度为 59 DIP 且正确贴边偏移
  assert.ok(componentContent.includes("absolute top-0 bottom-0 w-[59px]"), '侧栏主体容器未配置为 59 DIP 宽');
  assert.ok(componentContent.includes("isLeftDock ? 'left-0' : 'left-[21px]'"), '侧栏主体容器左右吸附偏移配置有误');

  // 圆环中心必须由 cfg.centerY 直接驱动，保证与详情卡尖角严格共线
  assert.ok(componentContent.includes('style={{ top: `${cfg.centerY - 20}px` }}'), '圆环未按 centerY 绝对定位，尖角无法与环心对齐');
});

test('11. 详情卡排版规范: 尺寸收拢至 246 DIP 且双周期字号一致', () => {
  const miniBarComponentPath = path.resolve('src/renderer/components/minibar/MiniBar.tsx');
  const componentContent = fs.readFileSync(miniBarComponentPath, 'utf-8');

  // 卡片外形尺寸
  assert.ok(componentContent.includes("w-[264px] h-[246px]"), '详情卡尺寸未收紧为 264x246');
  assert.ok(componentContent.includes("top-[37px]"), '详情卡垂直居中定位偏移应为 top-[37px]');

  // 百分比统一 20 DIP，相对倒计时统一 13 DIP，标题与绝对时间统一 12 DIP
  assert.ok(componentContent.includes("text-[20px] font-medium text-white leading-none tabular-nums tracking-tight"), '百分比未统一为 20 DIP');
  assert.ok(componentContent.includes("text-[13px] font-normal text-white/80 tabular-nums tracking-normal"), '倒计时未统一为 13 DIP');
  assert.ok(componentContent.includes("text-[12px] font-normal text-white/40 tabular-nums text-right"), '绝对时间未统一为 12 DIP');
});

test('12. 悬浮窗原生拖动设计完整性验证', () => {
  const miniBarComponentPath = path.resolve('src/renderer/components/minibar/MiniBar.tsx');
  const componentContent = fs.readFileSync(miniBarComponentPath, 'utf-8');

  // 1. 顶部和底部拖拽热区必须完整保留
  assert.ok(componentContent.includes('drag-region cursor-grab active:cursor-grabbing'), '缺少拖拽区 CSS 类');
  assert.ok(componentContent.includes('onMouseDown={handleDragRegionMouseDown}'), '缺少拖拽触发函数 handleDragRegionMouseDown 绑定');
  
  // 2. 拖拽时必须重置展开态并通知主进程
  assert.ok(componentContent.includes('window.codeisland?.notifyDragStart?.()'), 'handleDragRegionMouseDown 未通知主进程收起卡片');
  
  // 3. 子控件必须标记 no-drag 避免阻断点击
  assert.ok(componentContent.includes('no-drag'), '缺少 no-drag 标记');
});

test('13. 多显示器启动停靠几何与偏好语义计算 (主屏停靠、记忆副屏、热插拔兜底与边缘标签)', () => {
  // 用户实测复现布局
  const DISPLAY2_PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
  const DISPLAY1_SECONDARY = { x: 1920, y: -64, width: 1536, height: 864 };
  const dualDisplays = [DISPLAY2_PRIMARY, DISPLAY1_SECONDARY];

  // 场景 1: 用户曾拖到副屏 DISPLAY1 (x=1920, y=170)
  const savedOnSecondary = { x: 1920, y: 170, dockSide: 'left' };

  // 1.1 偏好为 'right'：必须固定停靠在主显示器 DISPLAY2 右边缘 (1920 - 80 = 1840)，严禁留在副显示器
  const dockRight = calculateStartupPosition({
    preference: 'right',
    saved: savedOnSecondary,
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(dockRight.dockSide, 'right');
  assert.equal(dockRight.x, 1840);
  assert.equal(dockRight.y, 170);
  assert.equal(dockRight.width, 80);
  assert.equal(dockRight.height, 340);

  // 1.2 偏好为 'left'：必须固定停靠在主显示器 DISPLAY2 左边缘 (0)，严禁留在副显示器
  const dockLeft = calculateStartupPosition({
    preference: 'left',
    saved: savedOnSecondary,
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(dockLeft.dockSide, 'left');
  assert.equal(dockLeft.x, 0);
  assert.equal(dockLeft.y, 170);
  assert.equal(dockLeft.width, 80);
  assert.equal(dockLeft.height, 340);

  // 1.3 偏好为 'remember'：沿用上次所在的副显示器 DISPLAY1 及其左侧停靠
  const dockRemember = calculateStartupPosition({
    preference: 'remember',
    saved: savedOnSecondary,
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(dockRemember.dockSide, 'left');
  assert.equal(dockRemember.x, 1920);
  assert.equal(dockRemember.y, 170);

  // 1.4 偏好为 'remember' 且上次在副屏为 top/bottom 横向胶囊条：启动时归到副屏右侧 (竖条)
  const dockRememberHorizontal = calculateStartupPosition({
    preference: 'remember',
    saved: { x: 2200, y: -64, dockSide: 'top' },
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(dockRememberHorizontal.dockSide, 'right');
  assert.equal(dockRememberHorizontal.x, 1920 + 1536 - 80); // 3376 (DISPLAY1 右边缘)
  assert.equal(dockRememberHorizontal.width, 80);
  assert.equal(dockRememberHorizontal.height, 340);

  // 边角 1: Windows 主显示器切换（DISPLAY1 成为主屏）
  const switchPrimary = calculateStartupPosition({
    preference: 'left',
    saved: { x: 0, y: 170, dockSide: 'right' },
    primaryWorkArea: DISPLAY1_SECONDARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(switchPrimary.dockSide, 'left');
  assert.equal(switchPrimary.x, 1920); // 立即跟随新主屏左边缘

  // 边角 2: 显示器热插拔（副显示器 DISPLAY1 被拔掉）
  const unplugSecondary = calculateStartupPosition({
    preference: 'remember',
    saved: savedOnSecondary, // 原坐标在已不存在的 1920
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: [DISPLAY2_PRIMARY], // 仅剩 DISPLAY2
  });
  // 必须安全回落到主显示器 DISPLAY2
  assert.equal(unplugSecondary.dockSide, 'left');
  assert.equal(unplugSecondary.x, 0); // 回落到主显示器左边缘
  assert.equal(unplugSecondary.y, 170);

  // 边角 3: 越界 Y 轴夹持（防止因 DPI/分辨率差异导致出屏）
  const overflowY = calculateStartupPosition({
    preference: 'right',
    saved: { x: 1920, y: 9999, dockSide: 'left' },
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(overflowY.y, 1080 - 340); // 740

  const underflowY = calculateStartupPosition({
    preference: 'right',
    saved: { x: 1920, y: -500, dockSide: 'left' },
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
  });
  assert.equal(underflowY.y, 0);

  // 边角 4: 边缘标签态 (edge-tab) 启动
  const edgeTabStartup = calculateStartupPosition({
    preference: 'right',
    saved: { x: 1840, y: 100, dockSide: 'right', displayMode: 'edge-tab' },
    primaryWorkArea: DISPLAY2_PRIMARY,
    allWorkAreas: dualDisplays,
    displayMode: 'edge-tab',
  });
  assert.equal(edgeTabStartup.dockSide, 'right');
  assert.equal(edgeTabStartup.width, 18);
  assert.equal(edgeTabStartup.height, 48);
  assert.equal(edgeTabStartup.x, 1920 - 18); // 1902
  assert.equal(edgeTabStartup.y, 100 + (340 - 48) / 2); // 246 (相对侧栏纵向居中)
});



