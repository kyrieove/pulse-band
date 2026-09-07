/// <reference types="vite/client" />

declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

import type { AgentSession, MinibarState } from '../common/types';
import type { PulseOronboxState, PulseErrorEntry } from '../main/services/oronbox-bridge';

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
  extractBandKey: (filePath: string) => Promise<BandKeyResult>;
  getHookStatus: () => Promise<HookStatus>;
  installHook: () => Promise<HookResult>;
  uninstallHook: () => Promise<HookResult>;
  getOronboxState: () => Promise<PulseOronboxState>;
  onOronboxState: (cb: (state: PulseOronboxState) => void) => () => void;
  connectBand: () => Promise<{ ok: boolean; device?: unknown; error?: string }>;
  disconnectBand: () => Promise<{ ok: boolean; error?: string }>;
  scanDevices: () => Promise<{
    ok: boolean;
    error?: string;
    devices: Array<{ name: string; address: string; connectType: string }>;
  }>;
  setAutoReconnect: (value: boolean) => Promise<{ ok: boolean; value?: boolean; error?: string }>;
  toggleBridge: (running: boolean) => Promise<{ ok: boolean; running?: boolean; error?: string }>;
  setBridgeMode: (mode: 'plugin' | 'direct') => Promise<{ ok: boolean; error?: string }>;
  importDevice: (payload: {
    name: string;
    addr: string;
    connectType: string;
    authkey: string;
    codename?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  installBundledRpk: () => Promise<{ ok: boolean; error?: string; result?: unknown }>;
  installRpk: (
    filePath: string,
    fileName: string,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  onInstallProgress: (cb: (p: { fileName: string; progress: number; done: boolean }) => void) => () => void;
  getDiagnostics: () => Promise<{ ok: boolean; error?: string; data?: any }>;
  getErrorLog: () => Promise<PulseErrorEntry[]>;
  clearErrorLog: () => Promise<{ ok: boolean }>;
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
}

declare global {
  interface Window {
    codeisland?: CodeislandBridge;
    pulse?: PulseBridge;
  }
}
