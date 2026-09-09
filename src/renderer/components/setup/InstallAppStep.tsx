import React, { useState } from 'react';
import { PackageCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { InstallAppState } from '../../../common/types';

export interface InstallAppStepProps {
  initialState?: Partial<InstallAppState>;
}

export const InstallAppStep: React.FC<InstallAppStepProps> = ({ initialState }) => {
  const [appState, setAppState] = useState<InstallAppState>({
    status: initialState?.status ?? 'idle',
    error: initialState?.error,
  });

  // 纯 UI 交互占位：禁止安装真实应用，仅切换为 installing 占位展示
  const handleStartInstall = () => {
    setAppState({
      status: 'installing',
    });
  };

  const handleReset = () => {
    setAppState({
      status: 'idle',
    });
  };

  return (
    <div className="space-y-4">
      {/* 头部说明卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <PackageCheck className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>安装 Pulse 快应用</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          准备安装内置 Pulse 快应用。
        </p>
      </div>

      {/* 核心操作与状态展示区 */}
      {appState.status === 'idle' && (
        <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-3 bg-[var(--bg-app)] transition-colors">
          <PackageCheck className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              准备安装内置 Pulse 快应用。
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              功能占位 · 仅展示交互流程，不执行真实安装操作
            </p>
          </div>
          <button
            type="button"
            onClick={handleStartInstall}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
          >
            开始安装
          </button>
        </div>
      )}

      {appState.status === 'installing' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在安装 Pulse 快应用
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              等待设备响应
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

      {appState.status === 'installed' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/[0.04] text-center space-y-3">
          <CheckCircle2 className="w-6 h-6 mx-auto text-[var(--status-success)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              Pulse 快应用安装完成
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

      {appState.status === 'error' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              {appState.error?.userMessage || '安装失败，请重试。'}
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
