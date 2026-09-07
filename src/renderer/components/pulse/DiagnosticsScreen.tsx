/**
 * 次屏「运行诊断」（照 pulse-ui-mockup/diagnostics.html 搬入 React）。
 *
 * 数据：
 * - daemon 健康：oronbox-bridge 快照
 * - 错误日志：主进程 error-log 环形缓冲
 *
 * 三家额度卡片已移到设备管理页，见 QuotaCards.tsx。
 */
import React, { useState } from 'react';
import { CheckCircle2, Server, TriangleAlert, Activity, LoaderCircle, Copy } from 'lucide-react';
import type { PulseOronboxState, PulseErrorEntry } from '../../../main/services/oronbox-bridge';
import type { DiagnosticReport, DiagnosticStatus } from '../../../main/services/diagnostics';
import { fmtUptime, fmtTime } from './ui';

const ERROR_TONE: Record<string, string> = {
  device: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  quota: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  bridge: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  daemon: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  install: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  settings: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

const DIAGNOSTIC_TONE: Record<DiagnosticStatus, { card: string; badge: string; label: string }> = {
  pass: {
    card: 'bg-emerald-500/[0.06] border-emerald-500/20',
    badge: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    label: '通过',
  },
  warn: {
    card: 'bg-amber-500/[0.06] border-amber-500/25',
    badge: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
    label: '警告',
  },
  fail: {
    card: 'bg-rose-500/[0.06] border-rose-500/25',
    badge: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
    label: '失败',
  },
};

export const DiagnosticsScreen: React.FC<{
  daemon: PulseOronboxState['daemon'] | null;
  connection: PulseOronboxState['connection'];
  errors: PulseErrorEntry[];
  onClearErrors: () => void;
}> = ({ daemon, connection, errors, onClearErrors }) => {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);

  const daemonActive = daemon?.rpcConnected === true;
  const daemonTone = daemonActive ? 'success' : 'danger';
  const reportCounts = report?.checks.reduce(
    (counts, check) => ({ ...counts, [check.status]: counts[check.status] + 1 }),
    { pass: 0, warn: 0, fail: 0 } as Record<DiagnosticStatus, number>,
  );

  const runFullDiagnostics = async () => {
    setRunningDiagnostics(true);
    setReportError(null);
    try {
      const next = await window.pulse?.runDiagnostics();
      if (!next) throw new Error('诊断接口不可用');
      setReport(next);
    } catch (err: any) {
      setReportError(String(err?.message ?? err));
    } finally {
      setRunningDiagnostics(false);
    }
  };

  const copyReport = async () => {
    if (!report) return;
    const text = await window.pulse?.formatDiagnosticReport(report);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopyMessage('诊断报告已复制');
  };

  const copyErrors = async () => {
    const text = await window.pulse?.formatErrorLog();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopyMessage('异常日志已复制');
  };

  return (
    <main className="flex-1 bg-island-bg overflow-y-auto custom-scrollbar p-5 space-y-4 select-text">
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-island-accent/10 border border-island-accent/25 text-island-accent flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">一键完整诊断</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">只读取当前状态，不会修改蓝牙、设备或第三方配置</p>
            </div>
          </div>
          <div className="flex gap-2 select-none">
            {report && <button onClick={copyReport} className="px-3 py-2 rounded-lg text-xs bg-zinc-800 text-zinc-300 flex items-center gap-1.5"><Copy className="w-3.5 h-3.5" />复制诊断报告</button>}
            <button
              onClick={runFullDiagnostics}
              disabled={runningDiagnostics}
              className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-island-accent/15 border border-island-accent/35 text-island-accent hover:bg-island-accent/25 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5 shrink-0"
            >
              {runningDiagnostics ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
              {runningDiagnostics ? '正在检查…' : report ? '重新诊断' : '开始完整诊断'}
            </button>
          </div>
        </div>

        {reportError && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
            诊断没有完成：{reportError}。请重启 Pulse 后重试。
          </div>
        )}
        {copyMessage && <div className="text-xs text-emerald-400">{copyMessage}</div>}

        {!report && !reportError && !runningDiagnostics && (
          <div className="py-4 text-center text-xs text-zinc-500 border border-dashed border-white/[0.08] rounded-lg">
            点击按钮检查 Pulse、Claude Hook、OronBox、手环应用和额度数据。
          </div>
        )}

        {report && reportCounts && (
          <>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-zinc-500 mr-auto">完成于 {fmtTime(report.checkedAt)}</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">通过 {reportCounts.pass}</span>
              <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/20">警告 {reportCounts.warn}</span>
              <span className="px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-300 border border-rose-500/20">失败 {reportCounts.fail}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {report.checks.map((check) => {
                const tone = DIAGNOSTIC_TONE[check.status];
                return (
                  <div key={check.id} className={`p-3 rounded-lg border ${tone.card}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs font-semibold text-zinc-200">{check.label}</div>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${tone.badge}`}>{tone.label}</span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1 leading-relaxed">{check.summary}</p>
                    {check.nextStep && <p className="text-[11px] text-zinc-300 mt-1.5 leading-relaxed">下一步：{check.nextStep}</p>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* 诊断 2：daemon 健康 */}
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-7 h-7 rounded-lg flex items-center justify-center ${
                daemonActive ? 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400' : 'bg-rose-500/10 border border-rose-500/25 text-rose-400'
              }`}
            >
              <Server className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">OronBox 后台守护进程 (Daemon)</h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">负责与底层 Windows 蓝牙栈、SPP 协议与手环驱动交互</p>
            </div>
          </div>
          <div
            className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${
              daemonTone === 'success'
                ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                : 'bg-rose-500/15 border border-rose-500/30 text-rose-400'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${daemonActive ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-rose-500'}`} />
            <span>{daemonActive ? '正常运行中 (Active)' : '未连接 (Down)'}</span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 pt-2 border-t border-white/[0.06] text-xs">
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">进程 PID</div>
            <div className="text-zinc-200 font-mono tabular-nums text-sm font-semibold mt-0.5">{daemon?.pid ?? '--'}</div>
          </div>
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">回环通信端点</div>
            <div className="text-zinc-200 font-mono tabular-nums text-sm font-semibold mt-0.5">{daemon?.endpoint ?? '--'}</div>
          </div>
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">守护进程运行时长</div>
            <div className="text-zinc-200 font-mono tabular-nums text-sm font-semibold mt-0.5">
              {fmtUptime(daemon?.uptimeSeconds)}
              {daemon?.uptimeSeconds != null && <span className="text-[11px] text-zinc-500"> ({daemon.uptimeSeconds}s)</span>}
            </div>
          </div>
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">协议版本 / 平台</div>
            <div className="text-zinc-200 font-mono text-sm font-semibold mt-0.5 flex items-center justify-between">
              <span className={daemon?.degraded ? 'text-amber-400' : ''}>
                Protocol {daemon?.protocolVersion != null ? `v${daemon.protocolVersion}` : '--'}
              </span>
              <span className="text-[10px] text-zinc-500">{daemon?.platform ?? '--'}</span>
            </div>
          </div>
        </div>

        {connection.state === 'error' && connection.error && (
          <div className="text-[11px] text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2 break-all">
            最近一次连接错误：{connection.error}
          </div>
        )}
      </section>

      {/* 诊断 3：错误日志 */}
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TriangleAlert className="w-4 h-4 text-rose-400" />
            <h3 className="text-sm font-semibold text-zinc-200">最近异常与错误日志 (最新在上)</h3>
          </div>
          <div className="flex items-center gap-3 select-none">
            <button onClick={copyErrors} className="text-[11px] text-island-accent hover:text-sky-300 font-medium transition">复制全部日志</button>
            <button onClick={onClearErrors} className="text-[11px] text-zinc-500 hover:text-zinc-300 font-medium transition">清空日志</button>
          </div>
        </div>

        {errors.length === 0 ? (
          <div className="py-6 text-center text-xs text-zinc-500 space-y-1">
            <div className="w-8 h-8 mx-auto rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <div className="text-zinc-300 font-medium">当前暂无异常日志</div>
            <p className="text-[11px] text-zinc-500">所有通信链路、额度抓取与手环代理均正常运作</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-[140px] overflow-y-auto custom-scrollbar pr-1">
            {errors.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="p-2.5 rounded-lg bg-[#0e1017] border border-white/[0.04] flex items-start gap-3 text-xs">
                <span className="font-mono text-zinc-500 tabular-nums shrink-0 pt-0.5">{fmtTime(e.ts)}</span>
                <span
                  className={`px-1.5 py-0.5 rounded border text-[10px] font-mono shrink-0 ${
                    ERROR_TONE[e.source] ?? 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'
                  }`}
                >
                  {e.source}
                </span>
                <span className="text-zinc-300 break-all">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
};
