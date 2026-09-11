import React from 'react';
import { LayoutDashboard, Watch, Settings2, PanelTop } from 'lucide-react';
import { Toggle } from '../pulse/ui';
import { useMiniBar } from '../../hooks/useMiniBar';
import { APP_NAME, APP_VERSION } from '../../../common/app-info';

export type PulsePage = 'overview' | 'band' | 'settings';

export interface SidebarProps {
  currentPage: PulsePage;
  onNavigate: (page: PulsePage) => void;
}

interface NavItem {
  id: PulsePage;
  label: string;
  icon: React.ElementType;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'band', label: '手环', icon: Watch },
  { id: 'settings', label: '设置', icon: Settings2 },
];

export const Sidebar: React.FC<SidebarProps> = ({ currentPage, onNavigate }) => {
  // 额度悬浮窗显隐：与设置页、托盘读取同一个 main 进程真实窗口状态
  const miniBar = useMiniBar();

  return (
    <aside className="w-[200px] shrink-0 bg-[var(--bg-surface)] border-r border-[var(--border-default)] flex flex-col justify-between p-3 select-none transition-colors duration-200">
      <div className="space-y-4">
        {/* 分组标识 */}
        <div className="px-2 pt-1">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
            功能导航
          </div>
        </div>

        {/* 一级导航列表：概览 / 手环 / 设置 */}
        <nav className="space-y-1" aria-label="主导航">
          {NAV_ITEMS.map((item) => {
            const active = currentPage === item.id;
            const Icon = item.icon;

            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] text-xs font-medium transition-all duration-150 ${
                  active
                    ? 'bg-[var(--bg-app)] text-[var(--accent-primary)] shadow-[var(--shadow-sm)] border border-[var(--border-strong)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[var(--accent-primary)]' : 'text-[var(--text-muted)]'}`} />
                <span>{item.label}</span>
                {active && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* 底部：额度悬浮窗常驻入口 + 版本标识 */}
      <div className="space-y-2">
        <div className="p-2.5 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <PanelTop className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              额度悬浮窗
            </span>
            <Toggle
              checked={miniBar.visible}
              disabled={miniBar.busy}
              onChange={(v) => void miniBar.setVisible(v)}
            />
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
            独立于手环，未配置手环也可显示各产品额度。
          </p>
          {miniBar.error && (
            <p className="text-[10px] leading-relaxed text-[var(--status-error)]">{miniBar.error}</p>
          )}
        </div>

        <div className="px-2 py-1.5 border-t border-[var(--border-default)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span>{APP_NAME}</span>
          <span className="font-mono text-[10px]">v{APP_VERSION}</span>
        </div>
      </div>
    </aside>
  );
};
