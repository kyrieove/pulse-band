import React from 'react';
import { Palette, Bot, RefreshCw, Wrench, Sun, Moon } from 'lucide-react';

export interface SettingsPageProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = ({ theme, onThemeChange }) => {
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
              <div className="text-[11px] text-[var(--text-muted)]">Light Theme 为默认原语设计</div>
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
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Agent 监控设置
          </h3>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          支持独立配置各个 AI Agent 的检测状态与页面显示控制（骨架预留）。
        </p>
      </section>

      {/* 分组 3：手环同步设置 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            手环同步设置
          </h3>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">
          设备重新配置与同步偏好设置（骨架预留）。
        </p>
      </section>

      {/* 分组 4：高级维护 (最低视觉权重) */}
      <section className="p-4 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)]/60 text-[var(--text-muted)] space-y-2 transition-colors duration-200">
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5" />
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            高级维护
          </h4>
        </div>
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          运行诊断、脱敏日志导出与系统维护工具。在非排错场景下保持低权重收敛。
        </p>
      </section>
    </div>
  );
};
