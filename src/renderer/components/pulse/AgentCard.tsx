import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { AgentLogo } from './AgentLogo';
import { parseResetTimeInfo } from './agent-quota-utils';

export type AgentStatusType = 'idle' | 'running' | 'warning' | 'critical';

export interface ExtendedQuotaItem {
  label: string;
  value: string | number;
}

/**
 * 单个额度周期（5 小时 / 7 天）的展示数据。
 *
 * 纪律：`remaining` 为 null 表示**没有数据**，界面必须显示 `--`，
 * 不得补成 0% 或 100%。
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
  extendedQuotas?: ExtendedQuotaItem[] | null;
  quotaStatus?: 'idle' | 'warning' | 'critical';
}

export interface AgentCardProps {
  data: AgentCardData;
  /** 锚点卡：三张里 5 小时剩余最低的那张（全部 >60% 时为 null） */
  anchor?: boolean;
}

export { toRemainingPercent, resolveQuotaStatus } from './agent-quota-utils';

const NO_DATA = '--';

/** 主数字颜色按阈值：>40 主文字，20–40 警告，<20 濒危 */
const percentColor = (remaining: number | null): string => {
  if (remaining == null) return 'text-[var(--text-muted)]';
  if (remaining > 40) return 'text-[var(--text-primary)]';
  if (remaining >= 20) return 'text-[var(--quota-warning)]';
  return 'text-[var(--quota-critical)]';
};

export const AgentCard: React.FC<AgentCardProps> = ({ data, anchor = false }) => {
  const fiveHour: QuotaWindow = data.fiveHour ?? {
    remaining: data.remainingPercent ?? data.primaryQuota ?? null,
    resetText: data.resetTime ?? null,
    status: data.quotaStatus ?? 'idle',
  };
  const sevenDay: QuotaWindow = data.sevenDay ?? { remaining: null, resetText: null, status: 'idle' };

  const remaining = fiveHour.remaining;
  const countdownText = parseResetTimeInfo(fiveHour.resetText).countdownText;

  const running = data.status === 'running';
  const statusLabel = running
    ? data.currentToolName
      ? `运行 ${data.currentToolName}`
      : '运行中'
    : data.status === 'critical'
    ? '额度濒危'
    : data.status === 'warning'
    ? '额度紧张'
    : '待命';

  const statusBadge = running
    ? 'bg-[var(--status-working)] text-white'
    : data.status === 'critical'
    ? 'bg-[var(--quota-critical)] text-white'
    : data.status === 'warning'
    ? 'bg-[var(--quota-warning)] text-white'
    : 'bg-[var(--bg-subtle)] text-[var(--text-muted)]';

  const numberColor = anchor ? 'text-[var(--anchor-text)]' : percentColor(remaining);
  const mutedText = anchor ? 'text-[var(--anchor-text)]/80' : 'text-[var(--text-muted)]';

  return (
    <div
      className={`relative p-3.5 rounded-[18px] border transition-colors duration-200 select-none ${
        anchor ? 'bg-[var(--anchor-wash)] border-transparent' : 'bg-[var(--bg-surface)] border-[var(--border-default)]'
      }`}
    >
      {/* 右上角：24px 圆形描边按钮 + 45° 外链箭头 */}
      <button
        type="button"
        className={`absolute top-3.5 right-3.5 w-6 h-6 rounded-full border flex items-center justify-center transition-colors ${
          anchor
            ? 'border-white/50 text-[var(--anchor-text)]'
            : 'border-[var(--border-strong)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
        }`}
        title="打开外部"
        aria-label="打开外部"
      >
        <ArrowUpRight className="w-3.5 h-3.5" />
      </button>

      {/* 顶部：logo + 名称 */}
      <div className="flex items-center gap-2 pr-7">
        <AgentLogo agent={data.id} size={18} />
        <h4
          className={`text-[13px] font-semibold truncate ${
            anchor ? 'text-[var(--anchor-text)]' : 'text-[var(--text-primary)]'
          }`}
        >
          {data.name}
        </h4>
      </div>

      {/* 主数字 */}
      <div className={`mt-2.5 flex items-baseline leading-none ${numberColor}`}>
        <span className="text-[36px] font-bold tracking-[-0.035em] tabular-nums">
          {remaining != null ? remaining : NO_DATA}
        </span>
        <span className="text-[19px] font-semibold ml-0.5">%</span>
      </div>
      <div className={`mt-1 text-[10.5px] ${mutedText}`}>5 小时剩余</div>

      {/* 徽章行：状态 + 倒计时 + 7 天 */}
      <div className="mt-3 flex items-center gap-1.5 flex-wrap min-w-0">
        <span className={`rounded-[6px] text-[10px] font-bold px-1.5 py-0.5 shrink-0 ${statusBadge}`}>
          {statusLabel}
        </span>
        <span className={`text-[10px] truncate ${mutedText}`}>{countdownText}</span>
        <span className={`text-[10px] font-medium tabular-nums ${mutedText}`}>
          · 7 天 {sevenDay.remaining != null ? `${sevenDay.remaining}%` : NO_DATA}
        </span>
      </div>
    </div>
  );
};
