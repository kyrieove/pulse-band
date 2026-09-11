import React from 'react';
import { LayoutDashboard, Watch, Settings2, Activity } from 'lucide-react';
import { Toggle } from '../pulse/ui';
import { useMiniBar } from '../../hooks/useMiniBar';
import { APP_NAME, APP_VERSION } from '../../../common/app-info';

export type PulsePage = 'overview' | 'band' | 'settings' | 'diagnostics';

export interface SidebarProps {
  currentPage: PulsePage;
  onNavigate: (page: PulsePage) => void;
}

interface NavItem {
  id: PulsePage;
  label: string;
  icon: React.ElementType;
}

const MENU_ITEMS: NavItem[] = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'band', label: '手环', icon: Watch },
];

const REGULAR_ITEMS: NavItem[] = [
  { id: 'settings', label: '设置', icon: Settings2 },
  { id: 'diagnostics', label: '运行诊断', icon: Activity },
];

function NavGroup(props: {
  title: string;
  items: NavItem[];
  currentPage: PulsePage;
  onNavigate: (page: PulsePage) => void;
}) {
  return (
    <div>
      <div className="px-2 pt-1 pb-1 text-[9.5px] font-bold uppercase tracking-[0.1em] text-[var(--text-muted)]">
        {props.title}
      </div>
      <nav className="space-y-1" aria-label={props.title}>
        {props.items.map((item) => {
          const active = props.currentPage === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => props.onNavigate(item.id)}
              className={`relative w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-[12.5px] transition-all duration-150 ${
                active
                  ? 'bg-[var(--accent-wash)] text-[var(--anchor-text)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] font-medium'
              }`}
            >
              {active && (
                <span className="absolute left-[-10px] top-2 bottom-2 w-[3px] rounded-full bg-[var(--accent-soft)]" />
              )}
              <Icon
                className={`w-4 h-4 shrink-0 ${active ? 'text-[var(--accent-soft)]' : 'text-[var(--text-muted)]'}`}
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export const Sidebar: React.FC<SidebarProps> = ({ currentPage, onNavigate }) => {
  // 额度悬浮窗显隐：与设置页、托盘读取同一个 main 进程真实窗口状态
  const miniBar = useMiniBar();

  return (
    <aside className="w-[172px] shrink-0 self-stretch bg-[var(--bg-surface)] rounded-[18px] p-[14px_10px] flex flex-col select-none transition-colors duration-200">
      {/* 顶部品牌 logo */}
      <div className="flex items-center gap-2.5 px-2 pb-4">
        <div className="w-7 h-7 rounded-full bg-[var(--accent-wash)] flex items-center justify-center text-[var(--anchor-text)]">
          <Activity className="w-3.5 h-3.5" />
        </div>
        <span className="text-[16px] font-bold text-[var(--text-primary)] tracking-tight">{APP_NAME}</span>
      </div>

      {/* 导航 + 悬浮窗开关卡（内容超高时仅在此区滚动，避免撑高窗口） */}
      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-3">
        <NavGroup title="菜单" items={MENU_ITEMS} currentPage={currentPage} onNavigate={onNavigate} />
        <NavGroup title="常规" items={REGULAR_ITEMS} currentPage={currentPage} onNavigate={onNavigate} />

        {/* 悬浮窗开关卡 */}
        <div className="rounded-[14px] p-3 bg-[var(--accent-wash)] space-y-2">
          <div className="text-[11px] font-semibold text-[var(--anchor-text)]">额度悬浮窗</div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[var(--anchor-text)]">独立于手环显示</span>
            <Toggle
              checked={miniBar.visible}
              disabled={miniBar.busy}
              onChange={(v) => void miniBar.setVisible(v)}
            />
          </div>
          {miniBar.error && (
            <p className="text-[10px] leading-relaxed text-[var(--status-error)]">{miniBar.error}</p>
          )}
        </div>
      </div>

      {/* 版本行钉底 */}
      <div className="mt-auto pt-4 px-2 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span>{APP_NAME}</span>
        <span className="font-mono text-[10px]">v{APP_VERSION}</span>
      </div>
    </aside>
  );
};