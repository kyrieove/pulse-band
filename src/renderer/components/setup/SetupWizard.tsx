import React, { useState } from 'react';
import {
  Watch,
  FileText,
  ShieldCheck,
  Bluetooth,
  Network,
  PackageCheck,
  CheckCircle2,
  AlertCircle,
  Clock,
  ChevronRight,
  ChevronLeft,
  X,
  Layers,
} from 'lucide-react';
import {
  type SetupStepId,
  type StepStatus,
  type SetupStep,
  INITIAL_SETUP_STEPS,
} from './types';

export interface SetupWizardProps {
  onClose: () => void;
  onFinish?: () => void;
}

const STEP_ICONS: Record<SetupStepId, React.ElementType> = {
  prepare: Watch,
  import_log: FileText,
  save_credentials: ShieldCheck,
  windows_pairing: Bluetooth,
  rfcomm_auth: Network,
  install_app: PackageCheck,
  verify_quota: CheckCircle2,
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
      onFinish ? onFinish() : onClose();
    } else {
      setCurrentIndex((prev) => Math.min(steps.length - 1, prev + 1));
    }
  };

  const handlePrev = () => {
    setStepError(null);
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  };

  const handleStepClick = (index: number) => {
    // 允许用户回看已完成步骤或当前步骤
    if (index <= currentIndex) {
      setStepError(null);
      setCurrentIndex(index);
    }
  };

  // 渲染具体步骤的占位与指导信息（无假进度、无假成功、无真实硬件操作）
  const renderStepContent = (step: SetupStep) => {
    switch (step.id) {
      case 'prepare':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Watch className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>手环准备要点</span>
              </h4>
              <ul className="text-xs text-[var(--text-secondary)] space-y-2 list-disc list-inside leading-relaxed">
                <li>确认手环电量充足并保持亮屏就绪。</li>
                <li>若手环已绑定手机端健康应用，请在手环设置中进入“连接新手机”使其处于可被发现模式。</li>
                <li>确认当前 Windows 电脑的蓝牙开关处于开启状态。</li>
              </ul>
            </div>

            <div className="p-3.5 rounded-[var(--radius-md)] bg-black/[0.02] dark:bg-white/[0.03] border border-dashed border-[var(--border-strong)] text-xs text-[var(--text-muted)] flex items-center justify-between">
              <span>手环检测与环境准备</span>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)]">
                占位待命
              </span>
            </div>
          </div>
        );

      case 'import_log':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <FileText className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>手机日志导入指引</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                从手机端导出的健康应用日志压缩包中提取设备认证信息。提取过程全程在本地内存执行，不向任何网络服务器上传。
              </p>
            </div>

            <div className="p-6 rounded-[var(--radius-md)] border-2 border-dashed border-[var(--border-strong)] text-center space-y-2 bg-[var(--bg-app)]">
              <FileText className="w-8 h-8 mx-auto text-[var(--text-muted)]" />
              <p className="text-xs font-medium text-[var(--text-primary)]">
                拖入手机日志文件或点击选取
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">
                占位状态 · 真实文件读取与认证信息解析待后续子任务接入
              </p>
            </div>
          </div>
        );

      case 'save_credentials':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>Windows DPAPI 本地用户安全加密</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                提取的设备认证凭据将使用 Windows 数据保护接口 (DPAPI) 基于当前登录用户凭据进行硬件绑定加密，杜绝明文文件留存。
              </p>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-between text-xs">
              <div>
                <div className="font-medium text-[var(--text-primary)]">凭据加密策略</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">本地安全上下文加密保护</div>
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                准备接入
              </span>
            </div>
          </div>
        );

      case 'windows_pairing':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Bluetooth className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>Windows 经典蓝牙配对</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                引导在 Windows 蓝牙系统管理器中发现并完成与手环的配对绑定。配对请求发出后需在手环屏幕上点击确认。
              </p>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-between text-xs">
              <div>
                <div className="font-medium text-[var(--text-primary)]">系统配对通道</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Windows Bluetooth API 待命</div>
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                占位待命
              </span>
            </div>
          </div>
        );

      case 'rfcomm_auth':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <Network className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>RFCOMM 链路握手与认证校验</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                通过物理串口建立稳定通信，使用已保存的认证凭据进行双向鉴权校验，构建受保护的可靠传输通道。
              </p>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-between text-xs">
              <div>
                <div className="font-medium text-[var(--text-primary)]">链路认证协议</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">通道握手与保活机制</div>
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                待发起
              </span>
            </div>
          </div>
        );

      case 'install_app':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <PackageCheck className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>手环端快应用部署</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                将内置的 Pulse 手环端快应用包推送并安装至手环。安装完成后，手环屏幕上将出现配套快应用图标。
              </p>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-between text-xs">
              <div>
                <div className="font-medium text-[var(--text-primary)]">内置应用包</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">Pulse Band Quick App v1.1.0</div>
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                就绪待推
              </span>
            </div>
          </div>
        );

      case 'verify_quota':
        return (
          <div className="space-y-4">
            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] space-y-2.5">
              <h4 className="text-xs font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-[var(--accent-primary)]" />
                <span>全链路数据验证</span>
              </h4>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                触发一次数据帧推送测试，确认 AI Agent 状态与额度数据能够实时、准确地呈现在手环界面上。
              </p>
            </div>

            <div className="p-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-between text-xs">
              <div>
                <div className="font-medium text-[var(--text-primary)]">数据同步验证</div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5">双向端到端通道检验</div>
              </div>
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-secondary)]">
                待验证
              </span>
            </div>
          </div>
        );

      default:
        return null;
    }
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
            className="p-1 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors"
            title="关闭向导"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 主体：左侧步骤状态导航 + 右侧步骤详情与占位 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧步骤列表 */}
          <aside className="w-56 shrink-0 bg-[var(--bg-app)] border-r border-[var(--border-default)] p-3 overflow-y-auto custom-scrollbar space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] px-2 py-1">
              流程步骤
            </div>

            {steps.map((s, idx) => {
              const Icon = STEP_ICONS[s.id] ?? Clock;
              const isSelected = idx === currentIndex;
              const canClick = idx <= currentIndex;

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
                  disabled={!canClick}
                  onClick={() => handleStepClick(idx)}
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-[var(--radius-md)] text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] font-semibold shadow-[var(--shadow-sm)] border border-[var(--border-default)]'
                      : canClick
                      ? 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)]/60 cursor-pointer'
                      : 'text-[var(--text-muted)] opacity-50 cursor-not-allowed'
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
              <span>状态模型：UI 骨架占位态</span>
              <span className="font-mono text-[10px]">Subproject 2 Ready</span>
            </div>
          </main>
        </div>

        {/* 底部操作工具条 */}
        <div className="px-5 py-3 border-t border-[var(--border-default)] bg-[var(--bg-app)] flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-default)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors"
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
                  : 'hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)]'
              }`}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>上一步</span>
            </button>

            <button
              type="button"
              onClick={handleNext}
              className="flex items-center gap-1 px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] hover:bg-[var(--accent-hover)] text-white text-xs font-medium transition-colors shadow-sm"
            >
              <span>{isLastStep ? '完成设置' : '下一步'}</span>
              {!isLastStep && <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
