import React, { useRef, useState } from 'react';
import {
  Watch,
  Palette,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Check,
  RefreshCw,
  Upload,
  ImagePlus,
  Trash2,
} from 'lucide-react';
import type { PulsePage } from '../layout/Sidebar';
import { useBandConnection } from '../../hooks/useBandConnection';
import { useWatchFace } from '../../hooks/useWatchFace';
import {
  normalizeWatchfaceColor,
  watchfaceDisplayName,
  isSupportedImageFileName,
  WATCHFACE_IMAGE_ACCEPT,
} from './watchface-utils';

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

  // 预览图：一个隐藏的 file input 服务所有卡片，靠 pendingPreviewIdRef 记住目标表盘
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingPreviewIdRef = useRef<string | null>(null);
  const [previewFileError, setPreviewFileError] = useState<string | null>(null);

  const connected = conn.state === 'connected';
  const busy = wf.settingId !== null || wf.installing;

  /** 把一张本地图片关联到指定表盘（选文件与拖入共用） */
  const attachPreview = (id: string, file: File | undefined) => {
    if (!id || !file) return;
    if (!isSupportedImageFileName(file.name)) {
      setPreviewFileError(`「${file.name}」不是支持的图片格式（仅 PNG / JPEG）`);
      return;
    }
    const filePath = window.pulse?.getPathForFile?.(file);
    if (!filePath) {
      setPreviewFileError('无法获取所选图片的本地路径');
      return;
    }
    setPreviewFileError(null);
    void wf.setPreview(id, filePath);
  };

  const openImagePicker = (id: string) => {
    pendingPreviewIdRef.current = id;
    setPreviewFileError(null);
    imageInputRef.current?.click();
  };

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
      {/* 预览图选文件入口：服务全部卡片 */}
      <input
        ref={imageInputRef}
        type="file"
        accept={WATCHFACE_IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const id = pendingPreviewIdRef.current;
          pendingPreviewIdRef.current = null;
          if (e.target) e.target.value = '';
          if (id) attachPreview(id, file ?? undefined);
        }}
      />

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

      {/* 状态二：读取中（无任何已有列表时给骨架屏，占位比例与真实卡片一致） */}
      {wf.loading && wf.items.length === 0 && (
        <div className="grid grid-cols-5 gap-2.5">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            <div key={i} className="w-full aspect-[192/490] rounded-[10px] bg-[var(--bg-subtle)] animate-pulse" />
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

          <div className="shrink-0 flex items-end justify-between">
            <div>
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">已安装表盘</h3>
              <p className="text-[11px] text-[var(--text-muted)] mt-0.5">
                点击卡片切换表盘；标「使用中」的是当前表盘
              </p>
            </div>
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

          {/* 本地预览图错误条（选文件/解码失败等） */}
          {(previewFileError || wf.previewError) && (
            <div className="p-2.5 rounded-[10px] bg-rose-500/[0.08] border border-rose-500/20 flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-[var(--status-error)] shrink-0" />
              <span className="text-[11.5px] text-[var(--status-error)] truncate">
                {previewFileError ?? wf.previewError}
              </span>
              <button
                type="button"
                onClick={() => {
                  setPreviewFileError(null);
                  wf.dismissPreviewError();
                }}
                className="shrink-0 text-[11.5px] font-semibold text-[var(--anchor-text)] underline cursor-pointer select-none"
              >
                知道了
              </button>
            </div>
          )}

          {/*
            卡片比例 = 手环屏 192:490。协议不返回缩略图，所以：
            - 有本地图时显示本地图（object-cover）
            - 没有本地图时用设备返回的 background_color 铺底；该字段缺失或不是合法颜色
              则回退中性底色 + 表盘图标，保证每张卡片都是一个可辨认的形状，而不是留白块
          */}
          <div className="grid grid-cols-5 gap-2.5">
            {wf.items.map((item) => {
              const isSetting = wf.settingId === item.id;
              const locked = busy && !isSetting;
              const bg = normalizeWatchfaceColor(item.background_color);
              const displayName = watchfaceDisplayName(item.name, item.id);
              const preview = wf.previews[item.id];
              const previewBusy = wf.previewBusyId === item.id;
              return (
                <div
                  key={item.id}
                  className="relative"
                  onDragOver={(e) => {
                    // 卡片自己处理图片拖入，不让它冒泡到下面的 .bin 安装区
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    attachPreview(item.id, e.dataTransfer.files?.[0]);
                  }}
                >
                  <button
                    type="button"
                    disabled={busy || item.is_current}
                    onClick={() => {
                      setSetError(null);
                      void wf.setWatchface(item.id).then((res) => {
                        if (!res.ok && res.message) setSetError(res.message);
                      });
                    }}
                    title={`${displayName} · v${item.version_code ?? '?'}${
                      item.can_remove ? '' : ' · 内置表盘（设备不允许删除）'
                    }${preview ? ` · 已关联本地图片（${preview.source === 'manual' ? '手动指定' : '自动提取'}）` : ''}`}
                    className={`relative block w-full aspect-[192/490] overflow-hidden rounded-[10px] border transition-colors select-none text-left ${
                      item.is_current
                        ? 'border-[var(--accent-primary)] cursor-default'
                        : 'border-[var(--border-strong)] hover:border-[var(--accent-soft)] cursor-pointer disabled:cursor-not-allowed'
                    } ${locked ? 'opacity-60' : ''}`}
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-0"
                      style={{ backgroundColor: bg ?? 'var(--bg-subtle)' }}
                    />
                    {!bg && (
                      <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
                        <Watch className="w-6 h-6 text-[var(--text-muted)] opacity-40" />
                      </span>
                    )}
                    {preview && (
                      <img
                        src={preview.dataUrl}
                        alt=""
                        draggable={false}
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}

                    {/* 状态标识用文字 + 图标，不依赖描边颜色单独表达 */}
                    <span className="absolute top-1 left-1 flex flex-col items-start gap-1">
                      {item.is_current && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--accent-primary)] px-1.5 py-[3px] text-[9px] font-semibold leading-none text-white">
                          <Check className="w-2.5 h-2.5" />
                          使用中
                        </span>
                      )}
                      {!item.can_remove && (
                        <span className="rounded-full bg-[var(--bg-surface)] px-1.5 py-[3px] text-[9px] font-medium leading-none text-[var(--text-muted)]">
                          内置
                        </span>
                      )}
                    </span>

                    {/* 名称过长截断，悬停卡片用 title 看全名 */}
                    <span className="absolute inset-x-0 bottom-0 p-1">
                      <span className="line-clamp-2 block rounded-[6px] bg-[var(--bg-surface)] px-1.5 py-1 text-[10px] font-semibold leading-[1.25] text-[var(--text-primary)]">
                        {displayName}
                      </span>
                    </span>

                    {(isSetting || previewBusy) && (
                      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[var(--bg-surface)]">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-primary)]" />
                        <span className="text-[10px] font-medium text-[var(--text-secondary)]">
                          {isSetting ? '切换中…' : '处理图片…'}
                        </span>
                      </span>
                    )}
                  </button>

                  {/* 预览图操作放在卡片外层：button 不能嵌套 button */}
                  <div className="absolute top-1 right-1 z-10 flex flex-col gap-1">
                    <button
                      type="button"
                      disabled={previewBusy}
                      onClick={() => openImagePicker(item.id)}
                      title={
                        preview
                          ? '替换本地图片（由你选择，只存在本机）'
                          : '为这个表盘选择一张本地图片（由你选择，只存在本机）'
                      }
                      className="w-5 h-5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none"
                    >
                      <ImagePlus className="w-3 h-3" />
                    </button>
                    {preview && (
                      <button
                        type="button"
                        disabled={previewBusy}
                        onClick={() => {
                          setPreviewFileError(null);
                          void wf.clearPreview(item.id);
                        }}
                        title="清除本地图片"
                        className="w-5 h-5 rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--status-error)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed select-none"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/*
            诚实文案：协议不返回预览图，卡片上的图是用户自己放的，
            不是从手环同步下来的，不写成"自动获取的预览"。
          */}
          <p className="shrink-0 text-[10.5px] text-[var(--text-muted)] leading-relaxed">
            手环协议不提供表盘预览图：卡片右上角可为表盘关联一张你自己的本地图片（仅保存在本机），
            未关联时显示的是该表盘的背景色。也可以直接把图片拖到卡片上。
          </p>
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
