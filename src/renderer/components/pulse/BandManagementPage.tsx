import React, { useState } from 'react';
import { Watch, Package, ChevronDown, ChevronRight, Upload } from 'lucide-react';

export interface BandManagementPageProps {
  onStartSetup?: () => void;
}

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-5">
      {/* 设备状态区域骨架 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-secondary)]">
              <Watch className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                Xiaomi Smart Band 10
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                已配置手环 · 状态：未连接
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onStartSetup}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors cursor-pointer"
            title="进入手环设置向导，重新配置设备"
          >
            更换手环
          </button>
        </div>

        <div className="pt-3 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>日常连接与同步管理</span>
          <button
            type="button"
            disabled
            className="px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium opacity-60 cursor-not-allowed"
          >
            连接
          </button>
        </div>
      </section>

      {/* Pulse 快应用版本区域骨架 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3 transition-colors duration-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-[var(--text-muted)]" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Pulse 手环快应用
            </h3>
          </div>
          <span className="text-xs font-mono text-[var(--text-muted)]">
            v1.1.0 (内置版本)
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          配套手环端快应用负责在手环屏幕上实时渲染 Agent 运行状态与配额。
        </p>
      </section>

      {/* 高级区域：推送其他快应用 (默认折叠) */}
      <section className="rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] overflow-hidden transition-colors duration-200">
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="w-full p-4 flex items-center justify-between text-left hover:bg-[var(--bg-app)] transition-colors"
        >
          <div className="flex items-center gap-2">
            {advancedOpen ? (
              <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
            ) : (
              <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
            )}
            <span className="text-xs font-medium text-[var(--text-primary)]">
              高级工具：推送其他快应用
            </span>
          </div>
          <span className="text-[11px] text-[var(--text-muted)]">
            {advancedOpen ? '点击收起' : '默认折叠'}
          </span>
        </button>

        {advancedOpen && (
          <div className="p-5 pt-1 border-t border-[var(--border-default)] space-y-3">
            <div className="p-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border-strong)] text-center space-y-2 bg-[var(--bg-app)]">
              <Upload className="w-6 h-6 mx-auto text-[var(--text-muted)]" />
              <p className="text-xs text-[var(--text-secondary)]">
                支持拖入或选择单个 .rpk 文件
              </p>
              <p className="text-[11px] text-[var(--text-muted)]">
                高级开发工具，非页面主要视觉中心
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
};
