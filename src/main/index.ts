import { app, BrowserWindow, ipcMain, shell, Tray } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AgentKind, SessionDetectionMode } from '../common/types';
import { SessionManager } from './services/session-manager';
import { CodexSessionTailer } from './services/codex-tailer';
import { ClaudeDesktopTailer } from './services/claude-desktop-tailer';
import { AntigravitySessionPoller } from './services/antigravity-session';
import { ClaudeHookServer } from './services/claude-hook-server';
import { registerClaudeHookInstall, getHookStatus } from './services/claude-hook-install';
import { registerBandKeyExtract } from './services/band-key-extract';
import { StatusServer } from './services/status-server';
import { PulseCoreClient } from './services/pulse-core-client';
import { PulseCoreBridge } from './services/pulse-core-bridge';
import { createTray } from './tray';
import { createMiniBarWindow, disposeMiniBar, toggleMiniBar, isMiniBarVisible } from './minibar-window';
import { isVersionNewer } from './services/version-check';
import { AppInstallService, registerAppInstallIpc } from './services/app-install-service';
import { CoreAppInstallBridge } from './services/core-app-install-bridge';
import { WatchfaceService, registerWatchfaceIpc } from './services/watchface-service';
import { WatchfacePreviewStore, WATCHFACE_PREVIEW_DIR_NAME } from './services/watchface-preview-store';
import {
  WatchfacePreviewService,
  registerWatchfacePreviewIpc,
} from './services/watchface-preview-service';
import { deviceConfigService } from './services/device-config-service';

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

// 各 agent 会话检测方式的唯一判定点（随 MinibarState 下发给渲染层）：
// Claude=hook 是否安装（未装时 transcript 思考期不落盘，只能轮询且测不到 thinking）；
// Codex=fs.watch 主通路是否存活（失败时降级为 500ms 轮询）；
// Antigravity=固定 5 秒 RPC 轮询，非事件驱动。
const resolveSessionDetection = (): Record<AgentKind, SessionDetectionMode> => {
  let claude: SessionDetectionMode = 'polling';
  try {
    claude = getHookStatus().installed ? 'event' : 'polling';
  } catch {
    // 读不到 hook 状态时保守按轮询报，不谎报实时
  }
  return {
    claude,
    codex: codexTailer.isEventDriven ? 'event' : 'polling',
    antigravity: 'polling',
  };
};

const statusServer = new StatusServer(sessionManager, 8765);
statusServer.start();

// pulse-core 只在显式手环操作时按需启动；打开 Pulse 本身不碰蓝牙。
const coreClient = new PulseCoreClient();
const coreBridge = new PulseCoreBridge(coreClient);
const coreAppInstallBridge = new CoreAppInstallBridge(coreClient);
const appInstallService = new AppInstallService(coreAppInstallBridge);
// 用户自己关联的表盘预览图缓存：只落本机 userData，不进仓库、不上传、不碰协议
const watchfacePreviewService = new WatchfacePreviewService(
  new WatchfacePreviewStore(path.join(app.getPath('userData'), WATCHFACE_PREVIEW_DIR_NAME)),
);
const watchfaceService = new WatchfaceService(coreClient, watchfacePreviewService);
coreClient.on('daemon-spawned', (pid) => console.log('[PulseCore] daemon 已拉起 pid=' + pid));
coreClient.on('degraded', (info) =>
  console.warn('[PulseCore] protocolVersion 不匹配，进入降级（继续用旧链路）:', JSON.stringify(info))
);
coreClient.on('connected', () => console.log('[PulseCore] RPC 已连接'));
coreClient.on('disconnected', () => console.warn('[PulseCore] RPC 断开，等待重连'));

// 初始屏（截图/调试用）：PULSE_SCREEN=diagnostics 时直接打开次屏
const INITIAL_SCREEN =
  process.env.PULSE_SCREEN === 'diagnostics' ||
  process.env.PULSE_SCREEN === 'settings' ||
  process.env.PULSE_SCREEN === 'watchface'
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
    // 必须和 index.css 的 --bg-canvas 浅色值保持一致（#e9ece9），避免冷启动先刷一帧旧深色残留
    backgroundColor: '#e9ece9',
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

  coreBridge.attach(win);
  appInstallService.attach(win);

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
      // 彻底退出：视觉反馈要快——窗口和托盘图标立刻消失；
      // 礼让序列（断开手环归还给手机 → 停 daemon）放后台走完，
      // 总预算 5s，到点强制退出。手环断开最坏 3s（等真蓝牙断链），
      // daemon 是按设计常驻的，停不掉就留给下次启动复用，不拿它卡用户。
      isQuitting = true;
      win?.hide();
      const budget = setTimeout(() => {
        runAppCleanup();
        app.exit(0);
      }, 5_000);
      coreClient
        .stopDaemonIfRunning()
        .catch(() => {})
        .finally(() => {
          clearTimeout(budget);
          runAppCleanup();
          app.exit(0);
        });
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
  createMiniBarWindow(sessionManager, statusServer, resolveSessionDetection);
  registerClaudeHookInstall();
  registerBandKeyExtract(ipcMain);
  registerAppInstallIpc(appInstallService, ipcMain, () => win);
  registerWatchfaceIpc(watchfaceService, ipcMain);
  registerWatchfacePreviewIpc(watchfacePreviewService, ipcMain);
  watchfacePreviewService.startBackgroundPreparation([
    path.resolve(import.meta.dirname, '../../watch-face'),
  ]);

  // 设备配置与已配对手环管理 IPC
  ipcMain.handle('pulse:device-config:status', () => {
    return deviceConfigService.getDeviceConfigStatus();
  });
  ipcMain.handle('pulse:device-config:paired-devices', () => {
    return deviceConfigService.getPairedBandDevices();
  });
  ipcMain.handle('pulse:device-config:save', async (_e, payload) => {
    return deviceConfigService.saveDeviceConfig(payload);
  });

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

// 退出清理（幂等）：托盘「彻底退出」的预算强制路径走 app.exit（不触发
// before-quit），所以两边的收尾都汇到这里，谁先到谁执行。
let appCleanupDone = false;
function runAppCleanup(): void {
  if (appCleanupDone) return;
  appCleanupDone = true;
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
  coreBridge.detach();
  coreClient.dispose();
}

app.on('before-quit', () => {
  isQuitting = true;
  runAppCleanup();
});
