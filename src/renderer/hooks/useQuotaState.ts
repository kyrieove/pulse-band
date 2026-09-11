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
  /** 手动触发一次取数（“立即刷新”按钮用） */
  refresh: () => Promise<void>;
}

export function useQuotaState(): UseQuotaStateResult {
  const [state, setState] = useState<MinibarState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const ciRef = useRef<typeof window.codeisland>(window.codeisland);

  const pull = useCallback(async () => {
    // 页面不可见时跳过，避免后台空转
    if (document.visibilityState === 'hidden') return;
    const ci = ciRef.current;
    if (!ci) return;
    try {
      const s = await ci.getMinibarState?.();
      if (s) {
        setState(s);
        setUpdatedAt(new Date());
      }
    } catch {
      // 拉取异常时保留上一份数据，不报错、不伪造
    }
  }, []);

  useEffect(() => {
    const ci = ciRef.current;
    if (!ci) return;
    let alive = true;

    void pull();

    // 悬浮窗窗口内该通道有效；主窗口轮询兜底，二者不冲突
    const unsub = ci.onMinibarState?.((s) => {
      if (!alive || !s) return;
      setState(s);
      setUpdatedAt(new Date());
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

  return { state, updatedAt, refresh: pull };
}
