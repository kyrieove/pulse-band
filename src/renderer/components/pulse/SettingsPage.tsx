import React, { useEffect, useState } from 'react';
import { Check, Activity, Sun, Moon } from 'lucide-react';
import { Toggle } from './ui';
import { useMiniBar } from '../../hooks/useMiniBar';
import { APP_VERSION } from '../../../common/app-info';

export interface SettingsPageProps {
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  onOpenDiagnostics?: () => void;
}

/** MiniBar 启动停靠偏好三取值（与主进程 minibar-preference 约定一致） */
export type MiniBarStartupDock = 'remember' | 'left' | 'right';

const STARTUP_DOCK_OPTIONS: Array<{ value: MiniBarStartupDock; label: string }> = [
  { value: 'remember', label: '记住侧边' },
  { value: 'left', label: '固定靠左' },
  { value: 'right', label: '固定靠右' },
];

const KV: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const isUpcoming = value === '即将支持';
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[11px] text-[var(--text-muted)]">{label}</span>
      <span
        className={`text-[11px] tabular-nums ${
          isUpcoming ? 'text-[var(--text-muted)]' : 'font-mono text-[var(--text-primary)]'
        }`}
      >
        {value}
      </span>
    </div>
  );
};

const ThemeOption: React.FC<{
  mode: 'light' | 'dark';
  label: string;
  active: boolean;
  onSelect: () => void;
}> = ({ mode, label, active, onSelect }) => (
  <button
    type="button"
    onClick={onSelect}
    className={`relative p-2.5 rounded-[14px] border text-left transition-colors cursor-pointer ${
      active
        ? 'border-[1.5px] border-[var(--accent-soft)] bg-[var(--bg-subtle)]'
        : 'border-[var(--border-default)] bg-[var(--bg-surface)] hover:border-[var(--border-strong)]'
    }`}
  >
    <span className="text-[12px] font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
      {mode === 'light' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
      {label}
    </span>
    {/* 46×32 迷你窗口预览 */}
    <div
      className="mt-2 w-[46px] h-8 rounded-[6px] overflow-hidden relative"
      style={{ background: mode === 'light' ? 'var(--bg-canvas)' : '#121614' }}
    >
      <div
        className="absolute left-1 top-1 right-1 h-1.5 rounded-sm"
        style={{ background: mode === 'light' ? 'var(--bg-surface)' : '#1e2421' }}
      />
      <div
        className="absolute left-1 top-[9px] w-3 h-2.5 rounded-[2px]"
        style={{ background: mode === 'light' ? 'var(--bg-surface)' : '#1e2421' }}
      />
      <div
        className="absolute left-[17px] top-[9px] w-7 h-2.5 rounded-[2px]"
        style={{ background: mode === 'light' ? 'var(--bg-surface)' : '#1e2421' }}
      />
    </div>
    {active && (
      <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[var(--accent-primary)] text-white flex items-center justify-center">
        <Check className="w-3 h-3 stroke-[3]" />
      </span>
    )}
  </button>
);

export const SettingsPage: React.FC<SettingsPageProps> = ({
  theme,
  onThemeChange,
  onOpenDiagnostics,
}) => {
  const miniBar = useMiniBar();
  const [appVersion, setAppVersion] = useState<string>(APP_VERSION);
  // 启动停靠偏好：仅本地预览态，尚未接线（等主进程 get/set-dock-preference 契约）
  const [startupDock, setStartupDock] = useState<MiniBarStartupDock>('remember');

  useEffect(() => {
    let alive = true;
    window.pulse?.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">设置</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">外观、显示与运行环境</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[1fr_254px] gap-2.5 overflow-y-auto custom-scrollbar">
        {/* 左列三卡 */}
        <div className="min-h-0 flex flex-col gap-2.5">
          {/* 主题外观 */}
          <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">主题外观</h3>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">选择浅色或深色界面</p>
            <div className="mt-3 grid grid-cols-2 gap-2.5">
              <ThemeOption mode="light" label="浅色" active={theme === 'light'} onSelect={() => onThemeChange('light')} />
              <ThemeOption mode="dark" label="深色" active={theme === 'dark'} onSelect={() => onThemeChange('dark')} />
            </div>
          </section>

          {/* 显示 */}
          <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 space-y-3">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">显示</h3>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-medium text-[var(--text-primary)]">显示额度悬浮窗</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  独立于手环，未配置手环也可使用；关闭只隐藏窗口，不影响额度采集
                </div>
              </div>
              <Toggle label="显示额度悬浮窗" checked={miniBar.visible} disabled={miniBar.busy} onChange={(v) => void miniBar.setVisible(v)} />
            </div>
            {miniBar.error && <p className="text-[11px] text-[var(--status-error)]">{miniBar.error}</p>}

            {/* 启动停靠偏好：UI 先行。主进程 minibar 偏好读写 IPC（channel 名待定）落地后，
                把本地 state 换成 get/set 调用并移除「即将支持」提示行。 */}
            <div className="pt-3 border-t border-[var(--border-default)] space-y-2">
              <div>
                <div className="text-[12px] font-medium text-[var(--text-primary)]">启动停靠位置</div>
                <div className="text-[11px] text-[var(--text-muted)]">
                  MiniBar 每次启动停靠在屏幕左侧或右侧；运行期间仍可拖到任意边缘
                </div>
              </div>
              <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="启动停靠位置">
                {STARTUP_DOCK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={startupDock === opt.value}
                    onClick={() => setStartupDock(opt.value)}
                    className={`rounded-[8px] border px-2 py-1.5 text-[11px] font-medium text-center transition-colors cursor-pointer select-none ${
                      startupDock === opt.value
                        ? 'border-[var(--accent-soft)] bg-[var(--accent-wash)] text-[var(--anchor-text)]'
                        : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] text-[var(--text-muted)]">
                即将支持：主进程偏好接口就绪后生效，当前选择暂不保存
              </p>
            </div>
          </section>

          {/* 运行诊断 */}
          <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] bg-[var(--accent-wash)] text-[var(--accent-primary)] flex items-center justify-center shrink-0">
              <Activity className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">运行诊断</div>
              <div className="text-[11px] text-[var(--text-muted)]">排查网络与手环连接问题，敏感凭据已自动脱敏</div>
            </div>
            <button
              type="button"
              onClick={onOpenDiagnostics}
              className="rounded-full px-[13px] py-1.5 text-[11px] font-semibold select-none cursor-pointer transition-colors bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)] shrink-0"
            >
              打开
            </button>
          </section>
        </div>

        {/* 右列：版本与环境 */}
        <section className="min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">版本与环境</h3>
          <div className="mt-2 space-y-1">
            <KV label="应用版本" value={appVersion} />
          </div>
          <p className="mt-3 text-[11px] text-[var(--text-muted)] leading-relaxed">
            配置与凭据保存在本机，不会上传到任何服务器。更新由 GitHub Releases 发布。
          </p>
        </section>
      </div>
    </div>
  );
};