import React, { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { AgentSession, MinibarState } from '../../../common/types';
import { AgentCard, type AgentCardData, type AgentStatusType } from './AgentCard';

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity',
};

export const AgentSection: React.FC = () => {
  const [minibarState, setMinibarState] = useState<MinibarState | null>(null);

  // 仅订阅已有的数据来源 (window.codeisland)
  useEffect(() => {
    if (!window.codeisland) return;
    let alive = true;

    window.codeisland.getMinibarState?.().then((s) => {
      if (alive && s) setMinibarState(s);
    });

    const unsub = window.codeisland.onMinibarState?.((s) => {
      if (alive && s) setMinibarState(s);
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const sessions: AgentSession[] = minibarState?.sessions ?? [];
  const quotas: any = minibarState?.quotas;

  // 严格基于真实数据提取已检测到的 Agent（绝不硬编码列表，绝不造假）
  const detectedKeys = new Set<string>();

  // 1. 从会话流识别已激活的 Agent
  sessions.forEach((s) => {
    if (s.agent) detectedKeys.add(s.agent);
  });

  // 2. 从已有配额快照识别有真实返回数据的 Agent
  if (quotas && typeof quotas === 'object') {
    Object.keys(quotas).forEach((key) => {
      const q = quotas[key];
      if (q && (q.pct5h != null || q.pct7d != null || q.resetText)) {
        detectedKeys.add(key);
      }
    });
  }

  // 构建实际检测到的 Agent 列表数据
  const agentList: AgentCardData[] = Array.from(detectedKeys).map((key) => {
    const q = quotas ? quotas[key] : null;
    const activeSession = sessions.find(
      (s) => s.agent === key && (s.status === 'running_tool' || s.status === 'thinking')
    );
    const session = activeSession ?? sessions.find((s) => s.agent === key);

    // 计算状态
    let status: AgentStatusType = 'idle';
    if (activeSession) {
      status = 'running';
    } else if (q?.pct5h != null) {
      if (q.pct5h <= 5) status = 'critical';
      else if (q.pct5h <= 20) status = 'warning';
      else status = 'idle';
    }

    // 收集真实存在的额外周期额度
    const extendedQuotas = [];
    if (q?.pct7d != null) {
      extendedQuotas.push({ label: '7 天滑动窗口额度', value: `${q.pct7d}%` });
    }

    return {
      id: key,
      name: AGENT_DISPLAY_NAMES[key] ?? session?.title ?? key,
      status,
      primaryQuota: q?.pct5h ?? null,
      resetTime: q?.resetText ?? null,
      currentToolName: activeSession?.currentTool?.name ?? null,
      elapsedSeconds: activeSession?.durationSeconds ?? null,
      extendedQuotas: extendedQuotas.length > 0 ? extendedQuotas : null,
      lastUpdatedAt: session?.updatedAt ?? null,
    };
  });

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          AI Agent 状态与额度
        </h3>
        <span className="text-[11px] text-[var(--text-muted)]">
          数据驱动 · 仅展示已检测实体
        </span>
      </div>

      {agentList.length > 0 ? (
        <div className="space-y-3">
          {agentList.map((agent) => (
            <AgentCard key={agent.id} data={agent} />
          ))}
        </div>
      ) : (
        /* 无活跃 Agent 时展示纯净空状态，杜绝任何假数据 */
        <div className="p-8 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-dashed border-[var(--border-strong)] text-center space-y-3 transition-colors duration-200">
          <div className="w-10 h-10 mx-auto rounded-full bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-muted)]">
            <Bot className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              尚未检测到活跃或已配置的 AI Agent
            </p>
            <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed">
              当本地启动 Claude Code、Codex CLI 或配置额度源后，系统将自动识别并在此呈现，无虚假数据占位。
            </p>
          </div>
        </div>
      )}
    </section>
  );
};
