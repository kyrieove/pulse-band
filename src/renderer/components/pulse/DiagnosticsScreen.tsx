/**
 * 「运行诊断」（对照 Diagnostics 页）：活体检检 + 一键完整诊断。
 *
 * 数据：
 * - 检查项来自主进程 diagnostics.ts 的 pass()/warn()/fail() 返回体（9 项）
 * - daemon 健康：pulse-core-bridge 快照；错误日志：主进程 error-log 环形缓冲
 */
import React, { useCallback, useState } from 'react';
import { Check, X, AlertTriangle, Activity, Copy, LoaderCircle } from 'lucide-react';
import type { PulseCoreState, PulseErrorEntry } from '../../../main/services/pulse-core-bridge';
import type { DiagnosticReport, DiagnosticStatus } from '../../../main/services/diagnostics';
import { fmtUptime, fmtTime } from './ui';

const STATUS_LABEL: Record<DiagnosticStatus, string> = { pass: '通过', warn: '警告', fail: '失败' };

const STATUS_ICON: Record<DiagnosticStatus, string> = {
  pass: 'bg-[var(--anchor-wash)] text-[var(--accent-primary)]',
  warn: 'bg-[var(--quota-warning-wash)] text-[var(--quota-warning)]',
  fail: 'bg-[var(--quota-critical-wash)] text-[var(--quota-critical)]',
};

export interface DiagnosticsScreenProps {
  daemon: PulseCoreState['daemon'] | null;
  connection: PulseCoreState['connection'];
  errors: PulseErrorEntry[];
  onClearErrors: () => void;
  /** 来自 useQuotaState 的真正取数时刻，用于「HH:MM 检测」 */
  updatedAt: Date | null;
  /** 一键诊断前先刷新额度数据 */
  onRefresh: () => void;
}

