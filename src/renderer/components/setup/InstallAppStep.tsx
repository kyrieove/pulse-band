import React, { useState, useEffect } from 'react';
import { PackageCheck, Loader2, AlertCircle, XCircle } from 'lucide-react';
import type {
  InstallSessionStatus,
  InstallProgressEvent,
  SetupError,
} from '../../../common/types';

export interface InstallAppStepProps {
  initialState?: {
    status?: InstallSessionStatus;
    error?: SetupError;
  };
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const InstallAppStep: React.FC<InstallAppStepProps> = () => {
  const [sessionStatus, setSessionStatus] = useState<InstallSessionStatus>('idle');
  const [activeInstallId, setActiveInstallId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    transferredBytes: number;
    fileSize: number;
    percentage: number;
  }>({
    transferredBytes: 0,
    fileSize: 0,
    percentage: 0,
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!window.pulse?.appInstall?.onProgress) return;

    const unsubscribe = window.pulse.appInstall.onProgress((ev: InstallProgressEvent) => {
      setSessionStatus(ev.status);
      if (ev.installId) {
        setActiveInstallId(ev.installId);
      }
      setProgress({
        transferredBytes: ev.transferredBytes ?? 0,
        fileSize: ev.fileSize ?? 0,
        percentage: ev.percentage ?? 0,
      });
      if (ev.status === 'failed' || ev.status === 'cancelled') {
        if (ev.error) {
          setErrorMessage(typeof ev.error === 'string' ? ev.error : JSON.stringify(ev.error));
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleStartInstall = async () => {
    try {
      setErrorMessage(null);
      setSessionStatus('preparing');
      if (window.pulse?.appInstall?.prepare) {
        const res = await window.pulse.appInstall.prepare({
          packageId: 'com.pulse.bandapp',
          fileSize: 262144,
          hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          chunkSize: 512,
        });
        setActiveInstallId(res.installId);
        setProgress({
          transferredBytes: 0,
          fileSize: res.fileSize,
          percentage: 0,
        });
      }
    } catch (err: any) {
      setSessionStatus('failed');
      setErrorMessage(err?.message ?? '初始化安装会话失败');
    }
  };

  const handleCancel = async () => {
    try {
      if (window.pulse?.appInstall?.cancel && activeInstallId) {
        await window.pulse.appInstall.cancel({
          installId: activeInstallId,
          reason: '用户主动取消',
        });
      }
    } catch (err: any) {
      console.error('[InstallAppStep] 取消失败:', err);
    } finally {
      setSessionStatus('cancelled');
      setErrorMessage('安装已取消');
    }
  };

  const handleReset = () => {
    setSessionStatus('idle');
    setActiveInstallId(null);
    setErrorMessage(null);
    setProgress({
      transferredBytes: 0,
      fileSize: 0,
      percentage: 0,
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
          管理快应用安装会话，通过分块传输将应用推送至设备。
        </p>
      </div>

      {/* 核心操作与状态展示区 */}
      {sessionStatus === 'idle' && (
        <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-3 bg-[var(--bg-app)] transition-colors">
          <PackageCheck className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              准备就绪
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              点击开始安装创建传输会话并执行分块校验
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

      {sessionStatus === 'preparing' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在准备安装会话
            </p>
            <p className="text-[11px] text-[var(--text-muted)] font-mono">
              {activeInstallId ? `会话: ${activeInstallId}` : '初始化参数中...'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            取消安装
          </button>
        </div>
      )}

      {sessionStatus === 'transferring' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] space-y-4">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-[var(--accent-primary)] animate-spin" />
              <span className="font-medium text-[var(--text-primary)]">
                正在传输快应用分块
              </span>
            </div>
            <span className="font-mono text-[var(--accent-primary)] font-semibold">
              {progress.percentage}%
            </span>
          </div>

          {/* 进度条 */}
          <div className="w-full bg-[var(--bg-surface)] rounded-full h-2 overflow-hidden border border-[var(--border-default)]">
            <div
              className="bg-[var(--accent-primary)] h-full transition-all duration-200 ease-out"
              style={{ width: `${progress.percentage}%` }}
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)] font-mono">
            <span>已传输: {formatBytes(progress.transferredBytes)}</span>
            <span>总大小: {formatBytes(progress.fileSize)}</span>
          </div>

          <div className="text-center pt-1">
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
            >
              取消传输
            </button>
          </div>
        </div>
      )}

      {sessionStatus === 'verifying' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-amber-500/20 bg-amber-500/[0.04] text-center space-y-3">
          <Loader2 className="w-6 h-6 mx-auto text-amber-500 animate-spin" />
          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--text-primary)]">
              正在校验安装包
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              分块传输完毕，正在进行完整性校验（当前阶段不向硬件写入）
            </p>
            <p className="text-[11px] font-mono text-[var(--text-secondary)]">
              已传输: {formatBytes(progress.transferredBytes)} / {formatBytes(progress.fileSize)} (100%)
            </p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            取消
          </button>
        </div>
      )}

      {(sessionStatus === 'cancelled' || sessionStatus === 'failed') && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            {sessionStatus === 'cancelled' ? (
              <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <div className="space-y-0.5">
              <p className="font-medium">
                {sessionStatus === 'cancelled' ? '安装已取消' : '安装失败'}
              </p>
              <p className="leading-relaxed opacity-90">
                {errorMessage || '安装会话已终止。'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            重置
          </button>
        </div>
      )}

      {/* 底部管道状态说明 */}
      <div className="p-3.5 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-dashed border-[var(--border-strong)] flex items-center justify-between text-xs">
        <div>
          <div className="font-medium text-[var(--text-primary)]">Main 安装会话</div>
          <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
            状态：{sessionStatus} · 硬件层保持隔离
          </div>
        </div>
        <span className="font-mono text-[11px] px-2.5 py-1 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
          管道就绪
        </span>
      </div>
    </div>
  );
};
