import React, { useEffect, useState } from 'react';
import { TopBar } from './components/layout/TopBar';
import { Sidebar, type PulsePage } from './components/layout/Sidebar';
import { ContentArea } from './components/layout/ContentArea';
import { BandConnectionCard } from './components/pulse/BandConnectionCard';
import { AgentSection } from './components/pulse/AgentSection';
import { BandManagementPage } from './components/pulse/BandManagementPage';
import { SettingsPage } from './components/pulse/SettingsPage';
import { SetupWizard } from './components/setup';
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
  const [state, setState] = useState<PulseOronboxState | null>(null);
  // 连接/断开的唯一前端入口（复用 preload 已有的 connectBand/disconnectBand）
  const band = useBandConnection();

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
            <BandManagementPage onStartSetup={() => setShowSetup(true)} />
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
          onClose={() => setShowSetup(false)}
          onFinish={() => setShowSetup(false)}
        />
      )}
    </div>
  );
};

export default App;
