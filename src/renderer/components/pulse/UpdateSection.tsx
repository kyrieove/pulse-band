import React, { useEffect, useState } from 'react';

type Phase = 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error';

const buttonBase =
  'rounded-full px-[13px] py-1.5 text-[11px] font-semibold select-none cursor-pointer transition-colors shrink-0 disabled:opacity-60 disabled:cursor-default';
const secondaryButton = `${buttonBase} bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)]`;
const primaryButton = `${buttonBase} bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white`;

/** 设置页「版本与环境」里的检查更新：进页面自动查一次，有新版可在应用内下载并安装 */
export const UpdateSection: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('checking');
  const [latest, setLatest] = useState('');
  const [releaseUrl, setReleaseUrl] = useState('');
  const [canDownload, setCanDownload] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');

  const check = async () => {
    setPhase('checking');
    setError('');
    const res = await window.pulse?.checkUpdate?.().catch((err: any) => ({ ok: false, error: String(err?.message ?? err) }) as any);
    if (!res?.ok) {
      setError(`检查更新失败：${res?.error ?? '未知错误'}`);
      setPhase('error');
      return;
    }
    setLatest(res.latestVersion ?? '');
    setReleaseUrl(res.releaseUrl ?? '');
    setCanDownload(!!res.canDownload);
    setPhase(res.updateAvailable ? 'available' : 'latest');
  };

  useEffect(() => {
    void check();
    return window.pulse?.onUpdateProgress?.((p) => {
      if (p.total) setPercent(Math.floor((p.received / p.total) * 100));
    });
  }, []);

  const download = async () => {
    setPercent(0);
    setPhase('downloading');
    const res = await window.pulse?.downloadUpdate?.();
    if (res?.ok) {
      setPhase('downloaded');
    } else {
      setError(res?.error ?? '下载失败');
      setPhase('error');
    }
  };

  const install = async () => {
    const res = await window.pulse?.installUpdate?.();
    if (!res?.ok) {
      setError(res?.error ?? '启动安装程序失败');
      setPhase('error');
    }
  };

  const status: Record<Phase, string> = {
    checking: '正在检查更新…',
    latest: '已是最新版本',
    available: `发现新版本 v${latest}`,
    downloading: `正在下载 v${latest}… ${percent}%`,
    downloaded: `v${latest} 已下载完成`,
    error,
  };

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[11px] leading-relaxed ${
            phase === 'error'
              ? 'text-rose-500'
              : phase === 'available' || phase === 'downloaded'
              ? 'text-[var(--accent-primary)] font-medium'
              : 'text-[var(--text-muted)]'
          }`}
        >
          {status[phase]}
        </span>
        {phase === 'available' && canDownload ? (
          <button type="button" onClick={download} className={primaryButton}>
            下载更新
          </button>
        ) : phase === 'available' ? (
          <button type="button" onClick={() => window.pulse?.openRelease?.(releaseUrl)} className={primaryButton}>
            前往下载
          </button>
        ) : phase === 'downloaded' ? (
          <button type="button" onClick={install} className={primaryButton}>
            安装并重启
          </button>
        ) : (
          <button
            type="button"
            onClick={check}
            disabled={phase === 'checking' || phase === 'downloading'}
            className={secondaryButton}
          >
            {phase === 'error' ? '重试' : phase === 'downloading' ? '下载中' : '检查更新'}
          </button>
        )}
      </div>

      {phase === 'downloading' && (
        <div className="h-1.5 rounded-full bg-[var(--border-default)] overflow-hidden">
          <div className="h-full bg-[var(--accent-primary)] transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      )}

      {phase === 'downloaded' && (
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          点击后 Pulse 会退出并打开安装程序，按提示完成安装即可，原有设置和手环配置保留。
        </p>
      )}

      {(phase === 'available' || phase === 'downloaded') && releaseUrl && (
        <button
          type="button"
          onClick={() => window.pulse?.openRelease?.(releaseUrl)}
          className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer"
        >
          查看更新说明
        </button>
      )}
    </div>
  );
};
