import React, { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import type { MinibarState } from '../../../common/types';
import { SUPPORTED_AGENTS, isAgentDetected } from '../pulse/AgentSection';

export const TopBar: React.FC = () => {
  const handleMinimize = () => {
    (window as any).pulse?.minimizeWindow?.();
  };

  const handleMaximize = () => {
    (window as any).pulse?.maximizeWindow?.();
  };

  const handleClose = () => {
    (window as any).pulse?.closeWindow?.();
  };

  // 状态行数据：已检测 Agent 数量 + 最近一次更新时刻（复用 minibar 配额/会话数据源）
  const [minibarState, setMinibarState] = useState<MinibarState | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (!window.codeisland) return;
    let alive = true;

    window.codeisland.getMinibarState?.().then((s) => {
      if (alive && s) {
        setMinibarState(s);
        setUpdatedAt(new Date());
      }
    });

    const unsub = window.codeisland.onMinibarState?.((s) => {
      if (alive && s) {
        setMinibarState(s);
        setUpdatedAt(new Date());
      }
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const sessions = minibarState?.sessions ?? [];
  const quotas = minibarState?.quotas;
  const agentCount = SUPPORTED_AGENTS.filter((k) =>
    isAgentDetected(k, sessions, quotas ? quotas[k] : null)
  ).length;
  const timeText = updatedAt
    ? updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <header className="h-[44px] shrink-0 rounded-[18px] bg-[var(--bg-surface)] flex items-center justify-between px-4 select-none transition-colors duration-200">
      {/* 左侧状态行：接入 Agent 数 + 更新时刻 */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--status-success)] shrink-0" />
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">
          {agentCount} 个 Agent 已接入
        </span>
        <span className="text-[11px] text-[var(--text-muted)] tabular-nums">· {timeText} 更新</span>
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