export const DiagnosticsScreen: React.FC<DiagnosticsScreenProps> = ({
  daemon,
  connection,
  errors,
  onClearErrors,
  updatedAt,
  onRefresh,
}) => {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const runFullDiagnostics = useCallback(async () => {
    setRunningDiagnostics(true);
    setReportError(null);
    try {
      onRefresh();
      const next = await window.pulse?.runDiagnostics();
      if (!next) throw new Error('诊断接口不可用');
      setReport(next);
    } catch (err: any) {
      setReportError(String(err?.message ?? err));
    } finally {
      setRunningDiagnostics(false);
    }
  }, [onRefresh]);

  const copyReport = async () => {
    if (!report) return;
    const text = await window.pulse?.formatDiagnosticReport(report);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopyMessage('诊断报告已复制');
  };

  const reportCounts = report?.checks.reduce(
    (counts, check) => ({ ...counts, [check.status]: counts[check.status] + 1 }),
    { pass: 0, warn: 0, fail: 0 } as Record<DiagnosticStatus, number>,
  );
  const timeText = updatedAt
    ? updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '--:--';

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      {/* 标题行 */}
      <div className="shrink-0 flex items-end justify-between">
        <div>
          <h2 className="text-[23px] font-bold tracking-[-0.025em] text-[var(--text-primary)]">诊断</h2>
          <p className="text-[11.5px] text-[var(--text-muted)] mt-0.5">只读取当前状态，不修改蓝牙、设备或第三方配置</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runFullDiagnostics}
            disabled={runningDiagnostics}
            className="btn-primary rounded-full px-[15px] py-2 text-[12px] font-semibold flex items-center gap-1.5 select-none cursor-pointer bg-[var(--accent-primary)] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {runningDiagnostics ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            {runningDiagnostics ? '诊断中…' : '一键完整诊断'}
          </button>
          <button
            type="button"
            onClick={copyReport}
            disabled={!report}
            className="rounded-full px-[13px] py-2 text-[12px] font-semibold flex items-center gap-1.5 select-none cursor-pointer bg-[var(--bg-surface)] border border-[var(--border-strong)] text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Copy className="w-3.5 h-3.5" />
            复制报告
          </button>
        </div>
      </div>

      {/* 状态行 */}
      <div className="shrink-0 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        {report && reportCounts ? (
          <>
            <span className="text-[var(--status-success)]">{reportCounts.pass} 项通过</span>
            <span>·</span>
            <span className="text-[var(--quota-warning)]">{reportCounts.warn} 项警告</span>
            <span>·</span>
            <span className="tabular-nums">HH:MM 检测</span>
          </>
        ) : (
          <span>尚未运行完整诊断 · 最近额度更新 {timeText}</span>
        )}
      </div>

      {reportError && (
        <div className="shrink-0 text-[11px] text-[var(--quota-critical)] bg-[var(--quota-critical-wash)] rounded-lg p-2.5">
          诊断没有完成：{reportError}。请重启 Pulse 后重试。
        </div>
      )}
      {copyMessage && <div className="shrink-0 text-[11px] text-[var(--status-success)]">{copyMessage}</div>}

      <div className="flex-1 min-h-0 grid grid-cols-[1fr_258px] gap-2.5 overflow-y-auto custom-scrollbar">
        {/* 左：链路检查 */}
        <section className="min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
          <h3 className="shrink-0 text-[13px] font-semibold text-[var(--text-primary)]">链路检查</h3>
          {!report && !reportError && !runningDiagnostics && (
            <div className="py-8 text-center text-[11px] text-[var(--text-muted)] border border-dashed border-[var(--border-strong)] rounded-[10px] mt-3">
              点击「一键完整诊断」检查 Pulse、Hook、手环连接与应用、额度数据。
            </div>
          )}
          {report && (
            <>
              <div className="mt-2 flex-1 min-h-0 space-y-0.5">
                {report.checks.map((check) => (
                  <div key={check.id} className="flex items-center gap-2.5 py-1.5">
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${STATUS_ICON[check.status]}`}>
                      {check.status === 'pass' ? (
                        <Check className="w-2.5 h-2.5 stroke-[3]" />
                      ) : check.status === 'warn' ? (
                        <AlertTriangle className="w-2.5 h-2.5" />
                      ) : (
                        <X className="w-2.5 h-2.5 stroke-[3]" />
                      )}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium text-[var(--text-primary)]">{check.label}</div>
                      <div className="text-[10.5px] text-[var(--text-muted)] truncate">{check.summary}</div>
                    </div>
                    <span className="text-[11px] font-medium shrink-0">
                      <span
                        className={
                          check.status === 'pass'
                            ? 'text-[var(--status-success)]'
                            : check.status === 'warn'
                            ? 'text-[var(--quota-warning)]'
                            : 'text-[var(--quota-critical)]'
                        }
                      >
                        {STATUS_LABEL[check.status]}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
              <p className="shrink-0 mt-2 pt-2 border-t border-[var(--border-default)] text-[10px] text-[var(--text-muted)]">
                报告中的 MAC、地址等敏感信息已自动脱敏。
              </p>
            </>
          )}
        </section>

        {/* 右列：设备守护进程 + 异常日志 */}
        <div className="min-h-0 flex flex-col gap-2.5">
          <section className="shrink-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">设备守护进程</h3>
            <div className="mt-2 space-y-1">
              <KV label="进程 PID" value={daemon?.pid != null ? String(daemon.pid) : '--'} />
              <KV label="端点" value={daemon?.endpoint ?? '--'} />
              <KV label="运行时长" value={fmtUptime(daemon?.uptimeSeconds)} />
              <KV label="协议·平台" value={`Protocol ${daemon?.protocolVersion != null ? `v${daemon.protocolVersion}` : '--'}${daemon?.platform ? ` · ${daemon.platform}` : ''}`} />
            </div>
            {connection.state === 'error' && connection.error && (
              <p className="mt-2 text-[11px] text-[var(--quota-critical)] bg-[var(--quota-critical-wash)] rounded-lg p-2 break-all">
                {connection.error}
              </p>
            )}
          </section>

          <section className="flex-1 min-h-0 rounded-[10px] bg-[var(--bg-subtle)] p-3.5 flex flex-col">
            <div className="shrink-0 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">异常日志</h3>
              {errors.length > 0 && (
                <button onClick={onClearErrors} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer">
                  清空日志
                </button>
              )}
            </div>
            {errors.length === 0 ? (
              <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center space-y-1.5">
                <span className="w-8 h-8 rounded-full bg-[var(--anchor-wash)] text-[var(--accent-primary)] flex items-center justify-center">
                  <Check className="w-4 h-4 stroke-[2.5]" />
                </span>
                <span className="text-[12px] font-medium text-[var(--text-primary)]">当前暂无异常</span>
                <span className="text-[10.5px] text-[var(--text-muted)]">所有通信链路均正常运作</span>
              </div>
            ) : (
              <div className="mt-2 flex-1 min-h-0 space-y-1.5 overflow-y-auto custom-scrollbar pr-1">
                {errors.map((e, i) => (
                  <div key={`${e.ts}-${i}`} className="p-2 rounded-lg bg-[var(--bg-subtle)] border border-[var(--border-default)] flex items-start gap-2 text-[11px]">
                    <span className="font-mono text-[var(--text-muted)] tabular-nums shrink-0 pt-0.5">{fmtTime(e.ts)}</span>
                    <span className="text-[var(--text-secondary)] break-all">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

const KV: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between py-1 gap-2">
    <span className="text-[11px] text-[var(--text-muted)] shrink-0">{label}</span>
    <span className="text-[11px] font-mono text-[var(--text-primary)] tabular-nums text-right truncate">{value}</span>
  </div>
);
