import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  Watch,
  Laptop,
  Check,
} from 'lucide-react';
import { AgentLogo } from '../pulse/AgentLogo';

export interface VerifyQuotaStepProps {
  onComplete?: () => void;
}

interface QuotaLimit {
  pct5h: number | null;
  pct7d: number | null;
  resetText?: string;
  authoritative?: boolean;
}

const AGENTS = [
  { key: 'claude', name: 'Claude Code', color: '#D97757' },
  { key: 'codex', name: 'Codex', color: '#10A37F' },
  { key: 'antigravity', name: 'Antigravity', color: '#4285F4' },
];

export const VerifyQuotaStep: React.FC<VerifyQuotaStepProps> = ({ onComplete }) => {
  const [limits, setLimits] = useState<Record<string, QuotaLimit> | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchQuota = async () => {
      try {
        const res = await window.pulse?.getDiagnostics?.();
        if (!alive) return;
        if (res?.ok && res.data?.limits) {
          setLimits(res.data.limits);
          setError(null);
        } else {
          setError(res?.error ?? 'status-server 当前不可达');
        }
      } catch (err: any) {
        if (!alive) return;
        setError(err?.message ?? '读取额度数据失败');
      } finally {
        if (alive) setLoading(false);
      }
    };

    void fetchQuota();
    const interval = setInterval(fetchQuota, 5000);

    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const hasAnyQuota =
    limits !== null &&
    Object.values(limits).some((q) => q && (q.pct5h != null || q.pct7d != null));

  const handleConfirmFinish = () => {
    onComplete?.();
  };

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>双轨验证：PC 端额度与手环端显示</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          确保电脑端 status-server 能够获取到 AI 编程助手的额度数据，并在手环屏幕上真实确认卡片显示正常。
        </p>
      </div>

      {/* 轨道 1：电脑端 status-server 额度数据获取 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Laptop className="w-4 h-4 text-[var(--accent-primary)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              PC 端数据源 (status-server 127.0.0.1:8765)
            </span>
          </div>
          <div>
            {loading ? (
              <span className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 查询中…
              </span>
            ) : hasAnyQuota ? (
              <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
                数据就绪
              </span>
            ) : (
              <span className="text-[11px] px-2 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">
                等待轮询数据
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-500 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          {AGENTS.map((agent) => {
            const q = limits?.[agent.key];
            const hasData = q && (q.pct5h != null || q.pct7d != null);

            return (
              <div
                key={agent.key}
                className="p-2.5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] space-y-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <AgentLogo agent={agent.key} size={15} color={agent.color} />
                  <span className="text-[11px] font-semibold text-[var(--text-primary)] truncate">
                    {agent.name}
                  </span>
                </div>

                <div className="font-mono text-[11px]">
                  {hasData ? (
                    <div className="space-y-0.5 text-[var(--text-secondary)]">
                      <div>5h: <span className="font-semibold text-[var(--text-primary)]">{q.pct5h != null ? `${q.pct5h}%` : '--'}</span></div>
                      <div>7d: <span className="font-semibold text-[var(--text-primary)]">{q.pct7d != null ? `${q.pct7d}%` : '--'}</span></div>
                    </div>
                  ) : (
                    <span className="text-[var(--text-muted)] text-[10px]">
                      {loading ? '获取中…' : '暂无数据 (等待使用)'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 轨道 2：手环端视觉确认卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3">
        <div className="flex items-center gap-2">
          <Watch className="w-4 h-4 text-[var(--accent-primary)]" />
          <span className="text-xs font-semibold text-[var(--text-primary)]">
            手环端显示视觉确认
          </span>
        </div>

        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          请在手环应用列表中打开 <strong>Pulse</strong>，确认是否能看到 Agent 额度卡片（或待命图标）。
        </p>

        <div className="p-3 rounded-[var(--radius-md)] bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-600 dark:text-amber-400 space-y-1">
          <div className="font-medium">科学实证纪律提示：</div>
          <p className="leading-relaxed text-[var(--text-muted)]">
            根据工程规范，桌面端无法直接替手环屏幕做出「已显示」的判断。手环屏幕的实际渲染结论须由您亲自核验后确认。
          </p>
        </div>
      </div>

      {/* 操作按钮组 */}
      <div className="pt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={handleConfirmFinish}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer"
        >
          稍后验证 (直接进入主界面)
        </button>

        <button
          type="button"
          onClick={handleConfirmFinish}
          className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer flex items-center gap-1.5"
        >
          <Check className="w-3.5 h-3.5" />
          <span>由用户确认手环显示正常 (完成配置)</span>
        </button>
      </div>
    </div>
  );
};
