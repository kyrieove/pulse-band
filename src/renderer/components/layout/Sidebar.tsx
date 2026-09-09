import React from 'react';
import { LayoutDashboard, Watch, Settings2 } from 'lucide-react';

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

      {/* 底部版本标识 */}
      <div className="px-2 py-1.5 border-t border-[var(--border-default)] flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span>Pulse 2.0</span>
        <span className="font-mono text-[10px]">v2.0-preview</span>
      </div>
    </aside>
  );
};
