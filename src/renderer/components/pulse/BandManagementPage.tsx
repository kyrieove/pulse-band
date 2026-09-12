import React, { useEffect, useState, useRef } from 'react';
import { Package, Upload, Loader2, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Watch } from 'lucide-react';
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

/**
 * 只有"进行中"的步骤才能被当作失败步骤名。
 *
 * 之前直接取最近一次活跃步骤，于是"已连接 → 链路断开 → error"这条路径会得到
 * failedStep='connected'，界面写出「连接失败于【已连接】」这种自相矛盾的文案。
 * connected 是终态，不是失败点，排除掉；排除后没有已知步骤就不写步骤名。
 */
const FAILABLE_STEPS: readonly ProgressStep[] = ['starting', 'searching', 'connecting', 'authenticating'];

/**
 * MAC 脱敏：保留前 2 组与后 2 组，隐藏中间字节。
 *
 * 不复用 device-config-service 的 maskMacAddress —— 那个模块顶层 import 了
 * node:child_process / node:fs / node:path，渲染进程直接引用会把 node 内置模块
 * 带进前端 bundle。本页是渲染层唯一需要脱敏的地方，故就地实现同形状的纯函数。
 * 地址只来自 useBandConnection 的只读快照，这里仅做展示层截断，
 * 不改变真实地址的存储与任何传递路径。
 */
const maskAddress = (address: string): string => {
  const clean = address.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length !== 12) return '已配置手环';
  return `${clean.slice(0, 2)}:${clean.slice(2, 4)}:**:**:${clean.slice(8, 10)}:${clean.slice(10, 12)}`;
};

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  // 手环设备信息（名称 / 地址 / 连接状态）来自 useBandConnection 的真实快照
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
  const lastStep = lastActiveStepRef.current;
  const failedStep =
    conn.state === 'error' && lastStep && FAILABLE_STEPS.includes(lastStep) ? lastStep : null;

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

  // 标题行只讲页面状态，设备身份交给设备卡，避免两处重复同一份信息
  const statusLine = !isConfigured
    ? '尚未配置手环'
    : isConnected
    ? '已连接'
    : isConnecting
    ? '正在连接…'
    : isError
    ? '连接失败'
    : '未连接';

  const addressLabel = conn.device?.address ? maskAddress(conn.device.address) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto custom-scrollbar">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">手环</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">{statusLine}</p>
        </div>
        {/* 配置入口全页只有一个：未配置时在设备卡里，已配置后降级为这里的次级入口 */}
        {isConfigured && (
          <button
            type="button"
            onClick={onStartSetup}
            className="rounded-full px-[15px] py-2 text-[12px] font-semibold select-none cursor-pointer transition-colors bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)]"
          >
            重新配置
          </button>
        )}
      </div>

      {/*
        设备卡：页面主体。五种状态五种面孔，全卡只有一个主操作。
        未配置 → 未连接 → 连接中 → 已连接 → 连接失败，互斥出现。
      */}
      <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-[10px] bg-[var(--accent-wash)] text-[var(--accent-primary)] flex items-center justify-center shrink-0">
            <Watch className="w-4 h-4" />
          </span>
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {isConfigured ? conn.device?.name ?? '已配对手环' : '尚未配置手环'}
          </h3>
        </div>

        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
          {!isConfigured
            ? '完成配对与日志导入后即可连接手环、安装手环端快应用'
            : addressLabel ?? '已配置手环'}
        </p>

        {/* 五步进度条只在"连接中"和"连接失败"时出现，其余状态一行都不占 */}
        {(isConnecting || isError) && <ConnectionProgress currentStep={step} failedStep={failedStep} />}

        {/* 连接失败诊断：失败于哪一步 + 底层原因。失败原因是这里的主信息，不截断 */}
        {isError && (
          <div className="flex items-start gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 text-[var(--status-error)] shrink-0 mt-0.5" />
            <div className="text-[11.5px] min-w-0">
              <p className="font-semibold text-[var(--status-error)]">
                {failedStep ? `连接失败于【${STEP_LABELS[failedStep]}】` : '连接失败'}
              </p>
              <p className="text-[var(--text-muted)] mt-0.5 leading-relaxed">
                {conn.error || '无法与手环建立蓝牙通讯，请确认手环在附近且蓝牙已开启'}
              </p>
            </div>
          </div>
        )}

        {/* 主操作：每个状态有且只有一个 */}
        <div className="pt-1">
          {!isConfigured ? (
            <button
              type="button"
              onClick={onStartSetup}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5"
            >
              配置手环
            </button>
          ) : isConnecting ? (
            /* 取消 = 放弃本次连接。core 没有独立的 cancel RPC，
               复用的是 device.disconnect（把 desired_connected 置回 false 并释放链路），
               与「断开连接」是同一个原语，不存在两套断开语义。 */
            <button
              type="button"
              onClick={() => void conn.disconnect()}
              disabled={conn.busy}
              className="rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              取消
            </button>
          ) : isConnected ? (
            /* 断开是已连接状态的日常主操作，与概览页断开入口同一个动作 */
            <button
              type="button"
              onClick={() => void conn.disconnect()}
              disabled={conn.busy}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              断开连接
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void conn.connect()}
              disabled={!conn.canConnect}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isError ? '重试连接' : '连接'}
            </button>
          )}
        </div>
      </section>

      {/* 手环端应用卡：已配置后才出现，只讲快应用，不混设备信息 */}
      {isConfigured && (
        <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Package className="w-4 h-4 text-[var(--accent-primary)] shrink-0" />
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                Pulse 手环端快应用
              </h3>
            </div>
            <span className="shrink-0 text-[11px] font-mono text-[var(--text-muted)]">
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

          <div className="pt-1">
            <button
              type="button"
              onClick={reinstall}
              disabled={installing}
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
            >
              {installing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {installing ? '安装中…' : installResult?.ok ? '重装 Pulse 手环端' : '安装 Pulse 手环端'}
            </button>
          </div>
        </section>
      )}

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
