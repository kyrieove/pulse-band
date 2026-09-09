import React, { useState, useEffect, useRef } from 'react';
import { PackageCheck, Loader2, AlertCircle, XCircle, FileUp } from 'lucide-react';
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

interface PreparedPackageInfo {
  packageId: string;
  versionName: string;
  fileSizeKb: string;
  totalChunks: number;
}

export const InstallAppStep: React.FC<InstallAppStepProps> = () => {
  const [sessionStatus, setSessionStatus] = useState<InstallSessionStatus>('idle');
  const [activeInstallId, setActiveInstallId] = useState<string | null>(null);
  const [preparedPkg, setPreparedPkg] = useState<PreparedPackageInfo | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
          const errText =
            typeof ev.error === 'string'
              ? ev.error
              : (ev.error as any)?.userMessage ?? JSON.stringify(ev.error);
          setErrorMessage(errText);
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const filePath = window.pulse?.getPathForFile
      ? window.pulse.getPathForFile(file)
      : (file as any)?.path;

    if (!filePath) {
      setSessionStatus('failed');
      setPreparedPkg(null);
      setErrorMessage('无法获取文件路径');
      return;
    }

    try {
      setErrorMessage(null);
      setSessionStatus('preparing');
      if (window.pulse?.appInstall?.prepareFile) {
        const res = await window.pulse.appInstall.prepareFile(filePath);
        setActiveInstallId(res.installId);
        setPreparedPkg({
          packageId: res.packageId || '未知',
          versionName: res.versionName || '1.0.0',
          fileSizeKb: (res.fileSize / 1024).toFixed(1),
          totalChunks: res.totalChunks,
        });
        setProgress({
          transferredBytes: 0,
          fileSize: res.fileSize,
          percentage: 0,
        });
      }
    } catch (err: any) {
      setSessionStatus('failed');
      setPreparedPkg(null);
      setErrorMessage(err?.message ?? '安装包解析失败');
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const handleStartTransfer = async () => {
    try {
      setErrorMessage(null);
      if (window.pulse?.appInstall?.sendChunks) {
        await window.pulse.appInstall.sendChunks(activeInstallId || undefined);
      }
    } catch (err: any) {
      setSessionStatus('failed');
      setErrorMessage(err?.message ?? '分块传输中断');
    }
  };

  const handleCancelTransfer = async () => {
    try {
      if (window.pulse?.appInstall?.cancelTransfer && activeInstallId) {
        await window.pulse.appInstall.cancelTransfer(activeInstallId);
      } else if (window.pulse?.appInstall?.cancel && activeInstallId) {
        await window.pulse.appInstall.cancel({
          installId: activeInstallId,
          reason: '用户主动取消',
        });
      }
    } catch (err: any) {
      console.error('[InstallAppStep] 取消失败:', err);
    } finally {
      setSessionStatus('cancelled');
      setErrorMessage('传输已取消');
    }
  };

  const handleReselectFile = () => {
    setSessionStatus('idle');
    setActiveInstallId(null);
    setPreparedPkg(null);
    setErrorMessage(null);
    setProgress({
      transferredBytes: 0,
      fileSize: 0,
      percentage: 0,
    });
    fileInputRef.current?.click();
  };

  const handleReset = () => {
    setSessionStatus('idle');
    setActiveInstallId(null);
    setPreparedPkg(null);
    setErrorMessage(null);
    setProgress({
      transferredBytes: 0,
      fileSize: 0,
      percentage: 0,
    });
  };

  return (
    <div className="space-y-4">
      {/* 隐藏的 RPK 文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".rpk"
        className="hidden"
        onChange={handleFileSelect}
      />

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
              选择快应用安装包
            </p>
            <p className="text-[11px] text-[var(--text-muted)]">
              请选择本地 .rpk 安装包，系统将自动校验 manifest 并建立安全安装会话
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer inline-flex items-center gap-1.5"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>选择 RPK 文件</span>
          </button>
        </div>
      )}

      {sessionStatus === 'preparing' && (
        preparedPkg ? (
          <div className="p-5 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] space-y-3 text-left">
            <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <PackageCheck className="w-4 h-4" />
              <span>安装包已读取</span>
            </div>
            <div className="text-xs space-y-1 text-[var(--text-secondary)] font-mono bg-[var(--bg-surface)] p-3 rounded-[var(--radius-sm)] border border-[var(--border-default)]">
              <div>包名称: {preparedPkg.packageId}</div>
              <div>版本: {preparedPkg.versionName}</div>
              <div>大小: {preparedPkg.fileSizeKb} KB</div>
              <div>分块: {preparedPkg.totalChunks}</div>
            </div>
            <div className="pt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={handleStartTransfer}
                className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
              >
                开始分块传输
              </button>
              <button
                type="button"
                onClick={handleCancelTransfer}
                className="px-3 py-2 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] text-center space-y-3">
            <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--text-primary)]">
                正在准备安装会话
              </p>
              <p className="text-[11px] text-[var(--text-muted)] font-mono">
                {activeInstallId ? `会话: ${activeInstallId}` : '解析安装包中...'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleCancelTransfer}
              className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
            >
              取消安装
            </button>
          </div>
        )
      )}

      {sessionStatus === 'transferring' && (
        <div className="p-6 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] space-y-4">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-[var(--accent-primary)] animate-spin" />
              <span className="font-medium text-[var(--text-primary)]">
                正在传输安装包
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
            <span>
              {(progress.transferredBytes / 1024).toFixed(1)} KB / {(progress.fileSize / 1024).toFixed(1)} KB
            </span>
            <span>{progress.percentage}%</span>
          </div>

          <div className="text-center pt-1">
            <button
              type="button"
              onClick={handleCancelTransfer}
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
              已传输: {(progress.transferredBytes / 1024).toFixed(1)} / {(progress.fileSize / 1024).toFixed(1)} KB (100%)
            </p>
          </div>
          <button
            type="button"
            onClick={handleCancelTransfer}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            取消
          </button>
        </div>
      )}

      {sessionStatus === 'cancelled' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3 text-left">
          <div className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
            <div className="space-y-0.5">
              <p className="font-medium text-[var(--text-primary)]">
                传输已取消
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReselectFile}
            className="px-3.5 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
          >
            重新选择文件
          </button>
        </div>
      )}

      {sessionStatus === 'failed' && (
        <div className="p-4 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 space-y-3 text-left">
          <div className="flex items-start gap-2 text-xs text-[var(--status-error)]">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-1 whitespace-pre-line">
              <p className="font-medium">
                安装包处理失败
              </p>
              <div className="text-[11px] leading-relaxed opacity-90">
                <p className="text-[var(--text-muted)]">原因:</p>
                <p className="font-mono">{errorMessage || '未知异常'}</p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            重新开始
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
