import React from 'react';
import { Watch, BluetoothOff, CheckCircle2, RefreshCw, AlertCircle, ArrowRight, Loader2, Radio, KeyRound } from 'lucide-react';
import { ConnectionProgress, type ProgressStep } from './ConnectionProgress';

export type BandConnectionState =
  | 'idle'
  | 'starting'
  | 'searching'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

export interface BandConnectionCardProps {
  connectionState?: unknown;
  rawError?: string;
  lastSyncedText?: string;
  /** 连接/断开动作由上层注入（复用同一套 IPC，不在卡片内自建连接逻辑） */
  onConnect?: () => void;
  onDisconnect?: () => void;
  busy?: boolean;
  canConnect?: boolean;
}

/** 消毒脱敏错误信息，彻底杜绝路径、密钥与内部堆栈暴露 */
function sanitizeErrorMessage(raw?: string): string {
  if (!raw) return '连接出现异常，请确认手环处于可连接状态后重试。';
  const lower = raw.toLowerCase();
  if (lower.includes('auth') || lower.includes('hmac') || lower.includes('key')) {
    return '设备认证信息失效或不匹配，请在手环设置中重新配对。';
  }
  if (lower.includes('rfcomm') || lower.includes('busy') || lower.includes('channel') || lower.includes('occup')) {
    return '手环蓝牙通道已被占用，请在手环上选择“连接新手机”进入可连接模式。';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return '连接超时，请确认手环位于电脑蓝牙通信范围内并保持亮屏。';
  }
  if (lower.includes('device') || lower.includes('not found') || lower.includes('offline')) {
    return '未找到目标手环，请确保手环蓝牙已开启。';
  }
  return '连接通信异常，请检查手环状态后重新尝试。';
}

/** 将外部 props 严格归一化为 7 种标准状态，杜绝任何假状态与默认写死 */
function normalizeState(val: unknown): BandConnectionState {
  if (val === 'connected') return 'connected';
  if (val === 'connecting') return 'connecting';
  if (val === 'starting') return 'starting';
  if (val === 'searching') return 'searching';
  if (val === 'authenticating') return 'authenticating';
  if (val === 'error') return 'error';
  return 'idle';
}

export const BandConnectionCard: React.FC<BandConnectionCardProps> = ({
  connectionState,
  rawError,
  lastSyncedText,
  onConnect,
  onDisconnect,
  busy = false,
  canConnect = false,
}) => {
  const state = normalizeState(connectionState);

  const isConnected = state === 'connected';
  const isError = state === 'error';
  const isProgressing =
    state === 'starting' ||
    state === 'searching' ||
    state === 'connecting' ||
    state === 'authenticating';

  // 映射当前步骤给进度条
  const progressStep: ProgressStep = isConnected ? 'connected' : isProgressing ? state : 'starting';

  return (
    <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
      {/* 头部信息与当前状态徽章 */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-secondary)]">
            <Watch className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                Xiaomi Smart Band 10
              </h2>
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--bg-app)] text-[var(--text-muted)] border border-[var(--border-default)]">
                已配置手环
              </span>
            </div>

            {/* 同步与链路状态（不暴露 MAC / 密钥） */}
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {isConnected
                ? lastSyncedText ?? '已连接 · 数据同步正常'
                : isProgressing
                ? '正在建立通信链路…'
                : isError
                ? '手环连接中断'
                : '手环未连接 · 数据尚未同步到手环'}
            </p>
          </div>
        </div>

        {/* 状态徽章：严格消费真实状态 */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-full)] bg-black/[0.04] dark:bg-white/[0.06] text-xs font-medium text-[var(--text-muted)]">
          {isConnected ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-success)]" />
              <span className="text-[var(--status-success)]">已连接</span>
            </>
          ) : state === 'starting' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 text-[var(--status-working)] animate-spin" />
              <span className="text-[var(--status-working)]">启动服务</span>
            </>
          ) : state === 'searching' ? (
            <>
              <Radio className="w-3.5 h-3.5 text-[var(--status-working)] animate-pulse" />
              <span className="text-[var(--status-working)]">查找手环</span>
            </>
          ) : state === 'connecting' ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 text-[var(--status-working)] animate-spin" />
              <span className="text-[var(--status-working)]">建立连接</span>
            </>
          ) : state === 'authenticating' ? (
            <>
              <KeyRound className="w-3.5 h-3.5 text-[var(--status-working)]" />
              <span className="text-[var(--status-working)]">验证身份</span>
            </>
          ) : isError ? (
            <>
              <AlertCircle className="w-3.5 h-3.5 text-[var(--status-error)]" />
              <span className="text-[var(--status-error)]">连接异常</span>
            </>
          ) : (
            <>
              <BluetoothOff className="w-3.5 h-3.5" />
              <span>未连接</span>
            </>
          )}
        </div>
      </div>

      {/* 连接过程阶段进度指示条 */}
      {isProgressing && (
        <div className="pt-1">
          <ConnectionProgress currentStep={progressStep} />
        </div>
      )}

      {/* 错误提示区域（脱敏提示） */}
      {isError && (
        <div className="p-3 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 flex items-start gap-2 text-xs text-[var(--status-error)]">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <p className="leading-relaxed">{sanitizeErrorMessage(rawError)}</p>
        </div>
      )}

      {/* 分割线与主操作按钮（连接/断开复用 preload 的真实 IPC） */}
      <div className="pt-3 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>
          连接阶段：
          {isConnected
            ? '已连接双向安全链路'
            : state === 'starting'
            ? '正在启动设备服务'
            : state === 'searching'
            ? '正在查找已配置手环'
            : state === 'connecting'
            ? '正在建立物理连接'
            : state === 'authenticating'
            ? '正在验证身份凭据'
            : isError
            ? '连接失败已停止'
            : '待机就绪'}
        </span>

        <button
          type="button"
          onClick={isConnected ? onDisconnect : onConnect}
          disabled={isConnected ? busy || !onDisconnect : !canConnect}
          title={
            isConnected
              ? '断开与手环的蓝牙链路'
              : canConnect
              ? '连接手环（会断开它与小米运动健康的连接）'
              : '连接中或设备正忙，请稍候'
          }
          className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium flex items-center gap-1.5 select-none cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <span>
            {isConnected
              ? '断开连接'
              : state === 'connecting' || busy
              ? '连接中…'
              : '连接手环'}
          </span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </section>
  );
};
