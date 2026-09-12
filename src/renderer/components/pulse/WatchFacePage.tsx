import React, { useRef, useState } from 'react';
import {
  Watch,
  Palette,
  Loader2,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { PulsePage } from '../layout/Sidebar';
import { useBandConnection } from '../../hooks/useBandConnection';
import { useWatchFace } from '../../hooks/useWatchFace';

export interface WatchFacePageProps {
  /** 未连接手环时跳转「手环」页 */
  onNavigate: (page: PulsePage) => void;
}

/**
 * 表盘页：本地表盘列表 / 切换 / 安装（均已在 core 侧真机验证）。
 *
 * 按状态分层，每个状态只有一个明确主操作；未连接手环时整页只给
 * 「需要先连接手环」+ 跳转「手环」页入口，不出现任何灰掉的表盘按钮。
 */
export const WatchFacePage: React.FC<WatchFacePageProps> = ({ onNavigate }) => {
  const conn = useBandConnection();
  const wf = useWatchFace(conn.state === 'connected');

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const connected = conn.state === 'connected';
  const busy = wf.settingId !== null || wf.installing;

  const selectFile = (filePath: string | undefined, fileName?: string) => {
    if (!filePath || !fileName) {
      setFileError('无法获取所选文件的本地路径');
      return;
    }
    if (!fileName.toLowerCase().endsWith('.bin')) {
      setFileError(`「${fileName}」不是 .bin 表盘文件`);
      return;
    }
    setFileError(null);
    void wf.installWatchface(filePath, fileName);
  };

  const installFeedback = wf.installing ? null : wf.installOutcome ? (
    <span
      className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--status-success)] min-w-0"
      title={wf.installOutcome.fileName}
    >
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">
        {wf.installOutcome.meaning === 'INSTALL_SUCCESS'
          ? `「${wf.installOutcome.fileName}」安装成功，已加入表盘列表`
          : `「${wf.installOutcome.fileName}」已存在于手环，无需重复安装`}
      </span>
    </span>
  ) : wf.installError ? (
    <span className="inline-flex items-center gap-2 text-[11.5px] font-medium text-[var(--status-error)] min-w-0">
      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">安装失败：{wf.installError}</span>
      <button
        type="button"
        onClick={() => void wf.retryInstall()}
        className="shrink-0 font-semibold text-[var(--anchor-text)] underline cursor-pointer select-none"
      >
        重试
      </button>
    </span>
  ) : null;

  // ── 状态一：手环未连接。整页只呈现连接引导，不放灰掉的表盘按钮 ──
  if (!connected) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center select-none">
        <div className="w-12 h-12 rounded-full bg-[var(--accent-wash)] flex items-center justify-center">
          <Watch className="w-6 h-6 text-[var(--anchor-text)]" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">需要先连接手环</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-1 max-w-[280px] leading-relaxed">
            表盘列表、切换与本地安装都需要在手环连接后使用
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate('band')}
          className="btn-primary rounded-full px-4 py-2 text-[12px] font-semibold bg-[var(--accent-primary)] text-white cursor-pointer select-none"
        >
          前往「手环」页连接
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5 overflow-y-auto custom-scrollbar">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">表盘</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">
            {conn.device?.name ? `${conn.device.name} · ` : ''}
            {wf.loading ? '正在读取表盘列表…' : `已连接 · ${wf.items.length} 个表盘`}
          </p>
        </div>
      </div>

      {/* 状态二：读取中（无任何已有列表时给骨架屏） */}
      {wf.loading && wf.items.length === 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[110px] rounded-[10px] bg-[var(--bg-subtle)] animate-pulse" />
          ))}
        </div>
      )}

      {/* 状态三：读取失败（没有列表可回退时整卡呈现错误 + 重试） */}
      {!wf.loading && wf.loadError && wf.items.length === 0 && (
        <div className="p-3.5 rounded-[10px] bg-rose-500/[0.08] border border-rose-500/20 flex items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-[var(--status-error)] shrink-0 mt-0.5" />
            <div className="text-xs min-w-0">
              <span className="font-semibold text-[var(--status-error)]">读取表盘列表失败</span>
              <p className="text-[var(--text-muted)] mt-0.5 truncate">{wf.loadError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={wf.refresh}
            disabled={busy}
            className="btn-primary shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold bg-[var(--accent-primary)] text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            重试
          </button>
        </div>
      )}

      {/* 状态四：已有列表（含读取失败但有旧列表时的错误条） */}
      {wf.items.length > 0 && (
        <>
          {wf.loadError && !wf.loading && (
            <div className="p-2.5 rounded-[10px] bg-rose-500/[0.08] border border-rose-500/20 flex items-center justify-between gap-3">
              <span className="text-[11.5px] text-[var(--status-error)] truncate">{wf.loadError}</span>
              <button
                type="button"
                onClick={wf.refresh}
                disabled={busy}
                className="shrink-0 text-[11.5px] font-semibold text-[var(--anchor-text)] underline cursor-pointer select-none disabled:opacity-50"
              >
                重试
              </button>
            </div>
          )}

          <div className="shrink-0 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">已安装表盘</h3>
            <button
              type="button"
              onClick={wf.refresh}
              disabled={busy || wf.loading}
              title="刷新表盘列表"
              className="w-7 h-7 rounded-full border border-[var(--border-strong)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${wf.loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* 切换失败提示条 */}
          {setError && !wf.settingId && (
            <div className="p-2.5 rounded-[10px] bg-rose-500/[0.08] border border-rose-500/20 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-[var(--status-error)] shrink-0" />
              <span className="text-[11.5px] text-[var(--status-error)] truncate">切换失败：{setError}</span>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {wf.items.map((item) => {
              const isSetting = wf.settingId === item.id;
              const locked = busy && !isSetting;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={busy || item.is_current}
                  onClick={() => {
                    setSetError(null);
                    void wf.setWatchface(item.id).then((res) => {
                      if (!res.ok && res.message) setSetError(res.message);
                    });
                  }}
                  className={`relative rounded-[10px] border p-3 text-left transition-colors select-none ${
                    item.is_current
                      ? 'border-[var(--accent-soft)] bg-[var(--accent-wash)] cursor-default'
                      : 'border-[var(--border-strong)] bg-[var(--bg-surface)] hover:border-[var(--accent-soft)] cursor-pointer disabled:cursor-not-allowed'
                  } ${locked ? 'opacity-60' : ''}`}
                >
                  {isSetting ? (
                    <div className="h-full min-h-[64px] flex flex-col items-center justify-center gap-1.5">
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                      <span className="text-[11px] font-medium text-[var(--text-secondary)]">切换中…</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <span
                          className="text-[12.5px] font-semibold text-[var(--text-primary)] leading-snug break-all"
                          title={item.name}
                        >
                          {item.name || item.id}
                        </span>
                        {item.is_current && (
                          <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-[var(--accent-primary)] text-white text-[9.5px] font-semibold">
                            使用中
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                        {!item.can_remove && (
                          <span className="px-1.5 py-0.5 rounded-full bg-[var(--bg-subtle)] border border-[var(--border-strong)] text-[9.5px] text-[var(--text-muted)]">
                            内置
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-[var(--text-muted)]">
                          v{item.version_code ?? '?'}
                        </span>
                      </div>
                      {!item.is_current && !busy && (
                        <span className="mt-2 block text-[10.5px] font-medium text-[var(--anchor-text)]">
                          设为当前表盘
                        </span>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {/* 已连接但列表为空且无错误 */}
      {!wf.loading && !wf.loadError && wf.items.length === 0 && (
        <div className="rounded-[10px] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-6 text-center text-[11.5px] text-[var(--text-muted)] select-none">
          未读取到表盘，可点击刷新重试
        </div>
      )}

      {/* 安装本地表盘（长时 busy 态，无进度条） */}
      <section
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          const file = e.dataTransfer.files?.[0];
          const path = file ? window.pulse?.getPathForFile?.(file) : undefined;
          selectFile(path ?? undefined, file?.name);
        }}
        className={`shrink-0 rounded-[10px] p-4 flex flex-col gap-2.5 border transition-colors ${
          dragging
            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/[0.06]'
            : 'border-transparent bg-[var(--bg-subtle)]'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <Palette className="w-4 h-4 text-[var(--accent-primary)]" />
          <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">安装本地表盘</h3>
        </div>
        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
          拖入或选择 .bin 表盘文件安装到手环。安装是长耗时操作且没有进度提示，结束后在此显示结果。
        </p>

        {wf.installing ? (
          <div className="rounded-[var(--radius-md)] border border-[var(--border-strong)] bg-[var(--bg-surface)] p-3 flex items-start gap-2.5">
            <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)] shrink-0 mt-0.5" />
            <div className="text-[11.5px] leading-relaxed min-w-0">
              <div className="font-semibold text-[var(--text-primary)]">
                安装中…（可能需要几分钟，请保持手环连接）
              </div>
              <div className="text-[var(--text-muted)] mt-0.5">
                安装期间无法中途取消；离开本页将看不到安装结果。
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 flex-wrap">
            <input
              ref={inputRef}
              type="file"
              accept=".bin"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                const path = file ? window.pulse?.getPathForFile?.(file) : undefined;
                selectFile(path ?? undefined, file?.name);
                if (e.target) e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="btn-primary rounded-full px-4 py-2 text-[12px] font-semibold bg-[var(--accent-primary)] text-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none"
            >
              <Upload className="w-3.5 h-3.5" />
              选择表盘文件
            </button>
            {fileError && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--status-error)] min-w-0">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{fileError}</span>
              </span>
            )}
            {installFeedback}
          </div>
        )}
      </section>
    </div>
  );
};
