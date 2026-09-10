import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionManager } from './services/session-manager';
import type { StatusServer } from './services/status-server';
import type { MinibarState } from '../common/types';
import { resolveMiniBarVisibility } from './services/minibar-preference';

let minibarWin: BrowserWindow | null = null;
let isExpanded = false;
let updateTimer: NodeJS.Timeout | null = null;
let sessionManagerRef: SessionManager | null = null;
let statusServerRef: StatusServer | null = null;

// 收起态需要同时容纳 3 个 Agent 的 5h / 7d 两个周期（含周期标签），
// 340px 会把第三枚徽标挤出窗口（实测溢出 133px），因此加宽到 480px。
// 展开态与收起态同宽，避免切换时窗口宽度跳变。
const COLLAPSED_WIDTH = 480;
const COLLAPSED_HEIGHT = 44;
const EXPANDED_WIDTH = 480;
const EXPANDED_HEIGHT = 240;

function getBoundsFile(): string {
  return path.join(app.getPath('userData'), 'minibar-bounds.json');
}

function getPreferenceFile(): string {
  return path.join(app.getPath('userData'), 'minibar-preferences.json');
}

function loadVisibility(): boolean {
  try {
    return resolveMiniBarVisibility(JSON.parse(fs.readFileSync(getPreferenceFile(), 'utf-8'))?.visible);
  } catch {
    return true;
  }
}

function saveVisibility(visible: boolean): void {
  try {
    fs.writeFileSync(getPreferenceFile(), JSON.stringify({ visible }), 'utf-8');
  } catch {
    /* 界面状态持久化失败不影响悬浮窗本身 */
  }
}

function loadSavedBounds(): { x?: number; y?: number } {
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
    fs.writeFileSync(getBoundsFile(), JSON.stringify({ x: b.x, y: b.y }));
  } catch {
    // ignore
  }
}

/**
 * 把窗口位置夹回可见工作区。
 *
 * 场景：用户改过显示器布局（拔掉外接屏、改分辨率/缩放）后，上次保存的坐标
 * 可能落在所有显示器之外，窗口就会"消失"。只要仍与任一显示器工作区相交就保持原位，
 * 否则移回主显示器右上角默认位。
 */
function clampToVisibleArea(x: number, y: number, w: number, h: number): { x: number; y: number } {
  try {
    const intersects = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height;
    });
    if (intersects) return { x, y };
    const primary = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(primary.x + primary.width - w - 24),
      y: Math.round(primary.y + 24),
    };
  } catch {
    return { x, y };
  }
}

/** 显示前确保窗口在当前可见区域内（运行期显示器变化也需要纠正）。 */
function ensureOnScreen(): void {
  if (!minibarWin || minibarWin.isDestroyed()) return;
  const b = minibarWin.getBounds();
  const fixed = clampToVisibleArea(b.x, b.y, b.width, b.height);
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
  let defaultX = saved.x;
  let defaultY = saved.y;

  if (defaultX === undefined || defaultY === undefined) {
    try {
      const primary = screen.getPrimaryDisplay();
      defaultX = Math.round(primary.workArea.x + primary.workArea.width - COLLAPSED_WIDTH - 24);
      defaultY = Math.round(primary.workArea.y + 24);
    } catch {
      defaultX = 100;
      defaultY = 100;
    }
  } else {
    // 上次保存的位置可能已经不在任何显示器内（换了显示器/分辨率），夹回可见区域
    const fixed = clampToVisibleArea(defaultX, defaultY, COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
    defaultX = fixed.x;
    defaultY = fixed.y;
  }

  minibarWin = new BrowserWindow({
    width: COLLAPSED_WIDTH,
    height: COLLAPSED_HEIGHT,
    x: defaultX,
    y: defaultY,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
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

  minibarWin.on('moved', saveBounds);

  minibarWin.on('close', (e) => {
    e.preventDefault();
    minibarWin?.hide();
    notifyVisibility();
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
    };
  });

  ipcMain.removeAllListeners('minibar:toggle-expanded');
  ipcMain.on('minibar:toggle-expanded', () => {
    if (!minibarWin || minibarWin.isDestroyed()) return;
    isExpanded = !isExpanded;
    minibarWin.setSize(
      isExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH,
      isExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT
    );
    pushState();
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

  return minibarWin;
}

export function disposeMiniBar(): void {
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (minibarWin && !minibarWin.isDestroyed()) {
    minibarWin.destroy();
    minibarWin = null;
  }
}
