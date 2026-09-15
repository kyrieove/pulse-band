import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Watch,
  FileText,
  Bluetooth,
  PackageCheck,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronRight,
  ChevronLeft,
  X,
  Layers,
  ShieldCheck,
  Network,
} from 'lucide-react';
import {
  type SetupStepId,
  type StepStatus,
  type StepExecutionStatus,
  type SetupStep,
  INITIAL_SETUP_STEPS,
} from './types';
import { LogImportStep } from './LogImportStep';
import { ConnectBandStep } from './ConnectBandStep';
import { InstallAppStep } from './InstallAppStep';
import { VerifyQuotaStep, type QuotaVerifyOutcome } from './VerifyQuotaStep';

export interface SetupWizardProps {
  onClose: () => void;
  /** 完成向导时回报额度验证结果（deferred = 稍后验证，不代表已验证） */
  onFinish?: (outcome?: QuotaVerifyOutcome) => void;
  /** 打开时直接落在第几步（0-based）。用于"稍后验证"后回到第 4 步继续。 */
  initialStepIndex?: number;
}

const STEP_ICONS: Record<SetupStepId, React.ElementType> = {
  import_log: FileText,
  connect_band: Bluetooth,
  install_app: PackageCheck,
  verify_quota: CheckCircle2,
  // 保持兼容旧步骤标识
  prepare: Watch,
  save_credentials: ShieldCheck,
  windows_pairing: Bluetooth,
  rfcomm_auth: Network,
};

