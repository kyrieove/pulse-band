import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, X, Activity } from 'lucide-react';
import type { MinibarState, AgentKind, AgentSession } from '../../../common/types';

interface AgentConfig {
  key: AgentKind;
  label: string;
  shortLabel: string;
  color: string;
  grad: [string, string];
}

// 仅保留 Claude、Codex、Antigravity（按用户要求已完全剔除 zcode）
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
    label: 'Codex (CLI)',
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

export const MiniBar: React.FC = () => {
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
        className="w-full h-full flex items-center justify-between px-3 rounded-full apple-glass-pill drag-region select-none transition-all duration-300 relative overflow-hidden"
        onDoubleClick={handleToggle}
      >
        {/* 顶部高光镜面发丝 */}
        <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/40 to-transparent pointer-events-none" />

        {/* 左侧：运行状态小岛 */}
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          {activeSession ? (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full bg-[#30d158] shadow-[0_0_10px_#30d158] animate-pulse shrink-0" />
              <span className="text-[11px] font-semibold text-white/95 uppercase tracking-tight truncate max-w-[60px]">
                {activeSession.agent}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-white/40 shadow-[0_0_4px_rgba(255,255,255,0.4)] shrink-0" />
              <span className="text-[11px] font-medium text-white/50">Idle</span>
            </div>
          )}
        </div>

        {/* 中间：3 Agent 磨砂玻璃胶囊微标 */}
        <div className="flex items-center gap-1.5 shrink-0">
          {AGENT_CONFIGS.map((cfg) => {
            const q = quotas ? (quotas as any)[cfg.key] : null;
            const pct = q?.pct5h;
            return (
              <div
                key={cfg.key}
                className="apple-glass-badge rounded-full px-2.5 py-0.5 flex items-center gap-1.5 text-[10px] font-mono leading-none transition-all"
                title={`${cfg.label}: ${pct != null ? `${pct}%` : '--'}${!q?.authoritative ? ' (本地估算)' : ''}`}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{
                    backgroundColor: cfg.color,
                    boxShadow: `0 0 6px ${cfg.color}aa`,
                  }}
                />
                <span className="text-white/70 font-medium">{cfg.shortLabel}</span>
                <span className="text-white font-semibold tabular-nums">
                  {pct != null ? `${pct}%` : '--'}
                </span>
              </div>
            );
          })}
        </div>

        {/* 右侧：苹果风圆形微按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleToggle}
            className="no-drag w-6 h-6 rounded-full bg-white/[0.08] hover:bg-white/[0.22] active:scale-90 border border-white/[0.12] text-white/70 hover:text-white flex items-center justify-center transition-all shadow-sm"
            title="展开详细卡片"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="no-drag w-6 h-6 rounded-full bg-white/[0.08] hover:bg-rose-500/30 active:scale-90 border border-white/[0.12] text-white/70 hover:text-rose-300 flex items-center justify-center transition-all shadow-sm"
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
      className="w-full h-full flex flex-col justify-between p-3 rounded-3xl apple-glass-card drag-region select-none transition-all duration-300 relative overflow-hidden"
      onDoubleClick={handleToggle}
    >
      {/* 顶部镜面高光反射 */}
      <div className="absolute inset-x-0 top-0 h-[1px] bg-gradient-to-r from-transparent via-white/50 to-transparent pointer-events-none" />

      {/* 顶部标题栏 */}
      <div className="flex items-center justify-between shrink-0 pb-1.5 border-b border-white/[0.12]">
        <div className="flex items-center gap-2 min-w-0">
          {activeSession ? (
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-2 h-2 rounded-full bg-[#30d158] shadow-[0_0_10px_#30d158] animate-pulse shrink-0" />
              <span className="text-xs font-semibold text-white tracking-wide">
                {activeSession.agent.toUpperCase()}
              </span>
              <span className="text-[11px] text-white/60 font-mono truncate max-w-[150px]">
                {activeSession.currentTool?.name ? `· ${activeSession.currentTool.name}` : '· 运行中'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-white/60" />
              <span className="text-xs font-semibold text-white/90">Pulse 悬浮监控</span>
              <span className="text-[10px] text-white/50 font-mono border border-white/10 px-1 rounded-full">3 Agents</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={handleToggle}
            className="no-drag w-6 h-6 rounded-full bg-white/[0.08] hover:bg-white/[0.22] active:scale-90 border border-white/[0.12] text-white/70 hover:text-white flex items-center justify-center transition-all shadow-sm"
            title="折叠为迷你胶囊"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleClose}
            className="no-drag w-6 h-6 rounded-full bg-white/[0.08] hover:bg-rose-500/30 active:scale-90 border border-white/[0.12] text-white/70 hover:text-rose-300 flex items-center justify-center transition-all shadow-sm"
            title="隐藏悬浮窗"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* 3 Agent 额度详细卡片 */}
      <div className="flex-1 flex flex-col justify-around py-1.5 space-y-1.5">
        {AGENT_CONFIGS.map((cfg) => {
          const q = quotas ? (quotas as any)[cfg.key] : null;
          const isCurrentActive = activeSession?.agent === cfg.key;
          const pct5h = q?.pct5h ?? 0;
          const pct7d = q?.pct7d ?? 0;
          const r5 = shortReset(q?.resetText);
          const r7 = shortReset(q?.reset7dText);

          return (
            <div
              key={cfg.key}
              className={`p-2.5 rounded-2xl apple-glass-subcard transition-all ${
                isCurrentActive ? 'border-white/30 bg-white/[0.10] shadow-md' : ''
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
                  <span className="font-semibold text-white/95 text-[11px]">{cfg.label}</span>
                  {!q?.authoritative && (
                    <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 font-mono border border-amber-500/30">
                      ~EST
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2.5 font-mono text-[10px] tabular-nums">
                  <span className="text-white/80">
                    5h: <strong className="text-white font-semibold">{q?.pct5h != null ? `${q.pct5h}%` : '--'}</strong>
                    {r5 && <span className="text-white/40 ml-0.5">({r5})</span>}
                  </span>
                  <span className="text-white/60">
                    7d: <strong className="text-white/90 font-semibold">{q?.pct7d != null ? `${q.pct7d}%` : '--'}</strong>
                    {r7 && <span className="text-white/40 ml-0.5">({r7})</span>}
                  </span>
                </div>
              </div>

              {/* 苹果风平滑渐变进度槽（左 5h 专属渐变，右 7d 蓝青渐变） */}
              <div className="grid grid-cols-2 gap-2">
                <div className="w-full h-1.5 bg-black/30 rounded-full overflow-hidden border border-white/[0.06] p-[0.5px]">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, pct5h)}%`,
                      background: `linear-gradient(to right, ${cfg.grad[0]}, ${cfg.grad[1]})`,
                      boxShadow: `0 0 8px ${cfg.color}66`,
                    }}
                  />
                </div>
                <div className="w-full h-1.5 bg-black/30 rounded-full overflow-hidden border border-white/[0.06] p-[0.5px]">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.min(100, pct7d)}%`,
                      background: 'linear-gradient(to right, #0077b6, #00b4d8)',
                      boxShadow: '0 0 8px rgba(0, 180, 216, 0.4)',
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MiniBar;
