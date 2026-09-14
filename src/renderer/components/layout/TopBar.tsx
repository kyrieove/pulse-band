import React, { useState } from 'react';
import { Minus, Square, X } from 'lucide-react';
import { pickRandomPoem } from './poems';

export interface TopBarProps {}

export const TopBar: React.FC<TopBarProps> = () => {
  // 每次窗口挂载取一句，不轮播：顶栏是窗口框架，持续变化的文字会跟内容区抢注意力
  const [poem] = useState(pickRandomPoem);

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
      className="titlebar-drag h-[32px] shrink-0 bg-[var(--bg-surface)] border-b border-[var(--border-strong)] flex items-center justify-between px-3 select-none transition-colors duration-200"
    >
      {/* 左侧诗句：留在拖拽区内（不加 no-drag），点它照样能拖窗口 */}
      <div className="flex items-baseline gap-2 min-w-0 overflow-hidden" title={poem.from}>
        <span className="text-[11px] text-[var(--text-muted)] truncate">{poem.text}</span>
        <span className="text-[10px] text-[var(--text-muted)] opacity-60 shrink-0">
          {poem.from}
        </span>
      </div>

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