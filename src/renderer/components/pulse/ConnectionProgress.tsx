import React from 'react';
import { Check } from 'lucide-react';

export type ProgressStep = 'starting' | 'searching' | 'connecting' | 'authenticating' | 'connected';

export interface ConnectionProgressProps {
  /** 当前进行中的步骤；null 表示无进行中步骤（未开始 / 失败） */
  currentStep: ProgressStep | null;
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
  const currentIndex = currentStep == null ? -1 : (STEP_ORDER[currentStep] ?? -1);

  return (
    <div className="w-full py-3 px-4 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] transition-colors duration-200">
      <div className="flex items-center justify-between relative">
        {/* 背景连接线 */}
        <div className="absolute left-3 right-3 top-[11px] h-[2px] bg-[var(--bg-subtle)] -z-0" />
        {/* 跟随进度的着色连接线 */}
        <div
          className="absolute left-3 top-[11px] h-[2px] bg-[var(--accent-primary)] transition-all duration-300 -z-0"
          style={{ width: currentIndex <= 0 ? '0%' : `${(currentIndex / (STEPS.length - 1)) * 100}%` }}
        />

        {STEPS.map((step, index) => {
          const isDone = currentIndex >= index;
          const isCurrent = index === currentIndex;

          return (
            <div key={step.key} className="flex flex-col items-center gap-1.5 z-10 select-none">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200 text-xs ${
                  isDone && !isCurrent
                    ? 'bg-[var(--accent-wash)] text-[var(--accent-primary)]'
                    : isCurrent
                    ? 'bg-[var(--accent-soft)] text-white ring-2 ring-[var(--accent-soft)]'
                    : 'bg-[var(--bg-subtle)] border border-[var(--border-default)] text-[var(--text-muted)]'
                }`}
              >
                {isDone && !isCurrent ? <Check className="w-3.5 h-3.5 stroke-[2.5]" /> : null}
              </div>
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