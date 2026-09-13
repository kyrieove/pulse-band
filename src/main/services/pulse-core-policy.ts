export type BandConnectionReason = 'startup' | 'poll' | 'diagnostics' | 'manual-connect';

export function shouldConnectBand(reason: BandConnectionReason): boolean {
  return reason === 'manual-connect';
}

export type BandConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

/** 连接按钮是否可点。已连接、连接中或正在忙时不可点；失败后必须留着重试入口。 */
export function canConnectBand(state: BandConnectionState, busy: boolean): boolean {
  return !busy && state !== 'connected' && state !== 'connecting';
}

/**
 * 解析 pulse-core.exe 的绝对路径：
 * 打包环境优先命中 resources/pulse-core.exe，不存在时回退开发路径。
 */
export function resolveCoreExePath(
  resourcesPath: string | undefined,
  existsFn: (p: string) => boolean,
  devFallback: string,
): string {
  if (resourcesPath && typeof resourcesPath === 'string') {
    const normalizedRes = resourcesPath.replace(/\\/g, '/');
    const packagedPath = normalizedRes.endsWith('/')
      ? `${normalizedRes}pulse-core.exe`
      : `${normalizedRes}/pulse-core.exe`;
    if (existsFn(packagedPath)) {
      return packagedPath;
    }
  }
  return devFallback;
}

export interface DaemonArgsOptions {
  mode?: 'live' | 'fake';
  deviceConfigExists?: boolean;
  envMode?: string;
}

/**
 * 决定 pulse-core 启动参数：
 * 1. 显式 options.mode
 * 2. 环境变量 PULSE_CORE_MODE
 * 3. 正式设备场景（device.json 存在）启动 --live，否则 --fake
 */
export function resolveDaemonArgs(options?: DaemonArgsOptions): string[] {
  if (options?.mode === 'live' || options?.mode === 'fake') {
    return [`--${options.mode}`];
  }
  if (options?.envMode === 'live' || options?.envMode === 'fake') {
    return [`--${options.envMode}`];
  }
  if (options?.deviceConfigExists === true) {
    return ['--live'];
  }
  return ['--fake'];
}

/**
 * 断线重试策略：按交接单与 §0.5 保护条款最多连续重试 3 次
 */
export function shouldRetryLiveConnect(attempt: number, maxAttempts = 3): boolean {
  return attempt < maxAttempts;
}

