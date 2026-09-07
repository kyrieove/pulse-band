import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentSession } from '../common/types';

// 旧悬浮岛残留 API（仅剩会话推送通道；hook/notifier 功能已删除）
contextBridge.exposeInMainWorld('codeisland', {
  onSessionsUpdate: (callback: (sessions: AgentSession[]) => void) => {
    const subscription = (_: any, sessions: AgentSession[]) => callback(sessions);
    ipcRenderer.on('sessions-update', subscription);
    return () => ipcRenderer.removeListener('sessions-update', subscription);
  },
  getInitialSessions: () => ipcRenderer.invoke('get-initial-sessions'),
  clearSessions: () => {
    ipcRenderer.send('clear-sessions');
  },
  closeWindow: () => ipcRenderer.send('window-close'),
  // 迷你悬浮窗（PC 实时监控条）
  onMinibarState: (callback: (state: unknown) => void) => {
    const subscription = (_: any, state: unknown) => callback(state);
    ipcRenderer.on('minibar-state', subscription);
    return () => ipcRenderer.removeListener('minibar-state', subscription);
  },
  getMinibarState: () => ipcRenderer.invoke('minibar:get-state'),
  toggleMinibarExpanded: () => ipcRenderer.send('minibar:toggle-expanded'),
  closeMinibar: () => ipcRenderer.send('minibar:close'),
});

// Pulse 2.0 新界面 API（阶段 4）。OronBox 状态由主进程消毒后推送，authkey 永不出主进程。
contextBridge.exposeInMainWorld('pulse', {
  getOronboxState: () => ipcRenderer.invoke('oronbox:get-state'),
  onOronboxState: (callback: (state: unknown) => void) => {
    const subscription = (_: any, state: unknown) => callback(state);
    ipcRenderer.on('oronbox-state', subscription);
    return () => ipcRenderer.removeListener('oronbox-state', subscription);
  },
  connectBand: () => ipcRenderer.invoke('oronbox:connect'),
  disconnectBand: () => ipcRenderer.invoke('oronbox:disconnect'),
  scanDevices: () => ipcRenderer.invoke('oronbox:scan'),
  setAutoReconnect: (value: boolean) => ipcRenderer.invoke('oronbox:set-auto-reconnect', value),
  toggleBridge: (running: boolean) => ipcRenderer.invoke('oronbox:bridge-toggle', running),
  setBridgeMode: (mode: 'plugin' | 'direct') => ipcRenderer.invoke('oronbox:set-bridge-mode', mode),
  importDevice: (payload: {
    name: string;
    addr: string;
    connectType: string;
    authkey: string;
    codename?: string;
  }) => ipcRenderer.invoke('oronbox:import-device', payload),
  installRpk: (filePath: string, fileName: string) =>
    ipcRenderer.invoke('oronbox:install-rpk', { path: filePath, fileName }),
  onInstallProgress: (callback: (p: { fileName: string; progress: number; done: boolean }) => void) => {
    const subscription = (_: any, p: { fileName: string; progress: number; done: boolean }) => callback(p);
    ipcRenderer.on('oronbox-install-progress', subscription);
    return () => ipcRenderer.removeListener('oronbox-install-progress', subscription);
  },
  getDiagnostics: () => ipcRenderer.invoke('pulse:get-diagnostics'),
  getErrorLog: () => ipcRenderer.invoke('pulse:get-error-log'),
  clearErrorLog: () => ipcRenderer.invoke('pulse:clear-error-log'),
  onErrorLog: (callback: (entries: unknown[]) => void) => {
    const subscription = (_: any, entries: unknown[]) => callback(entries);
    ipcRenderer.on('pulse-error-log', subscription);
    return () => ipcRenderer.removeListener('pulse-error-log', subscription);
  },
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  // 桌面迷你悬浮窗（MiniBar）开关与状态
  toggleMiniBar: () => ipcRenderer.invoke('minibar:toggle'),
  isMiniBarVisible: () => ipcRenderer.invoke('minibar:is-visible'),
  setMiniBarVisible: (show: boolean) => ipcRenderer.invoke('minibar:set-visible', show),
  onMiniBarVisibilityChange: (callback: (visible: boolean) => void) => {
    const subscription = (_: any, visible: boolean) => callback(visible);
    ipcRenderer.on('minibar:visibility-changed', subscription);
    return () => ipcRenderer.removeListener('minibar:visibility-changed', subscription);
  },
  installBundledRpk: () => ipcRenderer.invoke('oronbox:install-bundled-rpk'),
  // 拖入 Mi Fitness / 小米健康研究的日志，解析出 authkey（只显示，不代替 OronBox 配对）
  extractBandKey: (filePath: string) => ipcRenderer.invoke('band:extract-key', { path: filePath }),
  // Claude Code hook 一键安装（写 ~/.claude/settings.json）
  getHookStatus: () => ipcRenderer.invoke('hook:status'),
  installHook: () => ipcRenderer.invoke('hook:install'),
  uninstallHook: () => ipcRenderer.invoke('hook:uninstall'),
  // Electron ≥32 移除了 File.path，拖拽文件的本地绝对路径只能在 preload 用 webUtils 取
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
});
