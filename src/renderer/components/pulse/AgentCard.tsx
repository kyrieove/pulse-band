import React from 'react';
import { ArrowRight } from 'lucide-react';
import { AgentLogo } from './AgentLogo';
import { parseResetTimeInfo } from './agent-quota-utils';

export type AgentStatusType = 'idle' | 'running' | 'warning' | 'critical';

export interface ExtendedQuotaItem {
  label: string;
  value: string | number;
}

export interface QuotaWindow {
  remaining: number | null;
  resetText: string | null;
  status: 'idle' | 'warning' | 'critical';
}

export interface AgentCardData {
  id: string;
  name: string;
  status: AgentStatusType;
  remainingPercent?: number | null;
  primaryQuota?: number | null;
  resetTime?: string | null;
  fiveHour?: QuotaWindow | null;
  sevenDay?: QuotaWindow | null;
  estimated?: boolean;
  currentToolName?: string | null;
  extendedQuotas?: ExtendedQuotaItem[] | null;
  quotaStatus?: 'idle' | 'warning' | 'critical';
}

export interface AgentCardProps {
  data: AgentCardData;
  anchor?: boolean;
}

export { toRemainingPercent, resolveQuotaStatus } from './agent-quota-utils';

const NO_DATA = '--';

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
  const resetText = parseResetTimeInfo(fiveHour.resetText).countdownText;
  const numberColor = anchor ? 'text-[var(--anchor-text)]' : percentColor(remaining);
  const mutedText = anchor ? 'text-[var(--anchor-text)]/80' : 'text-[var(--text-muted)]';

  return (
    <div
      className={`relative p-3.5 rounded-[10px] transition-colors duration-200 select-none ${
        anchor ? 'bg-[var(--anchor-wash)]' : 'bg-[var(--bg-subtle)]'
      }`}
    >
      {/* 顶部只保留品牌与名称；不再放无动作的外链箭头 */}
      <div className="flex items-center gap-2">
        <AgentLogo agent={data.id} size={18} />
        <h4
          className={`text-[13px] font-semibold truncate ${
            anchor ? 'text-[var(--anchor-text)]' : 'text-[var(--text-primary)]'
          }`}
        >
          {data.name}
        </h4>
      </div>

      <div className={`mt-2.5 flex items-baseline leading-none ${numberColor}`}>
        <span className="text-[36px] font-bold tracking-[-0.035em] tabular-nums">
          {remaining != null ? remaining : NO_DATA}
        </span>
        <span className="text-[19px] font-semibold ml-0.5">%</span>
      </div>
      <div className={`mt-1 text-[10.5px] ${mutedText}`}>5 小时剩余</div>

      {/* 时间信息固定成两列，避免状态长文案撑乱三张卡 */}
      <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 min-w-0">
        <span className={`text-[10px] truncate ${mutedText}`}>{resetText}</span>
        <span className={`text-[10px] font-medium tabular-nums text-right ${mutedText}`}>
          7 天 {sevenDay.remaining != null ? `${sevenDay.remaining}%` : NO_DATA}
        </span>
        {data.status === 'running' && data.currentToolName && (
          <span className={`col-span-2 inline-flex items-center gap-1 text-[10px] truncate ${mutedText}`}>
            <ArrowRight className="w-3 h-3 shrink-0" />运行 {data.currentToolName}
          </span>
        )}
      </div>
    </div>
  );
};
