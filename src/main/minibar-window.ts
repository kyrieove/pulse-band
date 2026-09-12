import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionManager } from './services/session-manager';
import type { StatusServer } from './services/status-server';
import type { MinibarState } from '../common/types';
import {
  resolveMiniBarVisibility,
  resolveMiniBarDockPreference,
  type MiniBarDockPreference,
} from './services/minibar-preference';
import {
  COLLAPSED_WIDTH,
  COLLAPSED_HEIGHT,
  EXPANDED_WIDTH,
  EXPANDED_HEIGHT,
  H_COLLAPSED_WIDTH,
  H_COLLAPSED_HEIGHT,
  EDGE_TAB_WIDTH,
  EDGE_TAB_HEIGHT,
  calculateCollapsedBounds,
  calculateWindowBoundsForState,
  calculateEdgeTabBounds,
  restoreAnchorFromEdgeTab,
  clampBoundsToWorkArea,
  resolveDockTarget,
  isHorizontalDock,
  calculateStartupPosition,
  type WorkAreaRect,
} from './services/minibar-geometry';
import type { DockSide } from './services/minibar-geometry';

export {
  COLLAPSED_WIDTH,
  COLLAPSED_HEIGHT,
  EXPANDED_WIDTH,
  EXPANDED_HEIGHT,
  EDGE_TAB_WIDTH,
  EDGE_TAB_HEIGHT,
  calculateCollapsedBounds,
  calculateWindowBoundsForState,
  calculateEdgeTabBounds,
  restoreAnchorFromEdgeTab,
  calculateStartupPosition,
};

let minibarWin: BrowserWindow | null = null;
let isExpanded = false;
let currentDockSide: DockSide = 'right';
let currentDisplayMode: import('../common/types').MinibarDisplayMode = 'full';
let updateTimer: NodeJS.Timeout | null = null;
let sessionManagerRef: SessionManager | null = null;
let statusServerRef: StatusServer | null = null;
// 手动拖拽跟随（替代原生 -webkit-app-region: drag）状态
let dragFollowTimer: NodeJS.Timeout | null = null;
let dragGrabOffset = { dx: 0, dy: 0 };

export function getBoundsFile(): string {
  return path.join(app.getPath('userData'), 'minibar-bounds.json');
}

export function getPreferenceFile(): string {
  return path.join(app.getPath('userData'), 'minibar-preferences.json');
}

interface MiniBarPreferences {
  visible?: boolean;
  dockPreference?: MiniBarDockPreference;
}

function loadPreferences(): MiniBarPreferences {
  try {
    const p = getPreferenceFile();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function savePreferences(patch: Partial<MiniBarPreferences>): void {
  try {
    const current = loadPreferences();
    const next: MiniBarPreferences = {
      ...current,
      ...patch,
    };
    fs.writeFileSync(getPreferenceFile(), JSON.stringify(next, null, 2), 'utf-8');
  } catch {
    /* 界面状态持久化失败不影响悬浮窗本身 */
  }
}

function loadVisibility(): boolean {
  return resolveMiniBarVisibility(loadPreferences().visible);
}

function saveVisibility(visible: boolean): void {
  savePreferences({ visible });
}

export function loadDockPreference(): MiniBarDockPreference {
  return resolveMiniBarDockPreference(loadPreferences().dockPreference);
}

export function saveDockPreference(dockPreference: MiniBarDockPreference): void {
  savePreferences({ dockPreference });
}

function loadSavedBounds(): {
  x?: number;
  y?: number;
  dockSide?: DockSide;
  displayMode?: import('../common/types').MinibarDisplayMode;
} {
  try {
    const p = getBoundsFile();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        return data;
      }
    }
  } catch {
    // ignore
  }
  return {};
}

function saveBounds() {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  try {
    const b = minibarWin.getBounds();
    const anchor = currentDisplayMode === 'edge-tab'
      ? restoreAnchorFromEdgeTab(b, currentDockSide)
      : calculateCollapsedBounds(b, isExpanded, currentDockSide);
    fs.writeFileSync(
      getBoundsFile(),
      JSON.stringify({
        x: anchor.x,
        y: anchor.y,
        dockSide: currentDockSide,
        displayMode: currentDisplayMode,
      })
    );
  } catch {
    // ignore
  }
}

/**
 * 把窗口位置夹回可见工作区。
 * 跨屏或拔屏时检测是否在任一显示器中；若脱落则夹回主显示器。
 */
export function clampToVisibleArea(
  x: number,
  y: number,
  w: number,
  h: number,
  expanded: boolean = false
): { x: number; y: number } {
  try {
    const displays = screen.getAllDisplays();
    const currentDisplay =
      displays.find((d) => {
        const a = d.workArea;
        return x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height;
      }) || screen.getPrimaryDisplay();

    return clampBoundsToWorkArea(x, y, w, h, currentDisplay.workArea, expanded, currentDockSide);
  } catch {
    return { x, y };
  }
}

