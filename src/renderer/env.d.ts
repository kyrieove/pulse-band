/// <reference types="vite/client" />

declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

import type {
  AgentSession,
  MinibarState,
  InstallSessionStatus,
  InstallPrepareRequest,
  InstallPrepareResult,
  InstallChunkRequest,
  InstallChunkResult,
  InstallCommitRequest,
  InstallCancelRequest,
  InstallProgressEvent,
} from '../common/types';
import type { PulseOronboxState, PulseErrorEntry } from '../main/services/oronbox-bridge';
import type { DiagnosticReport } from '../main/services/diagnostics';
import type {
  WatchfaceItem,
  WatchfaceListData,
  WatchfaceSetData,
  WatchfaceInstallData,
  WatchfaceResult,
} from '../main/services/watchface-service';

export type {
  WatchfaceItem,
  WatchfaceListData,
  WatchfaceSetData,
  WatchfaceInstallData,
  WatchfaceResult,
};

/** 表盘管理桥接（device.watchface.*：本地表盘列表 / 切换 / 本地文件安装） */
export interface WatchfaceBridge {
  list: () => Promise<WatchfaceResult<WatchfaceListData>>;
  set: (id: string) => Promise<WatchfaceResult<WatchfaceSetData>>;
  install: (filePath: string) => Promise<WatchfaceResult<WatchfaceInstallData>>;
}

/** 快应用原生安装 RPC 桥接接口（阶段契约：仅定义类型边界） */
export interface AppInstallBridge {
  prepare: (req: InstallPrepareRequest) => Promise<InstallPrepareResult>;
  prepareFile: (filePath: string) => Promise<InstallPrepareResult>;
  sendChunk: (req: InstallChunkRequest) => Promise<InstallChunkResult>;
  sendChunks: (installId?: string) => Promise<{
    sentChunks: number;
    totalBytes: number;
    status: InstallSessionStatus;
    /** pulse-core 依据真实设备结果给出的结论；completed 才代表设备已确认安装 */
    coreStatus: string | null;
  }>;
  commit: (req: InstallCommitRequest) => Promise<{ ok: boolean; status?: InstallSessionStatus; error?: string }>;
  cancel: (req: InstallCancelRequest) => Promise<{ ok: boolean; status?: InstallSessionStatus }>;
  cancelTransfer: (installId: string) => Promise<{ ok: boolean; status?: InstallSessionStatus }>;
  /** 内置手环端安装包信息（版本号来自真实 manifest，不写死） */
  getBundledInfo: () => Promise<{
    exists: boolean;
    packageId?: string;
    versionName?: string;
    versionCode?: number;
    fileSize?: number;
    manifestValid?: boolean;
  }>;
  /** 一键安装内置手环端快应用（prepare -> 全部分块 -> commit），无需用户选择文件 */
  installBundled: () => Promise<{
    installId: string;
    status: InstallSessionStatus;
    /** pulse-core 依据真实设备结果给出的结论；completed 才是设备已确认安装 */
    coreStatus: string | null;
    packageId?: string;
    versionName?: string;
    versionCode?: number;
    fileSize: number;
    totalChunks: number;
    sentChunks: number;
  }>;
  onProgress: (cb: (event: InstallProgressEvent) => void) => () => void;
}

/** 旧悬浮岛残留 API（仅剩仍有后端支撑的通道）与迷你悬浮窗 API */
export interface CodeislandBridge {
  onSessionsUpdate: (cb: (sessions: AgentSession[]) => void) => () => void;
  getInitialSessions: () => Promise<AgentSession[]>;
  clearSessions: () => void;
  closeWindow: () => void;
  onMinibarState: (cb: (state: MinibarState) => void) => () => void;
  getMinibarState: () => Promise<MinibarState>;
  toggleMinibarExpanded: () => void;
  setMinibarExpanded?: (expanded: boolean) => void;
  setMinibarDisplayMode?: (mode: 'full' | 'edge-tab') => void;
  notifyDragStart?: () => void;
  notifyDragEnd?: () => void;
  notifyMenuOpen?: () => void;
  onWindowBlur?: (cb: () => void) => () => void;
  closeMinibar: () => void;
  /** 重置悬浮窗停靠位置到主显示器右侧（minibar:reset-dock） */
  resetMiniBarDock: () => Promise<boolean>;
}

