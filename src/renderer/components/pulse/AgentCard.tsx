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

  const is5hCrit = fiveHour.status === 'critical';
  const is5hWarn = fiveHour.status === 'warning';
  const is7dCrit = sevenDay.status === 'critical';
  const is7dWarn = sevenDay.status === 'warning';

  // 告警优先级高于重点卡装饰配色：5h 受限时优先使用警告/濒危色
  const numberColor = is5hCrit
    ? 'text-[var(--quota-critical)]'
    : is5hWarn
    ? 'text-[var(--quota-warning)]'
    : anchor
    ? 'text-[var(--anchor-text)]'
    : percentColor(remaining);

  const mutedText = anchor ? 'text-[var(--anchor-text)]/80' : 'text-[var(--text-muted)]';
  const sevenDayColor = is7dCrit
    ? 'text-[var(--quota-critical)] font-semibold'
    : is7dWarn
    ? 'text-[var(--quota-warning)] font-semibold'
    : mutedText;

  // 任一周期进入 warning/critical 时提供明确文字短提示，灰度截图亦可区分受限周期
  const alertText = (() => {
    if (is5hCrit && is7dCrit) return '双周期濒危';
    if (is5hCrit && is7dWarn) return '5h 濒危 · 7d 偏低';
    if (is5hWarn && is7dCrit) return '7d 濒危 · 5h 偏低';
    if (is5hWarn && is7dWarn) return '双周期偏低';
    if (is5hCrit) return '5 小时濒危';
    if (is5hWarn) return '5 小时偏低';
    if (is7dCrit) return '7 天濒危';
    if (is7dWarn) return '7 天偏低';
    return null;
  })();

  return (
    <div
      className={`relative p-3.5 rounded-[10px] transition-colors duration-200 select-none ${
        anchor ? 'bg-[var(--anchor-wash)]' : 'bg-[var(--bg-subtle)]'
      }`}
    >
      {/* 顶部：品牌名称 + 独立告警文字标识 */}
      <div className="flex items-center justify-between gap-1.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0 truncate">
          <AgentLogo agent={data.id} size={18} />
          <h4
            className={`text-[13px] font-semibold truncate ${
              anchor ? 'text-[var(--anchor-text)]' : 'text-[var(--text-primary)]'
            }`}
          >
            {data.name}
          </h4>
        </div>
        {alertText && (
          <span
            className={`shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-[4px] leading-tight ${
              is5hCrit || is7dCrit
                ? 'bg-[var(--quota-critical-wash)] text-[var(--quota-critical-text)] border border-[var(--quota-critical)]/30'
                : 'bg-[var(--quota-warning-wash)] text-[var(--quota-warning-text)] border border-[var(--quota-warning)]/30'
            }`}
          >
            {alertText}
          </span>
        )}
      </div>

      <div className={`mt-2.5 flex items-baseline leading-none ${numberColor}`}>
        <span className="text-[36px] font-bold tracking-[-0.035em] tabular-nums">
          {remaining != null ? remaining : NO_DATA}
        </span>
        <span className="text-[19px] font-semibold ml-0.5">%</span>
      </div>
      <div className={`mt-1 text-[12px] font-normal ${mutedText}`}>5 小时剩余</div>

      {/* 时间信息固定成两列，避免状态长文案撑乱三张卡 */}
      <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 min-w-0">
        <span className={`text-[12px] font-normal truncate ${mutedText}`}>{resetText}</span>
        <span className={`text-[12px] font-normal tabular-nums text-right ${sevenDayColor}`}>
          7 天 {sevenDay.remaining != null ? `${sevenDay.remaining}%` : NO_DATA}
        </span>
        {data.status === 'running' && data.currentToolName && (
          <span className={`col-span-2 inline-flex items-center gap-1 text-[12px] font-normal truncate ${mutedText}`}>
            <ArrowRight className="w-3 h-3 shrink-0" />运行 {data.currentToolName}
          </span>
        )}
      </div>
    </div>
  );
};
