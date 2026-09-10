import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Wrench } from 'lucide-react';
import { AgentLogo } from './AgentLogo';

export type AgentStatusType = 'idle' | 'running' | 'warning' | 'critical';

export interface ExtendedQuotaItem {
  label: string;
  value: string | number;
}

/**
 * 单个额度周期（5 小时 / 7 天）的展示数据。
 *
 * 纪律：`remaining` 为 null 表示**没有数据**，界面必须显示 `--`，
 * 不得补成 0% 或 100%。`resetText` 同理，缺失显示 `--`。
 */
export interface QuotaWindow {
  remaining: number | null;
  resetText: string | null;
  status: 'idle' | 'warning' | 'critical';
}

export interface AgentCardData {
  id: string;
  name: string;
  status: AgentStatusType;
  /** 兼容字段：等价于 fiveHour.remaining */
  remainingPercent?: number | null;
  /** 兼容别名 */
  primaryQuota?: number | null;
  /** 兼容字段：等价于 fiveHour.resetText */
  resetTime?: string | null;
  /** 5 小时周期额度 */
  fiveHour?: QuotaWindow | null;
  /** 7 天周期额度 */
  sevenDay?: QuotaWindow | null;
  /** true = 本地估算而非服务端真值，界面需显式标注 */
  estimated?: boolean;
  currentToolName?: string | null;
  elapsedSeconds?: number | null;
  extendedQuotas?: ExtendedQuotaItem[] | null;
  lastUpdatedAt?: number | null;
  quotaStatus?: 'idle' | 'warning' | 'critical';
}

export interface AgentCardProps {
  data: AgentCardData;
}

export { toRemainingPercent, resolveQuotaStatus } from './agent-quota-utils';

const fmtDuration = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

const NO_DATA = '--';

/**
 * 单个额度周期行：标题 + 剩余百分比 + 该周期自己的重置时间 + 进度条。
 *
 * 两个周期都常驻显示，缺失数据不隐藏整行、也不伪造 0%/100%。
 */
const QuotaRow: React.FC<{ label: string; window?: QuotaWindow | null }> = ({ label, window: w }) => {
  const remaining = w?.remaining ?? null;
  const hasData = remaining != null;

  const tone = !hasData
    ? 'text-[var(--text-muted)]'
    : w?.status === 'critical'
    ? 'text-[var(--quota-critical)]'
    : w?.status === 'warning'
    ? 'text-[var(--quota-warning)]'
    : 'text-[var(--text-primary)]';

  const barTone =
    w?.status === 'critical'
      ? 'bg-[var(--quota-critical)]'
      : w?.status === 'warning'
      ? 'bg-[var(--quota-warning)]'
      : 'bg-[var(--accent-primary)]';

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-[var(--text-muted)] shrink-0">{label}</span>
        <span className="flex items-baseline gap-2.5 min-w-0">
          <span className={`text-sm font-bold tabular-nums ${tone}`}>
            {hasData ? `${remaining}%` : NO_DATA}
          </span>
          <span className="text-[11px] text-[var(--text-muted)] tabular-nums flex items-center gap-1 truncate">
            <Clock className="w-3 h-3 shrink-0" />
            <span className="truncate">
              重置 {hasData ? w?.resetText ?? NO_DATA : NO_DATA}
            </span>
          </span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-[var(--bg-app)] border border-[var(--border-default)] overflow-hidden">
        {hasData && (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${barTone}`}
            style={{ width: `${remaining}%` }}
          />
        )}
      </div>
    </div>
  );
};

export const AgentCard: React.FC<AgentCardProps> = ({ data }) => {
  const [expanded, setExpanded] = useState(false);

  const isRunning = data.status === 'running';
  const isCritical = data.status === 'critical';
  const isWarning = data.status === 'warning';

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

  // 双周期额度：优先用新字段，同时兼容旧的单周期字段
  const fiveHour: QuotaWindow = data.fiveHour ?? {
    remaining: data.remainingPercent ?? data.primaryQuota ?? null,
    resetText: data.resetTime ?? null,
    status: data.quotaStatus ?? 'idle',
  };
  const sevenDay: QuotaWindow =
    data.sevenDay ?? { remaining: null, resetText: null, status: 'idle' };

  const hasExpandedData =
    (data.extendedQuotas && data.extendedQuotas.length > 0) ||
    data.lastUpdatedAt != null;

  return (
    <div className="p-4 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3 transition-all duration-200 select-none">
      {/* 头部：Agent 名称、状态指示与展开触发按钮 */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center shrink-0">
            <AgentLogo agent={data.id} size={20} />
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

      {/* 双周期额度：5 小时与 7 天同时可见，无需展开 */}
      <div className="space-y-3 pt-1">
        <QuotaRow label="5 小时剩余" window={fiveHour} />
        <QuotaRow label="7 天剩余" window={sevenDay} />
      </div>

      {/* 运行态补充信息（额度不藏在详情里，这里只放运行计时） */}
      {isRunning && data.elapsedSeconds != null && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-[11px] text-[var(--text-muted)]">运行计时</span>
          <span className="text-xs font-semibold text-[var(--accent-primary)] tabular-nums font-mono">
            {fmtDuration(data.elapsedSeconds)}
          </span>
        </div>
      )}

      {data.estimated && (
        <p className="text-[10px] text-[var(--text-muted)]">额度为本地估算值，仅供参考</p>
      )}

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
