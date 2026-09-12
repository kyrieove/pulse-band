import React, { useEffect, useState } from 'react';
import { TopBar } from './components/layout/TopBar';
import { StatusBar } from './components/layout/StatusBar';
import { Sidebar, type PulsePage } from './components/layout/Sidebar';
import { ContentArea } from './components/layout/ContentArea';
import { OverviewPage } from './components/pulse/OverviewPage';
import { BandManagementPage } from './components/pulse/BandManagementPage';
import { WatchFacePage } from './components/pulse/WatchFacePage';
import { SettingsPage } from './components/pulse/SettingsPage';
import { SetupWizard } from './components/setup';
import { DiagnosticsScreen } from './components/pulse/DiagnosticsScreen';
import { MiniBar } from './components/minibar/MiniBar';
import { useBandConnection } from './hooks/useBandConnection';
import { useQuotaState } from './hooks/useQuotaState';
import type { PulseOronboxState } from '../main/services/oronbox-bridge';
import type { PulseErrorEntry } from '../main/services/error-log';

type AppScreen = PulsePage | 'minibar';

const getInitialScreen = (): AppScreen => {
  try {
    const s = new URLSearchParams(window.location.search).get('screen');
    if (s === 'minibar') return 'minibar';
    if (s === 'band' || s === 'settings' || s === 'watchface') return s;
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
  const [showSetup, setShowSetup] = useState<boolean>(false);
  /** 向导打开时落在第几步（0-based）：稍后验证后可回到第 4 步继续 */
  const [setupStartIndex, setSetupStartIndex] = useState<number>(0);
  const [errors, setErrors] = useState<PulseErrorEntry[]>([]);
  const [state, setState] = useState<PulseOronboxState | null>(null);
  // 连接/断开的唯一前端入口（复用 preload 已有的 connectBand/disconnectBand）
  const band = useBandConnection();
  // 额度/会话数据唯一来源：概览页与 TopBar 共用这一份，不再起第二个订阅
  const { state: quota, updatedAt, lastError, loading, refreshing, refresh } = useQuotaState();

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
    return <MiniBar theme={theme} />;
  }

  const handleNavigate = (newPage: PulsePage) => {
    setPage(newPage);
  };

  // 运行诊断页：进入时拉取主进程错误日志，清空后同步本地态
  useEffect(() => {
    if (page !== 'diagnostics') return;
    let alive = true;
    window.pulse?.getErrorLog?.().then((d) => {
      if (alive) setErrors((d as PulseErrorEntry[]) ?? []);
    });
    return () => {
      alive = false;
    };
  }, [page, showSetup]);

  const clearErrors = () => {
    void window.pulse?.clearErrorLog?.().then(() => setErrors([]));
  };

  return (
    <div className="w-full h-full flex bg-[var(--bg-surface)] text-[var(--text-primary)] overflow-hidden transition-colors duration-200">
      <Sidebar currentPage={page} onNavigate={handleNavigate} />

      {/* 右栏：状态顶栏 + 内容区 */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <TopBar />

        <ContentArea>
          {page === 'overview' && (
            <OverviewPage
              quota={quota}
              loading={loading}
              refreshing={refreshing}
              onRefresh={refresh}
              bandDeviceName={band.device?.name ?? null}
              bandConnected={band.state === 'connected'}
              bandBusy={band.busy}
              bandCanConnect={band.canConnect}
              onConnect={() => void band.connect()}
            />
          )}

          {page === 'band' && (
            <BandManagementPage
              onStartSetup={() => {
                setSetupStartIndex(0);
                setShowSetup(true);
              }}
            />
          )}

          {page === 'watchface' && <WatchFacePage onNavigate={handleNavigate} />}

          {page === 'settings' && (
            <SettingsPage
              theme={theme}
              onThemeChange={handleThemeChange}
              onOpenDiagnostics={() => handleNavigate('diagnostics')}
            />
          )}

          {page === 'diagnostics' && (
            <DiagnosticsScreen
              daemon={state?.daemon ?? null}
              connection={state?.connection ?? { state: 'disconnected' }}
              errors={errors}
              onClearErrors={clearErrors}
              updatedAt={updatedAt}
              onRefresh={refresh}
            />
          )}
        </ContentArea>
        <StatusBar state={quota} updatedAt={updatedAt} lastError={lastError} />
      </div>

      {/* 配置手环向导 (默认隐藏，仅在触发「配置手环」时展示) */}
      {showSetup && (
        <SetupWizard
          initialStepIndex={setupStartIndex}
          onClose={() => setShowSetup(false)}
          onFinish={() => setShowSetup(false)}
        />
      )}
    </div>
  );
};

export default App;