/**
 * 拖拽结束判定：根据松手时鼠标最近的四条屏幕边缘吸附。
 * 左右边缘使用竖向侧栏，上下边缘切换为横向胶囊条。
 */
function handleDragSettle(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursor);
  const workArea = targetDisplay.workArea;
  const dock = resolveDockTarget(cursor, workArea);
  const horizontal = isHorizontalDock(dock.dockSide);

  currentDockSide = dock.dockSide;
  isExpanded = false;
  const targetW = horizontal ? H_COLLAPSED_WIDTH : COLLAPSED_WIDTH;
  const targetH = horizontal ? H_COLLAPSED_HEIGHT : COLLAPSED_HEIGHT;

  minibarWin.setBounds({
    x: dock.x,
    y: dock.y,
    width: targetW,
    height: targetH,
  });
  saveBounds();
  pushState();
}

function startDragFollow(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  if (dragFollowTimer) clearInterval(dragFollowTimer);

  const cursor = screen.getCursorScreenPoint();
  const bounds = minibarWin.getBounds();
  dragGrabOffset = {
    dx: cursor.x - bounds.x,
    dy: cursor.y - bounds.y,
  };

  dragFollowTimer = setInterval(() => {
    if (!minibarWin || minibarWin.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    minibarWin.setPosition(
      Math.round(point.x - dragGrabOffset.dx),
      Math.round(point.y - dragGrabOffset.dy),
    );
  }, 16);
}

function stopDragFollowAndSettle(): void {
  if (dragFollowTimer) {
    clearInterval(dragFollowTimer);
    dragFollowTimer = null;
  }
  if (!minibarWin || minibarWin.isDestroyed()) return;
  handleDragSettle();
}

/**
 * 设置悬浮窗显示形态：完整侧栏模式 vs 边缘小型胶囊标签模式。
 * 切换时保持纵向居中与所属屏幕边缘吸附，零跳动。
 */
export function setDisplayMode(mode: import('../common/types').MinibarDisplayMode): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  if (currentDisplayMode === mode) return;

  const currentBounds = minibarWin.getBounds();
  if (mode === 'edge-tab') {
    const anchor = calculateCollapsedBounds(currentBounds, isExpanded, currentDockSide);
    isExpanded = false;
    const tabBounds = calculateEdgeTabBounds(anchor, currentDockSide);
    currentDisplayMode = 'edge-tab';
    minibarWin.setBounds(tabBounds);
    saveBounds();
    pushState();
  } else {
    const anchor = restoreAnchorFromEdgeTab(currentBounds, currentDockSide);
    const horizontal = isHorizontalDock(currentDockSide);
    const fixed = clampToVisibleArea(
      anchor.x,
      anchor.y,
      horizontal ? H_COLLAPSED_WIDTH : COLLAPSED_WIDTH,
      horizontal ? H_COLLAPSED_HEIGHT : COLLAPSED_HEIGHT,
      false,
    );
    currentDisplayMode = 'full';
    isExpanded = false;
    minibarWin.setBounds({
      x: fixed.x,
      y: fixed.y,
      width: horizontal ? H_COLLAPSED_WIDTH : COLLAPSED_WIDTH,
      height: horizontal ? H_COLLAPSED_HEIGHT : COLLAPSED_HEIGHT,
    });
    saveBounds();
    pushState();
  }
}

/** 显示前确保窗口在当前可见区域内（运行期拔插显示器也自适应）。 */
function ensureOnScreen(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  const b = minibarWin.getBounds();
  const fixed = clampToVisibleArea(b.x, b.y, b.width, b.height, isExpanded);
  if (fixed.x !== b.x || fixed.y !== b.y) {
    minibarWin.setPosition(fixed.x, fixed.y);
    saveBounds();
  }
}

function pushState() {
  if (!minibarWin || minibarWin.isDestroyed() || !sessionManagerRef || !statusServerRef) return;
  const state: MinibarState = {
    sessions: sessionManagerRef.getAllSessions(),
    quotas: statusServerRef.getQuotas(),
    isExpanded,
    dockSide: currentDockSide,
    displayMode: currentDisplayMode,
  };
  minibarWin.webContents.send('minibar-state', state);
}

function notifyVisibility() {
  const visible = isMiniBarVisible();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w !== minibarWin) {
      w.webContents.send('minibar:visibility-changed', visible);
    }
  }
}

export function isMiniBarVisible(): boolean {
  return !!(minibarWin && !minibarWin.isDestroyed() && minibarWin.isVisible());
}