export const SetupWizard: React.FC<SetupWizardProps> = ({ onClose, onFinish, initialStepIndex }) => {
  const [currentIndex, setCurrentIndex] = useState<number>(() => {
    const max = INITIAL_SETUP_STEPS.length - 1;
    const start = typeof initialStepIndex === 'number' ? initialStepIndex : 0;
    return Math.min(Math.max(0, start), max);
  });
  const [stepError, setStepError] = useState<string | null>(null);

  // 严格记录每一步的真实执行状态，绝不根据访问顺序伪造成功标记
  const [stepExecution, setStepExecution] = useState<Partial<Record<SetupStepId, StepExecutionStatus>>>(() => {
    const initial: Partial<Record<SetupStepId, StepExecutionStatus>> = {
      import_log: 'pending',
      connect_band: 'pending',
      install_app: 'pending',
      verify_quota: 'pending',
    };
    const start = typeof initialStepIndex === 'number' ? initialStepIndex : 0;
    const startId = INITIAL_SETUP_STEPS[start]?.id;
    if (startId) {
      initial[startId] = 'visited';
    }
    return initial;
  });

  // 挂载时检查本机已有真实配置与手环连接，如已真实就绪则标记为已成功
  useEffect(() => {
    let alive = true;
    window.pulse?.getDeviceConfigStatus?.()
      .then((status) => {
        if (alive && status?.exists && status?.valid) {
          setStepExecution((prev) => ({
            ...prev,
            import_log: 'success',
          }));
        }
      })
      .catch(() => {});

    window.pulse?.getCoreState?.()
      .then((s) => {
        if (alive && s?.connection?.state === 'connected') {
          setStepExecution((prev) => ({
            ...prev,
            connect_band: 'success',
          }));
        }
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, []);

  // ---- 模态焦点管理（审查第 13 项）：打开迁入、Tab 约束在向导内、关闭后恢复触发元素 ----
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // 焦点先落在面板本身（tabIndex=-1，不显示焦点圈），Tab 从关闭按钮开始
    dialogRef.current?.focus();
    return () => {
      // 卸载（Esc / 关闭 / 完成）时把焦点还给打开向导的元素
      previousFocusRef.current?.focus?.();
    };
  }, []);

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const handleWizardKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = dialogRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = !!active && panel.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const steps: SetupStep[] = INITIAL_SETUP_STEPS.map((step, idx) => {
    const exec = stepExecution[step.id] || 'pending';
    let status: StepStatus = 'pending';
    if (exec === 'success') {
      status = 'completed';
    } else if (idx === currentIndex) {
      status = stepError ? 'error' : 'active';
    } else {
      status = 'pending';
    }
    return {
      ...step,
      executionStatus: exec,
      status,
      error: idx === currentIndex && stepError ? stepError : undefined,
    };
  });

  const currentStep = steps[currentIndex];
  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === steps.length - 1;
  const currentExec = stepExecution[currentStep.id] || 'pending';
  const isCurrentSuccess = currentExec === 'success';

  // 这几个回调会作为 prop 交给子步骤。不包 useCallback 的话每次渲染都是新函数，
  // 子步骤里把它放进 effect 依赖就会跟着无限重渲染（见 ConnectBandStep 的说明）。
  const handleFinish = useCallback(
    (outcome?: QuotaVerifyOutcome) => {
      onFinish?.(outcome);
      onClose();
    },
    [onFinish, onClose]
  );

  const handleImportLogSuccess = useCallback(() => {
    setStepExecution((prev) => ({ ...prev, import_log: 'success' }));
    setCurrentIndex(1);
    setStepExecution((prev) => ({
      ...prev,
      connect_band: prev.connect_band === 'pending' ? 'visited' : prev.connect_band,
    }));
  }, []);

  const handleConnectBandSuccess = useCallback(() => {
    setStepExecution((prev) => ({ ...prev, connect_band: 'success' }));
  }, []);

  const handleInstallAppSuccess = useCallback(() => {
    setStepExecution((prev) => ({ ...prev, install_app: 'success' }));
  }, []);

  const handleVerifyQuotaComplete = useCallback(
    (outcome: QuotaVerifyOutcome) => {
      if (outcome === 'confirmed') {
        setStepExecution((prev) => ({ ...prev, verify_quota: 'success' }));
        handleFinish('confirmed');
      } else {
        setStepExecution((prev) => ({
          ...prev,
          verify_quota: prev.verify_quota === 'success' ? 'success' : 'skipped',
        }));
        handleFinish('deferred');
      }
    },
    [handleFinish]
  );

  const handleNext = () => {
    setStepError(null);
    if (isLastStep) {
      if (isCurrentSuccess) {
        handleFinish('confirmed');
      } else {
        setStepExecution((prev) => ({
          ...prev,
          [currentStep.id]: prev[currentStep.id] === 'success' ? 'success' : 'skipped',
        }));
        handleFinish('deferred');
      }
    } else {
      // 未确认成功的步骤在跳往下一步时标记为已跳过
      if (!isCurrentSuccess) {
        setStepExecution((prev) => ({
          ...prev,
          [currentStep.id]: prev[currentStep.id] === 'success' ? 'success' : 'skipped',
        }));
      }
      const nextIndex = Math.min(steps.length - 1, currentIndex + 1);
      setCurrentIndex(nextIndex);
      const nextStep = INITIAL_SETUP_STEPS[nextIndex];
      if (nextStep) {
        setStepExecution((prev) => ({
          ...prev,
          [nextStep.id]: prev[nextStep.id] === 'pending' ? 'visited' : prev[nextStep.id],
        }));
      }
    }
  };

  const handlePrev = () => {
    setStepError(null);
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  };

  const handleStepClick = (index: number) => {
    setStepError(null);
    setCurrentIndex(index);
    const targetStep = INITIAL_SETUP_STEPS[index];
    if (targetStep) {
      setStepExecution((prev) => ({
        ...prev,
        [targetStep.id]: prev[targetStep.id] === 'pending' ? 'visited' : prev[targetStep.id],
      }));
    }
  };

  const renderStepContent = (step: SetupStep) => {
    if (step.id === 'import_log') {
      return <LogImportStep onSuccess={handleImportLogSuccess} />;
    }

    if (step.id === 'connect_band') {
      return <ConnectBandStep onSuccess={handleConnectBandSuccess} />;
    }

    if (step.id === 'install_app') {
      return <InstallAppStep onSuccess={handleInstallAppSuccess} />;
    }

    if (step.id === 'verify_quota') {
      return (
        <div className="space-y-4">
          {/* 最后一页：向导步骤完成汇总 */}
          <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-[var(--accent-primary)]" />
                <h4 className="text-xs font-semibold text-[var(--text-primary)]">向导配置执行汇总</h4>
              </div>
              <span className="text-[11px] font-mono text-[var(--text-muted)]">
                已就绪 {steps.filter((s) => stepExecution[s.id] === 'success').length} / {steps.length} 项
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {steps.map((s) => {
                const exec = stepExecution[s.id];
                const isOk = exec === 'success';
                const isSkip = exec === 'skipped';
                return (
                  <div
                    key={s.id}
                    className={`p-2.5 rounded-[var(--radius-md)] border flex items-start gap-2 ${
                      isOk
                        ? 'bg-emerald-500/[0.06] border-emerald-500/25 text-[var(--text-primary)]'
                        : isSkip
                        ? 'bg-[var(--bg-surface)] border-[var(--border-default)] text-[var(--text-muted)]'
                        : 'bg-amber-500/[0.05] border-amber-500/25 text-[var(--text-secondary)]'
                    }`}
                  >
                    {isOk ? (
                      <CheckCircle2 className="w-4 h-4 text-[var(--status-success)] shrink-0 mt-0.5" />
                    ) : isSkip ? (
                      <span className="w-4 h-4 rounded-full bg-[var(--border-strong)] flex items-center justify-center text-[10px] text-white shrink-0 mt-0.5 font-bold">
                        —
                      </span>
                    ) : (
                      <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[11px] flex items-center justify-between">
                        <span className="truncate">{s.title}</span>
                        <span
                          className={`text-[10px] px-1 py-0.2 rounded font-normal shrink-0 ${
                            isOk
                              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                              : isSkip
                              ? 'bg-[var(--bg-subtle)] text-[var(--text-muted)]'
                              : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {isOk ? '已完成' : isSkip ? '已跳过' : '未完成'}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--text-muted)] mt-0.5 leading-tight">
                        {s.id === 'import_log'
                          ? isOk
                            ? '已提取 AuthKey 并完成设备绑定'
                            : '未绑定设备配置'
                          : s.id === 'connect_band'
                          ? isOk
                            ? '蓝牙 RFCOMM 安全通道已就绪'
                            : '手环当前未连接'
                          : s.id === 'install_app'
                          ? isOk
                            ? 'Pulse 快应用已推送至手环'
                            : '手环端尚未安装快应用'
                          : isOk
                          ? '已在手环屏幕确认卡片显示正常'
                          : '待在手环屏幕核验'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {steps.some((s) => stepExecution[s.id] !== 'success') && (
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed pt-1">
                未完成或跳过的步骤不会影响桌面端运行，可随时在「手环」管理页继续操作。
              </p>
            )}
          </div>

          <VerifyQuotaStep onComplete={handleVerifyQuotaComplete} />
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">
            {step.title}
          </h4>
          <p className="text-xs text-[var(--text-secondary)]">
            {step.description}
          </p>
        </div>
      </div>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
      onKeyDown={handleWizardKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none animate-in fade-in duration-200"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="w-full max-w-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-[var(--radius-xl)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] transition-colors duration-200 outline-none"
      >
        {/* 顶部标题栏 */}
        <div className="px-5 py-3.5 border-b border-[var(--border-default)] flex items-center justify-between bg-[var(--bg-surface)]">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-[var(--radius-sm)] bg-sky-500/15 flex items-center justify-center text-[var(--accent-primary)]">
              <Layers className="w-3.5 h-3.5" />
            </div>
            <div>
              <h3 id="wizard-title" className="text-sm font-semibold text-[var(--text-primary)]">
                Pulse 2.0 手环设置向导
              </h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                步骤 {currentStep.index} / {steps.length} · {currentStep.title}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors cursor-pointer"
            title="关闭向导"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 主体：左侧步骤导航 + 右侧步骤内容 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧步骤列表 */}
          <aside className="w-52 shrink-0 bg-[var(--bg-app)] border-r border-[var(--border-default)] p-3 overflow-y-auto custom-scrollbar space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-2 py-1">
              配置流程
            </div>

            {steps.map((s, idx) => {
              const Icon = STEP_ICONS[s.id] ?? Clock;
              const isSelected = idx === currentIndex;
              const exec = s.executionStatus;

              let statusBadge = (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--border-strong)] shrink-0" />
              );

              if (exec === 'success') {
                statusBadge = <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-success)] shrink-0" />;
              } else if (exec === 'skipped') {
                statusBadge = (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-subtle)] text-[var(--text-muted)] leading-none shrink-0 font-normal">
                    已跳过
                  </span>
                );
              } else if (exec === 'visited' && !isSelected) {
                statusBadge = (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 leading-none shrink-0 font-normal">
                    待办
                  </span>
                );
              } else if (isSelected) {
                statusBadge = <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-pulse shrink-0" />;
              }

              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleStepClick(idx)}
                  aria-current={isSelected ? 'step' : undefined}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-[var(--radius-md)] text-xs text-left transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold shadow-[var(--shadow-sm)] border border-[var(--border-default)]'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Icon
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isSelected
                          ? 'text-[var(--accent-primary)]'
                          : exec === 'success'
                          ? 'text-[var(--status-success)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                    />
                    <span className="truncate text-[11px]">{s.shortLabel}</span>
                  </div>
                  {statusBadge}
                </button>
              );
            })}
          </aside>

          {/* 右侧步骤内容展示 */}
          <main className="flex-1 p-6 overflow-y-auto custom-scrollbar flex flex-col justify-between space-y-6 bg-[var(--bg-surface)]">
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
                    步骤 {currentStep.index}
                  </span>
                  <h4 className="text-base font-semibold text-[var(--text-primary)]">
                    {currentStep.title}
                  </h4>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {currentStep.description}
                </p>
              </div>

              {/* 步骤错误提示 */}
              {currentStep.status === 'error' && currentStep.error && (
                <div className="p-3 rounded-[var(--radius-md)] bg-rose-500/[0.08] border border-rose-500/25 flex items-start gap-2 text-xs text-[var(--status-error)]">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p>{currentStep.error}</p>
                </div>
              )}

              {/* 核心步骤内容区 */}
              {renderStepContent(currentStep)}
            </div>

            {/* 底部架构说明注释 */}
            <div className="pt-4 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
              <span>手环链路：真实 RFCOMM 与业务快应用闭环</span>
              <span className="font-mono text-[10px]">Real Device Pipeline</span>
            </div>
          </main>
        </div>

        {/* 底部操作工具条 */}
        <div className="px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-app)] flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
          >
            退出向导
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isFirstStep}
              onClick={handlePrev}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] transition-colors ${
                isFirstStep
                  ? 'opacity-40 cursor-not-allowed'
                  : 'hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] cursor-pointer'
              }`}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>上一步</span>
            </button>

            <button
              type="button"
              onClick={handleNext}
              className={`flex items-center gap-1 px-4 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors shadow-sm cursor-pointer ${
                isCurrentSuccess
                  ? 'bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white'
                  : 'bg-[var(--bg-subtle)] hover:bg-[var(--border-strong)] border border-[var(--border-default)] text-[var(--text-primary)]'
              }`}
            >
              <span>
                {isLastStep
                  ? isCurrentSuccess
                    ? '完成向导'
                    : '跳过，稍后配置'
                  : isCurrentSuccess
                  ? '下一步'
                  : '跳过，稍后配置'}
              </span>
              {isLastStep ? (
                isCurrentSuccess ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                ) : null
              ) : (
                <ChevronRight className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
