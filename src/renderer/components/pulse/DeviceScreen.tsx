import React, { useState } from 'react';
import { AlertTriangle, ArrowRight, Link2, Wifi } from 'lucide-react';
import type { PulseOronboxState } from '../../../main/services/oronbox-bridge';
import { canConnectBand } from '../../../main/services/oronbox-policy';
import { Card, StatusBadge, maskMac } from './ui';
import { QuotaCards } from './QuotaCards';

type ConnTone = 'success' | 'warning' | 'danger';

const STATUS_TEXT: Record<string, string> = {
  connected: '已连接 (Connected)',
  connecting: '正在连接... (Connecting)',
  disconnected: '未连接 (Disconnected)',
  error: '连接异常 (Error)',
};

function explainError(raw?: string): string {
  if (!raw) return '连接出现异常，请前往运行诊断复制报告。';
  if (raw.includes('No RFCOMM channel available')) {
    return '手环没进“连接新手机”模式，或正被手机占用。请在手环上进入 设置 → 系统操作 → 连接新手机。';
  }
  if (raw.includes('Auth HMAC mismatch')) return 'authkey 已失效，请在设置与维护页重新完成首次配对。';
  return raw;
}

export const DeviceScreen: React.FC<{
  state: PulseOronboxState | null;
  onOpenSettings: () => void;
}> = ({ state, onOpenSettings }) => {
  const device = state?.device ?? null;
  const connection = state?.connection ?? { state: 'disconnected' as const };
  const [pendingConnect, setPendingConnect] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showMac, setShowMac] = useState(false);

  const connState =
    pendingConnect && (connection.state === 'disconnected' || connection.state === 'error')
      ? 'connecting'
      : connection.state;
  const tone: ConnTone = connState === 'connected' ? 'success' : connState === 'connecting' ? 'warning' : 'danger';

  const handleConnect = async () => {
    setBusy('connect');
    setPendingConnect(true);
    setMessage(null);
    const res = await window.pulse?.connectBand();
    setPendingConnect(false);
    setBusy(null);
    if (res && !res.ok) setMessage({ ok: false, text: `连接失败：${res.error ?? '未知错误'}` });
  };

  const handleDisconnect = async () => {
    setBusy('disconnect');
    setMessage(null);
    const res = await window.pulse?.disconnectBand();
    setBusy(null);
    if (res && !res.ok) setMessage({ ok: false, text: `断开失败：${res.error ?? '未知错误'}` });
  };

  const bridgeHealthy = state?.daemon.rpcConnected === true && state?.bridge.mode === 'direct';

  return (
    <main className="flex-1 bg-[var(--bg-canvas)] overflow-y-auto custom-scrollbar p-5 space-y-4 select-text">
      {device ? (
        <section className={`p-4 rounded-xl bg-[var(--bg-surface)] border ${tone === 'success' ? 'border-[var(--accent-wash)]' : 'border-[var(--border-default)]'}`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{device.name}</h2>
                {device.codename && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--text-muted)]">{device.codename}</span>}
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)] flex gap-3">
                <button className="font-mono hover:text-[var(--text-primary)] select-none" onClick={() => setShowMac(!showMac)}>
                  MAC: {showMac ? device.address : maskMac(device.address)}
                </button>
                <span>{device.connectType.toUpperCase()} 蓝牙串口</span>
              </div>
            </div>
            <StatusBadge tone={tone} text={STATUS_TEXT[connState] ?? STATUS_TEXT.disconnected} />
          </div>
          {connection.state === 'error' && <p className="mt-3 pt-3 border-t border-[var(--border-default)] text-xs text-[var(--status-error)]">{explainError(connection.error)}</p>}
        </section>
      ) : (
        <section className="p-7 rounded-xl bg-[var(--bg-surface)] border border-dashed border-white/[0.15] text-center space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">尚未载入已配对手环</h2>
          <p className="text-xs text-[var(--text-muted)]">Pulse 不扫描也不保存配对信息；首次设置请在「设置与维护」页提取 authkey。</p>
          <button onClick={onOpenSettings} className="px-4 py-2 rounded-lg bg-[var(--accent-primary)] text-[var(--bg-surface)] text-xs font-semibold select-none">
            前往设置与维护
          </button>
        </section>
      )}

      <section className="p-4 rounded-xl bg-[var(--quota-warning-wash)] border border-amber-500/35 text-[var(--quota-warning)] space-y-1.5">
        <div className="flex items-center gap-2 font-semibold text-sm"><AlertTriangle className="w-4 h-4 text-[var(--quota-warning)]" />连接前请注意</div>
        <p className="text-xs leading-relaxed text-[var(--quota-warning)]/90">
          连接 Pulse 会断开手环与小米运动健康的蓝牙连接——两者能否同时在线尚未验证。断开后仍需在手环选择“连接新手机”，再重新连接小米运动健康。
          连接后手环时间可能显示异常；Pulse 会尝试校时，但无法保证彻底规避该问题。
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3.5">
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]"><Wifi className="w-4 h-4 text-[var(--accent-primary)]" />手环连接</div>
          <p className="text-xs text-[var(--text-muted)]">Pulse 只响应你的手动操作，不会在启动或断线后自动连接。</p>
          <div className="flex gap-2 select-none">
            <button
              onClick={handleConnect}
              disabled={!canConnectBand(connState, busy !== null)}
              className="flex-1 px-3 py-2 rounded-lg bg-[var(--accent-primary)] text-[var(--bg-surface)] disabled:bg-[var(--bg-subtle)] disabled:text-[var(--text-muted)] text-xs font-semibold flex items-center justify-center gap-1.5"
            >
              <ArrowRight className="w-3.5 h-3.5" />{connState === 'connecting' ? '连接中…' : '连接手环（将断开手机）'}
            </button>
            <button onClick={handleDisconnect} disabled={connState !== 'connected' || busy !== null} className="px-4 py-2 rounded-lg bg-[var(--bg-subtle)] text-[var(--text-secondary)] disabled:opacity-40 text-xs">
              断开
            </button>
          </div>
          {message && <p className={`text-xs ${message.ok ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]'}`}>{message.text}</p>}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]"><Link2 className="w-4 h-4 text-[var(--status-success)]" />手环联网</div>
          <p className="text-xs text-[var(--text-muted)]">默认由 Pulse 直接响应手环请求；兼容模式位于设置与维护页。</p>
          <div className={`inline-flex items-center gap-2 text-xs font-medium ${bridgeHealthy ? 'text-[var(--status-success)]' : 'text-[var(--text-muted)]'}`}>
            <span className={`w-2 h-2 rounded-full ${bridgeHealthy ? 'bg-[var(--status-success)]' : 'bg-[var(--text-muted)]'}`} />
            {bridgeHealthy ? '联网链路已就绪' : '连接手环后检查联网链路'}
          </div>
        </Card>
      </section>

      <QuotaCards />
    </main>
  );
};
