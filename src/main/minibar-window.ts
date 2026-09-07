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

const COLLAPSED_WIDTH = 340;
const COLLAPSED_HEIGHT = 44;
const EXPANDED_WIDTH = 340;
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
