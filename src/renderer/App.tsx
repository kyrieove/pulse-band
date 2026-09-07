/**
 * Pulse 2.0 主界面：自绘标题栏 + 左侧导航（设备管理主屏 / 运行诊断次屏）。
 * 旧悬浮看板（FloatingPill / ExpandedPanel）不再挂载，组件文件阶段 6 删除。
 *
 * README 避坑 3：全局拦截 dragover/drop，防止 Electron 把拖入的 .rpk 当导航处理；
 * 真正的接收在 DeviceScreen 的投放区。
 */
import React, { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { TitleBar } from './components/pulse/TitleBar';
import { Sidebar, type Screen } from './components/pulse/Sidebar';
import { DeviceScreen } from './components/pulse/DeviceScreen';
import { DiagnosticsScreen } from './components/pulse/DiagnosticsScreen';
import { MiniBar } from './components/minibar/MiniBar';
import type { PulseOronboxState, PulseErrorEntry } from '../main/services/oronbox-bridge';

type AppScreen = Screen | 'minibar';

const initialScreen = (): AppScreen => {
  try {
    const s = new URLSearchParams(window.location.search).get('screen');
    if (s === 'minibar') return 'minibar';
    return s === 'diagnostics' ? 'diagnostics' : 'main';
  } catch {
    return 'main';
  }
};

export const App: React.FC = () => {
  const [screen, setScreen] = useState<AppScreen>(initialScreen);
  const [state, setState] = useState<PulseOronboxState | null>(null);
  const [errors, setErrors] = useState<PulseErrorEntry[]>([]);
  const [degradedDismissed, setDegradedDismissed] = useState(false);

  useEffect(() => {
    if (screen === 'minibar') {
      document.documentElement.classList.add('screen-minibar');
      return () => {
        document.documentElement.classList.remove('screen-minibar');
      };
    }
  }, [screen]);

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    if (screen === 'minibar') return;
    if (!window.pulse) return;
    let alive = true;
    window.pulse.getOronboxState().then((s) => alive && setState(s));
    const unsubState = window.pulse.onOronboxState((s) => setState(s));
    window.pulse.getErrorLog().then((entries) => alive && setErrors(entries));
    const unsubLog = window.pulse.onErrorLog((entries) => setErrors(entries));
    return () => {
      alive = false;
      unsubState();
      unsubLog();
    };
  }, [screen]);

  if (screen === 'minibar') {
    return <MiniBar />;
  }

  const degraded = state?.daemon.degraded === true && !degradedDismissed;
  const degradation = state?.daemon.degradation;

  return (
    <div className="w-full h-full flex flex-col bg-island-bg overflow-hidden">
      <TitleBar subtitle={screen === 'main' ? '· 小米手环 10 配套助手' : '· 运行诊断中心'} />

      {/* 阶段 4：protocolVersion 不匹配 → 顶部明显警告条（不退出、不停 daemon，按硬约束 6 降级） */}
      {degraded && (
        <div className="shrink-0 p-3 bg-amber-950/40 border-b border-amber-500/40 text-amber-300 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-md bg-amber-500/20 flex items-center justify-center shrink-0">
              <TriangleAlert className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <div className="font-semibold text-amber-200 flex items-center gap-1.5">
                <span>后台服务协议版本不匹配 · 已启用降级兼容链路</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-100 font-mono">DEGRADED</span>
              </div>
              <div className="text-[11px] text-amber-400/90 mt-0.5">
                当前 OronBox Daemon 协议版本为{' '}
                <code className="font-mono font-bold">{degradation?.actual != null ? `v${degradation.actual}` : '未知'}</code>
                （期望版本为 <code className="font-mono font-bold">v{degradation?.expected ?? 6}</code>）。Pulse
                已自动降级以保证通信可用，请更新 OronBox。
              </div>
            </div>
          </div>
          <button onClick={() => setDegradedDismissed(true)} className="text-amber-400/70 hover:text-amber-200 p-1 text-xs">
            忽略
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <Sidebar screen={screen} onNavigate={setScreen} daemon={state?.daemon ?? null} />
        {screen === 'main' ? (
          <DeviceScreen state={state} />
        ) : (
          <DiagnosticsScreen
            daemon={state?.daemon ?? null}
            connection={state?.connection ?? { state: 'disconnected' }}
            errors={errors}
            onClearErrors={() => window.pulse?.clearErrorLog()}
          />
        )}
      </div>
    </div>
  );
};

export default App;
