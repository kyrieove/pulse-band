import React, { useState } from 'react';
import { Palette, Bot, Wrench, Sun, Moon, ChevronDown, ChevronUp, PanelTop } from 'lucide-react';
import { Toggle } from './ui';
import { useMiniBar } from '../../hooks/useMiniBar';

export interface SettingsPageProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  showAgents?: boolean;
  onShowAgentsChange?: (show: boolean) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  theme,
  onThemeChange,
  showAgents = true,
  onShowAgentsChange,
}) => {
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const miniBar = useMiniBar();

  return (
    <div className="space-y-5">
      {/* 分组 1：外观设置 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <Palette className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            外观设置
          </h3>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-[var(--text-primary)]">主题外观</div>
              <div className="text-[11px] text-[var(--text-muted)]">Light Theme 为默认原语设计，支持 Dark Midnight 模式</div>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)]">
              <button
                type="button"
                onClick={() => onThemeChange('light')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-all ${
                  theme === 'light'
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Sun className="w-3.5 h-3.5" />
                <span>浅色 (默认)</span>
              </button>
              <button
                type="button"
                onClick={() => onThemeChange('dark')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-all ${
                  theme === 'dark'
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Moon className="w-3.5 h-3.5" />
                <span>深色</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 分组 2：Agent 监控设置 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Agent 监控设置
          </h3>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-[var(--text-primary)]">显示 Agent 状态</div>
              <div className="text-[11px] text-[var(--text-muted)]">在桌面悬浮监控条与概览工作区呈现已识别 Agent 的实时运行状态与额度</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showAgents}
              onClick={() => onShowAgentsChange?.(!showAgents)}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                showAgents ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-strong)]'
              }`}
              title={showAgents ? '关闭 Agent 显示' : '开启 Agent 显示'}
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                  showAgents ? 'translate-x-4' : 'translate-x-0'
                }`}
              />
            </button>
          </div>
        </div>
      </section>

      {/* 分组 3：额度悬浮窗（与侧栏、托盘控制同一个真实窗口） */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <PanelTop className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            额度悬浮窗
          </h3>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium text-[var(--text-primary)]">显示额度悬浮窗</div>
              <div className="text-[11px] text-[var(--text-muted)]">
                独立于手环，未配置手环也可使用；关闭只隐藏窗口，不影响额度采集
              </div>
            </div>
            <Toggle
              checked={miniBar.visible}
              disabled={miniBar.busy}
              onChange={(v) => void miniBar.setVisible(v)}
            />
          </div>
          {miniBar.error && (
            <p className="text-[11px] leading-relaxed text-[var(--status-error)]">{miniBar.error}</p>
          )}
          <div className="text-[11px] text-[var(--text-muted)] pt-3 border-t border-[var(--border-default)]/60">
            「显示 Agent 状态」控制概览与悬浮条内是否呈现 Agent 内容，与悬浮窗显隐是两件事。
          </div>
        </div>
      </section>

      {/* 分组 4：高级维护 (最低视觉权重，默认折叠收敛) */}
      <section className="rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)]/60 text-[var(--text-muted)] transition-colors duration-200 overflow-hidden">
        <button
          type="button"
          onClick={() => setMaintenanceOpen(!maintenanceOpen)}
          className="w-full p-4 flex items-center justify-between hover:bg-[var(--bg-app)] transition-colors text-left"
        >
          <div className="flex items-center gap-2">
            <Wrench className="w-3.5 h-3.5" />
            <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              高级维护
            </h4>
          </div>
          <div className="flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
            <span>{maintenanceOpen ? '收起' : '展开'}</span>
            {maintenanceOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </div>
        </button>

        {maintenanceOpen && (
          <div className="px-4 pb-4 pt-1 space-y-3 border-t border-[var(--border-default)]/40 text-xs">
            <div className="flex items-center justify-between py-1">
              <div>
                <div className="font-medium text-[var(--text-secondary)]">运行诊断</div>
                <div className="text-[11px] text-[var(--text-muted)]">排查网络与手环连接问题，所有敏感凭据已自动脱敏</div>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-app)] text-[var(--text-muted)] border border-[var(--border-default)]">
                只读中心
              </span>
            </div>

            <div className="flex items-center justify-between py-1 border-t border-[var(--border-default)]/40 pt-2">
              <div>
                <div className="font-medium text-[var(--text-secondary)]">版本与环境</div>
                <div className="text-[11px] text-[var(--text-muted)]">Pulse 2.0 桌面端架构基线</div>
              </div>
              <span className="text-[11px] font-mono text-[var(--text-muted)]">
                v1.1.2
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
