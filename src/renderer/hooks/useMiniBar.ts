import { useCallback, useEffect, useState } from 'react';

export interface UseMiniBarResult {
  /** 悬浮窗当前是否可见（唯一来源：main 进程的真实窗口状态） */
  visible: boolean;
  busy: boolean;
  error: string | null;
  setVisible: (show: boolean) => Promise<void>;
  toggle: () => Promise<void>;
}

/**
 * 额度悬浮窗（MiniBar）显隐状态的唯一前端入口。
 *
 * 复用 main 进程已有的 `minibar:is-visible` / `minibar:set-visible` /
 * `minibar:visibility-changed`，不新建窗口状态、不在渲染层缓存真值：
 * 托盘、侧栏、设置页看到与控制的都是同一个真实窗口。
 */
export function useMiniBar(): UseMiniBarResult {
  const [visible, setVisibleState] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.pulse) return;
    let alive = true;
    window.pulse.isMiniBarVisible?.().then((v) => {
      if (alive) setVisibleState(!!v);
    });
    const unsubscribe = window.pulse.onMiniBarVisibilityChange?.((v) => {
      if (alive) setVisibleState(!!v);
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  const setVisible = useCallback(async (show: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.pulse?.setMiniBarVisible?.(show);
      if (res === undefined) {
        setError('悬浮窗接口不可用');
        return;
      }
      // 只有 main 进程确认后的真实状态才更新显示
      setVisibleState(!!res);
      if (res !== show) {
        setError(show ? '悬浮窗创建或显示失败，请重启 Pulse 后重试' : '悬浮窗隐藏失败');
      }
    } catch {
      setError('悬浮窗操作失败，请重启 Pulse 后重试');
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = useCallback(async () => {
    await setVisible(!visible);
  }, [setVisible, visible]);

  return { visible, busy, error, setVisible, toggle };
}
