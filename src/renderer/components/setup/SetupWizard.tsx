import React, { useState } from 'react';
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
  type SetupStep,
  INITIAL_SETUP_STEPS,
} from './types';
import { LogImportStep } from './LogImportStep';
import { ConnectBandStep } from './ConnectBandStep';
import { InstallAppStep } from './InstallAppStep';
import { VerifyQuotaStep } from './VerifyQuotaStep';

export interface SetupWizardProps {
  onClose: () => void;
  onFinish?: () => void;
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

export const SetupWizard: React.FC<SetupWizardProps> = ({ onClose, onFinish }) => {
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [stepError, setStepError] = useState<string | null>(null);

  const steps: SetupStep[] = INITIAL_SETUP_STEPS.map((step, idx) => {
    let status: StepStatus = 'pending';
    if (idx < currentIndex) {
      status = 'completed';
    } else if (idx === currentIndex) {
      status = stepError ? 'error' : 'active';
    } else {
      status = 'pending';
    }
    return {
      ...step,
      status,
      error: idx === currentIndex && stepError ? stepError : undefined,
    };
  });

  const currentStep = steps[currentIndex];
  const isFirstStep = currentIndex === 0;
  const isLastStep = currentIndex === steps.length - 1;

  const handleNext = () => {
    setStepError(null);
    if (isLastStep) {
      onFinish?.();
      onClose();
    } else {
      setCurrentIndex((prev) => Math.min(steps.length - 1, prev + 1));
    }
  };

  const handlePrev = () => {
    setStepError(null);
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  };

  const handleStepClick = (index: number) => {
    setStepError(null);
    setCurrentIndex(index);
  };

  const handleFinish = () => {
    onFinish?.();
    onClose();
  };

  const renderStepContent = (step: SetupStep) => {
    if (step.id === 'import_log') {
      return <LogImportStep onSuccess={handleNext} />;
    }

    if (step.id === 'connect_band') {
      return <ConnectBandStep onSuccess={() => {}} />;
    }

    if (step.id === 'install_app') {
      return <InstallAppStep onSuccess={() => {}} />;
    }

    if (step.id === 'verify_quota') {
      return <VerifyQuotaStep onComplete={handleFinish} />;
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4 select-none animate-in fade-in duration-200"
    >
      <div className="w-full max-w-2xl bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-[var(--radius-xl)] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] transition-colors duration-200">
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

              let statusBadge = (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--border-strong)]" />
              );

              if (s.status === 'completed') {
                statusBadge = <CheckCircle2 className="w-3.5 h-3.5 text-[var(--status-success)] shrink-0" />;
              } else if (s.status === 'active') {
                statusBadge = <span className="w-2 h-2 rounded-full bg-[var(--accent-primary)] animate-pulse shrink-0" />;
              } else if (s.status === 'error') {
                statusBadge = <AlertCircle className="w-3.5 h-3.5 text-[var(--status-error)] shrink-0" />;
              }

              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleStepClick(idx)}
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
                          : s.status === 'completed'
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
              className="flex items-center gap-1 px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
            >
              <span>{isLastStep ? '完成向导' : '下一步'}</span>
              {!isLastStep && <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
