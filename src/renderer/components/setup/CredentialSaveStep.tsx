import React, { useState } from 'react';
import { ShieldCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import type { CredentialSaveState } from '../../../common/types';

export interface CredentialSaveStepProps {
  initialState?: Partial<CredentialSaveState>;
}

export const CredentialSaveStep: React.FC<CredentialSaveStepProps> = ({ initialState }) => {
  const [saveState, setSaveState] = useState<CredentialSaveState>({
    status: initialState?.status ?? 'idle',
    error: initialState?.error,
  });

  // 纯 UI 交互占位：禁止调用安全存储 API，禁止产生假 saved
  const handlePrepareClick = () => {
    setSaveState({
      status: 'saving',
    });
  };

  const handleReset = () => {
    setSaveState({
      status: 'idle',
    });
  };

  return (
    <div className="space-y-4">
      {/* 头部说明卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>保存设备凭据</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          将在 Windows 安全存储中保护设备信息。
        </p>
      </div>

      {/* 核心操作与状态展示区 */}
      {saveState.status === 'idle' && (
        <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-3 bg-[var(--bg-app)] transition-colors">
          <ShieldCheck className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              将在 Windows 安全存储中保护设备信息。
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              功能占位 · 仅展示交互流程，不调用任何底层安全接口
            </p>
          </div>
          <button
            type="button"
            onClick={handlePrepareClick}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
          >
            准备保存
          </button>
        </div>
      )}

      {saveState.status === 'saving' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在准备安全存储
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              等待真实能力连接
            </p>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            返回重置
          </button>
        </div>
      )}

      {saveState.status === 'saved' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/[0.04] text-center space-y-3">
          <CheckCircle2 className="w-6 h-6 mx-auto text-[var(--status-success)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              安全存储步骤已完成
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

      {saveState.status === 'error' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              {saveState.error?.userMessage || '安全存储准备失败，请重试。'}
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
