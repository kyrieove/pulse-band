import React, { useCallback, useEffect, useState } from 'react';
import { PackageCheck, Loader2, AlertCircle, XCircle, CheckCircle2 } from 'lucide-react';
import type { InstallProgressEvent, SetupError } from '../../../common/types';

export interface InstallAppStepProps {
  initialState?: {
    status?: string;
    error?: SetupError;
  };
}

interface BundledInfo {
  exists: boolean;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  manifestValid?: boolean;
}

type StepState = 'idle' | 'installing' | 'done' | 'failed';

/**
 * 向导第 6 步：一键安装内置的 Pulse 手环端快应用。
 *
 * 内置包随桌面端发布，用户不需要选择文件。点击后一次完成
 * prepare -> 全部分块 -> commit，结束条件只有 pulse-core 依据真实设备结果
 * 返回的 coreStatus === 'completed'，否则一律按未完成处理。
 */
export const InstallAppStep: React.FC<InstallAppStepProps> = () => {
  const [bundled, setBundled] = useState<BundledInfo | null>(null);
  const [state, setState] = useState<StepState>('idle');
  const [percentage, setPercentage] = useState<number>(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    window.pulse?.appInstall
      ?.getBundledInfo?.()
      .then((info) => {
        if (alive && info) setBundled(info as BundledInfo);
      })
      .catch(() => {
        if (alive) setBundled({ exists: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.pulse?.appInstall?.onProgress?.((ev: InstallProgressEvent) => {
      if (typeof ev.percentage === 'number') setPercentage(ev.percentage);
    });
    return () => unsubscribe?.();
  }, []);

  const install = useCallback(async () => {
    setState('installing');
    setPercentage(0);
    setMessage(null);
    try {
      const res = await window.pulse?.appInstall?.installBundled?.();
      if (!res) {
        setState('failed');
        setMessage({ ok: false, text: '安装接口不可用' });
        return;
      }
      if (res.coreStatus === 'completed') {
        setState('done');
        setMessage({
          ok: true,
          text: `设备已确认安装完成（${res.packageId ?? '未知包'} / versionCode ${res.versionCode ?? '?'}）`,
        });
      } else {
        setState('failed');
        setMessage({
          ok: false,
          text: `设备未确认安装完成（core 状态：${res.coreStatus ?? 'unknown'}）`,
        });
      }
    } catch (err: any) {
      setState('failed');
      setMessage({ ok: false, text: err?.message ?? '安装失败' });
    }
  }, []);

  const missing = bundled !== null && bundled.exists !== true;
  const canInstall = bundled?.exists === true && state !== 'installing';

  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <PackageCheck className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>安装 Pulse 快应用</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          手环端快应用随桌面端一起发布，无需自行准备安装包。点击下方按钮即可推送到手环。
        </p>
      </div>

      {/* 内置包信息：版本号来自真实 manifest */}
      <div className="p-4 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-app)] space-y-2">
        <div className="text-xs font-semibold text-[var(--text-primary)]">内置安装包</div>
        {bundled === null ? (
          <p className="text-xs text-[var(--text-muted)]">读取中…</p>
        ) : !bundled.exists ? (
          <p className="text-xs text-[var(--status-error)]">
            内置安装包缺失：assets/band-app.rpk 不在发布包里
          </p>
        ) : (
          <div className="text-xs space-y-1 text-[var(--text-secondary)] font-mono bg-[var(--bg-surface)] p-3 rounded-[var(--radius-sm)] border border-[var(--border-default)]">
            <div>包名称: {bundled.packageId ?? '未知'}</div>
            <div>版本: {bundled.versionName ?? '未知'}</div>
            <div>versionCode: {bundled.versionCode ?? '未知'}</div>
            <div>大小: {((bundled.fileSize ?? 0) / 1024).toFixed(1)} KB</div>
          </div>
        )}
      </div>

      {/* 一键安装动作 */}
      <div className="space-y-3">
        <button
          type="button"
          onClick={install}
          disabled={!canInstall}
          className="w-full px-4 py-2.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center justify-center gap-1.5"
        >
          {state === 'installing' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <PackageCheck className="w-3.5 h-3.5" />
          )}
          <span>
            {state === 'installing'
              ? `正在安装… ${percentage}%`
              : state === 'done'
              ? '重新安装'
              : '一键安装到手表'}
          </span>
        </button>

        {missing && (
          <p className="text-xs text-[var(--status-error)] flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>内置安装包缺失，无法安装。请重新安装 Pulse 桌面端。</span>
          </p>
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

        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          安装前请先在「手环」页连接手环；未连接时安装会失败。
        </p>
      </div>
    </div>
  );
};
