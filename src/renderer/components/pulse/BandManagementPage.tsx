import React, { useEffect, useState } from 'react';
import { Package, Upload, Loader2 } from 'lucide-react';
import { useBandConnection } from '../../hooks/useBandConnection';
import { OtherAppInstall } from './OtherAppInstall';
import { ConnectionProgress, type ProgressStep } from './ConnectionProgress';

export interface BandManagementPageProps {
  onStartSetup?: () => void;
}

interface BundledInfo {
  exists: boolean;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  manifestValid?: boolean;
}

/** 连接状态 → 五步进度条中的位置；未开始 / 失败 → null */
const CONN_STEP: Record<string, ProgressStep | null> = {
  starting: 'starting',
  searching: 'searching',
  connecting: 'connecting',
  authenticating: 'authenticating',
  connected: 'connected',
  idle: null,
  disconnected: null,
  error: null,
};

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  // 手环设备信息（名称 / MAC / 连接状态）来自 useBandConnection 的真实快照，无需 state?.bandInfo（该字段不存在）
  const conn = useBandConnection();

  // 内置手环端快应用的版本信息来自真实 manifest（安装动作在设置向导第 6 步）
  const [bundled, setBundled] = useState<BundledInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

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

  const reinstall = async () => {
    if (!window.pulse?.appInstall?.installBundled) return;
    setInstalling(true);
    setInstallMsg(null);
    try {
      const res = await window.pulse.appInstall.installBundled();
      setInstallMsg(res?.coreStatus === 'completed' ? '已安装' : `未完成（${res?.coreStatus ?? 'unknown'}）`);
    } catch (err: any) {
      setInstallMsg(err?.message ?? '安装失败');
    } finally {
      setInstalling(false);
    }
  };

  const step = CONN_STEP[conn.state] ?? null;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">手环</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
            {conn.device?.name ?? '尚未配置手环'}
            {conn.device?.address ? ` · ${conn.device.address}` : ''}
            {conn.device ? ` · ${conn.device.disconnected ? '未连接' : '已连接'}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={onStartSetup}
          className="rounded-full px-[15px] py-2 text-[12px] font-semibold select-none cursor-pointer transition-colors bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)]"
        >
          重新配置
        </button>
      </div>

      {/* 五步进度条 */}
      <ConnectionProgress currentStep={step} />

      {/* 下排双卡 */}
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-2.5">
        {/* 内置手环应用 */}
        <section className="min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-[var(--text-muted)]" />
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">内置手环应用</h3>
          </div>
          <div className="mt-2.5 flex items-baseline gap-2">
            <span className="text-[12px] text-[var(--text-secondary)]">Pulse 手环端</span>
            <span className="text-[11px] font-mono text-[var(--text-muted)]">
              {bundled === null
                ? '读取中…'
                : !bundled.exists
                ? '内置包缺失'
                : `v${bundled.versionName ?? '?'} (${bundled.versionCode ?? '?'})`}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
            配套快应用在手环屏幕实时渲染 Agent 状态与配额，随桌面端发布。
          </p>
          {installMsg && (
            <p className="mt-1.5 text-[11px] text-[var(--status-error)]">{installMsg}</p>
          )}
          <div className="mt-auto pt-3">
            <button
              type="button"
              onClick={reinstall}
              disabled={conn.state !== 'connected' || installing}
              className="btn-primary rounded-full w-full py-2 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              {installing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {installing ? '安装中…' : conn.state === 'connected' ? '重装' : '连接后重装'}
            </button>
          </div>
        </section>

        {/* 推送其他快应用 */}
        <section className="min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
          <div className="flex items-center gap-2.5">
            <Upload className="w-4 h-4 text-[var(--text-muted)]" />
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">推送其他快应用</h3>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)] leading-relaxed">
            安装第三方或自行构建的 .rpk 到手环，与内置安装共用同一条通道。
          </p>
          <div className="mt-2 flex-1 min-h-0">
            <OtherAppInstall connected={conn.state === 'connected'} />
          </div>
        </section>
      </div>
    </div>
  );
};