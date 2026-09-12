import React, { useCallback, useEffect, useState, useRef } from 'react';
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
 * 磁盘上的手环配置状态（%LOCALAPPDATA%/PulseDev/run/device.json）。
 *
 * 「是否已配置」的唯一权威来源。不能拿 conn.device 判断 —— 见下面的注释。
 */
interface DeviceConfigStatus {
  exists: boolean;
  valid: boolean;
  deviceName?: string;
  maskedAddr?: string;
  codename?: string;
  error?: string;
}

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  // 手环设备信息（名称 / 地址 / 连接状态）来自 useBandConnection 的真实快照
  const conn = useBandConnection();

  // 内置手环端快应用的版本信息来自真实 manifest
  const [bundled, setBundled] = useState<BundledInfo | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showOtherApps, setShowOtherApps] = useState(false);

  // 磁盘上的配置状态 —— 「已配置」的权威来源，与"当前是否连着"无关
  const [config, setConfig] = useState<DeviceConfigStatus | null>(null);

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

  /**
   * 读磁盘上的配置状态。
   *
   * 「是否已配置」不能用 conn.device 判断：core 的 device.status 在未连接时把 device
   * 直接置为 null（core/src/live.rs:1056 `if connected { live_device_json() } else { Null }`），
   * oronbox-bridge 的 safeDevice(null) 同样返回 null。于是拿 conn.device 当"已配置"
   * 会把「断开」误判成「尚未配置」—— 已配对的用户一断开就被推回配置向导，
   * 而向导第 1 步是「导入手机日志」、第 2 步才是「连接手环」，
   * 表现成"想连手环必须先点配置手环"。
   *
   * 配置本身确实是连接的技术前提（core/src/live.rs:551 `read_device_auth_mac()?`
   * 需要 device.json 里的 addr 与 32 位 authkey），所以未配置时只给「配置手环」是对的；
   * 错的只是把"已配置"和"当前连着"混为一谈。
   *
   * 重读时机：挂载时、连接状态变化后（向导内连上会触发）、窗口重新获得焦点时
   * （向导是覆盖层，本页不卸载，关闭向导后靠 focus 兜底）。
   */
  const readConfig = useCallback(() => {
    window.pulse
      ?.getDeviceConfigStatus?.()
      .then((s) => {
        if (s) setConfig(s);
      })
      .catch(() => {
        /* IPC 不可用时保持上一次结果，不把"未知"当成"未配置" */
      });
  }, []);

  useEffect(() => {
    readConfig();
  }, [readConfig, conn.state]);

  useEffect(() => {
    window.addEventListener('focus', readConfig);
    return () => window.removeEventListener('focus', readConfig);
  }, [readConfig]);

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

  const isConnected = conn.state === 'connected';
  const isConnecting = conn.state === 'connecting';
  const isError = conn.state === 'error';

  // 「已配置」看磁盘，不看连接状态 —— 断开手环不会取消配置
  const configKnown = config !== null;
  const isConfigured = Boolean(config?.exists && config?.valid);

  const deviceName = config?.deviceName ?? conn.device?.name ?? '已配对手环';
  // 脱敏地址由主进程 maskMacAddress 给出，渲染层不再自己截断一份
  const addressLabel = config?.maskedAddr ?? null;

  const cardTitle = !configKnown
    ? '手环'
    : isConfigured
    ? deviceName
    : config?.exists
    ? '手环配置无效'
    : '尚未配置手环';

  // 标题行只讲页面状态，设备身份交给设备卡，避免两处重复同一份信息。
  // 未配置时用简写「未配置」，不与设备卡标题「尚未配置手环」重复同一句话。
  const statusLine = !configKnown
    ? '读取中…'
    : !isConfigured
    ? config?.exists
      ? '配置无效'
      : '未配置'
    : isConnected
    ? '已连接'
    : isConnecting
    ? '正在连接…'
    : isError
    ? '连接失败'
    : '未连接';

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
        「已配置」来自磁盘 device.json，与当前连接状态无关：
        断开手环不会退回未配置，配置入口也只在未配置时出现在卡内。
      */}
      <section className="rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-[10px] bg-[var(--accent-wash)] text-[var(--accent-primary)] flex items-center justify-center shrink-0">
            <Watch className="w-4 h-4" />
          </span>
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {cardTitle}
          </h3>
        </div>

        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
          {!configKnown
            ? '正在读取本机手环配置'
            : !isConfigured
            ? config?.error ?? '完成配对与日志导入后即可连接手环、安装手环端快应用'
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
          {!configKnown ? (
            /* 配置状态还没读回来：不给任何可点动作，避免把"未知"渲染成"未配置" */
            <button
              type="button"
              disabled
              className="btn-primary rounded-full w-full py-2.5 text-[12px] font-semibold select-none bg-[var(--accent-primary)] text-white flex items-center justify-center gap-1.5 opacity-50 cursor-not-allowed"
            >
              读取配置中…
            </button>
          ) : !isConfigured ? (
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

      {/*
        ↓ 将来插卡位置：运动 / 睡眠数据卡放在这里（设备卡之下、手环端应用卡之上）。
        本轮不实现，也不放「即将支持」占位 —— docs/design/pulse-2.0-design-system.md:34
        「严禁展示不可用功能入口」。位置留在这里，将来直接插一张 <section> 即可，
        不需要再动页面骨架。
      */}

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
            {/*
              这里标的是「内置包」版本，即 Pulse 自带的那份 .rpk 的版本，
              不是手环上已安装的版本 —— 协议侧没有任何 RPC 能读出手环已装版本
              （device.app.* 只有 install.prepare/chunk/commit/cancel/mode），
              所以不写「已装版本」，避免把本地包版本冒充成设备状态。
            */}
            <span className="shrink-0 text-[11px] font-mono text-[var(--text-muted)]">
              {bundled === null
                ? '读取中…'
                : !bundled.exists
                ? '内置包缺失'
                : `内置包 v${bundled.versionName ?? '?'} (${bundled.versionCode ?? '?'})`}
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
            {/* 次级操作：页面唯一的主操作在设备卡，这里保持描边样式不抢权重。
                安装要走蓝牙通道，未连接时禁用并说明原因。 */}
            <button
              type="button"
              onClick={reinstall}
              disabled={!isConnected || installing}
              title={!isConnected ? '需要先连接手环' : undefined}
              className="rounded-full w-full py-2.5 text-[12px] font-semibold select-none cursor-pointer bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)] flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
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
