import React from 'react';
import { Check, Loader2, Circle } from 'lucide-react';

export type ProgressStep = 'starting' | 'searching' | 'connecting' | 'authenticating' | 'connected';

export interface ConnectionProgressProps {
  currentStep: ProgressStep;
}

interface StepDefinition {
  key: ProgressStep;
  label: string;
}

const STEPS: StepDefinition[] = [
  { key: 'starting', label: '启动服务' },
  { key: 'searching', label: '查找手环' },
  { key: 'connecting', label: '建立连接' },
  { key: 'authenticating', label: '验证身份' },
  { key: 'connected', label: '已连接' },
];

const STEP_ORDER: Record<ProgressStep, number> = {
  starting: 0,
  searching: 1,
  connecting: 2,
  authenticating: 3,
  connected: 4,
};

export const ConnectionProgress: React.FC<ConnectionProgressProps> = ({ currentStep }) => {
  const currentIndex = STEP_ORDER[currentStep] ?? 0;

  return (
    <div className="w-full py-3 px-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] transition-colors duration-200">
      <div className="flex items-center justify-between relative">
        {/* 背景连接横线 */}
        <div className="absolute left-3 right-3 top-3 h-[2px] bg-black/[0.06] dark:bg-white/[0.08] -z-0" />
        <div
          className="absolute left-3 top-3 h-[2px] bg-[var(--accent-primary)] transition-all duration-300 -z-0"
          style={{ width: `${(currentIndex / (STEPS.length - 1)) * 94}%` }}
        />

        {STEPS.map((step, index) => {
          const isDone = index < currentIndex;
          const isCurrent = index === currentIndex;

          return (
            <div key={step.key} className="flex flex-col items-center gap-1.5 z-10 select-none">
              {/* 步骤节点指示器 */}
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 text-xs ${
                  isDone
                    ? 'bg-[var(--status-success)] text-white shadow-sm'
                    : isCurrent
                    ? 'bg-[var(--bg-surface)] border-2 border-[var(--accent-primary)] text-[var(--accent-primary)] shadow-sm'
                    : 'bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-muted)]'
                }`}
              >
                {isDone ? (
                  <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                ) : isCurrent ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Circle className="w-2 h-2 fill-current opacity-40" />
                )}
              </div>

              {/* 步骤文字 */}
              <span
                className={`text-[11px] font-medium tracking-tight whitespace-nowrap ${
                  isCurrent
                    ? 'text-[var(--accent-primary)] font-semibold'
                    : isDone
                    ? 'text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)]'
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
