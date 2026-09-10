import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, X, Activity } from 'lucide-react';
import type { MinibarState, AgentKind, AgentSession } from '../../../common/types';
import { toRemainingPercent } from '../pulse/agent-quota-utils';

export interface MiniBarProps {
  theme?: 'light' | 'dark';
  showAgents?: boolean;
}

interface AgentConfig {
  key: AgentKind;
  label: string;
  shortLabel: string;
  color: string;
  grad: [string, string];
}

// 公开支持的三个 Agent：Claude、Codex、Antigravity
const AGENT_CONFIGS: AgentConfig[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    shortLabel: 'Cl',
    color: '#e5a93c',
    grad: ['#d97757', '#ffb703'],
  },
  {
    key: 'codex',
    label: 'Codex',
    shortLabel: 'Cx',
    color: '#30d158',
    grad: ['#1f9d55', '#30d158'],
  },
  {
    key: 'antigravity',
    label: 'Antigravity',
    shortLabel: 'Ag',
    color: '#c77dff',
    grad: ['#5a189a', '#9d4edd'],
  },
];

const shortReset = (t?: string | null): string => {
  if (!t) return '';
  return t.split(' · ')[0].trim();
};

export const MiniBar: React.FC<MiniBarProps> = ({ theme = 'light', showAgents = true }) => {
  const [state, setState] = useState<MinibarState | null>(null);

  useEffect(() => {
    if (!window.codeisland) return;
    let alive = true;

    window.codeisland.getMinibarState?.().then((s) => {
      if (alive && s) setState(s);
    });

    const unsub = window.codeisland.onMinibarState?.((s) => {
      if (alive && s) setState(s);
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const isExpanded = state?.isExpanded ?? false;
  const sessions: AgentSession[] = state?.sessions ?? [];
  const quotas = state?.quotas;

  // 识别活跃会话（运行工具优先，其次思考）
  const activeSession =
    sessions.find((s) => s.status === 'running_tool') ||
    sessions.find((s) => s.status === 'thinking');

  const handleToggle = () => {
    window.codeisland?.toggleMinibarExpanded?.();
  };

  const handleClose = () => {
    window.codeisland?.closeMinibar?.();
  };

  // 1. 折叠胶囊态 (340 x 44px) · 苹果毛玻璃胶囊风格
  if (!isExpanded) {
    return (
      <div
        data-theme={theme}
        className={`w-full h-full flex items-center justify-between px-3 rounded-full apple-glass-pill drag-region select-none transition-all duration-300 relative overflow-hidden ${
          theme === 'dark' ? 'dark' : ''
        }`}
        onDoubleClick={handleToggle}
      >
        {/* 顶部高光镜面发丝 */}
        <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/80 dark:via-white/40 to-transparent pointer-events-none" />

        {/* 左侧：运行状态小岛 */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          {activeSession ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-[var(--status-success)] shadow-[0_0_10px_var(--status-success)] animate-pulse shrink-0" />
              <span className="text-[11px] font-semibold text-[var(--text-primary)] uppercase tracking-tight truncate max-w-[60px]">
                {activeSession.agent}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-muted)] opacity-50 shrink-0" />
              <span className="text-[11px] font-medium text-[var(--text-muted)]">Idle</span>
            </div>
          )}
        </div>

        {/* 中间：3 Agent 磨砂玻璃胶囊微标（预留 showAgents 配置控制） */}
        {showAgents && (
          <div className="flex items-center gap-1.5 shrink-0">
            {AGENT_CONFIGS.map((cfg) => {
              const q = quotas ? quotas[cfg.key] : null;
              const remaining5h = toRemainingPercent(q?.pct5h);
              const remaining7d = toRemainingPercent(q?.pct7d);
              const tooltip =
                remaining5h != null || remaining7d != null
                  ? `${cfg.label}:\n5小时剩余 ${remaining5h != null ? `${remaining5h}%` : '--'}\n7天剩余 ${remaining7d != null ? `${remaining7d}%` : '--'}${!q?.authoritative ? '\n(本地估算)' : ''}`
                  : `${cfg.label}: 暂无额度数据`;

              return (
                <div
                  key={cfg.key}
                  className="apple-glass-badge rounded-full px-2.5 py-0.5 flex items-center gap-1.5 text-[10px] font-mono leading-none transition-all"
                  title={tooltip}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{
                      backgroundColor: cfg.color,
                      boxShadow: `0 0 6px ${cfg.color}aa`,
                    }}
                  />
                  <span className="text-[var(--text-secondary)] font-medium">{cfg.shortLabel}</span>
                  {/* 5h / 7d 两个周期在收起态也同时可见，且带周期标签避免数字含义不明 */}
                  <span className="text-[var(--text-muted)]">5h</span>
                  <span className="text-[var(--text-primary)] font-semibold tabular-nums">
                    {remaining5h != null ? `${remaining5h}%` : '--'}
                  </span>
                  <span className="text-[var(--text-muted)]">7d</span>
                  <span className="text-[var(--text-primary)] font-semibold tabular-nums">
                    {remaining7d != null ? `${remaining7d}%` : '--'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* 右侧：苹果风微按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleToggle}
            className="no-drag w-6 h-6 rounded-full bg-[var(--border-default)] hover:bg-[var(--border-strong)] active:scale-90 border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-all shadow-sm"
            title="展开详细卡片"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="no-drag w-6 h-6 rounded-full bg-[var(--border-default)] hover:bg-rose-500/20 active:scale-90 border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-rose-500 flex items-center justify-center transition-all shadow-sm"
            title="隐藏悬浮条（可在 Pulse PC 端随时重新开启）"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  // 2. 展开卡片态 (340 x 240px) · 苹果毛玻璃卡片风格
  return (
    <div
      data-theme={theme}
      className={`w-full h-full flex flex-col justify-between p-3 rounded-3xl apple-glass-card drag-region select-none transition-all duration-300 relative overflow-hidden ${
        theme === 'dark' ? 'dark' : ''
      }`}
      onDoubleClick={handleToggle}
    >
      {/* 顶部镜面高光反射 */}
      <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/80 dark:via-white/50 to-transparent pointer-events-none" />

      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between shrink-0 pb-1.5 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2 min-w-0">
          {activeSession ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-[var(--status-success)] shadow-[0_0_10px_var(--status-success)] animate-pulse shrink-0" />
              <span className="text-xs font-semibold text-[var(--text-primary)] tracking-wide">
                {activeSession.agent.toUpperCase()}
              </span>
              <span className="text-[11px] text-[var(--text-muted)] font-mono truncate max-w-[150px]">
                {activeSession.currentTool?.name ? `· ${activeSession.currentTool.name}` : '· 运行中'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span className="text-xs font-semibold text-[var(--text-primary)]">Pulse 悬浮监控</span>
              <span className="text-[10px] text-[var(--text-muted)] font-mono border border-[var(--border-default)] px-1 rounded-full">
                {showAgents ? '3 Agents' : '0 Agents'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleToggle}
            className="no-drag w-6 h-6 rounded-full bg-[var(--border-default)] hover:bg-[var(--border-strong)] active:scale-90 border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center justify-center transition-all shadow-sm"
            title="折叠为迷你胶囊"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="no-drag w-6 h-6 rounded-full bg-[var(--border-default)] hover:bg-rose-500/20 active:scale-90 border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-rose-500 flex items-center justify-center transition-all shadow-sm"
            title="隐藏悬浮窗"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 3 Agent 额度详细卡片 */}
      <div className="flex-1 flex flex-col justify-around py-1.5 space-y-1.5">
        {showAgents ? (
          AGENT_CONFIGS.map((cfg) => {
            const q = quotas ? quotas[cfg.key] : null;
            const isCurrentActive = activeSession?.agent === cfg.key;
            // 两个周期统一"剩余"口径；缺失即 null，显示 -- 且不画进度条（绝不补 0）
            const remaining5h = toRemainingPercent(q?.pct5h);
            const remaining7d = toRemainingPercent(q?.pct7d);
            const r5 = shortReset(q?.resetText);
            const r7 = shortReset(q?.reset7dText);

            return (
              <div
                key={cfg.key}
                className={`p-2.5 rounded-2xl apple-glass-subcard transition-all ${
                  isCurrentActive ? 'border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 shadow-md' : ''
                }`}
              >
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{
                        backgroundColor: cfg.color,
                        boxShadow: `0 0 8px ${cfg.color}bb`,
                      }}
                    />
                    <span className="font-semibold text-[var(--text-primary)] text-[11px]">{cfg.label}</span>
                    {!q?.authoritative && (
                      <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-mono border border-amber-500/30">
                        ~EST
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2.5 font-mono text-[10px] tabular-nums">
                    <span className="text-[var(--text-secondary)]">
                      5h剩余: <strong className="text-[var(--text-primary)] font-semibold">{remaining5h != null ? `${remaining5h}%` : '--'}</strong>
                      {r5 && <span className="text-[var(--text-muted)] ml-0.5">({r5})</span>}
                    </span>
                    <span className="text-[var(--text-secondary)]">
                      7d剩余: <strong className="text-[var(--text-primary)] font-semibold">{remaining7d != null ? `${remaining7d}%` : '--'}</strong>
                      {r7 && <span className="text-[var(--text-muted)] ml-0.5">({r7})</span>}
                    </span>
                  </div>
                </div>

                {/* 苹果风平滑渐变进度槽：5h / 7d 各一条，无数据时不填充 */}
                <div className="grid grid-cols-2 gap-2">
                  <div
                    className="w-full h-1.5 bg-black/10 dark:bg-black/30 rounded-full overflow-hidden border border-[var(--border-default)] p-[0.5px]"
                    title={`5小时剩余额度: ${remaining5h != null ? `${remaining5h}%` : '--'}`}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, Math.max(0, remaining5h ?? 0))}%`,
                        background: `linear-gradient(to right, ${cfg.grad[0]}, ${cfg.grad[1]})`,
                        boxShadow: `0 0 8px ${cfg.color}66`,
                      }}
                    />
                  </div>
                  <div
                    className="w-full h-1.5 bg-black/10 dark:bg-black/30 rounded-full overflow-hidden border border-[var(--border-default)] p-[0.5px]"
                    title={`7天剩余额度: ${remaining7d != null ? `${remaining7d}%` : '--'}`}
                  >
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.min(100, Math.max(0, remaining7d ?? 0))}%`,
                        background: 'linear-gradient(to right, #0077b6, #00b4d8)',
                        boxShadow: '0 0 8px rgba(0, 180, 216, 0.4)',
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="py-6 text-center text-xs text-[var(--text-muted)]">
            Agent 显示已关闭
          </div>
        )}
      </div>
    </div>
  );
};

export default MiniBar;