export function toggleMiniBar(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  if (minibarWin.isVisible()) {
    minibarWin.hide();
    saveVisibility(false);
  } else {
    ensureOnScreen();
    minibarWin.show();
    saveVisibility(true);
    pushState();
  }
  notifyVisibility();
}

/**
 * 设置悬浮窗展开/收起状态。
 * 支持右吸附向左展开与左吸附向右展开，屏幕吸附边缘绝对不动。
 */
export function setWindowExpanded(expand: boolean): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  if (isExpanded === expand) return;
  if (currentDisplayMode === 'edge-tab') return; // 边缘标签态下不直接展开卡片

  const currentBounds = minibarWin.getBounds();
  const anchor = calculateCollapsedBounds(currentBounds, isExpanded, currentDockSide);
  isExpanded = expand;
  const newBounds = calculateWindowBoundsForState(anchor, isExpanded, currentDockSide);

  minibarWin.setBounds(newBounds);
  pushState();
}

/**
 * 重置 MiniBar 悬浮窗至主显示器右侧停靠位置（默认位置）。
 */
export function resetMiniBarDock(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;

  try {
    const primary = screen.getPrimaryDisplay();
    currentDockSide = 'right';
    currentDisplayMode = 'full';
    isExpanded = false;

    const width = COLLAPSED_WIDTH;
    const height = COLLAPSED_HEIGHT;
    const newX = Math.round(primary.workArea.x + primary.workArea.width - width);
    const newY = Math.round(primary.workArea.y + Math.max(24, (primary.workArea.height - height) / 2));

    minibarWin.setBounds({ x: newX, y: newY, width, height });
    saveBounds();
    pushState();
  } catch {
    // ignore
  }
}

