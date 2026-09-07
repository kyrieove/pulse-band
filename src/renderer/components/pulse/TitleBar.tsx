/**
 * 自绘标题栏（main.html header）：drag-region 拖拽，窗口按钮必须 no-drag（README 避坑 2）。
 * 关闭 = 隐藏到托盘（阶段 2 约定），不退进程。
 */
import React, { useEffect, useState } from 'react';
import { Minus, Square, X } from 'lucide-react';

export const TitleBar: React.FC<{ subtitle: string }> = ({ subtitle }) => {
  const [minibarVisible, setMinibarVisible] = useState(false);

  useEffect(() => {
    if (!window.pulse) return;
    let alive = true;
    window.pulse.isMiniBarVisible?.().then((v) => {
      if (alive) setMinibarVisible(v);
    });
    const unsub = window.pulse.onMiniBarVisibilityChange?.((v) => {
      if (alive) setMinibarVisible(v);
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const handleToggleMiniBar = async () => {
    if (!window.pulse) return;
    const next = await window.pulse.toggleMiniBar?.();
    setMinibarVisible(!!next);
  };

  return (
    <header className="h-10 shrink-0 bg-island-sidebar border-b border-white/[0.08] flex items-center justify-between px-3 drag-region">
      <div className="flex items-center gap-2.5">
        <div className="w-5 h-5 rounded-md bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center shadow-[0_0_10px_rgba(56,189,248,0.4)]">
          <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
        </div>
        <span className="font-semibold text-xs tracking-wide text-zinc-200">Pulse</span>
        <span className="text-[10px] text-zinc-500 font-mono border border-zinc-800 px-1 rounded">2.0</span>
        <span className="text-[11px] text-zinc-400 ml-1">{subtitle}</span>
      </div>

      <div className="flex items-center gap-1.5 no-drag">
        {/* 迷你悬浮窗 (MiniBar) 显眼快捷开关 */}
        <button
          onClick={handleToggleMiniBar}
          className={`px-2.5 py-0.5 rounded-md text-[11px] font-medium flex items-center gap-1.5 transition border ${
            minibarVisible
              ? 'bg-sky-500/20 text-sky-300 border-sky-500/40 shadow-[0_0_8px_rgba(56,189,248,0.25)]'
              : 'bg-white/[0.04] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08] border-white/[0.08]'
          }`}
          title={minibarVisible ? '点击隐藏桌面迷你悬浮窗 (MiniBar)' : '点击开启桌面迷你悬浮窗 (MiniBar)'}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              minibarVisible ? 'bg-sky-400 shadow-[0_0_6px_#38bdf8]' : 'bg-zinc-600'
            }`}
          />
          <span>悬浮窗 {minibarVisible ? '已开启' : '已关闭'}</span>
        </button>

        <div className="w-[1px] h-3.5 bg-white/10 mx-0.5" />

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
