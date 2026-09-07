/**
 * 自绘标题栏（main.html header）：drag-region 拖拽，窗口按钮必须 no-drag（README 避坑 2）。
 * 关闭 = 隐藏到托盘（阶段 2 约定），不退进程。
 */
import React, { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';

export const TitleBar: React.FC<{ subtitle: string }> = ({ subtitle }) => {
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.pulse?.getAppVersion().then(setVersion);
  }, []);

  return (
    <header className="h-10 shrink-0 bg-island-sidebar border-b border-white/[0.08] flex items-center justify-between px-3 drag-region">
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center shadow-[0_0_10px_rgba(56,189,248,0.4)]">
          <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <span className="font-semibold text-xs tracking-wide text-zinc-200">Pulse</span>
        <span className="text-[10px] text-zinc-500 font-mono border border-zinc-800 px-1 rounded">{version ? `v${version}` : 'v--'}</span>
        <span className="text-[11px] text-zinc-400 ml-1">{subtitle}</span>
      </div>

      <div className="flex items-center gap-1.5 no-drag">
        <button
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition"
          onClick={() => window.pulse?.minimizeWindow()}
          title="最小化"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-white/10 text-zinc-400 hover:text-zinc-200 transition"
          onClick={() => window.pulse?.maximizeWindow()}
          title="最大化/还原"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-rose-600 text-zinc-400 hover:text-white transition"
          onClick={() => window.pulse?.closeWindow()}
          title="隐藏到托盘（后台服务保持运行）"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
