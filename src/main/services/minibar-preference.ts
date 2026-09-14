export type MiniBarDockPreference = 'remember' | 'left' | 'right';

export function resolveMiniBarVisibility(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

export function resolveMiniBarDockPreference(value: unknown): MiniBarDockPreference {
  if (value === 'left' || value === 'right' || value === 'remember') {
    return value;
  }
  return 'remember';
}

/**
 * 根据启动停靠偏好与上次保存的停靠边，计算本次启动应当使用的侧边停靠位置。
 * 保证返回值只能是 'left' 或 'right'。
 *
 * - remember（默认）：沿用上次停靠位置，但只在左/右之间沿用；上次若是 top/bottom 或未记录，启动时归到 right
 * - left：每次启动固定左侧
 * - right：每次启动固定右侧
 */
export function resolveInitialDockSide(
  preference: MiniBarDockPreference,
  savedDockSide?: string | null,
): 'left' | 'right' {
  if (preference === 'left') return 'left';
  if (preference === 'right') return 'right';
  // preference === 'remember'
  if (savedDockSide === 'left') return 'left';
  return 'right';
}

