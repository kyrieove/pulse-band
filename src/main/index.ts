import { app, BrowserWindow, ipcMain, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { SessionManager } from './services/session-manager';
import { CodexSessionTailer } from './services/codex-tailer';
import { ZCodeSessionTailer } from './services/zcode-tailer';
import { ClaudeDesktopTailer } from './services/claude-desktop-tailer';
import { AntigravitySessionPoller } from './services/antigravity-session';
import { ClaudeHookServer } from './services/claude-hook-server';
import { registerClaudeHookInstall } from './services/claude-hook-install';
import { registerBandKeyExtract } from './services/band-key-extract';
import { StatusServer } from './services/status-server';
import { OronBoxClient } from './services/oronbox-client';
import { OronBoxBridge } from './services/oronbox-bridge';
import { createTray } from './tray';
import { createMiniBarWindow, disposeMiniBar, toggleMiniBar, isMiniBarVisible } from './minibar-window';

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
const zcodeTailer = new ZCodeSessionTailer(sessionManager);
const claudeDesktopTailer = new ClaudeDesktopTailer(sessionManager);
const antigravityPoller = new AntigravitySessionPoller(sessionManager);
const claudeServer = new ClaudeHookServer(sessionManager, 41789);

const statusServer = new StatusServer(sessionManager, 8765);
statusServer.start();

// OronBox daemon：拉起无头 daemon 并保持 RPC 连接（断线自动重连）。
// protocolVersion 不匹配时只降级报警，不停 daemon（硬约束 6）。
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

const FETCH_BRIDGE_PLUGIN_ID = 'org.zxor.oronbox.miwear-interconnect-fetch';

// 阶段 3/7：不开 OronBox GUI 的最小链路。桥接模式按持久化模式落位：
// plugin → plugin.open FetchBridge；direct → 响应器接管（applyBootMode 验证式关插件，防双重应答）。
async function bootstrapOronboxBandLink(): Promise<void> {
  await oronboxBridge.applyBootMode();

  try {
    const cur = await oronbox.call<{ key: string; value: unknown }>('settings.get', {
      key: 'auto_reconnect',
    });
    if (cur?.value !== true) {
      await oronbox.call('settings.set', { key: 'auto_reconnect', value: true });
      console.log('[OronBox] auto_reconnect → true');
    }
  } catch (err) {
    console.error('[OronBox] 设置 auto_reconnect 失败:', err);
  }

  if (oronboxBridge.mode === 'plugin') {
    try {
      const plugins = await oronbox.call<Array<{ id: string; running: boolean }>>('plugin.list', {
        includeIcons: false,
      });
      const bridge = plugins?.find((p) => p.id === FETCH_BRIDGE_PLUGIN_ID);
      if (!bridge) {
        console.error('[OronBox] 未安装 FetchBridge 插件:', FETCH_BRIDGE_PLUGIN_ID);
      } else if (!bridge.running) {
        // 插件不会自启，必须显式 open
        await oronbox.call('plugin.open', { id: FETCH_BRIDGE_PLUGIN_ID }, 30_000);
        console.log('[OronBox] FetchBridge 插件已 open');
      } else {
        console.log('[OronBox] FetchBridge 插件已在运行');
      }
    } catch (err) {
      console.error('[OronBox] 打开 FetchBridge 插件失败:', err);
    }
  } else {
    console.log('[OronBox] 桥接为直连模式，插件保持关闭');
  }

  try {
    const status = await oronbox.call<{ connected: boolean }>('device.status');
    if (!status?.connected) {
      const device = await oronbox.call('device.connect', {}, 60_000);
      console.log('[OronBox] device.connect 完成:', JSON.stringify(device));
    } else {
      console.log('[OronBox] 手环已连接，跳过 connect');
    }
  } catch (err) {
    console.error('[OronBox] device.connect 失败:', err);
  }
}

// 初始屏（截图/调试用）：PULSE_SCREEN=diagnostics 时直接打开次屏
const INITIAL_SCREEN = process.env.PULSE_SCREEN === 'diagnostics' ? 'diagnostics' : 'main';

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
    // 供阶段 4/5 回执截图（等 React 首帧完成再抓）
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
      oronbox.stopDaemon().finally(() => app.quit());
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
  zcodeTailer.start();
  claudeDesktopTailer.start();
  antigravityPoller.start();
  await claudeServer.start().catch((err) => {
    console.error('Failed to start Claude hook server:', err);
  });
  // 确保 OronBox daemon 在跑并连上 RPC（失败不阻塞启动，后续自动重连）
  await oronbox.start().catch((err) => {
    console.error('Failed to start OronBox daemon client:', err);
  });
  // 阶段 3 最小链路：auto_reconnect + FetchBridge 插件 + 连手环（status-server 照旧 8765）
  await bootstrapOronboxBandLink();
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
  zcodeTailer.stop();
  claudeDesktopTailer.stop();
  antigravityPoller.stop();
  claudeServer.stop();
  sessionManager.dispose();
  oronboxBridge.detach();
  oronbox.dispose();
});
