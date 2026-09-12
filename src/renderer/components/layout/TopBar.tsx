import React from 'react';
import { Minus, Square, X } from 'lucide-react';
import type { MinibarState } from '../../../common/types';
import { SUPPORTED_AGENTS, isAgentDetected } from '../pulse/AgentSection';

export interface TopBarProps {
  /** 由 App 层唯一一份 useQuotaState 注入，避免重复订阅/轮询 */
  state: MinibarState | null;
  updatedAt: Date | null;
  lastError?: Error | string | null;
}

export const TopBar: React.FC<TopBarProps> = ({ state, updatedAt, lastError }) => {
  const handleMinimize = () => {
    (window as any).pulse?.minimizeWindow?.();
  };

  const handleMaximize = () => {
    (window as any).pulse?.maximizeWindow?.();
  };

  const handleClose = () => {
    (window as any).pulse?.closeWindow?.();
  };

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
    <header
      className="titlebar-drag h-[44px] shrink-0 bg-[var(--bg-surface)] border-b border-[var(--border-strong)] flex items-center justify-between px-4 select-none transition-colors duration-200"
    >
      {/* 左侧状态行：接入 Agent 数 + 更新时刻 */}
      <div className="flex items-center gap-2 min-w-0" title={statusTitle}>
        <span className={`w-1.5 h-1.5 rounded-full ${dotClass} shrink-0`} />
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">
          {agentCount} 个 Agent 已接入
        </span>
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">
          · {isErr ? `上次收到快照 ${timeText} (拉取异常)` : `收到快照 ${timeText}`}
        </span>
      </div>

      {/* 右侧窗口三联按钮 */}
      <div className="flex items-center no-drag">
        <button
          onClick={handleMinimize}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-xs"
          title="最小化"
          aria-label="最小化"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-xs"
          title="最大化"
          aria-label="最大化"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          onClick={handleClose}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-[var(--status-error)] rounded-lg transition-colors text-xs"
          title="关闭"
          aria-label="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};