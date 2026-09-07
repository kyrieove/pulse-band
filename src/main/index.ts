import { app, BrowserWindow, ipcMain, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { SessionManager } from './services/session-manager';
import { CodexSessionTailer } from './services/codex-tailer';
import { ClaudeDesktopTailer } from './services/claude-desktop-tailer';
import { AntigravitySessionPoller } from './services/antigravity-session';
import { ClaudeHookServer } from './services/claude-hook-server';
import { registerClaudeHookInstall } from './services/claude-hook-install';
import { registerBandKeyExtract } from './services/band-key-extract';
import { StatusServer } from './services/status-server';
import { OronBoxClient, ORONBOX_EXE } from './services/oronbox-client';
import { OronBoxBridge } from './services/oronbox-bridge';
import { createTray } from './tray';
import { createMiniBarWindow, disposeMiniBar, toggleMiniBar, isMiniBarVisible } from './minibar-window';
import { isVersionNewer } from './services/version-check';

// Ensure single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
// 托盘常驻：窗口在真正退出前不许被销毁，否则托盘回调会打在已销毁对象上
let isQuitting = false;

const sessionManager = new SessionManager();
const codexTailer = new CodexSessionTailer(sessionManager);
const claudeDesktopTailer = new ClaudeDesktopTailer(sessionManager);
const antigravityPoller = new AntigravitySessionPoller(sessionManager);
const claudeServer = new ClaudeHookServer(sessionManager, 41789);

const statusServer = new StatusServer(sessionManager, 8765);
statusServer.start();

// OronBox 客户端只在显式手环操作时按需启动 daemon；打开 Pulse 本身不碰蓝牙。
const oronbox = new OronBoxClient();
const oronboxBridge = new OronBoxBridge(
  oronbox,
  path.join(app.getPath('userData'), 'pulse-bridge-mode.json'),
);
oronbox.on('daemon-spawned', (pid) => console.log('[OronBox] daemon 已拉起 pid=' + pid));
oronbox.on('degraded', (info) =>
  console.warn('[OronBox] protocolVersion 不匹配，进入降级（继续用旧链路）:', JSON.stringify(info))
);
oronbox.on('connected', () => console.log('[OronBox] RPC 已连接'));
oronbox.on('disconnected', () => console.warn('[OronBox] RPC 断开，等待重连'));

// 初始屏（截图/调试用）：PULSE_SCREEN=diagnostics 时直接打开次屏
const INITIAL_SCREEN =
  process.env.PULSE_SCREEN === 'diagnostics' || process.env.PULSE_SCREEN === 'settings'
    ? process.env.PULSE_SCREEN
    : 'main';

function createWindow() {
  const cjsPreload = path.join(import.meta.dirname, '../preload/index.cjs');
  const jsPreload = path.join(import.meta.dirname, '../preload/index.js');
  const mjsPreload = path.join(import.meta.dirname, '../preload/index.mjs');
  const preloadPath = fs.existsSync(cjsPreload)
    ? cjsPreload
    : fs.existsSync(jsPreload)
    ? jsPreload
    : mjsPreload;

  // 阶段 4：从「透明悬浮胶囊」改为 900×620 标准窗口（自绘标题栏，深色不透明）
  win = new BrowserWindow({
    width: 900,
    height: 620,
    minWidth: 720,
    minHeight: 520,
    center: true,
    frame: false,
    backgroundColor: '#0d0f14',
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 关闭 = 隐藏到托盘。Alt+F4 和任何原生关闭都走这里，只有真正退出才放行。
  // 不拦的话窗口会被销毁而进程仍在（window-all-closed 是空的），
  // 之后点托盘就是 "Object has been destroyed"。
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win?.hide();
    }
  });

  win.once('ready-to-show', () => {
    if (!win) return;
    win.show();
    win.focus();
    console.log('[CodeIsland] Window ready-to-show fired, visible at', win.getBounds());
    if (process.env.PULSE_SCREEN) {
      // 供界面调试截图（等 React 首帧完成再抓）；正式版不写 app.asar。
      setTimeout(async () => {
        try {
          if (!win) return;
          const image = await win.capturePage();
          const savePath = path.resolve(import.meta.dirname, `../../debug-window-${INITIAL_SCREEN}.png`);
          fs.writeFileSync(savePath, image.toPNG());
          console.log('[CodeIsland] Saved window screenshot to', savePath, 'size:', image.getSize());
        } catch (err) {
          console.error('[CodeIsland] Screenshot capture error:', err);
        }
      }, 1200);
    }
  });

  win.webContents.on('did-fail-load', (_, errorCode, errorDescription) => {
    console.error(`[Renderer] Load failed: ${errorCode} - ${errorDescription}`);
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?screen=${INITIAL_SCREEN}`);
  } else {
    win.loadFile(path.join(import.meta.dirname, '../../dist/index.html'), {
      query: { screen: INITIAL_SCREEN },
    });
  }

  // Relay session updates to renderer
  sessionManager.on('update', (sessions) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sessions-update', sessions);
    }
  });

  oronboxBridge.attach(win);

  tray = createTray(
    win,
    sessionManager,
    () => {
      if (win) {
        win.center();
        win.show();
        win.focus();
      }
    },
    () => {
      // 彻底退出：先断开手环（让它回去找手机）、再让 daemon 自行退出，最后退 Pulse
      oronbox.stopDaemonIfRunning().finally(() => app.quit());
    },
    toggleMiniBar,
    isMiniBarVisible
  );
}

// IPC Handlers
ipcMain.on('clear-sessions', () => {
  sessionManager.clearAll();
});

ipcMain.handle('get-initial-sessions', () => {
  return sessionManager.getAllSessions();
});

ipcMain.handle('pulse:get-app-version', () => app.getVersion());
ipcMain.handle('pulse:is-oronbox-installed', () => fs.existsSync(ORONBOX_EXE));
ipcMain.handle('pulse:check-update', async () => {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch('https://api.github.com/repos/kyrieove/pulse-band/releases/latest', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const latestVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
    const releaseUrl = typeof release.html_url === 'string' ? release.html_url : '';
    const updateAvailable = isVersionNewer(latestVersion, currentVersion);
    return { ok: true, currentVersion, latestVersion, updateAvailable, releaseUrl };
  } catch (err: any) {
    return { ok: false, currentVersion, error: String(err?.message ?? err) };
  }
});
ipcMain.handle('pulse:open-release', async (_e, url: unknown) => {
  if (typeof url !== 'string' || !url.startsWith('https://github.com/kyrieove/pulse-band/releases/')) {
    return { ok: false, error: '不允许打开该地址' };
  }
  await shell.openExternal(url);
  return { ok: true };
});

// 自绘标题栏的窗口控制（window-close = 隐藏到托盘，阶段 2 约定）
ipcMain.on('window-close', () => {
  if (win) win.hide();
});

ipcMain.on('window-minimize', () => {
  win?.minimize();
});

ipcMain.on('window-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

app.whenReady().then(async () => {
  createWindow();
  createMiniBarWindow(sessionManager, statusServer);
  registerClaudeHookInstall();
  registerBandKeyExtract();

  // Start background monitoring services
  codexTailer.start();
  claudeDesktopTailer.start();
  antigravityPoller.start();
  await claudeServer.start().catch((err) => {
    console.error('Failed to start Claude hook server:', err);
  });
});

app.on('window-all-closed', () => {
  // Keep app running in tray
});

app.on('before-quit', () => {
  isQuitting = true;
  disposeMiniBar();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  codexTailer.stop();
  claudeDesktopTailer.stop();
  antigravityPoller.stop();
  claudeServer.stop();
  sessionManager.dispose();
  oronboxBridge.detach();
  oronbox.dispose();
});
