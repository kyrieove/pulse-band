import React from 'react';
import { Bot, Info } from 'lucide-react';

export const AgentSection: React.FC = () => {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          AI Agent 状态与额度
        </h3>
        <span className="text-[11px] text-[var(--text-muted)]">
          数据驱动模型
        </span>
      </div>

      {/* 视觉骨架卡片：空状态占位，杜绝伪造假数据 */}
      <div className="p-8 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-dashed border-[var(--border-strong)] text-center space-y-3 transition-colors duration-200">
        <div className="w-10 h-10 mx-auto rounded-full bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-muted)]">
          <Bot className="w-5 h-5" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            尚未检测到活跃的 AI Agent
          </p>
          <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed">
            Pulse 2.0 支持 Claude Code、Codex CLI 等 Agent。启动本地会话后，真实运行状态与额度将在此自动呈现。
          </p>
        </div>
        <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-sm)] bg-[var(--bg-app)] text-[11px] text-[var(--text-secondary)]">
          <Info className="w-3 h-3 text-[var(--text-muted)]" />
          <span>骨架阶段：无假额度、无 Mock 数据</span>
        </div>
      </div>
    </section>
  );
};
