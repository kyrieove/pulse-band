import React from 'react';
import { RefreshCw, Download } from 'lucide-react';
import type { MinibarState } from '../../../common/types';
import { AgentLogo } from './AgentLogo';
import { AgentSection, SUPPORTED_AGENTS, isAgentDetected } from './AgentSection';
import { toRemainingPercent } from './agent-quota-utils';

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export interface OverviewPageProps {
  /** 由 App 层唯一一份 useQuotaState 注入 */
  quota: MinibarState | null;
  loading?: boolean;
  refreshing?: boolean;
  onRefresh: () => void;
  bandDeviceName: string | null;
  bandConnected: boolean;
  bandBusy: boolean;
  bandCanConnect: boolean;
  onConnect: () => void;
}

/** 5 小时柱色按阈值：>40 主色，20–40 警告，<20 濒危 */
const fiveBarTone = (remaining: number | null) => {
  if (remaining == null) return 'bg-[var(--bg-subtle)]';
  if (remaining > 40) return 'bg-[var(--accent-primary)]';
  if (remaining >= 20) return 'bg-[var(--quota-warning)]';
  return 'bg-[var(--quota-critical)]';
};

/** 柱：pct 为 null 时整根铺 --hatch，否则按百分比高度 */
const Bar: React.FC<{ pct: number | null; className: string }> = ({ pct, className }) => (
  <div className="w-[26px] rounded-full overflow-hidden bg-[var(--bg-subtle)] self-end h-full flex items-end">
    <div
      className={`w-full rounded-full ${className}`}
      style={pct == null ? { height: '100%', background: 'var(--hatch)' } : { height: `${pct}%` }}
    />
  </div>
);

export const OverviewPage: React.FC<OverviewPageProps> = ({
  quota,
  loading = false,
  refreshing = false,
  onRefresh,
  bandDeviceName,
  bandConnected,
  bandBusy,
  bandCanConnect,
  onConnect,
}) => {
  const sessions = quota?.sessions ?? [];
  const quotas = quota?.quotas;
  const detected = SUPPORTED_AGENTS.filter((k) =>
    isAgentDetected(k, sessions, quotas ? quotas[k] : null)
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* 标题行：直接铺在灰底上 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">
            额度总览
          </h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
            按产品实时查看 5 小时与 7 天额度
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="btn-primary rounded-full px-[15px] py-2 text-[12px] font-semibold flex items-center gap-1.5 select-none transition-colors bg-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中…' : '立即刷新'}
          </button>
          <button
            type="button"
            aria-disabled="true"
            onClick={(e) => e.preventDefault()}
            title="即将支持"
            className="rounded-full px-[15px] py-2 text-[12px] font-semibold select-none transition-colors bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)] flex items-center gap-1.5 opacity-50 cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            导出记录
          </button>
        </div>
      </div>

      {/* 三张统计卡 */}
      <AgentSection state={quota} loading={loading} />

      {/* 最后一行：双周期对比 + 数据来源/手环 */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_214px] gap-2.5">
        {/* 双周期对比 */}
        <div className="min-h-[240px] rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
          <div className="shrink-0 flex items-center justify-between">
            <h3 className="text-[12px] font-semibold text-[var(--text-primary)]">双周期对比</h3>
            <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)]" />5 小时
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-[var(--data-secondary)]" />7 天
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: 'var(--hatch)' }} />未提供
              </span>
            </div>
          </div>

          <div className="flex-1 min-h-[170px] min-w-0 flex items-stretch justify-around gap-3 pt-3">
            {detected.map((a) => {
              const q = quotas ? quotas[a] : null;
              const five = toRemainingPercent(q?.pct5h);
              const seven = toRemainingPercent(q?.pct7d);
              return (
                <div key={a} className="flex-1 min-h-0 flex flex-col items-center gap-2">
                  <div className="flex-1 min-h-0 h-full flex items-end justify-center gap-2 w-full">
                    <Bar pct={five} className={fiveBarTone(five)} />
                    <Bar pct={seven} className="bg-[var(--data-secondary)]" />
                  </div>
                  <span className="shrink-0 text-[10.5px] text-[var(--text-muted)] truncate">
                    {AGENT_LABEL[a] ?? a}
                  </span>
                </div>
              );
            })}
            {detected.length === 0 && (
              <p className="text-[11px] text-[var(--text-muted)] self-center">暂无可对比的 Agent</p>
            )}
          </div>
        </div>

        {/* 右列：数据来源 + 手环 */}
        <div className="min-h-0 flex flex-col gap-2.5">
          <div className="shrink-0 rounded-[10px] bg-[var(--bg-subtle)] p-3">
            <h3 className="text-[11px] font-semibold text-[var(--text-primary)] mb-2">数据来源</h3>
            <div className="space-y-2">
              {detected.map((a) => {
                const q = quotas ? quotas[a] : null;
                const auth = q?.authoritative === true;
                return (
                  <div key={a} className="flex items-center gap-2">
                    <AgentLogo agent={a} size={16} />
                    <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1">
                      {AGENT_LABEL[a] ?? a}
                    </span>
                    <span
                      className={`text-[9px] font-bold px-1.5 py-0.5 rounded-[6px] ${
                        auth
                          ? 'bg-[var(--accent-wash)] text-[var(--anchor-text)]'
                          : 'bg-[var(--quota-warning-wash)] text-[var(--quota-warning-text)]'
                      }`}
                    >
                      {auth ? 'Live' : '估算'}
                    </span>
                  </div>
                );
              })}
              {detected.length === 0 && (
                <p className="text-[10px] text-[var(--text-muted)]">暂无已检测的 Agent</p>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3 flex flex-col">
            <h3 className="text-[11px] font-semibold text-[var(--text-primary)]">手环</h3>
            <div className="mt-2 text-[12px] text-[var(--text-secondary)] truncate">
              {bandDeviceName ?? '未连接'}
            </div>
            <button
              type="button"
              onClick={onConnect}
              disabled={!bandCanConnect}
              className="btn-primary mt-auto w-full rounded-full py-2 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {bandBusy ? '连接中…' : bandConnected ? '已连接' : '连接手环'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
