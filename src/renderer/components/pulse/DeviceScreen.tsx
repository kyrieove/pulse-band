import React, { useState } from 'react';
import { AlertTriangle, ArrowRight, Link2, Wifi } from 'lucide-react';
import type { PulseOronboxState } from '../../../main/services/oronbox-bridge';
import { canConnectBand } from '../../../main/services/oronbox-policy';
import { Card, StatusBadge, maskMac } from './ui';

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
    <main className="flex-1 bg-island-bg overflow-y-auto custom-scrollbar p-5 space-y-4 select-text">
      {device ? (
        <section className={`p-4 rounded-xl bg-island-surface border ${tone === 'success' ? 'border-emerald-500/30' : 'border-white/[0.1]'}`}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-zinc-100">{device.name}</h2>
                {device.codename && <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{device.codename}</span>}
              </div>
              <div className="mt-1 text-xs text-zinc-400 flex gap-3">
                <button className="font-mono hover:text-zinc-200 select-none" onClick={() => setShowMac(!showMac)}>
                  MAC: {showMac ? device.address : maskMac(device.address)}
                </button>
                <span>{device.connectType.toUpperCase()} 蓝牙串口</span>
              </div>
            </div>
            <StatusBadge tone={tone} text={STATUS_TEXT[connState] ?? STATUS_TEXT.disconnected} />
          </div>
          {connection.state === 'error' && <p className="mt-3 pt-3 border-t border-white/[0.06] text-xs text-rose-300">{explainError(connection.error)}</p>}
        </section>
      ) : (
        <section className="p-7 rounded-xl bg-island-surface border border-dashed border-white/[0.15] text-center space-y-3">
          <h2 className="text-sm font-semibold text-zinc-200">尚未载入已配对手环</h2>
          <p className="text-xs text-zinc-400">Pulse 不再扫描或保存配对信息，首次配对由 OronBox 完成。</p>
          <button onClick={onOpenSettings} className="px-4 py-2 rounded-lg bg-island-accent text-zinc-950 text-xs font-semibold select-none">
            前往设置与维护
          </button>
        </section>
      )}

      <section className="p-4 rounded-xl bg-amber-500/[0.08] border border-amber-500/35 text-amber-100 space-y-1.5">
        <div className="flex items-center gap-2 font-semibold text-sm"><AlertTriangle className="w-4 h-4 text-amber-400" />连接前请注意</div>
        <p className="text-xs leading-relaxed text-amber-200/90">
          连接 Pulse 或 OronBox 会断开手环与小米运动健康的蓝牙连接。断开后仍需在手环选择“连接新手机”，再重新连接小米运动健康。
          连接 OronBox 后手环时间也可能异常；Pulse 会尝试校时，但无法保证彻底规避该问题。
        </p>
      </section>

      <section className="grid grid-cols-2 gap-3.5">
        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Wifi className="w-4 h-4 text-island-accent" />手环连接</div>
          <p className="text-xs text-zinc-400">Pulse 只响应你的手动操作，不会在启动或断线后自动连接。</p>
          <div className="flex gap-2 select-none">
            <button
              onClick={handleConnect}
              disabled={!canConnectBand(connState, busy !== null)}
              className="flex-1 px-3 py-2 rounded-lg bg-island-accent text-zinc-950 disabled:bg-zinc-800 disabled:text-zinc-500 text-xs font-semibold flex items-center justify-center gap-1.5"
            >
              <ArrowRight className="w-3.5 h-3.5" />{connState === 'connecting' ? '连接中…' : '连接手环（将断开手机）'}
            </button>
            <button onClick={handleDisconnect} disabled={connState !== 'connected' || busy !== null} className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300 disabled:opacity-40 text-xs">
              断开
            </button>
          </div>
          {message && <p className={`text-xs ${message.ok ? 'text-emerald-400' : 'text-rose-300'}`}>{message.text}</p>}
        </Card>

        <Card className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200"><Link2 className="w-4 h-4 text-emerald-400" />手环联网</div>
          <p className="text-xs text-zinc-400">默认由 Pulse 直接响应手环请求；兼容模式位于设置与维护页。</p>
          <div className={`inline-flex items-center gap-2 text-xs font-medium ${bridgeHealthy ? 'text-emerald-400' : 'text-zinc-500'}`}>
            <span className={`w-2 h-2 rounded-full ${bridgeHealthy ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {bridgeHealthy ? '联网链路已就绪' : '连接手环后检查联网链路'}
          </div>
        </Card>
      </section>
    </main>
  );
};
