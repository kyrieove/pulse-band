import React from 'react';
import { Minus, Square, X } from 'lucide-react';

export interface TopBarProps {}

export const TopBar: React.FC<TopBarProps> = () => {
  const handleMinimize = () => {
    (window as any).pulse?.minimizeWindow?.();
  };

  const handleMaximize = () => {
    (window as any).pulse?.maximizeWindow?.();
  };

  const handleClose = () => {
    (window as any).pulse?.closeWindow?.();
  };

  return (
    <header
      className="titlebar-drag h-[32px] shrink-0 bg-[var(--bg-surface)] border-b border-[var(--border-strong)] flex items-center justify-end px-3 select-none transition-colors duration-200"
    >
      {/* 右侧窗口三联按钮 */}
      <div className="flex items-center no-drag">
        <button
          onClick={handleMinimize}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-xs"
          title="最小化"
          aria-label="最小化"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleMaximize}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] rounded-lg transition-colors text-xs"
          title="最大化"
          aria-label="最大化"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          onClick={handleClose}
          className="w-[26px] h-6 flex items-center justify-center text-[var(--text-muted)] hover:text-white hover:bg-[var(--status-error)] rounded-lg transition-colors text-xs"
          title="关闭"
          aria-label="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};