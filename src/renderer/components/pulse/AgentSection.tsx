import React from 'react';
import { Bot } from 'lucide-react';
import type { AgentSession, MinibarState } from '../../../common/types';
import { useQuotaState } from '../../hooks/useQuotaState';
import type { AgentQuota } from '../../../main/services/quota-collector';
import {
  AgentCard,
  type AgentCardData,
  type AgentStatusType,
  type ExtendedQuotaItem,
  type QuotaWindow,
  toRemainingPercent,
  resolveQuotaStatus,
} from './AgentCard';

export const SUPPORTED_AGENTS = ['claude', 'codex', 'antigravity'] as const;
export type SupportedAgent = typeof SUPPORTED_AGENTS[number];

const AGENT_DISPLAY_NAMES: Record<SupportedAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
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

export interface AgentSectionProps {
  /** 由上层注入共享数据源；不传时回退到自己的一份 useQuotaState */
  state?: MinibarState | null;
  loading?: boolean;
}

/** 骨架卡：结构、行数、间距与 AgentCard 完全一致，各行替换为灰色条，无任何文字或数字 */
const AgentCardSkeleton: React.FC = () => (
  <div className="relative p-3.5 rounded-[10px] bg-[var(--bg-subtle)] animate-pulse select-none">
    {/* 1. 顶部 Logo 与标题行 */}
    <div className="flex items-center gap-2">
      <div className="w-[18px] h-[18px] rounded-full bg-[var(--border-strong)] shrink-0" />
      <div className="h-[14px] w-20 rounded bg-[var(--border-strong)]" />
    </div>

    {/* 2. 36px 额度数字行 */}
    <div className="mt-2.5 flex items-baseline leading-none">
      <div className="h-[36px] w-16 rounded bg-[var(--border-strong)]" />
    </div>

    {/* 3. 副标题行 */}
    <div className="mt-1">
      <div className="h-[12px] w-14 rounded bg-[var(--border-strong)]" />
    </div>

    {/* 4. 双列元信息行 */}
    <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 min-w-0">
      <div className="h-[11px] w-24 rounded bg-[var(--border-strong)]" />
      <div className="h-[11px] w-12 rounded bg-[var(--border-strong)]" />
    </div>
  </div>
);

interface AgentSectionContentProps {
  minibarState: MinibarState | null;
  isLoading: boolean;
}

const AgentSectionContent: React.FC<AgentSectionContentProps> = ({ minibarState, isLoading }) => {
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

    // 双周期额度：pct5h/pct7d 是"已使用"百分比，统一转换为"剩余"。
    // 缺失即 null，界面显示 --，绝不补成 0%/100%。
    const fiveHour: QuotaWindow = {
      remaining: toRemainingPercent(q?.pct5h),
      resetText: q?.resetText?.trim() ? q.resetText : null,
      status: resolveQuotaStatus(q?.level5h, q?.pct5h),
    };
    const sevenDay: QuotaWindow = {
      remaining: toRemainingPercent(q?.pct7d),
      resetText: q?.reset7dText ?? null,
      status: resolveQuotaStatus(q?.level7d, q?.pct7d),
    };

    // 卡片整体告警取两个周期中更严重的一个，避免 7 天已濒危而卡片仍显示正常
    const severity = (s: QuotaWindow['status']): number =>
      s === 'critical' ? 2 : s === 'warning' ? 1 : 0;
    const worst = severity(fiveHour.status) >= severity(sevenDay.status) ? fiveHour : sevenDay;
    const quotaStatus = worst.status;

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

    // 展开区只放额度以外的补充信息（额度本身不再藏在详情里）
    const extendedQuotas: ExtendedQuotaItem[] = [];
    if (q?.used5h != null && q?.limit5h != null) {
      extendedQuotas.push({ label: '5 小时用量', value: `${q.used5h} / ${q.limit5h}` });
    }
    if (q?.used7d != null && q?.limit7d != null) {
      extendedQuotas.push({ label: '7 天用量', value: `${q.used7d} / ${q.limit7d}` });
    }

    return {
      id: key,
      name: AGENT_DISPLAY_NAMES[key] ?? session?.title ?? key,
      status,
      remainingPercent: fiveHour.remaining,
      primaryQuota: fiveHour.remaining,
      resetTime: fiveHour.resetText,
      fiveHour,
      sevenDay,
      estimated: q != null && q.authoritative === false,
      currentToolName: activeSession?.currentTool?.name ?? null,
      extendedQuotas: extendedQuotas.length > 0 ? extendedQuotas : null,
      quotaStatus,
    };
  });

  // 锚点卡：三张里 5 小时剩余最低者；三张都 >60% 时无锚点。最多一张。
  const anchorId = (() => {
    const with5h = agentList.filter((c) => c.fiveHour?.remaining != null);
    if (with5h.length === 0) return null;
    const lowest = with5h.reduce((a, b) => (a.fiveHour!.remaining! < b.fiveHour!.remaining! ? a : b));
    return (lowest.fiveHour!.remaining ?? 0) > 60 ? null : lowest.id;
  })();

  return (
    <section className="shrink-0">
      {agentList.length > 0 ? (
        <div className="grid grid-cols-3 gap-2.5">
          {agentList.map((agent) => (
            <AgentCard key={agent.id} data={agent} anchor={agent.id === anchorId} />
          ))}
        </div>
      ) : isLoading ? (
        /* 初始数据拉取中：三个和 AgentCard 完全一致结构的占位卡，避免高度跳变 */
        <div className="grid grid-cols-3 gap-2.5">
          {[0, 1, 2].map((i) => (
            <AgentCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        /* 无活跃 Agent 时展示纯净空状态，杜绝任何假数据 */
        <div className="p-8 rounded-[10px] bg-[var(--bg-subtle)] border border-dashed border-[var(--border-strong)] text-center space-y-3 transition-colors duration-200">
          <div className="w-10 h-10 mx-auto rounded-full bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-muted)]">
            <Bot className="w-5 h-5" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">
              尚未检测到活跃或已配置的 AI Agent
            </p>
            <p className="text-xs text-[var(--text-muted)] max-w-sm mx-auto leading-relaxed">
              当本地启动 Claude Code、Codex 或配置额度源后，系统将自动识别并在此呈现，无虚假数据占位。
            </p>
          </div>
        </div>
      )}
    </section>
  );
};

/** 仅在上层未注入 state 时调用的内部子组件，负责挂载自身 hook */
const AgentSectionSelfContained: React.FC<{ loading?: boolean }> = ({ loading }) => {
  const hookResult = useQuotaState();
  return (
    <AgentSectionContent
      minibarState={hookResult.state}
      isLoading={loading ?? hookResult.loading}
    />
  );
};

export const AgentSection: React.FC<AgentSectionProps> = ({ state: propState, loading: propLoading }) => {
  // 收到 state prop（哪怕值是 null）就直接渲染，不调 hook
  if (propState !== undefined) {
    return <AgentSectionContent minibarState={propState} isLoading={propLoading ?? false} />;
  }
  // 未收到 state prop（undefined）时才渲染内部子组件，由它调用 hook 再渲染
  return <AgentSectionSelfContained loading={propLoading} />;
};