export function createMiniBarWindow(
  sessionManager: SessionManager,
  statusServer: StatusServer
): BrowserWindow {
  sessionManagerRef = sessionManager;
  statusServerRef = statusServer;

  const cjsPreload = path.join(import.meta.dirname, '../preload/index.cjs');
  const jsPreload = path.join(import.meta.dirname, '../preload/index.js');
  const mjsPreload = path.join(import.meta.dirname, '../preload/index.mjs');
  const preloadPath = fs.existsSync(cjsPreload)
    ? cjsPreload
    : fs.existsSync(jsPreload)
    ? jsPreload
    : mjsPreload;

  const saved = loadSavedBounds();
  const dockPref = loadDockPreference();

  if (saved.displayMode) {
    currentDisplayMode = saved.displayMode;
  }

  let primaryWorkArea: WorkAreaRect = { x: 0, y: 0, width: 1920, height: 1080 };
  let allWorkAreas: WorkAreaRect[] = [primaryWorkArea];
  try {
    primaryWorkArea = screen.getPrimaryDisplay().workArea;
    allWorkAreas = screen.getAllDisplays().map((d) => d.workArea);
  } catch {
    // 单元测试或无原生显示环境兜底
  }

  const startup = calculateStartupPosition({
    preference: dockPref,
    saved,
    primaryWorkArea,
    allWorkAreas,
    displayMode: currentDisplayMode,
  });

  currentDockSide = startup.dockSide;
  const initW = startup.width;
  const initH = startup.height;
  const defaultX = startup.x;
  const defaultY = startup.y;

  minibarWin = new BrowserWindow({
    width: initW,
    height: initH,
    x: defaultX,
    y: defaultY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false, // 彻底消除 Windows DWM 透明窗口外围矩形投影框
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  minibarWin.on('close', (e) => {
    e.preventDefault();
    minibarWin?.hide();
    notifyVisibility();
  });

  minibarWin.on('blur', () => {
    if (minibarWin && !minibarWin.isDestroyed()) {
      minibarWin.webContents.send('minibar:window-blur');
    }
  });

  minibarWin.on('show', () => notifyVisibility());
  minibarWin.on('hide', () => notifyVisibility());

  minibarWin.once('ready-to-show', () => {
    pushState();
    if (loadVisibility()) minibarWin?.show();
    notifyVisibility();
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    minibarWin.loadURL(`${process.env.VITE_DEV_SERVER_URL}?screen=minibar`);
  } else {
    minibarWin.loadFile(path.join(import.meta.dirname, '../../dist/index.html'), {
      query: { screen: 'minibar' },
    });
  }

  // 监听会话变更与心跳轮询
  sessionManager.on('update', pushState);
  if (!updateTimer) {
    updateTimer = setInterval(pushState, 3000);
  }

  // 注册独立 IPC 事件（幂等单次绑定）
  ipcMain.removeHandler('minibar:get-state');
  ipcMain.handle('minibar:get-state', () => {
    return {
      sessions: sessionManager.getAllSessions(),
      quotas: statusServer.getQuotas(),
      isExpanded,
      dockSide: currentDockSide,
      displayMode: currentDisplayMode,
    };
  });

  ipcMain.removeAllListeners('minibar:set-display-mode');
  ipcMain.on('minibar:set-display-mode', (_, mode: import('../common/types').MinibarDisplayMode) => {
    setDisplayMode(mode);
  });

  ipcMain.removeAllListeners('minibar:set-expanded');
  ipcMain.on('minibar:set-expanded', (_, expand: boolean) => {
    setWindowExpanded(!!expand);
  });

  ipcMain.removeAllListeners('minibar:drag-start');
  ipcMain.on('minibar:drag-start', () => {
    if (!minibarWin || minibarWin.isDestroyed()) return;
    if (isExpanded) {
      isExpanded = false;
      const currentBounds = minibarWin.getBounds();
      const anchor = calculateCollapsedBounds(currentBounds, true, currentDockSide);
      const horizontal = isHorizontalDock(currentDockSide);
      minibarWin.setBounds({
        x: anchor.x,
        y: anchor.y,
        width: horizontal ? H_COLLAPSED_WIDTH : COLLAPSED_WIDTH,
        height: horizontal ? H_COLLAPSED_HEIGHT : COLLAPSED_HEIGHT,
      });
      pushState();
    }
    // 手动拖拽：窗口跟随鼠标连续移动，松手由 drag-end 吸附
    startDragFollow();
  });

  ipcMain.removeAllListeners('minibar:drag-end');
  ipcMain.on('minibar:drag-end', () => {
    stopDragFollowAndSettle();
  });

  ipcMain.removeAllListeners('minibar:toggle-expanded');
  ipcMain.on('minibar:toggle-expanded', () => {
    setWindowExpanded(!isExpanded);
  });

  ipcMain.removeAllListeners('minibar:menu-open');
  ipcMain.on('minibar:menu-open', () => {
    if (!minibarWin || minibarWin.isDestroyed()) return;
    // 仅在显式右键打开菜单时给予窗口前台焦点，确保点击外部产生原生 blur 自动关闭菜单
    minibarWin.focus();

    if (currentDisplayMode === 'edge-tab') {
      const isHorizontal = isHorizontalDock(currentDockSide);
      const menu = Menu.buildFromTemplate([
        {
          label: isHorizontal ? '恢复完整胶囊条' : '恢复完整侧栏',
          click: () => {
            setDisplayMode('full');
          },
        },
        {
          label: '重置悬浮窗位置',
          click: () => {
            resetMiniBarDock();
          },
        },
        { type: 'separator' },
        {
          label: '完全隐藏悬浮窗',
          click: () => {
            minibarWin?.hide();
            saveVisibility(false);
            notifyVisibility();
          },
        },
      ]);
      menu.popup({ window: minibarWin });
    }
  });

  ipcMain.removeAllListeners('minibar:close');
  ipcMain.on('minibar:close', () => {
    minibarWin?.hide();
    saveVisibility(false);
    notifyVisibility();
  });

  ipcMain.removeHandler('minibar:toggle');
  ipcMain.handle('minibar:toggle', () => {
    toggleMiniBar();
    return isMiniBarVisible();
  });

  ipcMain.removeHandler('minibar:is-visible');
  ipcMain.handle('minibar:is-visible', () => {
    return isMiniBarVisible();
  });

  ipcMain.removeHandler('minibar:set-visible');
  ipcMain.handle('minibar:set-visible', (_, show: boolean) => {
    if (!minibarWin || minibarWin.isDestroyed()) return false;
    if (show) {
      ensureOnScreen();
      minibarWin.show();
      pushState();
    } else {
      minibarWin.hide();
    }
    saveVisibility(show);
    notifyVisibility();
    return isMiniBarVisible();
  });

  ipcMain.removeHandler('minibar:reset-dock');
  ipcMain.handle('minibar:reset-dock', () => {
    resetMiniBarDock();
    return true;
  });

  ipcMain.removeHandler('minibar:get-dock-preference');
  ipcMain.handle('minibar:get-dock-preference', () => {
    return loadDockPreference();
  });

  ipcMain.removeHandler('minibar:set-dock-preference');
  ipcMain.handle('minibar:set-dock-preference', (_, pref: unknown) => {
    const valid = resolveMiniBarDockPreference(pref);
    saveDockPreference(valid);
    return valid;
  });

  return minibarWin;
}

export function disposeMiniBar(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (dragFollowTimer) {
    clearInterval(dragFollowTimer);
    dragFollowTimer = null;
  }
  if (minibarWin && !minibarWin.isDestroyed()) {
    minibarWin.destroy();
    minibarWin = null;
  }
}
