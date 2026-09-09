import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Activity, Clock, Wrench } from 'lucide-react';

export type AgentStatusType = 'idle' | 'running' | 'warning' | 'critical';

export interface ExtendedQuotaItem {
  label: string;
  value: string | number;
}

export interface AgentCardData {
  id: string;
  name: string;
  status: AgentStatusType;
  primaryQuota?: number | null;
  resetTime?: string | null;
  currentToolName?: string | null;
  elapsedSeconds?: number | null;
  extendedQuotas?: ExtendedQuotaItem[] | null;
  lastUpdatedAt?: number | null;
}

export interface AgentCardProps {
  data: AgentCardData;
}

const fmtDuration = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

export const AgentCard: React.FC<AgentCardProps> = ({ data }) => {
  const [expanded, setExpanded] = useState(false);

  const isRunning = data.status === 'running';
  const isWarning = data.status === 'warning';
  const isCritical = data.status === 'critical';

  // 状态色彩与指示
  const statusColor = isRunning
    ? 'text-[var(--status-working)] bg-[var(--status-working)]/10 border-[var(--status-working)]/30'
    : isCritical
    ? 'text-[var(--status-error)] bg-[var(--status-error)]/10 border-[var(--status-error)]/30'
    : isWarning
    ? 'text-[var(--status-warning)] bg-[var(--status-warning)]/10 border-[var(--status-warning)]/30'
    : 'text-[var(--status-idle)] bg-black/[0.04] dark:bg-white/[0.06] border-transparent';

  const statusLabel = isRunning
    ? '运行中'
    : isCritical
    ? '额度濒危'
    : isWarning
    ? '额度紧张'
    : '待命就绪';

  // 额度色彩
  const quotaTone =
    data.primaryQuota != null && data.primaryQuota <= 5
      ? 'text-[var(--quota-critical)]'
      : data.primaryQuota != null && data.primaryQuota <= 20
      ? 'text-[var(--quota-warning)]'
      : 'text-[var(--text-primary)]';

  const hasExpandedData =
    (data.extendedQuotas && data.extendedQuotas.length > 0) ||
    data.lastUpdatedAt != null;

  return (
    <div className="p-4 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3 transition-all duration-200 select-none">
      {/* 头部：Agent 名称、状态指示与展开触发按钮 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--accent-primary)] shrink-0">
            <Activity className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-semibold text-[var(--text-primary)] truncate">
              {data.name}
            </h4>
            {isRunning && data.currentToolName && (
              <p className="text-[11px] text-[var(--text-muted)] truncate flex items-center gap-1 mt-0.5">
                <Wrench className="w-3 h-3 shrink-0" />
                <span>工具: {data.currentToolName}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* 状态徽章 */}
          <span
            className={`px-2 py-0.5 rounded-[var(--radius-full)] text-xs font-medium border flex items-center gap-1.5 ${statusColor}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isRunning
                  ? 'bg-[var(--status-working)] animate-pulse shadow-[0_0_6px_var(--status-working)]'
                  : isCritical
                  ? 'bg-[var(--status-error)]'
                  : isWarning
                  ? 'bg-[var(--status-warning)]'
                  : 'bg-[var(--status-idle)]'
              }`}
            />
            <span>{statusLabel}</span>
          </span>

          {/* 展开切换按钮 */}
          {hasExpandedData && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="p-1 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors"
              title={expanded ? '收起详细指标' : '展开详细指标'}
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* 核心指标行：主要额度、重置时间、运行计时 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1 text-xs">
        {data.primaryQuota != null && (
          <div className="space-y-0.5">
            <div className="text-[11px] text-[var(--text-muted)]">主要剩余额度</div>
            <div className={`text-base font-bold tabular-nums ${quotaTone}`}>
              {data.primaryQuota}%
            </div>
          </div>
        )}

        {data.resetTime && (
          <div className="space-y-0.5">
            <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>重置时间</span>
            </div>
            <div className="text-xs font-medium text-[var(--text-secondary)] tabular-nums">
              {data.resetTime}
            </div>
          </div>
        )}

        {isRunning && data.elapsedSeconds != null && (
          <div className="space-y-0.5">
            <div className="text-[11px] text-[var(--text-muted)]">运行计时</div>
            <div className="text-xs font-semibold text-[var(--accent-primary)] tabular-nums font-mono">
              {fmtDuration(data.elapsedSeconds)}
            </div>
          </div>
        )}
      </div>

      {/* 展开区域：仅当存在数据时渲染预留结构 */}
      {expanded && hasExpandedData && (
        <div className="pt-3 mt-1 border-t border-[var(--border-default)] space-y-2.5">
          {data.extendedQuotas && data.extendedQuotas.length > 0 && (
            <div className="grid grid-cols-2 gap-2 text-xs">
              {data.extendedQuotas.map((item, idx) => (
                <div key={idx} className="p-2 rounded-[var(--radius-md)] bg-[var(--bg-app)]">
                  <div className="text-[10px] text-[var(--text-muted)]">{item.label}</div>
                  <div className="text-xs font-semibold text-[var(--text-primary)] tabular-nums mt-0.5">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.lastUpdatedAt != null && (
            <div className="text-[10px] text-[var(--text-muted)]">
              数据更新时间：{new Date(data.lastUpdatedAt).toLocaleTimeString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
