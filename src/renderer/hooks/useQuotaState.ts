import { useCallback, useEffect, useRef, useState } from 'react';
import type { MinibarState } from '../../common/types';

/**
 * 额度/会话数据源统一 hook。
 *
 * 背景：主进程 pushState() 只 `minibarWin.webContents.send('minibar-state')`，只推给悬浮窗；
 * 主窗口里 `onMinibarState` 能订阅到但回调永不触发。因此这里保留订阅（悬浮窗窗口内有效，同一 hook 两处复用）
 * 之外，额外用轮询兜底主窗口的取数。
 */
const POLL_INTERVAL_MS = 15_000;

export interface UseQuotaStateResult {
  state: MinibarState | null;
  /** 真正拿到数据的时刻；从未成功取到过则为 null（绝不退化为挂载时刻） */
  updatedAt: Date | null;
  /** 别名，代表前端拿到最新快照的时刻 */
  lastUpdatedAt: Date | null;
  /** 最近一次拉取或连接错误，拉取成功时清空为 null */
  lastError: Error | string | null;
  /** 是否处于初始加载中（首次 pull 结束前为 true，无论成败） */
  loading: boolean;
  /** 是否处于手动刷新进行中（只在 refresh() 调用期间为 true） */
  refreshing: boolean;
  /** 手动触发一次取数（“立即刷新”按钮用） */
  refresh: () => Promise<void>;
}

export function useQuotaState(): UseQuotaStateResult {
  const [state, setState] = useState<MinibarState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [lastError, setLastError] = useState<Error | string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const ciRef = useRef<typeof window.codeisland>(window.codeisland);

  const pull = useCallback(async () => {
    // 页面不可见时跳过，避免后台空转，但仍需落地 loading 状态避免悬挂
    if (document.visibilityState === 'hidden') {
      setLoading(false);
      return;
    }
    const ci = ciRef.current;
    if (!ci) {
      setLoading(false);
      return;
    }
    try {
      const s = await ci.getMinibarState?.();
      if (s) {
        setState(s);
        setUpdatedAt(new Date());
        setLastError(null);
      } else {
        setLastError('未获取到额度快照');
      }
    } catch (err: any) {
      // 拉取异常时保留上一份数据，不伪造，但向页面暴露失败状态
      setLastError(err?.message ?? String(err) ?? '网络请求异常');
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await pull();
    } finally {
      setRefreshing(false);
    }
  }, [pull]);

  useEffect(() => {
    const ci = ciRef.current;
    if (!ci) {
      setLoading(false);
      return;
    }
    let alive = true;

    void pull();

    // 悬浮窗窗口内该通道有效；主窗口轮询兜底，二者不冲突
    const unsub = ci.onMinibarState?.((s) => {
      if (!alive || !s) return;
      setState(s);
      setUpdatedAt(new Date());
      setLastError(null);
    });

    const timer = setInterval(pull, POLL_INTERVAL_MS);

    // 页面从隐藏回到可见时立即补拉一次，避免切回窗口要等满一个轮询周期
    const onVis = () => {
      if (document.visibilityState === 'visible') void pull();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      alive = false;
      unsub?.();
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(timer);
    };
  }, [pull]);

  return { state, updatedAt, lastUpdatedAt: updatedAt, lastError, loading, refreshing, refresh };
}
