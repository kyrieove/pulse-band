import { useCallback, useEffect, useState } from 'react';
import type { PulseOronboxState } from '../../main/services/oronbox-bridge';
import { canConnectBand, type BandConnectionState } from '../../main/services/oronbox-policy';

export interface UseBandConnectionResult {
  /** 归一化后的连接状态（含"刚点了连接"的本地过渡态） */
  state: BandConnectionState;
  error?: string;
  device: PulseOronboxState['device'];
  busy: boolean;
  canConnect: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

/**
 * 手环连接 / 断开的唯一前端入口。
 *
 * 复用 preload 已有的 `connectBand` / `disconnectBand` 与 `oronbox:get-state` 订阅，
 * 不新增 IPC 通道，也不维护第二套连接状态：
 * 真实状态只有一个来源，即 main 进程从 pulse-core 收到的 device.state 快照。
 *
 * 注意：可连接判定复用 `canConnectBand`（oronbox-policy），与 main 侧同一套规则。
 */
export function useBandConnection(): UseBandConnectionResult {
  const [snapshot, setSnapshot] = useState<PulseOronboxState | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);

  useEffect(() => {
    if (!window.pulse) return;
    let alive = true;
    window.pulse.getOronboxState().then((s) => {
      if (alive) setSnapshot(s);
    });
    const unsubscribe = window.pulse.onOronboxState((s) => setSnapshot(s));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const rawState: BandConnectionState = snapshot?.connection.state ?? 'disconnected';

  // 真实状态已经动起来（连上或明确失败）后，清掉本地过渡态
  useEffect(() => {
    if (pendingConnect && (rawState === 'connected' || rawState === 'error')) {
      setPendingConnect(false);
    }
  }, [pendingConnect, rawState]);

  const state: BandConnectionState =
    pendingConnect && rawState === 'disconnected' ? 'connecting' : rawState;

  const connect = useCallback(async () => {
    if (!window.pulse) return;
    setBusy(true);
    setPendingConnect(true);
    try {
      const res = await window.pulse.connectBand();
      // 失败时立刻退出过渡态，把真实错误交给状态订阅展示
      if (res && !res.ok) setPendingConnect(false);
    } catch {
      setPendingConnect(false);
    } finally {
      setBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!window.pulse) return;
    setBusy(true);
    try {
      await window.pulse.disconnectBand();
    } finally {
      setBusy(false);
      setPendingConnect(false);
    }
  }, []);

  return {
    state,
    error: snapshot?.connection.error,
    device: snapshot?.device ?? null,
    busy,
    canConnect: canConnectBand(state, busy),
    connect,
    disconnect,
  };
}
