import React from 'react';
import { Watch, BluetoothOff, CheckCircle2, RefreshCw, AlertCircle, ArrowRight } from 'lucide-react';

export interface BandConnectionCardProps {
  connectionState?: unknown;
}

export const BandConnectionCard: React.FC<BandConnectionCardProps> = ({ connectionState }) => {
  const isConnected = connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';
  const isError = connectionState === 'error';

  return (
    <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
      {/* 头部信息与状态 */}
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
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {isConnected
                ? '已连接 · 实时链路保持中'
                : '手环未连接 · 数据尚未同步到手环'}
            </p>
          </div>
        </div>

        {/* 状态徽章：严格消费真实状态，绝无写死 connected */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-full)] bg-black/[0.04] dark:bg-white/[0.06] text-xs font-medium text-[var(--text-muted)]">
          {isConnected ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-success)]" />
              <span className="text-[var(--status-success)]">已连接</span>
            </>
          ) : isConnecting ? (
            <>
              <RefreshCw className="w-3.5 h-3.5 text-[var(--status-working)] animate-spin" />
              <span className="text-[var(--status-working)]">正在连接</span>
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

      {/* 分割线与主操作区域：骨架阶段不实现真实连接按钮 */}
      <div className="pt-3 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>
          连接阶段：{isConnected ? '已建立安全链路' : isConnecting ? '正在握手协商' : '待机就绪'}
        </span>
        <button
          type="button"
          disabled
          className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium opacity-60 cursor-not-allowed flex items-center gap-1.5"
          title="UI 视觉骨架阶段，暂未接通底层连接"
        >
          <span>{isConnected ? '断开连接' : '连接手环'}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </section>
  );
};
