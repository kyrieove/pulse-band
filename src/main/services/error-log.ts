/**
 * 主进程统一错误环形缓冲（阶段 5 诊断屏「最近异常日志」数据源）。
 * 各服务（额度抓取 / OronBox 客户端 / 装包）往里推，UI 订阅推送。
 * 只存内存，进程退出即清空；不上屏任何含 authkey 的内容（红线）。
 */

export interface PulseErrorEntry {
  ts: number;
  source: string;
  message: string;
  level: 'error' | 'warn' | 'info';
}

const MAX_ENTRIES = 50;
const ring: PulseErrorEntry[] = [];
const listeners = new Set<(entries: PulseErrorEntry[]) => void>();

export function pushError(
  source: string,
  message: string,
  level: PulseErrorEntry['level'] = 'error',
): void {
  const entry: PulseErrorEntry = { ts: Date.now(), source, message, level };
  ring.unshift(entry);
  if (ring.length > MAX_ENTRIES) ring.length = MAX_ENTRIES;
  for (const cb of listeners) {
    try {
      cb([...ring]);
    } catch {
      /* 监听方异常不影响采集 */
    }
  }
}

export function getRecentErrors(count = 20): PulseErrorEntry[] {
  return ring.slice(0, count);
}

export function clearErrors(): void {
  ring.length = 0;
  for (const cb of listeners) {
    try {
      cb([]);
    } catch {
      /* 同上 */
    }
  }
}

export function onErrorLog(cb: (entries: PulseErrorEntry[]) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