/** Pulse 2.0 主进程桥（阶段 4） */
export type BandKeyResult =
  | {
      ok: true;
      logFile: string;
      agree: boolean;
      deviceKey: string | null;
      deviceKeyRaw: string | null;
      encryptKey: string | null;
    }
  | { ok: false; error: string };

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  command: string | null;
}
export type HookResult = Partial<HookStatus> & { ok: boolean; error?: string };

export interface PulseBridge {
  getAppVersion: () => Promise<string>;
  isOronboxInstalled: () => Promise<boolean>;
  checkUpdate: () => Promise<{
    ok: boolean;
    currentVersion: string;
    latestVersion?: string;
    updateAvailable?: boolean;
    releaseUrl?: string;
    error?: string;
  }>;
  openRelease: (url: string) => Promise<{ ok: boolean; error?: string }>;
  extractBandKey: (filePath: string) => Promise<BandKeyResult>;
  getHookStatus: () => Promise<HookStatus>;
  installHook: () => Promise<HookResult>;
  uninstallHook: () => Promise<HookResult>;
  getOronboxState: () => Promise<PulseOronboxState>;
  onOronboxState: (cb: (state: PulseOronboxState) => void) => () => void;
  connectBand: () => Promise<{ ok: boolean; device?: unknown; error?: string }>;
  disconnectBand: () => Promise<{ ok: boolean; error?: string }>;
  toggleBridge: (running: boolean) => Promise<{ ok: boolean; running?: boolean; error?: string }>;
  setBridgeMode: (mode: 'plugin' | 'direct') => Promise<{ ok: boolean; error?: string }>;
  installBundledRpk: () => Promise<{ ok: boolean; error?: string; result?: unknown }>;
  installRpk: (
    filePath: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  onInstallProgress: (cb: (p: { fileName: string; progress: number; done: boolean }) => void) => () => void;
  getDiagnostics: () => Promise<{ ok: boolean; error?: string; data?: any }>;
  runDiagnostics: () => Promise<DiagnosticReport>;
  getErrorLog: () => Promise<PulseErrorEntry[]>;
  clearErrorLog: () => Promise<{ ok: boolean }>;
  formatErrorLog: () => Promise<string>;
  formatDiagnosticReport: (report: DiagnosticReport) => Promise<string>;
  syncBandTime: () => Promise<{ ok: boolean; error?: string }>;
  onErrorLog: (cb: (entries: PulseErrorEntry[]) => void) => () => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  toggleMiniBar: () => Promise<boolean>;
  isMiniBarVisible: () => Promise<boolean>;
  setMiniBarVisible: (show: boolean) => Promise<boolean>;
  onMiniBarVisibilityChange: (cb: (visible: boolean) => void) => () => void;
  /** Electron ≥32 拖拽文件取本地路径（webUtils 只在 preload 可用） */
  getPathForFile: (file: File) => string;
  /** 设备配置状态与手环绑定相关 API */
  getDeviceConfigStatus: () => Promise<{
    exists: boolean;
    valid: boolean;
    deviceName?: string;
    maskedAddr?: string;
    codename?: string;
    error?: string;
  }>;
  getPairedBandDevices: () => Promise<
    Array<{
      id: string;
      name: string;
      maskedMac: string;
      isXiaomiBand: boolean;
    }>
  >;
  saveDeviceConfig: (payload: {
    logPath?: string;
    selectedDeviceId?: string;
    useExisting?: boolean;
  }) => Promise<{
    ok: boolean;
    error?: string;
    deviceName?: string;
    maskedAddr?: string;
  }>;
  /** 快应用原生安装协议契约（阶段契约：仅暴露类型边界，未绑定真实 IPC） */
  appInstall?: AppInstallBridge;
  /** 表盘管理（device.watchface.*，主进程统一错误形状） */
  watchface?: WatchfaceBridge;
}

declare global {
  interface Window {
    codeisland?: CodeislandBridge;
    pulse?: PulseBridge;
  }
}
