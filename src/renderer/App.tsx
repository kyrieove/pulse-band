import React, { useEffect, useState } from 'react';
import { Watch, Clock3 } from 'lucide-react';
import { TopBar } from './components/layout/TopBar';
import { Sidebar, type PulsePage } from './components/layout/Sidebar';
import { ContentArea } from './components/layout/ContentArea';
import { BandConnectionCard } from './components/pulse/BandConnectionCard';
import { AgentSection } from './components/pulse/AgentSection';
import { BandManagementPage } from './components/pulse/BandManagementPage';
import { SettingsPage } from './components/pulse/SettingsPage';
import { SetupWizard, type QuotaVerifyOutcome } from './components/setup';
import { MiniBar } from './components/minibar/MiniBar';
import { useBandConnection } from './hooks/useBandConnection';
import type { PulseOronboxState } from '../main/services/oronbox-bridge';

type AppScreen = PulsePage | 'minibar';

const getInitialScreen = (): AppScreen => {
  try {
    const s = new URLSearchParams(window.location.search).get('screen');
    if (s === 'minibar') return 'minibar';
    if (s === 'band' || s === 'settings') return s;
    return 'overview';
  } catch {
    return 'overview';
  }
};

export const App: React.FC = () => {
  const [screen] = useState<AppScreen>(getInitialScreen);
  const [page, setPage] = useState<PulsePage>(screen === 'minibar' ? 'overview' : screen);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('pulse-theme') as 'light' | 'dark') || 'light';
    } catch {
      return 'light';
    }
  });
  const [showAgents, setShowAgents] = useState<boolean>(true);
  const [showSetup, setShowSetup] = useState<boolean>(false);
  /** 向导打开时落在第几步（0-based）：稍后验证后可回到第 4 步继续 */
  const [setupStartIndex, setSetupStartIndex] = useState<number>(0);
  /** 额度验证结果：deferred 表示用户选择了稍后验证，**不得**当作已验证 */
  const [quotaVerify, setQuotaVerify] = useState<QuotaVerifyOutcome | 'unknown'>('unknown');
  const [configStatus, setConfigStatus] = useState<{ exists: boolean; valid: boolean } | null>(null);
  const [state, setState] = useState<PulseOronboxState | null>(null);
  // 连接/断开的唯一前端入口（复用 preload 已有的 connectBand/disconnectBand）
  const band = useBandConnection();

  useEffect(() => {
    if (screen === 'minibar') return;
    window.pulse?.getDeviceConfigStatus?.().then((st) => {
      if (st) setConfigStatus(st);
    });
  }, [screen, showSetup]);

  const handleThemeChange = (newTheme: 'light' | 'dark') => {
    setTheme(newTheme);
    try {
      localStorage.setItem('pulse-theme', newTheme);
    } catch {}
  };

  // 跨窗口主题同步：主窗口状态作为唯一源，MiniBar窗口通过storage事件响应
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'pulse-theme' && (e.newValue === 'light' || e.newValue === 'dark')) {
        setTheme(e.newValue);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // MiniBar 独立窗口适配
  useEffect(() => {
    if (screen === 'minibar') {
      document.documentElement.classList.add('screen-minibar');
      return () => {
        document.documentElement.classList.remove('screen-minibar');
      };
    }
  }, [screen]);

  // 全局防止文件拖拽导致 Electron 默认导航
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // 恢复原有 daemon/device 状态订阅
  useEffect(() => {
    if (screen === 'minibar') return;
    if (!window.pulse) return;
    let alive = true;
    window.pulse.getOronboxState().then((s) => alive && setState(s));
    const unsubState = window.pulse.onOronboxState((s) => setState(s));
    return () => {
      alive = false;
      unsubState();
    };
  }, [screen]);

  // 主题切换效果生效到 html 根节点
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // 如果处于 MiniBar 独立小窗
  if (screen === 'minibar') {
    return <MiniBar theme={theme} showAgents={showAgents} />;
  }

  const handleNavigate = (newPage: PulsePage) => {
    setPage(newPage);
  };

  const getSubtitle = () => {
    switch (page) {
      case 'overview':
        return '· 概览';
      case 'band':
        return '· 手环管理';
      case 'settings':
        return '· 设置';
      default:
        return undefined;
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-[var(--bg-app)] text-[var(--text-primary)] overflow-hidden transition-colors duration-200">
      {/* 顶部自绘标题栏 */}
      <TopBar
        subtitle={getSubtitle()}
        theme={theme}
        onToggleTheme={() => handleThemeChange(theme === 'light' ? 'dark' : 'light')}
      />

      {/* 主体工作区布局：左侧导航 + 右侧主内容 */}
      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentPage={page} onNavigate={handleNavigate} />

        <ContentArea>
          {page === 'overview' && (
            <div className="space-y-5">
              {configStatus !== null && !configStatus.exists && (
                <div className="p-4 rounded-[var(--radius-lg)] bg-amber-500/10 border border-amber-500/30 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-[var(--radius-md)] bg-amber-500/20 flex items-center justify-center text-amber-600 dark:text-amber-400 shrink-0">
                      <Watch className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-[var(--text-primary)]">
                        尚未配置小米手环
                      </h4>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                        绑定手环并导入日志后，即可在手环屏幕实时查看 AI 编程助手状态与配额。
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSetup(true)}
                    className="px-3.5 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium cursor-pointer transition-colors shadow-sm shrink-0"
                  >
                    配置手环
                  </button>
                </div>
              )}
              {/* 额度验证未完成：明确标注"未验证"，并提供继续验证入口 */}
              {quotaVerify === 'deferred' && (
                <div className="p-4 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-[var(--radius-md)] bg-[var(--bg-app)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
                      <Clock3 className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold text-[var(--text-primary)]">
                        额度验证未完成
                      </h4>
                      <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                        你选择了稍后验证，本项不会记录为已验证。可在手环上打开 Pulse 后回到向导第 4 步继续。
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSetupStartIndex(3);
                      setShowSetup(true);
                    }}
                    className="px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer transition-colors shrink-0"
                  >
                    继续验证
                  </button>
                </div>
              )}
              <BandConnectionCard
                connectionState={state?.connection.state}
                rawError={state?.connection.error}
                onConnect={band.connect}
                onDisconnect={band.disconnect}
                busy={band.busy}
                canConnect={band.canConnect}
              />
              {showAgents && <AgentSection />}
            </div>
          )}

          {page === 'band' && (
            <BandManagementPage
              onStartSetup={() => {
                setSetupStartIndex(0);
                setShowSetup(true);
              }}
            />
          )}

          {page === 'settings' && (
            <SettingsPage
              theme={theme}
              onThemeChange={handleThemeChange}
              showAgents={showAgents}
              onShowAgentsChange={setShowAgents}
            />
          )}
        </ContentArea>
      </div>

      {/* 配置手环向导 (默认隐藏，仅在触发「配置手环」时展示) */}
      {showSetup && (
        <SetupWizard
          initialStepIndex={setupStartIndex}
          onClose={() => setShowSetup(false)}
          onFinish={(outcome) => {
            if (outcome) setQuotaVerify(outcome);
            setShowSetup(false);
          }}
        />
      )}
    </div>
  );
};

export default App;
