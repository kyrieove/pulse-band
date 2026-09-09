import React, { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { AgentSession, MinibarState } from '../../../common/types';
import type { AgentQuota } from '../../../main/services/quota-collector';
import {
  AgentCard,
  type AgentCardData,
  type AgentStatusType,
  type ExtendedQuotaItem,
  toRemainingPercent,
  resolveQuotaStatus,
} from './AgentCard';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'antigravity'] as const;
export type SupportedAgent = typeof SUPPORTED_AGENTS[number];

const AGENT_DISPLAY_NAMES: Record<SupportedAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity',
};

/**
 * 判定某个 AI Agent 是否被真实检测到
 * 规则：
 * 1. 在 active/recent sessions 中存在该 Agent；或者
 * 2. 在 quotas 中存在对应 key，且具备有效真实数据（非空占位、未失效、具有服务端真实数据或实际使用记录）
 */
export function isAgentDetected(
  agent: SupportedAgent,
  sessions: AgentSession[],
  quota?: AgentQuota | null
): boolean {
  // 条件 1：在 active/recent sessions 中存在该 Agent
  const hasSession = sessions.some((s) => s.agent === agent);
  if (hasSession) return true;

  // 条件 2：在 quotas 中存在对应 key，且具备有效真实数据
  if (!quota || typeof quota !== 'object') return false;
  if (quota.needsAuth === true) return false;

  // 服务端权威认证数据
  if (quota.authoritative === true) return true;

  // 本地兜底或非权威数据：必须存在实际的使用记录或冷却状态，杜绝 0 活跃的初始占位
  const hasRecordedUsage =
    (quota.pct5h != null && quota.pct5h > 0) ||
    (quota.pct7d != null && quota.pct7d > 0) ||
    (quota.used5h != null && quota.used5h > 0) ||
    (quota.used7d != null && quota.used7d > 0);

  if (hasRecordedUsage) return true;

  // 若重置倒计时不是默认初始的 'ready'，说明发生过调用并处于窗口期
  if (quota.resetText && quota.resetText !== 'ready') return true;

  return false;
}

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
  const quotas = minibarState?.quotas;

  // 仅在明确支持的合法 Agent 范围中检测实体，严禁泛化遍历和假阳性
  const detectedKeys = SUPPORTED_AGENTS.filter((key) =>
    isAgentDetected(key, sessions, quotas ? quotas[key] : null)
  );

  // 构建实际检测到的 Agent 列表数据
  const agentList: AgentCardData[] = detectedKeys.map((key) => {
    const q: AgentQuota | null = quotas ? quotas[key] : null;
    const activeSession = sessions.find(
      (s) => s.agent === key && (s.status === 'running_tool' || s.status === 'thinking')
    );
    const session = activeSession ?? sessions.find((s) => s.agent === key);

    // 配额状态与剩余百分比（正确解释 pct5h/pct7d 为已使用百分比，转换为剩余百分比）
    const remainingPercent = toRemainingPercent(q?.pct5h);
    const quotaStatus = resolveQuotaStatus(q?.level5h, q?.pct5h);

    // 运行态优先级最高：如果有正在运行的 session，卡片主状态为 running
    let status: AgentStatusType = 'idle';
    if (activeSession) {
      status = 'running';
    } else if (quotaStatus === 'critical') {
      status = 'critical';
    } else if (quotaStatus === 'warning') {
      status = 'warning';
    } else {
      status = 'idle';
    }

    // 收集真实存在的额外周期额度（展开态明确区分 5 小时与 7 天窗口已使用）
    const extendedQuotas: ExtendedQuotaItem[] = [];
    if (q?.pct5h != null) {
      extendedQuotas.push({
        label: '5 小时窗口已使用',
        value: `${q.pct5h}%`,
      });
    }
    if (q?.pct7d != null) {
      extendedQuotas.push({
        label: '7 天窗口已使用',
        value: `${q.pct7d}%`,
      });
    }
    if (q?.reset7dText) {
      extendedQuotas.push({
        label: '7 天窗口重置',
        value: q.reset7dText,
      });
    }

    return {
      id: key,
      name: AGENT_DISPLAY_NAMES[key] ?? session?.title ?? key,
      status,
      remainingPercent,
      primaryQuota: remainingPercent,
      resetTime: q?.resetText ?? null,
      currentToolName: activeSession?.currentTool?.name ?? null,
      elapsedSeconds: activeSession?.durationSeconds ?? null,
      extendedQuotas: extendedQuotas.length > 0 ? extendedQuotas : null,
      lastUpdatedAt: session?.updatedAt ?? null,
      quotaStatus,
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
