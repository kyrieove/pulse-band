/// <reference types="vite/client" />

declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

import type {
  AgentSession,
  MinibarState,
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

/** 快应用原生安装 RPC 桥接接口（阶段契约：仅定义类型边界） */
export interface AppInstallBridge {
  prepare: (req: InstallPrepareRequest) => Promise<InstallPrepareResult>;
  sendChunk: (req: InstallChunkRequest) => Promise<InstallChunkResult>;
  commit: (req: InstallCommitRequest) => Promise<{ ok: boolean; status?: InstallSessionStatus; error?: string }>;
  cancel: (req: InstallCancelRequest) => Promise<{ ok: boolean; status?: InstallSessionStatus }>;
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
  closeMinibar: () => void;
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
  /** 快应用原生安装协议契约（阶段契约：仅暴露类型边界，未绑定真实 IPC） */
  appInstall?: AppInstallBridge;
}

declare global {
  interface Window {
    codeisland?: CodeislandBridge;
    pulse?: PulseBridge;
  }
}
