import { Tray, Menu, nativeImage, app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { SessionManager } from './services/session-manager';

export function createTray(
  mainWindow: BrowserWindow,
  sessionManager: SessionManager,
  onResetPosition: () => void,
  onFullExit: () => void,
  onToggleMiniBar?: () => void,
  isMiniBarVisible?: () => boolean
): Tray {
  const iconPath = path.resolve(import.meta.dirname, '../../assets/icon.png');
  let icon = nativeImage.createEmpty();

  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }

  const tray = new Tray(icon);
  tray.setToolTip('Pulse');

  // 退出过程中窗口先于托盘销毁，这时托盘回调仍可能触发
  const alive = () => !mainWindow.isDestroyed();

  const updateMenu = () => {
    const isVisible = alive() && mainWindow.isVisible();
    const miniBarVisible = isMiniBarVisible ? isMiniBarVisible() : false;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: isVisible ? '隐藏主界面 (Hide Main Window)' : '显示主界面 (Show Main Window)',
        click: () => {
          if (!alive()) return;
          if (mainWindow.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow.show();
            mainWindow.focus();
          }
        },
      },
      ...(onToggleMiniBar ? [
        {
          label: miniBarVisible ? '隐藏迷你悬浮窗 (Hide MiniBar)' : '显示迷你悬浮窗 (Show MiniBar)',
          click: () => {
            onToggleMiniBar();
            updateMenu();
          },
        }
      ] : []),
      {
        label: '复位至当前屏幕顶端居中 (Reset Position)',
        click: onResetPosition,
      },
      { type: 'separator' },
      {
        label: '清空当前所有会话 (Clear Sessions)',
        click: () => sessionManager.clearAll(),
      },
      { type: 'separator' },
      {
        // 普通退出只退 Pulse：daemon 常驻，手环侧链路不受影响
        label: '退出 Pulse (Exit)',
        click: () => {
          app.quit();
        },
      },
      {
        // 彻底退出：先发 daemon.stop（会短暂断开手环连接，可恢复），再退 Pulse
        label: '彻底退出（含后台服务）',
        click: onFullExit,
      },
    ]);

    tray.setContextMenu(contextMenu);
  };

  updateMenu();

  tray.on('click', () => {
    if (!alive()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return tray;
}
