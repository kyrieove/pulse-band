import React, { useEffect, useState, useRef } from 'react';
import { Package, Upload, Loader2, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
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

const STEP_LABELS: Record<ProgressStep, string> = {
  starting: '启动服务',
  searching: '查找手环',
  connecting: '建立连接',
  authenticating: '验证身份',
  connected: '已连接',
};

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  // 手环设备信息（名称 / MAC / 连接状态）来自 useBandConnection 的真实快照
  const conn = useBandConnection();

  // 内置手环端快应用的版本信息来自真实 manifest
  const [bundled, setBundled] = useState<BundledInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showOtherApps, setShowOtherApps] = useState(false);

  // 记录最近一次进行中的步骤，连接出错时可精准提示失败于哪一步
  const lastActiveStepRef = useRef<ProgressStep | null>(null);
  const step = CONN_STEP[conn.state] ?? null;
  if (step) {
    lastActiveStepRef.current = step;
  }
  const failedStep = conn.state === 'error' ? (lastActiveStepRef.current ?? 'connecting') : null;

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
    setInstallResult(null);
    try {
      const res = await window.pulse.appInstall.installBundled();
      if (res?.coreStatus === 'completed') {
        setInstallResult({
          ok: true,
          message: `手环端快应用安装成功 (v${res?.versionName ?? bundled?.versionName ?? '1.0.0'})`,
        });
      } else {
        setInstallResult({
          ok: false,
          message: `安装未确认完成 (core: ${res?.coreStatus ?? '未知'})`,
        });
      }
    } catch (err: any) {
      setInstallResult({
        ok: false,
        message: err?.message ?? '安装失败，请重试',
      });
    } finally {
      setInstalling(false);
    }
  };

  const isConfigured = Boolean(conn.device);
  const isConnected = conn.state === 'connected';
  const isConnecting = conn.state === 'connecting';
  const isError = conn.state === 'error';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto custom-scrollbar">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">手环</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
            {!isConfigured
              ? '尚未配置手环 · 请先完成配对手环与日志导入'
              : `${conn.device?.name ?? '已配对手环'}${conn.device?.address ? ` · ${conn.device.address}` : ''} · ${
                  isConnected ? '已连接' : isConnecting ? '连接中…' : isError ? '连接失败' : '未连接'
                }`}
          </p>
        </div>
        {/* 右上角按钮：未配置时为主入口「配置手环」，已配置时为次级「重新配置」 */}
        <button
          type="button"
          onClick={onStartSetup}
          className={`rounded-full px-[15px] py-2 text-[12px] font-semibold select-none cursor-pointer transition-colors ${
            !isConfigured
              ? 'btn-primary bg-[var(--accent-primary)] text-white'
              : 'bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)]'
          }`}
        >
          {isConfigured ? '重新配置' : '配置手环'}
        </button>
      </div>

      {/* 五步连接进度条 */}
      <ConnectionProgress currentStep={step} failedStep={failedStep} />

      {/* 连接失败诊断与重试条 */}
      {isError && (
        <div className="p-3.5 rounded-[10px] bg-rose-500/[0.08] border border-rose-500/20 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-[var(--status-error)] shrink-0 mt-0.5" />
            <div className="text-xs">
              <span className="font-semibold text-[var(--status-error)]">
                连接失败于【{failedStep ? STEP_LABELS[failedStep] : '建立连接'}】
              </span>
              <p className="text-[var(--text-muted)] mt-0.5 truncate">
                {conn.error || '无法与手环建立蓝牙通讯，请确认手环在附近且蓝牙已开启'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void conn.connect()}
            disabled={conn.busy}
            className="btn-primary shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold bg-[var(--accent-primary)] text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            重试连接
          </button>
        </div>
      )}

      {/* 主卡：手环连接与核心 Pulse 应用管理 */}
      <section className="rounded-[10px] bg-[var(--bg-subtle)] p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-[var(--accent-primary)]" />
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">Pulse 手环端快应用</h3>
          </div>
          <span className="text-[11px] font-mono text-[var(--text-muted)]">
            {bundled === null
              ? '读取中…'
              : !bundled.exists
              ? '内置包缺失'
              : `v${bundled.versionName ?? '?'} (${bundled.versionCode ?? '?'})`}
          </span>
        </div>

        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
          配套快应用在手环屏幕实时渲染 Claude、Codex、Antigravity 的运行状态与 5h/7d 剩余额度。
        </p>

        {/* 安装反馈文案：成功用 success，失败用 error */}
        {installResult && (
          <div
            className={`flex items-center gap-2 text-[11.5px] font-medium ${
              installResult.ok ? 'text-[var(--status-success)]' : 'text-[var(--status-error)]'
            }`}
          >
            {installResult.ok ? (
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            )}
            <span>{installResult.message}</span>
          </div>
        )}

        {/* 单一主操作按当前状态呈现 */}
        <div className="pt-2">
          {!isConfigured ? (
            <button
              type="button"
              onClick={onStartSetup}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5"
            >
              配置手环
            </button>
          ) : isConnecting ? (
            <button
              type="button"
              disabled
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none bg-[var(--accent-primary)] text-white opacity-70 cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              连接中…
            </button>
          ) : !isConnected ? (
            <button
              type="button"
              onClick={() => void conn.connect()}
              disabled={conn.busy}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {isError ? '重试连接' : '连接手环'}
            </button>
          ) : (
            <button
              type="button"
              onClick={reinstall}
              disabled={installing}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {installing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {installing ? '安装中…' : installResult?.ok ? '重装 Pulse 手环端' : '安装 Pulse 手环端'}
            </button>
          )}
        </div>
      </section>

      {/* 次级入口：第三方或自建快应用 RPK 推送 */}
      <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
        <button
          type="button"
          onClick={() => setShowOtherApps((prev) => !prev)}
          className="flex items-center justify-between w-full text-left cursor-pointer select-none"
        >
          <div className="flex items-center gap-2">
            <Upload className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <h4 className="text-[12px] font-medium text-[var(--text-secondary)]">推送其他快应用 (.rpk)</h4>
          </div>
          {showOtherApps ? (
            <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
          )}
        </button>

        {showOtherApps && (
          <div className="mt-3 pt-3 border-t border-[var(--border-default)]">
            <p className="text-[11px] text-[var(--text-muted)] mb-3 leading-relaxed">
              安装第三方或自行构建的 .rpk 到手环，与内置安装共用同一条蓝牙通道。
            </p>
            <OtherAppInstall connected={isConnected} />
          </div>
        )}
      </section>
    </div>
  );
};