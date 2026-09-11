import React, { useEffect, useState, useRef, useCallback } from 'react';
import { X, Pin, PinOff, Sliders, EyeOff, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import type { MinibarState, AgentKind, AgentSession } from '../../../common/types';
import { toRemainingPercent, parseResetTimeInfo } from '../pulse/agent-quota-utils';
import { AgentLogo } from '../pulse/AgentLogo';

export interface MiniBarProps {
  theme?: 'light' | 'dark';
  showAgents?: boolean;
}

interface AgentConfig {
  key: AgentKind;
  name: string;
  fullName: string;
  color: string;
  grad: [string, string];
  /** 圆环中心在侧栏内的 Y 坐标（用于详情卡尖角精确水平对齐） */
  centerY: number;
}

const AGENT_CONFIGS: AgentConfig[] = [
  {
    key: 'claude',
    name: 'Claude',
    fullName: 'Anthropic Claude Code',
    color: '#E5A93C',
    grad: ['#D97757', '#E5A93C'],
    centerY: 68,
  },
  {
    key: 'codex',
    name: 'Codex',
    fullName: 'OpenAI Codex CLI',
    color: '#30D158',
    grad: ['#10A37F', '#30D158'],
    centerY: 160,
  },
  {
    key: 'antigravity',
    name: 'Antigravity',
    fullName: 'Google Antigravity',
    color: '#C77DFF',
    grad: ['#8B5CF6', '#C77DFF'],
    centerY: 252,
  },
];

const DEFAULT_BG_OPACITY = 0.94;
const OPACITY_STORAGE_KEY = 'pulse_minibar_bg_opacity';

export const MiniBar: React.FC<MiniBarProps> = ({ theme = 'dark' }) => {
  const [state, setState] = useState<MinibarState | null>(null);
  const [hoveredAgent, setHoveredAgent] = useState<AgentKind | null>(null);
  const [pinnedAgent, setPinnedAgent] = useState<AgentKind | null>(null);

  // 详情卡挂载与动画解耦状态（彻底解决窗口提前缩小导致的硬件裁剪闪退）
  const [mountedAgent, setMountedAgent] = useState<AgentKind | null>(null);
  const [cardVisible, setCardVisible] = useState(false);

  // 背景不透明度状态 (35% ~ 100%)，仅作用于背景色，文字和图标保持 100% 锐利
  const [bgOpacity, setBgOpacity] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(OPACITY_STORAGE_KEY);
      if (saved) {
        const val = parseFloat(saved);
        if (!Number.isNaN(val) && val >= 0.35 && val <= 1) {
          return val;
        }
      }
    } catch {
      // 忽略读取异常
    }
    return DEFAULT_BG_OPACITY;
  });

  // 右键上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  }>({
    visible: false,
    x: 0,
    y: 0,
  });

  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const leaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);
  const opacitySaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 边缘标签拖拽防误触参考（位移 >4px 判定为拖拽）
  const tabDragRef = useRef<{ startX: number; startY: number; moved: boolean }>({
    startX: 0,
    startY: 0,
    moved: false,
  });
  // 手动拖拽进行中标记：用于松手/失焦时上报主进程吸附
  const draggingRef = useRef(false);

  // 吸附方向与显示模式
  const dockSide = state?.dockSide ?? 'right';
  const isLeftDock = dockSide === 'left';
  const isHorizontal = dockSide === 'top' || dockSide === 'bottom';
  const dockAtTop = dockSide === 'top';
  const isEdgeTab = state?.displayMode === 'edge-tab';

  // 当前逻辑目标 Agent（固定态优先，其次悬停态）
  const targetAgent = pinnedAgent || hoveredAgent;

  // 订阅真实数据源推送
  useEffect(() => {
    if (!window.codeisland) return;
    let alive = true;

    window.codeisland.getMinibarState?.().then((s) => {
      if (alive && s) setState(s);
    });

    const unsub = window.codeisland.onMinibarState?.((s) => {
      if (alive && s) setState(s as MinibarState);
    });

    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  // 向主进程同步物理窗口展开/收缩几何
  const syncExpandedToMain = useCallback((expanded: boolean) => {
    if (window.codeisland?.setMinibarExpanded) {
      window.codeisland.setMinibarExpanded(expanded);
    } else if (window.codeisland?.toggleMinibarExpanded && state?.isExpanded !== expanded) {
      window.codeisland.toggleMinibarExpanded();
    }
  }, [state?.isExpanded]);

  // 背景不透明度调节（35% - 100%），防抖 500ms 持久化到 localStorage
  const handleOpacityChange = (newOpacity: number) => {
    const clamped = Math.max(0.35, Math.min(1, Math.round(newOpacity * 100) / 100));
    setBgOpacity(clamped);
    if (opacitySaveTimerRef.current) {
      clearTimeout(opacitySaveTimerRef.current);
    }
    opacitySaveTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(OPACITY_STORAGE_KEY, clamped.toString());
      } catch {
        // 忽略存储错误
      }
    }, 500);
  };

  // 动画状态机：根据 targetAgent 控制卡片挂载与淡入淡出动画
  // （物理窗口展开与否统一由下方单一来源 effect 决定，卡片与菜单共用一套扩宽/收起逻辑）
  useEffect(() => {
    if (isEdgeTab) {
      // 边缘标签模式下收起并卸载卡片
      if (mountedAgent) {
        setMountedAgent(null);
        setCardVisible(false);
      }
      return;
    }

    if (targetAgent) {
      // 目标存在：立即取消正在进行的退出倒计时
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      // 若卡片尚未挂载，先挂载卡片并触发淡入
      if (!mountedAgent) {
        setMountedAgent(targetAgent);
        const raf = requestAnimationFrame(() => {
          setCardVisible(true);
        });
        return () => cancelAnimationFrame(raf);
      } else {
        // 卡片已挂载（在不同 Agent 之间切换）：直接切换内容，保持展开，不闪烁
        setMountedAgent(targetAgent);
        setCardVisible(true);
      }
    } else if (mountedAgent) {
      // 目标消失且卡片当前仍挂载：先触发 CSS 优雅淡出，动画结束后才卸载 DOM
      setCardVisible(false);
      closeTimerRef.current = setTimeout(() => {
        setMountedAgent(null);
        closeTimerRef.current = null;
      }, 160); // 160ms 优雅淡出动画时长
    }
  }, [targetAgent, mountedAgent, isEdgeTab]);

  // 物理窗口展开/收起单一来源：卡片挂载或右键菜单打开即扩宽，二者都关闭才收起。
  useEffect(() => {
    syncExpandedToMain(!isEdgeTab && (!!mountedAgent || contextMenu.visible));
  }, [mountedAgent, contextMenu.visible, isEdgeTab, syncExpandedToMain]);

  // 清理所有定时器
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      if (opacitySaveTimerRef.current) clearTimeout(opacitySaveTimerRef.current);
    };
  }, []);

  // 关闭右键上下文菜单
  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => {
      if (!prev.visible) return prev;
      return { ...prev, visible: false };
    });
  }, []);

  // 右键上下文菜单生命周期与多通道关闭逻辑
  useEffect(() => {
    if (!contextMenu.visible) return;

    // 1. 宿主窗口失焦时自动关闭（例如用户点击其他桌面应用、任务栏或桌面）
    const unsubBlur = window.codeisland?.onWindowBlur?.(() => {
      closeContextMenu();
    });

    // 2. 指针事件捕获阶段拦截：
    //    - 点击在菜单内部（如拖动背景不透明度滑块），正常放行
    //    - 点击在菜单外部，立即关闭菜单；若是鼠标右键，阻断冒泡防止在同一次操作中原地重开
    const handleCapturePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.minibar-context-menu')) {
        return;
      }
      closeContextMenu();
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // 3. 全局 Esc 快捷键关闭
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeContextMenu();
      }
    };

    window.addEventListener('pointerdown', handleCapturePointerDown, { capture: true });
    window.addEventListener('keydown', handleGlobalKeyDown);

    return () => {
      unsubBlur?.();
      window.removeEventListener('pointerdown', handleCapturePointerDown, { capture: true });
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [contextMenu.visible, closeContextMenu]);

  // 悬停某个 Agent 圆环
  const handleMouseEnterAgent = (key: AgentKind) => {
    if (contextMenu.visible) return; // 打开菜单时暂停交互抖动
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (pinnedAgent && pinnedAgent !== key) {
      return;
    }
    // 若卡片当前已展开，零延迟快速切换，提升跟手度
    if (mountedAgent && cardVisible) {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
      setHoveredAgent(key);
      return;
    }
    // 若卡片尚未展开，延迟 150ms 确认展开意图，避免划过误触
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setHoveredAgent(key);
    }, 150);
  };

  const handleMouseLeaveAgent = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  // 移出整个交互区域（约 250ms 延迟收起，固定态或右键菜单打开除外）
  const handleContainerMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (contextMenu.visible) {
      // 菜单打开时绝对不自动收起
      return;
    }
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
    }
    leaveTimerRef.current = setTimeout(() => {
      if (!pinnedAgent) {
        setHoveredAgent(null);
      }
    }, 250);
  };

  // 移入卡片或侧栏交互桥时清除收起计时
  const handleInteractiveMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
      setCardVisible(true);
    }
  };

  // 拖拽热区被按下时，立即清空展开态并通知主进程切回纯侧栏尺寸，绝不允许方块悬空拖动
  const handleDragRegionMouseDown = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setContextMenu((prev) => ({ ...prev, visible: false }));
    setPinnedAgent(null);
    setHoveredAgent(null);
    setMountedAgent(null);
    setCardVisible(false);
    draggingRef.current = true;
    window.codeisland?.notifyDragStart?.();
    syncExpandedToMain(false);
  };

  // 手动拖拽结束上报：鼠标松开或窗口失焦时通知主进程停止跟随并吸附
  useEffect(() => {
    const endDrag = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        window.codeisland?.notifyDragEnd?.();
      }
    };
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('blur', endDrag);
    return () => {
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('blur', endDrag);
    };
  }, []);

  // 点击圆环切换固定态
  const handleRingClick = (key: AgentKind) => {
    if (pinnedAgent === key) {
      setPinnedAgent(null);
    } else {
      setPinnedAgent(key);
      setHoveredAgent(key);
    }
  };

  // 键盘 Esc 关闭卡片并取消固定或关闭菜单
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (contextMenu.visible) {
        closeContextMenu();
        return;
      }
      setPinnedAgent(null);
      setHoveredAgent(null);
    }
  };

  const handleClose = () => {
    setPinnedAgent(null);
    setHoveredAgent(null);
    closeContextMenu();
    window.codeisland?.closeMinibar?.();
  };

  // 切换为边缘标签微型模式
  const handleCollapseToEdgeTab = () => {
    setPinnedAgent(null);
    setHoveredAgent(null);
    setMountedAgent(null);
    setCardVisible(false);
    closeContextMenu();
    window.codeisland?.setMinibarDisplayMode?.('edge-tab');
  };

  // 从边缘标签恢复为完整侧栏
  const handleRestoreFromEdgeTab = () => {
    window.codeisland?.setMinibarDisplayMode?.('full');
  };

  // 打开右键上下文菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }

    // 仅在显式右键呼出菜单时通知主进程给予窗口前台焦点，以便响应系统 blur 与 Esc
    // 普通鼠标悬停绝不抢占焦点
    window.codeisland?.notifyMenuOpen?.();

    const rect = containerRef.current?.getBoundingClientRect();
    const relX = rect ? e.clientX - rect.left : e.clientX;
    const relY = rect ? e.clientY - rect.top : e.clientY;

    let menuX: number;
    let menuY: number;
    if (isHorizontal) {
      // 横向：菜单钉在贴近横条的屏幕内侧（顶部吸附时在横条下方，底部吸附时在横条上方）
      menuX = Math.max(8, Math.min(relX - 86, 340 - 172 - 8));
      menuY = dockAtTop ? 86 : 8;
    } else {
      // 竖向：菜单始终钉在侧栏内侧，左侧栏向右展开(x=92)，右侧栏向左展开(x=106)
      const MENU_WIDTH = 172;
      const MENU_HEIGHT = 230;
      const EXPANDED_W = 370;
      const SIDEBAR_W = 80;
      const GAP = 12;
      menuX = isLeftDock
        ? SIDEBAR_W + GAP
        : EXPANDED_W - SIDEBAR_W - MENU_WIDTH - GAP;
      // 纵向跟随右键位置，但夹在窗口内：上限保证菜单底部不超出窗口 (340 DIP)。
      menuY = Math.max(10, Math.min(relY - 24, 340 - MENU_HEIGHT - 10));
    }

    setContextMenu({
      visible: true,
      x: menuX,
      y: menuY,
    });
  };

  const quotas = state?.quotas;
  const sessions: AgentSession[] = state?.sessions ?? [];

  // 获取当前展示的 Agent 配置与真实数据
  const activeKeyForCard = mountedAgent;
  const currentAgentConfig = AGENT_CONFIGS.find((c) => c.key === activeKeyForCard);
  const currentQuota = quotas && activeKeyForCard ? quotas[activeKeyForCard] : null;
  const currentActiveSession = sessions.find(
    (s) => s.agent === activeKeyForCard && (s.status === 'running_tool' || s.status === 'thinking')
  );

  // =========================================================================
  // 共用渲染片段：详情卡内容体与右键菜单（竖向/横向复用同一套 markup）
  // =========================================================================
  const renderCardBody = () => (
    <>
      {/* 1. 卡片顶部：Agent 名称（比例字体，字重 500）+ 状态微标 + 控制按钮 */}
      <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          {/* 卡片内 Logo：Codex 渲染为纯白色，其余保持品牌色 */}
          <AgentLogo
            agent={currentAgentConfig!.key}
            size={18}
            color={currentAgentConfig!.key === 'codex' ? '#ffffff' : currentAgentConfig!.color}
          />
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-[15px] text-white tracking-normal truncate">
              {currentAgentConfig!.name}
            </span>
            {currentQuota?.authoritative === false ? (
              <span
                className="text-[9px] px-1 py-0.2 rounded bg-amber-500/10 text-amber-300/90 border border-amber-500/20"
                title="本地估算数据"
              >
                Est
              </span>
            ) : (
              <span
                className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-300/90 border border-emerald-500/20"
                title="官方实时权威额度"
              >
                Live
              </span>
            )}
            {currentQuota?.needsAuth && (
              <span className="text-[9px] px-1 py-0.2 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
                Auth
              </span>
            )}
          </div>
        </div>

        {/* 微型操作按钮 */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() =>
              setPinnedAgent(pinnedAgent === currentAgentConfig!.key ? null : currentAgentConfig!.key)
            }
            className={`w-5 h-5 rounded-full flex items-center justify-center transition-all ${
              pinnedAgent === currentAgentConfig!.key
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-white/40 hover:text-white/80 border border-white/[0.06]'
            }`}
            title={pinnedAgent === currentAgentConfig!.key ? '已固定（点击取消）' : '固定此卡片'}
          >
            {pinnedAgent === currentAgentConfig!.key ? (
              <PinOff className="w-2.5 h-2.5" />
            ) : (
              <Pin className="w-2.5 h-2.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              setPinnedAgent(null);
              setHoveredAgent(null);
            }}
            className="w-5 h-5 rounded-full bg-white/[0.04] hover:bg-rose-500/20 text-white/40 hover:text-rose-400 border border-white/[0.06] flex items-center justify-center transition-all cursor-pointer"
            title="收起卡片 (Esc)"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* 2. 卡片中部：高密度额度模块，突出“额度”和“重置时间”双轴 */}
      <div className="py-1 space-y-2.5 flex-1 flex flex-col justify-center">
        {/* 5小时周期（短周期/主要周期） */}
        {(() => {
          const remaining5h = toRemainingPercent(currentQuota?.pct5h);
          const { countdownText, absoluteTimeText } = parseResetTimeInfo(currentQuota?.resetText);

          return (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[12px] text-white/50 font-normal">
                <span>5 小时额度</span>
              </div>

              <div className="flex items-baseline justify-between">
                <div className="flex items-baseline gap-1">
                  <span className="text-[12px] font-normal text-white/50">剩余</span>
                  <span className="text-[20px] font-medium text-white leading-none tabular-nums tracking-tight">
                    {remaining5h != null ? `${remaining5h}%` : '—'}
                  </span>
                </div>
                <span className="text-[13px] font-normal text-white/80 tabular-nums tracking-normal">
                  {countdownText}
                </span>
              </div>

              <div className="w-full h-[3px] bg-white/[0.08] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(0, remaining5h ?? 0))}%`,
                    backgroundColor: currentAgentConfig!.color,
                    boxShadow: `0 0 8px ${currentAgentConfig!.color}99`,
                  }}
                />
              </div>

              {absoluteTimeText && (
                <div className="text-[12px] font-normal text-white/40 tabular-nums text-right">
                  {absoluteTimeText}
                </div>
              )}
            </div>
          );
        })()}

        {/* 7天周期（长周期/次要周期） */}
        {(() => {
          const has7dData = currentQuota?.pct7d != null;
          const remaining7d = toRemainingPercent(currentQuota?.pct7d);
          const { countdownText, absoluteTimeText } = parseResetTimeInfo(currentQuota?.reset7dText);

          return (
            <div className="space-y-1 pt-1.5 border-t border-white/[0.05]">
              <div className="flex items-center justify-between text-[12px] text-white/50 font-normal">
                <span>7 天额度</span>
                {!has7dData && <span className="text-white/30 text-[11px]">官方未提供此周期额度</span>}
              </div>

              {has7dData ? (
                <>
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[12px] font-normal text-white/50">剩余</span>
                      <span className="text-[20px] font-medium text-white leading-none tabular-nums tracking-tight">
                        {remaining7d != null ? `${remaining7d}%` : '—'}
                      </span>
                    </div>
                    <span className="text-[13px] font-normal text-white/80 tabular-nums tracking-normal">
                      {countdownText}
                    </span>
                  </div>
                  <div className="w-full h-[3px] bg-white/[0.08] rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300 bg-sky-500"
                      style={{
                        width: `${Math.min(100, Math.max(0, remaining7d ?? 0))}%`,
                        boxShadow: '0 0 8px rgba(14, 165, 233, 0.4)',
                      }}
                    />
                  </div>
                  {absoluteTimeText && (
                    <div className="text-[12px] font-normal text-white/40 tabular-nums text-right">
                      {absoluteTimeText}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          );
        })()}
      </div>

      {/* 3. 卡片底部：极简状态胶囊 (Status Pill) */}
      <div className="pt-2 border-t border-white/[0.06] flex items-center justify-between">
        {currentActiveSession ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 text-[10px] font-normal text-emerald-300 border border-emerald-500/20 max-w-[220px] truncate">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
            <span className="truncate">
              {currentActiveSession.status === 'running_tool'
                ? `Running: ${currentActiveSession.currentTool?.name ?? 'tool'}`
                : 'Thinking...'}
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.04] text-[10px] font-normal text-white/45 border border-white/[0.06]">
            <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
            Ready
          </span>
        )}
        <span className="text-[9.5px] font-normal text-white/25">Pulse 2.0</span>
      </div>
    </>
  );

  const renderContextMenu = () => (
    <div
      className="fixed z-[100] w-[172px] rounded-xl py-1 text-white border border-white/10 shadow-2xl minibar-context-menu"
      style={{
        left: `${Math.max(8, contextMenu.x)}px`,
        top: `${Math.max(8, contextMenu.y)}px`,
        backgroundColor: 'rgba(18, 18, 20, 0.96)',
        backdropFilter: 'blur(24px)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 1. 收起为边缘标签 */}
      <button
        type="button"
        onClick={handleCollapseToEdgeTab}
        className="w-full px-3 py-1.5 text-[12px] text-left text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors cursor-pointer"
      >
        {isLeftDock ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        收起为边缘标签
      </button>

      {/* 1.5 重置到右侧 */}
      <button
        type="button"
        onClick={() => {
          closeContextMenu();
          (window.codeisland as any)?.resetMiniBarDock?.();
        }}
        className="w-full px-3 py-1.5 text-[12px] text-left text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors cursor-pointer"
      >
        <ChevronRight className="w-3.5 h-3.5" />
        重置到右侧
      </button>

      {/* 2. 固定/取消固定当前详情卡 */}
      <button
        type="button"
        disabled={!targetAgent}
        onClick={() => {
          if (targetAgent) {
            setPinnedAgent(pinnedAgent ? null : targetAgent);
            setContextMenu((prev) => ({ ...prev, visible: false }));
          }
        }}
        className={`w-full px-3 py-1.5 text-[12px] text-left flex items-center gap-2 transition-colors ${
          targetAgent
            ? 'text-white/90 hover:bg-white/10 cursor-pointer'
            : 'text-white/30 cursor-not-allowed'
        }`}
      >
        {pinnedAgent ? (
          <>
            <PinOff className="w-3.5 h-3.5 text-amber-400" />
            取消固定详情卡
          </>
        ) : (
          <>
            <Pin className="w-3.5 h-3.5" />
            固定当前详情卡
          </>
        )}
      </button>

      {/* 3. 背景不透明度展开项与滑块 */}
      <div className="px-3 py-1.5 text-[12px] text-white/90 border-t border-white/[0.06] mt-1 pt-1.5">
        <div className="flex items-center justify-between text-white/80 pb-1">
          <span className="flex items-center gap-1.5">
            <Sliders className="w-3 h-3 text-white/60" />
            背景不透明度
          </span>
          <span className="text-[11px] font-normal text-sky-400 tabular-nums">
            {Math.round(bgOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="35"
          max="100"
          step="1"
          value={Math.round(bgOpacity * 100)}
          onChange={(e) => handleOpacityChange(parseInt(e.target.value, 10) / 100)}
          className="w-full minibar-slider cursor-pointer"
          title="调整背景不透明度 (35% - 100%)"
        />
      </div>

      {/* 5. 完全隐藏悬浮窗 */}
      <button
        type="button"
        onClick={handleClose}
        className="w-full px-3 py-1.5 text-[12px] text-left text-rose-300/90 hover:bg-rose-500/15 flex items-center gap-2 transition-colors cursor-pointer"
      >
        <EyeOff className="w-3.5 h-3.5 text-rose-400" />
        完全隐藏悬浮窗
      </button>
    </div>
  );

  // =========================================================================
  // 视图模式 A：边缘胶囊标签（Edge Tab，宽 18 DIP，高 48 DIP）
  // =========================================================================
  if (isEdgeTab) {
    return (
      <div
        ref={containerRef}
        data-theme={theme}
        className="w-full h-full relative select-none flex items-center justify-center overflow-hidden minibar-sidebar-container outline-none font-sans antialiased"
        onContextMenu={handleContextMenu}
        tabIndex={0}
        role="region"
        aria-label="Agent 额度微型边缘标签"
      >
        <div
          className={`${isHorizontal ? 'w-[48px] h-[18px]' : 'w-[18px] h-[48px]'} rounded-[9px] flex items-center justify-center cursor-pointer transition-all duration-150 group border border-white/10 ${
            isHorizontal
              ? dockAtTop ? 'rounded-b-none border-b-0' : 'rounded-t-none border-t-0'
              : isLeftDock ? 'rounded-l-none border-l-0' : 'rounded-r-none border-r-0'
          }`}
          style={{
            backgroundColor: `rgba(8, 8, 8, ${bgOpacity})`,
            backdropFilter: 'blur(20px)',
          }}
          title={isHorizontal
            ? dockAtTop ? '点击恢复侧栏 (向下展开)' : '点击恢复侧栏 (向上展开)'
            : isLeftDock ? '点击恢复侧栏 (向右展开)' : '点击恢复侧栏 (向左展开)'}
          onPointerDown={(e) => {
            tabDragRef.current = { startX: e.screenX, startY: e.screenY, moved: false };
          }}
          onPointerMove={(e) => {
            if (tabDragRef.current.startX !== 0 || tabDragRef.current.startY !== 0) {
              const dx = e.screenX - tabDragRef.current.startX;
              const dy = e.screenY - tabDragRef.current.startY;
              if (Math.hypot(dx, dy) > 4) {
                tabDragRef.current.moved = true;
              }
            }
          }}
          onPointerUp={() => {
            if (!tabDragRef.current.moved) {
              handleRestoreFromEdgeTab();
            }
            tabDragRef.current = { startX: 0, startY: 0, moved: false };
          }}
        >
          {/* 小箭头提示展开方向（横向：顶部朝下 ▼，底部朝上 ▲；竖向：右吸附朝左 ◀，左吸附朝右 ▶） */}
          {isHorizontal ? (
            dockAtTop ? (
              <ChevronDown className="w-3.5 h-3.5 text-white/50 group-hover:text-white transition-colors" />
            ) : (
              <ChevronUp className="w-3.5 h-3.5 text-white/50 group-hover:text-white transition-colors" />
            )
          ) : isLeftDock ? (
            <ChevronRight className="w-3.5 h-3.5 text-white/50 group-hover:text-white transition-colors" />
          ) : (
            <ChevronLeft className="w-3.5 h-3.5 text-white/50 group-hover:text-white transition-colors" />
          )}
        </div>

        {/* 边缘标签模式下的微型右键菜单 */}
        {contextMenu.visible && (
          <div
            className="fixed z-[100] w-[130px] rounded-xl py-1 text-white border border-white/10 shadow-2xl minibar-context-menu"
            style={{
              left: `${Math.max(4, contextMenu.x)}px`,
              top: `${Math.max(4, contextMenu.y)}px`,
              backgroundColor: 'rgba(18, 18, 20, 0.96)',
              backdropFilter: 'blur(20px)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleRestoreFromEdgeTab}
              className="w-full px-2.5 py-1.5 text-[12px] text-left text-white/90 hover:bg-white/10 flex items-center gap-2 transition-colors cursor-pointer"
            >
              {isLeftDock ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
              恢复完整侧栏
            </button>
            <div className="h-[1px] bg-white/[0.08] my-1" />
            <button
              type="button"
              onClick={handleClose}
              className="w-full px-2.5 py-1.5 text-[12px] text-left text-rose-300/90 hover:bg-rose-500/15 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <EyeOff className="w-3 h-3 text-rose-400" />
              完全隐藏悬浮窗
            </button>
          </div>
        )}
      </div>
    );
  }

  // =========================================================================
  // 横向完整悬浮窗：顶部/底部吸附时使用 340×80 胶囊条，卡片向屏幕内侧展开
  if (isHorizontal) {
    return (
      <div
        ref={containerRef}
        data-theme={theme}
        className="w-full h-full relative select-none flex items-center justify-center overflow-visible minibar-sidebar-container outline-none font-sans antialiased"
        onMouseLeave={handleContainerMouseLeave}
        onContextMenu={handleContextMenu}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="region"
        aria-label="Agent 额度横向悬浮组件"
      >
        {currentAgentConfig && (
          <div
            className={`absolute left-[38px] w-[264px] h-[246px] rounded-[20px] p-3.5 text-white minibar-card-shadow flex flex-col justify-between z-50 minibar-card-anim pointer-events-auto ${
              dockAtTop ? 'top-[62px]' : 'bottom-[62px]'
            } ${
              cardVisible
                ? 'opacity-100 transform translate-y-0'
                : dockAtTop
                ? 'opacity-0 transform -translate-y-2'
                : 'opacity-0 transform translate-y-2'
            }`}
            style={{ backgroundColor: `rgba(8, 8, 8, ${bgOpacity})` }}
            onMouseEnter={handleInteractiveMouseEnter}
            role="dialog"
            aria-modal="false"
            aria-label={`${currentAgentConfig.name} 额度详情`}
          >
            <div
              className={`absolute left-0 right-0 h-[20px] pointer-events-auto ${
                dockAtTop ? 'top-[-18px]' : 'bottom-[-18px]'
              }`}
            />
            <div
              className={`absolute w-0 h-0 border-x-[7px] border-x-transparent pointer-events-none transition-all duration-150 left-1/2 -translate-x-1/2 ${
                dockAtTop ? 'top-[-14px] border-b-[7px]' : 'bottom-[-14px] border-t-[7px]'
              }`}
              style={{
                borderBottomColor: dockAtTop ? `rgba(8, 8, 8, ${bgOpacity})` : undefined,
                borderTopColor: dockAtTop ? undefined : `rgba(8, 8, 8, ${bgOpacity})`,
              }}
            />
            {renderCardBody()}
          </div>
        )}

        <div
          className={`absolute left-0 right-0 h-[56px] z-10 drag-region cursor-grab active:cursor-grabbing border border-white/10 ${
            dockAtTop ? 'top-0 rounded-b-[20px]' : 'bottom-0 rounded-t-[20px]'
          }`}
          style={{ backgroundColor: `rgba(8, 8, 8, ${bgOpacity})` }}
          onMouseDown={handleDragRegionMouseDown}
        >
          {AGENT_CONFIGS.map((cfg) => {
            const q = quotas ? quotas[cfg.key] : null;
            const remaining5h = toRemainingPercent(q?.pct5h);
            const isSelected = targetAgent === cfg.key;
            const isPinnedThis = pinnedAgent === cfg.key;
            const radius = 17;
            const circumference = 2 * Math.PI * radius;
            const strokeOffset =
              remaining5h != null
                ? circumference * (1 - Math.min(100, Math.max(0, remaining5h)) / 100)
                : circumference;

            return (
              <div
                key={cfg.key}
                className="no-drag absolute top-0 bottom-0 flex items-center justify-center cursor-pointer group transition-all"
                style={{ left: `${cfg.centerY - 20}px` }}
                onMouseEnter={() => handleMouseEnterAgent(cfg.key)}
                onMouseLeave={handleMouseLeaveAgent}
                onClick={() => handleRingClick(cfg.key)}
                role="button"
                tabIndex={0}
                aria-label={`${cfg.name} 5小时剩余额度 ${remaining5h != null ? `${remaining5h}%` : '无数据'}`}
              >
                <div
                  className={`w-[40px] h-[40px] relative flex items-center justify-center rounded-full transition-transform duration-200 ${
                    isSelected ? 'scale-105' : 'group-hover:scale-102'
                  }`}
                >
                  <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
                    <circle
                      cx="20"
                      cy="20"
                      r={radius}
                      fill="none"
                      stroke={isPinnedThis ? `${cfg.color}33` : 'rgba(255, 255, 255, 0.08)'}
                      strokeWidth="3"
                    />
                    {remaining5h != null && (
                      <circle
                        cx="20"
                        cy="20"
                        r={radius}
                        fill="none"
                        stroke={cfg.color}
                        strokeWidth="3"
                        strokeDasharray={circumference}
                        strokeDashoffset={strokeOffset}
                        strokeLinecap="round"
                        className="transition-all duration-300"
                      />
                    )}
                  </svg>
                  <div className="absolute inset-0 flex items-center justify-center">
                    <AgentLogo
                      agent={cfg.key}
                      size={15}
                      color={cfg.key === 'codex' ? '#ffffff' : cfg.color}
                    />
                  </div>
                </div>
                <div className="ml-1.5 leading-none">
                  <span className="text-[15px] font-medium text-white leading-none tabular-nums tracking-tight">
                    {remaining5h != null ? `${remaining5h}%` : '—'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {contextMenu.visible && renderContextMenu()}
      </div>
    );
  }

  // 视图模式 B：完整悬浮窗（80 DIP 宽贴边侧栏 + 向桌面内侧展开详情卡）
  // =========================================================================
  return (
    <div
      ref={containerRef}
      data-theme={theme}
      className={`w-full h-full relative select-none flex items-center overflow-visible minibar-sidebar-container outline-none font-sans antialiased ${
        isLeftDock ? 'justify-start' : 'justify-end'
      }`}
      onMouseLeave={handleContainerMouseLeave}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="region"
      aria-label="Agent 额度悬浮组件"
    >
      {/* =========================================================================
          单项详情卡 (264 DIP 宽，246 DIP 高，根据吸附侧向左或向右展开)
          ========================================================================= */}
      {currentAgentConfig && (
        <div
          className={`absolute top-[37px] w-[264px] h-[246px] rounded-[20px] p-3.5 text-white minibar-card-shadow flex flex-col justify-between z-50 minibar-card-anim pointer-events-auto ${
            isLeftDock ? 'left-[65px]' : 'right-[65px]'
          } ${
            cardVisible
              ? 'opacity-100 transform translate-x-0'
              : isLeftDock
              ? 'opacity-0 transform -translate-x-2'
              : 'opacity-0 transform translate-x-2'
          }`}
          style={{
            backgroundColor: `rgba(8, 8, 8, ${bgOpacity})`,
          }}
          onMouseEnter={handleInteractiveMouseEnter}
          role="dialog"
          aria-modal="false"
          aria-label={`${currentAgentConfig.name} 额度详情`}
        >
          {/* 与侧栏之间的透明交互桥，消除鼠标移动时的缝隙丢失 */}
          <div
            className={`absolute top-0 bottom-0 w-[20px] pointer-events-auto ${
              isLeftDock ? 'left-[-18px]' : 'right-[-18px]'
            }`}
          />

          {/* 指向选中圆环中心的短小柔和尖角 (与卡片背景动态同透明度色) */}
          <div
            className={`absolute w-0 h-0 border-y-[7px] border-y-transparent pointer-events-none transition-all duration-150 ${
              isLeftDock ? 'left-[-6px] border-r-[6px]' : 'right-[-6px] border-l-[6px]'
            }`}
            style={{
              top: `${Math.max(16, Math.min(220, currentAgentConfig.centerY - 37 - 5))}px`,
              borderRightColor: isLeftDock ? `rgba(8, 8, 8, ${bgOpacity})` : undefined,
              borderLeftColor: !isLeftDock ? `rgba(8, 8, 8, ${bgOpacity})` : undefined,
            }}
          />

          {renderCardBody()}

        </div>
      )}

      {/* =========================================================================
          贴边 Agent Dock (80 DIP 宽，黑色直线主体宽 59 DIP，贴合屏幕左侧或右侧)
          ========================================================================= */}
      <div
        className="w-[80px] h-[340px] relative flex flex-col items-center justify-between py-2 select-none pointer-events-auto"
        onMouseEnter={handleInteractiveMouseEnter}
      >
        {/* 侧栏背景 SVG */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible" viewBox="0 0 80 340" fill="none">
          <defs>
            <filter id="minibar-edge-shadow" x="-60%" y="-20%" width="220%" height="140%">
              <feDropShadow dx={isLeftDock ? 3 : -3} dy="0" stdDeviation="6" floodColor="#000" floodOpacity="0.45" />
            </filter>
          </defs>
          {isLeftDock ? (
            <path d="M 0,0 C 0,22 59,18 59,40 L 59,300 C 59,322 0,318 0,340 Z" fill={`rgba(8, 8, 8, ${bgOpacity})`} stroke="rgba(255, 255, 255, 0.08)" strokeWidth="1" filter="url(#minibar-edge-shadow)" />
          ) : (
            <path d="M 80,0 C 80,22 21,18 21,40 L 21,300 C 21,322 80,318 80,340 Z" fill={`rgba(8, 8, 8, ${bgOpacity})`} stroke="rgba(255, 255, 255, 0.08)" strokeWidth="1" filter="url(#minibar-edge-shadow)" />
          )}
        </svg>

        {/* 内容容器：整条黑色主体即拖动热区，圆环与按钮标记 no-drag 仍可点击 */}
        <div
          className={`absolute top-0 bottom-0 w-[59px] z-10 drag-region cursor-grab active:cursor-grabbing ${
            isLeftDock ? 'left-0' : 'left-[21px]'
          }`}
          onMouseDown={handleDragRegionMouseDown}
        >
          {/* 极隐蔽关闭按钮已移除：X 号影响美观，关闭入口收敛到右键菜单“完全隐藏悬浮窗” */}
          {/* 中间三个 Agent 视觉单元：按 cfg.centerY 绝对定位，圆环中心与详情卡尖角严格共线 */}
          {AGENT_CONFIGS.map((cfg) => {
              const q = quotas ? quotas[cfg.key] : null;
              const remaining5h = toRemainingPercent(q?.pct5h);
              const isSelected = targetAgent === cfg.key;
              const isPinnedThis = pinnedAgent === cfg.key;

              // 精致圆环几何：外径 46 DIP，半径 19.5，细轨道 2.8px
              const radius = 17;
              const circumference = 2 * Math.PI * radius;
              const strokeOffset =
                remaining5h != null
                  ? circumference * (1 - Math.min(100, Math.max(0, remaining5h)) / 100)
                  : circumference;

              return (
                <div
                  key={cfg.key}
                  className="no-drag absolute left-0 right-0 flex flex-col items-center cursor-pointer group transition-all"
                  style={{ top: `${cfg.centerY - 20}px` }}
                  onMouseEnter={() => handleMouseEnterAgent(cfg.key)}
                  onMouseLeave={handleMouseLeaveAgent}
                  onClick={() => handleRingClick(cfg.key)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${cfg.name} 5小时剩余额度 ${remaining5h != null ? `${remaining5h}%` : '无数据'}`}
                >
                  {/* 46 DIP 额度圆环主体（无发灰阴影） */}
                  <div
                    className={`w-[40px] h-[40px] relative flex items-center justify-center rounded-full transition-transform duration-200 ${
                      isSelected ? 'scale-105' : 'group-hover:scale-102'
                    }`}
                  >
                    <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
                      {/* 暗色质感底环 */}
                      <circle
                        cx="20"
                        cy="20"
                        r={radius}
                        fill="none"
                        stroke={isPinnedThis ? `${cfg.color}33` : 'rgba(255, 255, 255, 0.08)'}
                        strokeWidth="3"
                      />
                      {/* 饱满品牌色进度环 */}
                      {remaining5h != null && (
                        <circle
                          cx="20"
                          cy="20"
                          r={radius}
                          fill="none"
                          stroke={cfg.color}
                          strokeWidth="3"
                          strokeDasharray={circumference}
                          strokeDashoffset={strokeOffset}
                          strokeLinecap="round"
                          className="transition-all duration-300"
                        />
                      )}
                    </svg>

                    {/* 中心 Logo：17 DIP，Codex 呈现纯白色，Claude 与 Antigravity 呈现品牌标 */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <AgentLogo
                        agent={cfg.key}
                        size={15}
                        color={cfg.key === 'codex' ? '#ffffff' : cfg.color}
                      />
                    </div>
                  </div>

                  {/* 圆环下方：剩余百分比（周期统一为 5h，不再逐项重复标注） */}
                  <div className="mt-1 leading-none">
                    <span className="text-[15px] font-medium text-white leading-none tabular-nums tracking-tight">
                      {remaining5h != null ? `${remaining5h}%` : '—'}
                    </span>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* =========================================================================
          右键上下文菜单浮层
          ========================================================================= */}
      {contextMenu.visible && renderContextMenu()}

    </div>
  );
};

export default MiniBar;
