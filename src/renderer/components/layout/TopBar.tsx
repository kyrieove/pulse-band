import React from 'react';
import { Minus, Square, X, Activity } from 'lucide-react';
import { APP_NAME } from '../../../common/app-info';

export interface TopBarProps {
  subtitle?: string;
  theme?: 'light' | 'dark';
  onToggleTheme?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ subtitle }) => {
  const handleMinimize = () => {
    // 兼容现有主进程窗口控制
    (window as any).pulse?.minimizeWindow?.();
  };

  const handleMaximize = () => {
    (window as any).pulse?.maximizeWindow?.();
  };

  const handleClose = () => {
    (window as any).pulse?.closeWindow?.();
  };

  return (
    <header className="w-full h-10 shrink-0 bg-[var(--bg-surface)] border-b border-[var(--border-default)] flex items-center justify-between px-4 drag-region select-none transition-colors duration-200">
      {/* 左侧品牌与副标题 */}
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded-md bg-sky-500/15 flex items-center justify-center text-[var(--accent-primary)]">
          <Activity className="w-3.5 h-3.5" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold tracking-tight text-[var(--text-primary)]">
            {APP_NAME}
          </span>
          {subtitle && (
            <span className="text-[11px] text-[var(--text-muted)] font-normal">
              {subtitle}
            </span>
          )}
        </div>
      </div>

      {/* 右侧窗口三联按钮 */}
      <div className="flex items-center no-drag">
        <button
          onClick={handleMinimize}
          className="w-8 h-7 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] rounded transition-colors text-xs"
          title="最小化"
          aria-label="最小化"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-8 h-7 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] rounded transition-colors text-xs"
          title="最大化"
          aria-label="最大化"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          onClick={handleClose}
          className="w-8 h-7 flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-[var(--status-error)] rounded transition-colors text-xs"
          title="关闭"
          aria-label="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
