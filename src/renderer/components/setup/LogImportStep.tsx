import React, { useEffect, useState } from 'react';
import {
  FileText,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Upload,
  Watch,
  Bluetooth,
  ArrowRight,
} from 'lucide-react';

export interface LogImportStepProps {
  onSuccess?: () => void;
}

interface ExistingStatus {
  exists: boolean;
  valid: boolean;
  deviceName?: string;
  maskedAddr?: string;
  codename?: string;
  error?: string;
}

interface PairedDevice {
  id: string;
  name: string;
  maskedMac: string;
  isXiaomiBand: boolean;
}

export const LogImportStep: React.FC<LogImportStepProps> = ({ onSuccess }) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [existingConfig, setExistingConfig] = useState<ExistingStatus | null>(null);
  const [showOverride, setShowOverride] = useState<boolean>(false);

  // 配对设备与文件导入状态
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [logPath, setLogPath] = useState<string>('');
  const [logFileName, setLogFileName] = useState<string>('');
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 初始化检查本机已有配置及已配对手环
  useEffect(() => {
    let alive = true;
    const init = async () => {
      setLoading(true);
      try {
        if (window.pulse?.getDeviceConfigStatus) {
          const status = await window.pulse.getDeviceConfigStatus();
          if (alive) setExistingConfig(status);
        }
        if (window.pulse?.getPairedBandDevices) {
          const devices = await window.pulse.getPairedBandDevices();
          if (alive) {
            setPairedDevices(devices);
            const firstXiaomi = devices.find((d) => d.isXiaomiBand);
            if (firstXiaomi) {
              setSelectedDeviceId(firstXiaomi.id);
            } else if (devices.length > 0) {
              setSelectedDeviceId(devices[0].id);
            }
          }
        }
      } catch (err: any) {
        if (alive) setErrorMessage(err?.message ?? '读取设备信息失败');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void init();
    return () => {
      alive = false;
    };
  }, []);

  const handleUseExisting = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      const res = await window.pulse?.saveDeviceConfig({ useExisting: true });
      if (res?.ok) {
        setSaveSuccess(true);
        onSuccess?.();
      } else {
        setErrorMessage(res?.error || '使用现有配置失败');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || '操作失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setErrorMessage(null);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const resolvedPath = window.pulse?.getPathForFile?.(file) || '';
    if (!resolvedPath) {
      setErrorMessage('无法获取所选文件的系统绝对路径');
      return;
    }

    setLogPath(resolvedPath);
    setLogFileName(file.name);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const resolvedPath = window.pulse?.getPathForFile?.(file) || '';
    if (!resolvedPath) {
      setErrorMessage('无法获取所选文件的系统绝对路径');
      return;
    }

    setLogPath(resolvedPath);
    setLogFileName(file.name);
  };

  const handleSaveNewConfig = async () => {
    if (!logPath) {
      setErrorMessage('请先选择或拖入手机日志文件');
      return;
    }
    if (!selectedDeviceId) {
      setErrorMessage('请选择需要绑定的蓝牙手环设备');
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    try {
      const res = await window.pulse?.saveDeviceConfig({
        logPath,
        selectedDeviceId,
      });

      if (res?.ok) {
        setSaveSuccess(true);
        onSuccess?.();
      } else {
        setErrorMessage(res?.error || '保存设备配置失败');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || '执行配置保存时发生异常');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8 text-center space-y-3">
        <Loader2 className="w-6 h-6 mx-auto text-[var(--accent-primary)] animate-spin" />
        <p className="text-xs text-[var(--text-muted)]">正在检查本机环境与蓝牙配对设备…</p>
      </div>
    );
  }

  // 1. 如果检测到本机已有有效配置且用户未选择重新覆盖
  if (existingConfig?.exists && existingConfig.valid && !showOverride && !saveSuccess) {
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
          <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-[var(--status-success)]" />
            <span>检测到本机已有手环配置</span>
          </h4>
          <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
            系统已找到此前配置的小米手环凭据。您可以直接复用该配置，或选择重新导入日志进行覆盖。
          </p>
        </div>

        <div className="p-4 rounded-[var(--radius-md)] border border-emerald-500/20 bg-emerald-500/[0.04] space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Watch className="w-5 h-5 text-[var(--status-success)]" />
              <div>
                <div className="text-xs font-semibold text-[var(--text-primary)]">
                  {existingConfig.deviceName || 'Xiaomi Smart Band 10'}
                </div>
                <div className="text-[11px] font-mono text-[var(--text-muted)]">
                  设备地址: {existingConfig.maskedAddr} · 代号: {existingConfig.codename || 'o66'}
                </div>
              </div>
            </div>
            <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium border border-emerald-500/30">
              配置合法可用
            </span>
          </div>

          <div className="pt-3 border-t border-emerald-500/15 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowOverride(true)}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer"
            >
              重新导入新日志覆盖
            </button>
            <button
              type="button"
              onClick={handleUseExisting}
              disabled={isSaving}
              className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer flex items-center gap-1.5 disabled:opacity-60"
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
              <span>直接使用此配置 (跳过导入)</span>
            </button>
          </div>
        </div>

        {errorMessage && (
          <div className="p-3 rounded-[var(--radius-md)] bg-rose-500/10 border border-rose-500/30 text-xs text-rose-500 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>
    );
  }

  // 2. 导入新日志与绑定配置界面
  return (
    <div className="space-y-4">
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
        <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
          <FileText className="w-4 h-4 text-[var(--accent-primary)]" />
          <span>导入手机日志并绑定手环</span>
        </h4>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          从小米运动健康或小米健康研究导出的日志中自动提取 AuthKey，并与 Windows 系统已配对的手环物理地址绑定。
        </p>
      </div>

      {/* 蓝牙设备选择区 */}
      <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bluetooth className="w-4 h-4 text-[var(--accent-primary)]" />
            <span className="text-xs font-semibold text-[var(--text-primary)]">
              匹配已配对手环 (系统蓝牙)
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            {pairedDevices.length > 0 ? `发现 ${pairedDevices.length} 个已配对设备` : '未发现已配对设备'}
          </span>
        </div>

        {pairedDevices.length === 0 ? (
          <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 text-xs text-amber-600 dark:text-amber-400 space-y-1">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>未在 Windows 蓝牙列表中找到已配对手环</span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] pl-5.5 leading-relaxed">
              手环必须先在 Windows 系统设置里配对。请前往：系统设置 → 蓝牙和其他设备 → 添加设备，完成手环配对后再刷新此向导。
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {pairedDevices.map((d) => (
              <label
                key={d.id}
                className={`flex items-center justify-between p-2.5 rounded-[var(--radius-md)] border cursor-pointer transition-all ${
                  selectedDeviceId === d.id
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/[0.05]'
                    : 'border-[var(--border-default)] hover:bg-[var(--bg-surface)]'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="bandDevice"
                    value={d.id}
                    checked={selectedDeviceId === d.id}
                    onChange={() => setSelectedDeviceId(d.id)}
                    className="text-[var(--accent-primary)] focus:ring-0"
                  />
                  <div>
                    <div className="text-xs font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                      <span>{d.name}</span>
                      {d.isXiaomiBand && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
                          小米手环
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-[var(--text-muted)]">
                      MAC: {d.maskedMac}
                    </div>
                  </div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* 日志拖拽 / 选择区 */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleFileDrop}
        className={`p-6 rounded-[var(--radius-md)] border-2 border-dashed transition-all text-center space-y-3 bg-[var(--bg-app)] ${
          isDragging
            ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/[0.04]'
            : 'border-[var(--border-strong)]'
        }`}
      >
        <Upload className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
        <div className="space-y-1">
          <p className="text-xs font-medium text-[var(--text-primary)]">
            {logFileName ? `已选文件：${logFileName}` : '拖入日志文件或点击选择'}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            支持 XiaomiFit.main.log、Mi Fitness 导出的 zip 压缩包或解压文件夹
          </p>
        </div>

        <label className="inline-block px-3.5 py-1.5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-default)] hover:bg-[var(--bg-app)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer shadow-sm">
          <span>浏览本地文件…</span>
          <input
            type="file"
            accept=".log,.zip,text/plain"
            onChange={handleFileInputChange}
            className="hidden"
          />
        </label>
      </div>

      {/* 错误提示 */}
      {errorMessage && (
        <div className="p-3 rounded-[var(--radius-md)] bg-rose-500/10 border border-rose-500/30 text-xs text-rose-500 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* 成功确认 */}
      {saveSuccess && (
        <div className="p-3 rounded-[var(--radius-md)] bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-500 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>配置已成功保存至 device.json！正在进入下一步…</span>
        </div>
      )}

      {/* 底部按钮操作 */}
      <div className="flex items-center justify-between pt-2">
        {existingConfig?.exists && (
          <button
            type="button"
            onClick={() => setShowOverride(false)}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] underline cursor-pointer"
          >
            取消并返回已有配置
          </button>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={handleSaveNewConfig}
            disabled={isSaving || !logPath || !selectedDeviceId}
            className="px-4 py-2 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            <span>保存并继续</span>
          </button>
        </div>
      </div>
    </div>
  );
};
