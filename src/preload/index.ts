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
  setMinibarExpanded: (expanded: boolean) => ipcRenderer.send('minibar:set-expanded', expanded),
  setMinibarDisplayMode: (mode: 'full' | 'edge-tab') => ipcRenderer.send('minibar:set-display-mode', mode),
  notifyDragStart: () => ipcRenderer.send('minibar:drag-start'),
  notifyDragEnd: () => ipcRenderer.send('minibar:drag-end'),
  notifyMenuOpen: () => ipcRenderer.send('minibar:menu-open'),
  onWindowBlur: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on('minibar:window-blur', subscription);
    return () => ipcRenderer.removeListener('minibar:window-blur', subscription);
  },
  closeMinibar: () => ipcRenderer.send('minibar:close'),
  resetMiniBarDock: () => ipcRenderer.invoke('minibar:reset-dock'),
});

// Pulse 2.0 新界面 API（阶段 4）。Pulse Core 状态由主进程消毒后推送，authkey 永不出主进程。
contextBridge.exposeInMainWorld('pulse', {
  getAppVersion: () => ipcRenderer.invoke('pulse:get-app-version'),
  checkUpdate: () => ipcRenderer.invoke('pulse:check-update'),
  openRelease: (url: string) => ipcRenderer.invoke('pulse:open-release', url),
  getCoreState: () => ipcRenderer.invoke('pulse:core:get-state'),
  onCoreState: (callback: (state: unknown) => void) => {
    const subscription = (_: any, state: unknown) => callback(state);
    ipcRenderer.on('pulse:core:state', subscription);
    return () => ipcRenderer.removeListener('pulse:core:state', subscription);
  },
  connectBand: () => ipcRenderer.invoke('pulse:band:connect'),
  disconnectBand: () => ipcRenderer.invoke('pulse:band:disconnect'),
  getDiagnostics: () => ipcRenderer.invoke('pulse:get-diagnostics'),
  runDiagnostics: () => ipcRenderer.invoke('pulse:run-diagnostics'),
  getErrorLog: () => ipcRenderer.invoke('pulse:get-error-log'),
  clearErrorLog: () => ipcRenderer.invoke('pulse:clear-error-log'),
  formatErrorLog: () => ipcRenderer.invoke('pulse:format-error-log'),
  formatDiagnosticReport: (report: unknown) => ipcRenderer.invoke('pulse:format-diagnostic-report', report),
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
  // MiniBar 启动停靠偏好（主进程 minibar-preference 持久化，非法值主进程归一为 remember）
  getMiniBarDockPreference: () => ipcRenderer.invoke('minibar:get-dock-preference'),
  setMiniBarDockPreference: (pref: 'remember' | 'left' | 'right') =>
    ipcRenderer.invoke('minibar:set-dock-preference', pref),
  // 拖入 Mi Fitness / 小米健康研究的日志，解析出 authkey
  extractBandKey: (filePath: string) => ipcRenderer.invoke('band:extract-key', { path: filePath }),
  // 设备配置与已配对手环管理
  getDeviceConfigStatus: () => ipcRenderer.invoke('pulse:device-config:status'),
  getPairedBandDevices: () => ipcRenderer.invoke('pulse:device-config:paired-devices'),
  scanBandDevices: () => ipcRenderer.invoke('pulse:device-config:scan-devices'),
  saveDeviceConfig: (payload: any) => ipcRenderer.invoke('pulse:device-config:save', payload),
  // Claude Code hook 一键安装（写 ~/.claude/settings.json）
  getHookStatus: () => ipcRenderer.invoke('hook:status'),
  installHook: () => ipcRenderer.invoke('hook:install'),
  uninstallHook: () => ipcRenderer.invoke('hook:uninstall'),
  // Electron ≥32 移除了 File.path，拖拽文件的本地绝对路径只能在 preload 用 webUtils 取
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  // device.app.install 真实 IPC 桥接（阶段契约闭环）
  appInstall: {
    prepare: (req: any) => ipcRenderer.invoke('pulse:app-install:prepare', req),
    prepareFile: (filePath: string) =>
      ipcRenderer.invoke('pulse:app-install:prepare-file', { filePath }),
    sendChunk: (req: any) => ipcRenderer.invoke('pulse:app-install:chunk', req),
    sendChunks: (installId?: string) =>
      ipcRenderer.invoke('pulse:app-install:send-chunks', { installId }),
    commit: (req: any) => ipcRenderer.invoke('pulse:app-install:commit', req),
    cancel: (req: any) => ipcRenderer.invoke('pulse:app-install:cancel', req),
    cancelTransfer: (installId: string) =>
      ipcRenderer.invoke('pulse:app-install:cancel-transfer', { installId }),
    // 内置手环端快应用：一键安装（无需用户选择文件）
    getBundledInfo: () => ipcRenderer.invoke('pulse:app-install:bundled-info'),
    installBundled: () => ipcRenderer.invoke('pulse:app-install:install-bundled'),
    onProgress: (callback: (event: any) => void) => {
      const subscription = (_: any, ev: any) => callback(ev);
      ipcRenderer.on('pulse:app-install-progress', subscription);
      return () => ipcRenderer.removeListener('pulse:app-install-progress', subscription);
    },
  },
  // 表盘管理（device.watchface.*，已真机验证的本地表盘列表 / 切换 / 安装）
  watchface: {
    list: () => ipcRenderer.invoke('pulse:watchface:list'),
    set: (id: string) => ipcRenderer.invoke('pulse:watchface:set', { id }),
    install: (filePath: string) => ipcRenderer.invoke('pulse:watchface:install', { filePath }),
    // 本地预览图缓存（用户自己关联的图片，只存在本机 userData）
    preview: {
      list: () => ipcRenderer.invoke('pulse:watchface:preview:list'),
      set: (id: string, filePath: string) =>
        ipcRenderer.invoke('pulse:watchface:preview:set', { id, filePath }),
      clear: (id: string) => ipcRenderer.invoke('pulse:watchface:preview:clear', { id }),
    },
  },
});
