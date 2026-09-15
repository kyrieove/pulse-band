import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Watch,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Bluetooth,
  RefreshCw,
  HelpCircle,
} from 'lucide-react';
import type { PulseCoreState } from '../../../main/services/pulse-core-bridge';

export interface ConnectBandStepProps {
  onSuccess?: () => void;
}

export const ConnectBandStep: React.FC<ConnectBandStepProps> = ({ onSuccess }) => {
  const [state, setState] = useState<PulseCoreState | null>(null);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceName?: string; maskedAddr?: string } | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // 1. 读取当前配置与订阅 PulseCore / Core 状态
  useEffect(() => {
    let alive = true;

    window.pulse?.getDeviceConfigStatus?.().then((status) => {
      if (alive && status) {
        setDeviceInfo({ deviceName: status.deviceName, maskedAddr: status.maskedAddr });
      }
    });

    window.pulse?.getCoreState?.().then((s) => {
      if (alive && s) setState(s);
    });

    const unsub = window.pulse?.onCoreState?.((s) => {
      if (alive && s) setState(s as PulseCoreState);
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const isConnected = state?.connection?.state === 'connected';
  const isRpcReady = state?.daemon?.rpcConnected === true;
  const isFullyReady = isConnected && isRpcReady;

  // 连接就绪自动回调通知父级。
  //
  // onSuccess 不能进依赖：SetupWizard 每次渲染都传新函数，父级 setStepExecution
  // 又返回新对象 → 重渲染 → 新 onSuccess → effect 再跑，无限循环。
  // 这里用 ref 读最新值，并保证「false → true」只通知一次。
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  const notifiedRef = useRef(false);
  useEffect(() => {
    if (!isFullyReady) {
      notifiedRef.current = false;
      return;
    }
    if (notifiedRef.current) return;
    notifiedRef.current = true;
    onSuccessRef.current?.();
  }, [isFullyReady]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setActionError(null);
    try {
      const res = await window.pulse?.connectBand?.();
      if (!res?.ok) {
        setActionError(res?.error || '连接建立失败');
      }
    } catch (err: any) {
      setActionError(err?.message || '发起连接时发生异常');
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setActionError(null);
    try {
      await window.pulse?.disconnectBand?.();
    } catch (err: any) {
      setActionError(err?.message || '断开连接失败');
    }
  }, []);

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <Bluetooth className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>连接蓝牙手环并验证协议</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          通过 Windows 蓝牙 RFCOMM 通道与手环建立直连，并自动完成 32 位 AuthKey 的业务握手。
        </p>
      </div>

      {/* 设备与连接状态卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Watch className="w-5 h-5 text-[var(--accent-primary)]" />
            <div>
              <div className="text-xs font-semibold text-[var(--text-primary)]">
                {deviceInfo?.deviceName || state?.device?.name || 'Xiaomi Smart Band 10'}
              </div>
              <div className="text-[11px] font-mono text-[var(--text-muted)]">
                目标 MAC: {deviceInfo?.maskedAddr || '***'}
              </div>
            </div>
          </div>

          <div>
            {isFullyReady ? (
              <span className="text-[11px] px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>已连接 (协议就绪)</span>
              </span>
            ) : state?.connection?.state === 'connecting' || connecting ? (
              <span className="text-[11px] px-2.5 py-1 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium flex items-center gap-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>正在连接…</span>
              </span>
            ) : (
              <span className="text-[11px] px-2.5 py-1 rounded bg-zinc-500/15 text-zinc-500 font-medium">
                未连接
              </span>
            )}
          </div>
        </div>

        {/* 详细指标行 */}
        <div className="pt-2 border-t border-[var(--border-default)] grid grid-cols-2 gap-2 text-[11px]">
          <div>
            <span className="text-[var(--text-muted)]">链路状态: </span>
            <span className="font-mono text-[var(--text-primary)]">
              {state?.connection?.state ?? 'disconnected'}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Core 守护进程: </span>
            <span className="font-mono text-[var(--text-primary)]">
              {state?.daemon?.rpcConnected ? '就绪 (RPC Active)' : '未就绪'}
            </span>
          </div>
        </div>
      </div>

      {/* 错误提示 */}
      {(actionError || state?.connection?.error) && (
        <div className="p-3 rounded-[var(--radius-md)] bg-rose-500/10 border border-rose-500/30 text-xs text-rose-500 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{actionError || state?.connection?.error}</span>
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <HelpCircle className="w-3.5 h-3.5" />
          <span>请保持手环点亮且位于电脑附近</span>
        </div>

        <div className="flex items-center gap-2">
          {isConnected ? (
            <button
              type="button"
              onClick={handleDisconnect}
              className="px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-rose-500 hover:border-rose-500/40 transition-colors cursor-pointer"
            >
              断开
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || state?.connection?.state === 'connecting'}
              className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
            >
              {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              <span>发起连接</span>
            </button>
          )}
        </div>
      </div>

      {/* 排查提示框 */}
      <div className="p-3 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] text-[11px] text-[var(--text-muted)] space-y-1">
        <div className="font-medium text-[var(--text-secondary)]">连接排查建议：</div>
        <ul className="list-disc pl-4 space-y-0.5 leading-relaxed">
          <li>确认电脑蓝牙已打开，手环在身边且屏幕亮着；手环弹出配对确认时，在手环上点同意（不需要在 Windows 设置里配对）。</li>
          <li>若手机小米运动健康 App 正在同步，蓝牙连接可能会被占用，可暂时在手机上关闭蓝牙或退出后台。</li>
          <li>若连续 3 次重试失败，可把电脑蓝牙关掉再打开一次。</li>
        </ul>
      </div>
    </div>
  );
};
