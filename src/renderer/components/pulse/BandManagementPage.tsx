import React, { useCallback, useEffect, useState } from 'react';
import { Watch, Package, ChevronDown, ChevronRight, Upload, Download, Loader2 } from 'lucide-react';
import { useBandConnection } from '../../hooks/useBandConnection';
import type { InstallProgressEvent } from '../../../common/types';

export interface BandManagementPageProps {
  onStartSetup?: () => void;
}

const CONN_STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
  error: '连接失败',
};

interface BundledInfo {
  exists: boolean;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  manifestValid?: boolean;
}

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const conn = useBandConnection();

  // 内置手环端快应用：版本信息来自真实 manifest，安装为一键动作
  const [bundled, setBundled] = useState<BundledInfo | null>(null);
  const [installBusy, setInstallBusy] = useState(false);
  const [installProgress, setInstallProgress] = useState<number | null>(null);
  const [installMessage, setInstallMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    window.pulse?.appInstall
      ?.getBundledInfo?.()
      .then((info) => {
        if (alive && info) setBundled(info as BundledInfo);
      })
      .catch(() => {
        if (alive) setBundled({ exists: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.pulse?.appInstall?.onProgress?.((ev: InstallProgressEvent) => {
      if (typeof ev.percentage === 'number') setInstallProgress(ev.percentage);
      if (ev.status === 'failed') {
        setInstallBusy(false);
        setInstallProgress(null);
      }
    });
    return () => unsubscribe?.();
  }, []);

  const installBundled = useCallback(async () => {
    setInstallBusy(true);
    setInstallProgress(0);
    setInstallMessage(null);
    try {
      const res = await window.pulse?.appInstall?.installBundled?.();
      if (!res) {
        setInstallMessage({ ok: false, text: '安装接口不可用' });
        return;
      }
      // 只有 pulse-core 依据真实设备结果返回 completed 才算成功
      if (res.coreStatus === 'completed') {
        setInstallMessage({
          ok: true,
          text: `设备已确认安装完成（${res.packageId ?? '未知包'} / versionCode ${res.versionCode ?? '?'}）`,
        });
      } else {
        setInstallMessage({
          ok: false,
          text: `设备未确认安装完成（core 状态：${res.coreStatus ?? 'unknown'}）`,
        });
      }
    } catch (err: any) {
      setInstallMessage({ ok: false, text: err?.message ?? '安装失败' });
    } finally {
      setInstallBusy(false);
      setInstallProgress(null);
    }
  }, []);

  const canInstall = conn.state === 'connected' && !installBusy && bundled?.exists === true;

  return (
    <div className="space-y-5">
      {/* 设备状态区域 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-secondary)]">
              <Watch className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                {conn.device?.name ?? 'Xiaomi Smart Band 10'}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {conn.device ? '已配置手环' : '尚未载入已配对手环'} · 状态：
                {CONN_STATE_TEXT[conn.state] ?? '未连接'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onStartSetup}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors cursor-pointer"
            title="进入手环设置向导，重新配置设备"
          >
            更换手环
          </button>
        </div>

        {conn.state === 'error' && conn.error && (
          <p className="text-xs text-[var(--status-error)] leading-relaxed">{conn.error}</p>
        )}

        <div className="pt-3 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>日常连接与同步管理</span>
          <div className="flex items-center gap-2 select-none">
            <button
              type="button"
              onClick={conn.connect}
              disabled={!conn.canConnect}
              className="px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {conn.state === 'connecting' ? '连接中…' : '连接'}
            </button>
            <button
              type="button"
              onClick={conn.disconnect}
              disabled={conn.state !== 'connected' || conn.busy}
              className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              断开
            </button>
          </div>
        </div>
      </section>

      {/* Pulse 快应用：真实版本信息 + 一键安装 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-[var(--text-muted)]" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Pulse 手环快应用
            </h3>
          </div>
          <span className="text-xs font-mono text-[var(--text-muted)]">
            {bundled === null
              ? '读取中…'
              : !bundled.exists
              ? '内置包缺失'
              : `v${bundled.versionName ?? '?'} (versionCode ${bundled.versionCode ?? '?'})`}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          配套手环端快应用负责在手环屏幕上实时渲染 Agent 运行状态与配额。安装包随桌面端发布，无需自行选择文件。
        </p>

        <div className="flex items-center gap-2 select-none">
          <button
            type="button"
            onClick={installBundled}
            disabled={!canInstall}
            title={
              conn.state !== 'connected'
                ? '请先连接手环'
                : bundled?.exists !== true
                ? '内置安装包缺失，无法安装'
                : '安装或重新安装内置手环端快应用'
            }
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {installBusy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>{installBusy ? '正在安装…' : '安装／重新安装手环端'}</span>
          </button>
          {installProgress !== null && (
            <span className="text-xs text-[var(--text-muted)]">{installProgress}%</span>
          )}
        </div>

        {installMessage && (
          <p
            className={`text-xs leading-relaxed ${
              installMessage.ok ? 'text-emerald-400' : 'text-[var(--status-error)]'
            }`}
          >
            {installMessage.text}
          </p>
        )}
      </section>

      {/* 高级区域：推送其他快应用 (默认折叠) */}
      <section className="rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] overflow-hidden transition-colors duration-200">
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-[var(--bg-app)] transition-colors"
        >
          <div className="flex items-center gap-2">
            {advancedOpen ? (
              <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
            ) : (
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            )}
            <span className="text-xs font-medium text-[var(--text-primary)]">
              高级工具：推送其他快应用
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            {advancedOpen ? '点击收起' : '默认折叠'}
          </span>
        </button>

        {advancedOpen && (
          <div className="p-5 pt-1 border-t border-[var(--border-default)] space-y-3">
            <div className="p-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] text-center space-y-2 bg-[var(--bg-app)]">
              <Upload className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
              <p className="text-xs text-[var(--text-secondary)]">
                支持拖入或选择单个 .rpk 文件
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">
                高级开发工具，非页面主要视觉中心
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
