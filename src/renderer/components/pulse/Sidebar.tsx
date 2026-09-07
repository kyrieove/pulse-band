/**
 * 左侧导航边栏（main.html aside）：功能导航 + 底部悬浮窗开关。
 */
import React, { useEffect, useState } from 'react';
import { Smartphone, Activity, Settings } from 'lucide-react';
import { Toggle } from './ui';

export type Screen = 'main' | 'diagnostics' | 'settings';

const NAV: Array<{ id: Screen; label: string; hint: string }> = [
  { id: 'main', label: '设备管理', hint: '主屏' },
  { id: 'diagnostics', label: '运行诊断', hint: '次屏' },
  { id: 'settings', label: '设置与维护', hint: '设置' },
];

export const Sidebar: React.FC<{
  screen: Screen;
  onNavigate: (s: Screen) => void;
}> = ({ screen, onNavigate }) => {
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

  const handleToggleMiniBar = async (val: boolean) => {
    if (!window.pulse) return;
    const res = await window.pulse.setMiniBarVisible?.(val);
    setMinibarVisible(!!res);
  };

  return (
    <aside className="w-48 shrink-0 bg-island-sidebar border-r border-white/[0.08] flex flex-col justify-between p-3">
      <div className="space-y-1">
        <div className="text-[10px] uppercase font-bold tracking-wider text-zinc-500 px-2 py-1.5">功能导航</div>
        {NAV.map((item) => {
          const active = screen === item.id;
          const Icon = item.id === 'main' ? Smartphone : item.id === 'diagnostics' ? Activity : Settings;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition ${
                active
                  ? 'bg-white/[0.08] text-island-accent font-medium border border-sky-500/20 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{item.label}</span>
              <span className="ml-auto text-[10px] text-zinc-500 font-mono">
                {active ? <span className="inline-block w-1.5 h-1.5 rounded-full bg-island-accent" /> : item.hint}
              </span>
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        {/* 桌面迷你悬浮窗 (MiniBar) 显明控制开关 */}
        <div className="p-2.5 rounded-lg bg-[#12151c] border border-white/[0.06] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-zinc-300 font-medium flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  minibarVisible ? 'bg-sky-400 shadow-[0_0_6px_#38bdf8]' : 'bg-zinc-600'
                }`}
              />
              桌面迷你悬浮窗
            </span>
            <Toggle checked={minibarVisible} onChange={handleToggleMiniBar} />
          </div>
          <div className="text-[10px] text-zinc-500">
            {minibarVisible ? '已置顶显示 · 磨砂玻璃透明风格' : '未开启 · 点击开关开启悬浮'}
          </div>
        </div>
      </div>
    </aside>
  );
};
