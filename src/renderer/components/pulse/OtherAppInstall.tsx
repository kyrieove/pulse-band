import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload, Package, Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import type { InstallProgressEvent } from '../../../common/types';

interface PreparedRpk {
  installId: string;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize: number;
  totalChunks: number;
}

export interface OtherAppInstallProps {
  /** 手环是否已连接：未连接时不允许选择或安装 */
  connected: boolean;
}

/**
 * 「推送其他快应用」：选择/拖入任意 .rpk 并安装到手环。
 *
 * 复用现有 IPC 与安装服务（prepareFile → sendChunks → commit），
 * 不新建第二套安装管线；忙碌互斥由 AppInstallService 单会话约束保证，
 * 与内置 Pulse 安装共用同一条约束。
 */
export const OtherAppInstall: React.FC<OtherAppInstallProps> = ({ connected }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<PreparedRpk | null>(null);
  const [percentage, setPercentage] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const unsubscribe = window.pulse?.appInstall?.onProgress?.((ev: InstallProgressEvent) => {
      if (typeof ev.percentage === 'number') setPercentage(ev.percentage);
    });
    return () => unsubscribe?.();
  }, []);

  const reset = () => {
    setPrepared(null);
    setPercentage(0);
    setMessage(null);
  };

  const selectFile = useCallback(
    async (filePath: string | undefined, fileName?: string) => {
      if (!filePath) {
        setMessage({ ok: false, text: '无法获取文件路径' });
        return;
      }
      if (!filePath.toLowerCase().endsWith('.rpk')) {
        setMessage({ ok: false, text: '只支持 .rpk 快应用格式' });
        return;
      }
      setBusy(true);
      setMessage(null);
      setPrepared(null);
      try {
        // 读取安装包并建立安装会话（设备侧 prepare 在此完成）
        const res = await window.pulse?.appInstall?.prepareFile?.(filePath);
        if (!res) {
          setMessage({ ok: false, text: '安装接口不可用' });
          return;
        }
        setPrepared({
          installId: res.installId,
          packageId: res.packageId,
          versionName: res.versionName,
          versionCode: res.versionCode,
          fileSize: res.fileSize,
          totalChunks: res.totalChunks,
        });
        setPercentage(0);
        if (fileName) setMessage({ ok: true, text: `已读取 ${fileName}` });
      } catch (err: any) {
        setMessage({ ok: false, text: err?.message ?? '安装包读取失败' });
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const install = useCallback(async () => {
    if (!prepared) return;
    setBusy(true);
    setMessage(null);
    try {
      // sendChunks 内部会完成全部分块并调用 commit（commit 需要会话自己的 expectedHash）
      const res = await window.pulse?.appInstall?.sendChunks?.(prepared.installId);
      if (res?.coreStatus === 'completed') {
        setMessage({ ok: true, text: '设备已确认安装完成' });
      } else {
        setMessage({
          ok: false,
          text: `设备未确认安装完成（core 状态：${res?.coreStatus ?? 'unknown'}）`,
        });
      }
    } catch (err: any) {
      setMessage({ ok: false, text: err?.message ?? '安装失败' });
    } finally {
      setBusy(false);
    }
  }, [prepared]);

  const cancel = useCallback(async () => {
    if (!prepared) return;
    try {
      await window.pulse?.appInstall?.cancel?.({ installId: prepared.installId, reason: '用户取消' });
    } catch {
      /* 取消失败不阻塞界面复位 */
    }
    reset();
  }, [prepared]);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept=".rpk"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const path = file ? window.pulse?.getPathForFile?.(file) : undefined;
          void selectFile(path ?? undefined, file?.name);
          if (e.target) e.target.value = '';
        }}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (connected) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!connected) {
            setMessage({ ok: false, text: '请先连接手环' });
            return;
          }
          const file = e.dataTransfer.files?.[0];
          const path = file ? window.pulse?.getPathForFile?.(file) : undefined;
          void selectFile(path ?? undefined, file?.name);
        }}
        className={`p-5 rounded-[var(--radius-md)] border border-dashed text-center space-y-2 transition-colors ${
          dragging
            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/[0.06]'
            : 'border-[var(--border-strong)] bg-[var(--bg-app)]'
        }`}
      >
        <Upload className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
        <p className="text-xs text-[var(--text-secondary)]">
          {connected ? '拖入 .rpk 文件，或点击下方选择' : '请先连接手环'}
        </p>
        <button
          type="button"
          disabled={!connected || busy}
          onClick={() => inputRef.current?.click()}
          className="px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          选择 RPK 文件
        </button>
      </div>

      {prepared && (
        <div className="p-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
            <Package className="w-3.5 h-3.5 text-[var(--accent-primary)]" />
            安装包已读取
          </div>
          <div className="text-xs space-y-1 text-[var(--text-secondary)] font-mono">
            <div>包名称: {prepared.packageId ?? '未解析'}</div>
            <div>版本: {prepared.versionName ?? '未解析'}</div>
            <div>versionCode: {prepared.versionCode ?? '未解析'}</div>
            <div>大小: {(prepared.fileSize / 1024).toFixed(1)} KB</div>
            <div>分块: {prepared.totalChunks}</div>
          </div>
          <div className="flex items-center gap-2 pt-1 select-none">
            <button
              type="button"
              onClick={install}
              disabled={busy}
              className="px-3 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium cursor-pointer disabled:opacity-60 inline-flex items-center gap-1.5"
            >
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              <span>安装到手环</span>
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] cursor-pointer disabled:opacity-50"
            >
              取消
            </button>
            {busy && <span className="text-xs text-[var(--text-muted)]">{percentage}%</span>}
          </div>
        </div>
      )}

      {message && (
        <p
          className={`text-xs leading-relaxed flex items-start gap-1.5 ${
            message.ok ? 'text-emerald-400' : 'text-[var(--status-error)]'
          }`}
        >
          {message.ok ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          ) : (
            <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          )}
          <span>{message.text}</span>
        </p>
      )}
    </div>
  );
};
