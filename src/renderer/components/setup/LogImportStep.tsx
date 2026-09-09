import React, { useState } from 'react';
import { FileText, Loader2, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import type { LogImportState } from '../../../common/types';

export interface LogImportStepProps {
  initialState?: Partial<LogImportState>;
}

export const LogImportStep: React.FC<LogImportStepProps> = ({ initialState }) => {
  const [importState, setImportState] = useState<LogImportState>({
    status: initialState?.status ?? 'idle',
    fileName: initialState?.fileName,
    error: initialState?.error,
  });

  // 纯 UI 交互占位：禁止调用文件选择 API，禁止产生假 success
  const handleSelectClick = () => {
    setImportState({
      status: 'selecting',
    });
  };

  const handleReset = () => {
    setImportState({
      status: 'idle',
    });
  };

  return (
    <div className="space-y-4">
      {/* 头部说明卡片 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>导入手机日志</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          请选择手机导出的日志文件。
        </p>
      </div>

      {/* 核心操作与状态展示区 */}
      {importState.status === 'idle' && (
        <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-3 bg-[var(--bg-app)] transition-colors">
          <FileText className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              请选择手机导出的日志文件
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              功能占位 · 仅展示交互流程，不进行真实文件读取
            </p>
          </div>
          <button
            type="button"
            onClick={handleSelectClick}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
          >
            选择日志文件
          </button>
        </div>
      )}

      {importState.status === 'selecting' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在选择日志文件
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
            返回重新选择
          </button>
        </div>
      )}

      {importState.status === 'parsing' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <RefreshCw className="w-6 h-6 mx-auto text-[var(--status-working)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在内存解析日志
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              安全内存沙箱处理中
            </p>
          </div>
        </div>
      )}

      {importState.status === 'success' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/[0.04] text-center space-y-3">
          <CheckCircle2 className="w-6 h-6 mx-auto text-[var(--status-success)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              日志解析完成
            </p>
            {importState.fileName && (
              <p className="text-[11px] text-[var(--text-secondary)] font-mono">
                {importState.fileName}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            重新选择
          </button>
        </div>
      )}

      {importState.status === 'error' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              {importState.error?.userMessage || '日志解析失败，请确认文件格式后重试。'}
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
