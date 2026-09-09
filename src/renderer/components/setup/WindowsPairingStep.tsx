import React, { useState } from 'react';
import { Bluetooth, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { WindowsPairingState } from '../../../common/types';

export interface WindowsPairingStepProps {
  initialState?: Partial<WindowsPairingState>;
}

export const WindowsPairingStep: React.FC<WindowsPairingStepProps> = ({ initialState }) => {
  const [pairingState, setPairingState] = useState<WindowsPairingState>({
    status: initialState?.status ?? 'idle',
    error: initialState?.error,
  });

  // 纯 UI 交互占位：禁止打开系统设置，禁止检测设备，仅切换为 waiting 占位展示
  const handleOpenSettingsClick = () => {
    setPairingState({
      status: 'waiting',
    });
  };

  const handleReset = () => {
    setPairingState({
      status: 'idle',
    });
  };

  return (
    <div className="space-y-4">
      {/* 头部说明卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <Bluetooth className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>Windows 配对</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          请在 Windows 蓝牙设置中完成设备配对。
        </p>
      </div>

      {/* 核心操作与状态展示区 */}
      {pairingState.status === 'idle' && (
        <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-3 bg-[var(--bg-app)] transition-colors">
          <Bluetooth className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              请在 Windows 蓝牙设置中完成设备配对。
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              功能占位 · 仅展示交互流程，不调用系统蓝牙接口
            </p>
          </div>
          <button
            type="button"
            onClick={handleOpenSettingsClick}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
          >
            打开蓝牙设置
          </button>
        </div>
      )}

      {pairingState.status === 'waiting' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              等待 Windows 配对完成
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              完成配对后返回 Pulse 继续设置。
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            返回
          </button>
        </div>
      )}

      {pairingState.status === 'checking' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在检查配对状态
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              功能占位 · 等待真实能力连接
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            返回
          </button>
        </div>
      )}

      {pairingState.status === 'paired' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/[0.04] text-center space-y-3">
          <CheckCircle2 className="w-6 h-6 mx-auto text-[var(--status-success)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Windows 配对步骤完成
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              预留状态展示
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            返回
          </button>
        </div>
      )}

      {pairingState.status === 'error' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              {pairingState.error?.userMessage || 'Windows 配对失败，请重试。'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            重试
          </button>
        </div>
      )}

      {/* 底部状态占位说明 */}
      <div className="p-3.5 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-dashed border-[var(--border-strong)] flex items-center justify-between text-xs">
        <div>
          <div className="font-medium text-[var(--text-primary)]">功能占位</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
            等待真实能力连接
          </div>
        </div>
        <span className="font-mono text-[11px] px-2.5 py-1 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
          准备接入
        </span>
      </div>
    </div>
  );
};
