import React from 'react';
import type { MinibarState } from '../../../common/types';
import { SUPPORTED_AGENTS, isAgentDetected } from '../pulse/AgentSection';

export interface StatusBarProps {
  /** 由 App 层唯一一份 useQuotaState 注入，避免重复订阅/轮询 */
  state: MinibarState | null;
  updatedAt: Date | null;
  lastError?: Error | string | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({ state, updatedAt, lastError }) => {
  const sessions = state?.sessions ?? [];
  const quotas = state?.quotas;
  const agentCount = SUPPORTED_AGENTS.filter((k) =>
    isAgentDetected(k, sessions, quotas ? quotas[k] : null)
  ).length;

  const isErr = Boolean(lastError);
  const dotClass =
    isErr
      ? 'bg-[var(--status-error)]'
      : updatedAt !== null && agentCount > 0
      ? 'bg-[var(--status-success)]'
      : 'bg-[var(--status-idle)]';

  const statusTitle = isErr
    ? `拉取快照失败: ${String(lastError)}`
    : updatedAt === null
    ? '未获取到额度数据'
    : `${agentCount} 个 Agent 已接入`;

  // 从未成功取到数据则显示占位符，绝不退化为当前时刻
  const timeText = updatedAt
    ? updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <footer
      className="h-[32px] shrink-0 bg-[var(--bg-surface)] border-t border-[var(--border-strong)] flex items-center justify-between px-4 select-none transition-colors duration-200"
    >
      {/* 状态行：接入 Agent 数 + 更新时刻 */}
      <div className="flex items-center gap-2 min-w-0" title={statusTitle}>
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass} shrink-0`} />
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">
          {agentCount} 个 Agent 已接入
        </span>
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
          · {isErr ? `上次收到快照 ${timeText} (拉取异常)` : `收到快照 ${timeText}`}
        </span>
      </div>
    </footer>
  );
};
