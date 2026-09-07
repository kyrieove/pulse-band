/**
 * 三家 AI 编程助手的额度卡片 —— 推送给手环显示的数据源。
 *
 * 数据来自本进程内的 status-server（127.0.0.1:8765），经主进程转发，10s 轮询；
 * 不触碰 OronBox，也不会引起手环连接。
 *
 * authoritative:false 必须视觉强区分（双层虚线边框 + 斜纹底 + 琥珀徽章 + ~EST + 数值带 *）。
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers } from 'lucide-react';
import { fmtTime } from './ui';

interface QuotaView {
  pct5h: number | null;
  pct7d: number | null;
  resetText: string;
  authoritative: boolean;
  needsAuth?: boolean;
}

interface QuotaMeta {
  lastSuccessAt: Record<string, number>;
  nextTry: Record<string, number>;
}

const AGENTS: Array<{ key: string; label: string; color: string; glow: string }> = [
  { key: 'claude', label: 'Claude Code', color: '#D97757', glow: 'rgba(217, 119, 87, 0.4)' },
  { key: 'codex', label: 'Codex (CLI)', color: '#10A37F', glow: 'rgba(16, 163, 127, 0.4)' },
  { key: 'antigravity', label: 'Antigravity', color: '#4285F4', glow: 'rgba(66, 133, 244, 0.4)' },
];

const fmtCountdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
};

export const QuotaCards: React.FC = () => {
  const [diag, setDiag] = useState<{ limits: Record<string, QuotaView | null>; quotaMeta?: QuotaMeta } | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await window.pulse?.getDiagnostics();
      if (!alive) return;
      if (res?.ok && res.data) {
        setDiag({ limits: res.data.limits ?? {}, quotaMeta: res.data.quotaMeta });
        setDiagError(null);
      } else {
        setDiagError(res?.error ?? 'status-server 不可达');
      }
    };
    void load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const meta = diag?.quotaMeta;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-island-accent" />
          <h2 className="text-sm font-semibold text-zinc-200">AI 编程助手额度 (推送给手环显示的数据源)</h2>
        </div>
        <span className="text-[11px] text-zinc-500 font-mono tabular-nums">每 60 秒轮询更新 · 支持 5h/7d 窗口</span>
      </div>

      {diagError && (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> 额度数据不可用：{diagError}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {AGENTS.map((agent) => {
          const q = diag?.limits?.[agent.key] ?? null;
          const authoritative = q?.authoritative === true;
          const pct5h = q?.pct5h;
          const pct7d = q?.pct7d;
          const lastOk = meta?.lastSuccessAt?.[agent.key] ?? 0;
          const nextTry = meta?.nextTry?.[agent.key] ?? 0;
          const inBackoff = nextTry > now;

          return (
            <div
              key={agent.key}
              className={
                authoritative
                  ? 'p-3.5 rounded-xl bg-island-surface border border-white/[0.08] hover:border-white/[0.15] transition space-y-3'
                  : 'p-3.5 rounded-xl bg-[#15141b] border-2 border-dashed border-amber-500/40 stripe-pattern-warning hover:border-amber-500/60 transition space-y-3 relative overflow-hidden'
              }
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: agent.color, boxShadow: `0 0 8px ${agent.glow}` }} />
                  <span className="text-xs font-semibold text-zinc-100">{agent.label}</span>
                </div>
                {authoritative ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-2.5 h-2.5" />
                    权威真值
                  </span>
                ) : (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold flex items-center gap-1 shadow-sm">
                    <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />
                    本地估算 (非权威)
                  </span>
                )}
              </div>

              {/* 5h */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className={`${authoritative ? 'text-zinc-400' : 'text-amber-200/80'} text-[11px] flex items-center gap-1`}>
                    5{authoritative ? '小时' : '小时估算'}窗口用量
                    {!authoritative && <span className="text-[9px] text-amber-400 font-mono">~EST</span>}
                  </span>
                  <span className={`font-mono font-bold tabular-nums ${authoritative ? 'text-zinc-200' : 'text-amber-300'}`}>
                    {pct5h == null ? '--' : `${pct5h}${authoritative ? '%' : '%*'}`}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${pct5h ?? 0}%`, backgroundColor: agent.color, opacity: authoritative ? 1 : 0.85 }}
                  />
                </div>
              </div>

              {/* 7d */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className={`${authoritative ? 'text-zinc-400' : 'text-amber-200/80'} text-[11px] flex items-center gap-1`}>
                    7{authoritative ? '天' : '天估算'}窗口用量
                    {!authoritative && <span className="text-[9px] text-amber-400 font-mono">~EST</span>}
                  </span>
                  <span className={`font-mono font-bold tabular-nums ${authoritative ? 'text-zinc-200' : 'text-amber-300'}`}>
                    {pct7d == null ? '--' : `${pct7d}${authoritative ? '%' : '%*'}`}
                  </span>
                </div>
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${pct7d ?? 0}%`, backgroundColor: agent.color, opacity: authoritative ? 1 : 0.85 }}
                  />
                </div>
              </div>

              <div
                className={`pt-2 border-t flex items-center justify-between text-[11px] ${
                  authoritative ? 'border-white/[0.06] text-zinc-400' : 'border-amber-500/20 text-amber-400/90'
                }`}
              >
                <span>
                  {authoritative ? '额度重置倒计时:' : '*本地兜底数据 · '}
                  {!authoritative && <span className="font-mono tabular-nums text-zinc-300">{q?.resetText ?? '--'}</span>}
                </span>
                {authoritative && <span className="font-mono tabular-nums text-zinc-200 font-medium">{q?.resetText ?? '--'}</span>}
              </div>

              {/* 最后成功拉取 + 429 退避倒计时 */}
              <div className="text-[10px] text-zinc-500 font-mono tabular-nums flex items-center justify-between">
                <span>上次成功拉取: {lastOk ? fmtTime(lastOk) : '尚未成功'}</span>
                {inBackoff && (
                  <span className="text-amber-400" title="429/失败退避中，到期前不会发起上游请求">
                    退避 {fmtCountdown(nextTry - now)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
