/**
 * 次屏「运行诊断」（照 pulse-ui-mockup/diagnostics.html 搬入 React）。
 *
 * 数据：
 * - 三家额度 + quotaMeta（最后成功拉取 / 429 退避到期）：status-server /api/status，经主进程转发，10s 轮询
 * - daemon 健康：oronbox-bridge 快照
 * - 错误日志：主进程 error-log 环形缓冲
 *
 * 阶段 5 重点：authoritative:false 必须视觉强区分（双层虚线边框 + 斜纹底 + 琥珀徽章 + ~EST + 数值带 *）。
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Server, TriangleAlert, Layers, Activity, LoaderCircle } from 'lucide-react';
import type { PulseOronboxState, PulseErrorEntry } from '../../../main/services/oronbox-bridge';
import type { DiagnosticReport, DiagnosticStatus } from '../../../main/services/diagnostics';
import { fmtUptime, fmtTime } from './ui';

interface QuotaView {
  pct5h: number | null;
  pct7d: number | null;
  resetText: string;
  authoritative: boolean;
  needsAuth?: boolean;
}

interface QuotaMeta {
  lastSuccessAt: Record<string, number>;
  nextTry: Record<string, number>;
}

const AGENTS: Array<{ key: string; label: string; color: string; glow: string }> = [
  { key: 'claude', label: 'Claude Code', color: '#D97757', glow: 'rgba(217, 119, 87, 0.4)' },
  { key: 'codex', label: 'Codex (CLI)', color: '#10A37F', glow: 'rgba(16, 163, 127, 0.4)' },
  { key: 'antigravity', label: 'Antigravity', color: '#4285F4', glow: 'rgba(66, 133, 244, 0.4)' },
];

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

const fmtCountdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
};

export const DiagnosticsScreen: React.FC<{
  daemon: PulseOronboxState['daemon'] | null;
  connection: PulseOronboxState['connection'];
  errors: PulseErrorEntry[];
  onClearErrors: () => void;
}> = ({ daemon, connection, errors, onClearErrors }) => {
  const [diag, setDiag] = useState<{ limits: Record<string, QuotaView | null>; quotaMeta?: QuotaMeta } | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [hook, setHook] = useState<{ installed: boolean; settingsPath: string; command: string | null } | null>(null);
  const [hookMsg, setHookMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [runningDiagnostics, setRunningDiagnostics] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    window.pulse?.getHookStatus().then(setHook).catch(() => setHook(null));
  }, []);

  const runHook = async (action: 'install' | 'uninstall') => {
    const res = action === 'install' ? await window.pulse?.installHook() : await window.pulse?.uninstallHook();
    if (!res) return;
    if (res.ok) {
      setHook({ installed: !!res.installed, settingsPath: res.settingsPath ?? '', command: res.command ?? null });
      setHookMsg({
        ok: true,
        text: action === 'install' ? '已写入 settings.json。重开一个 Claude Code 会话即可生效。' : '已从 settings.json 移除。',
      });
    } else {
      setHookMsg({ ok: false, text: res.error ?? '操作失败' });
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await window.pulse?.getDiagnostics();
      if (!alive) return;
      if (res?.ok && res.data) {
        setDiag({ limits: res.data.limits ?? {}, quotaMeta: res.data.quotaMeta });
        setDiagError(null);
      } else {
        setDiagError(res?.error ?? 'status-server 不可达');
      }
    };
    void load();
    const poll = setInterval(load, 10_000);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  const meta = diag?.quotaMeta;
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

  return (
    <main className="flex-1 bg-island-bg overflow-y-auto custom-scrollbar p-5 space-y-4">
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
          <button
            onClick={runFullDiagnostics}
            disabled={runningDiagnostics}
            className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-island-accent/15 border border-island-accent/35 text-island-accent hover:bg-island-accent/25 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-1.5 shrink-0"
          >
            {runningDiagnostics ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
            {runningDiagnostics ? '正在检查…' : report ? '重新诊断' : '开始完整诊断'}
          </button>
        </div>

        {reportError && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5">
            诊断没有完成：{reportError}。请重启 Pulse 后重试。
          </div>
        )}

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

      {/* 诊断 1：三家额度 */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-island-accent" />
            <h2 className="text-sm font-semibold text-zinc-200">AI 编程助手额度 (推送给手环显示的数据源)</h2>
          </div>
          <span className="text-[11px] text-zinc-500 font-mono tabular-nums">每 60 秒轮询更新 · 支持 5h/7d 窗口</span>
        </div>

        {diagError && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5" /> 额度数据不可用：{diagError}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          {AGENTS.map((agent) => {
            const q = diag?.limits?.[agent.key] ?? null;
            const authoritative = q?.authoritative === true;
            const pct5h = q?.pct5h;
            const pct7d = q?.pct7d;
            const lastOk = meta?.lastSuccessAt?.[agent.key] ?? 0;
            const nextTry = meta?.nextTry?.[agent.key] ?? 0;
            const inBackoff = nextTry > now;

            return (
              <div
                key={agent.key}
                className={
                  authoritative
                    ? 'p-3.5 rounded-xl bg-island-surface border border-white/[0.08] hover:border-white/[0.15] transition space-y-3'
                    : 'p-3.5 rounded-xl bg-[#15141b] border-2 border-dashed border-amber-500/40 stripe-pattern-warning hover:border-amber-500/60 transition space-y-3 relative overflow-hidden'
                }
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: agent.color, boxShadow: `0 0 8px ${agent.glow}` }} />
                    <span className="text-xs font-semibold text-zinc-100">{agent.label}</span>
                  </div>
                  {authoritative ? (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-medium flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      权威真值
                    </span>
                  ) : (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold flex items-center gap-1 shadow-sm">
                      <AlertTriangle className="w-2.5 h-2.5 text-amber-400" />
                      本地估算 (非权威)
                    </span>
                  )}
                </div>

                {/* 5h */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={`${authoritative ? 'text-zinc-400' : 'text-amber-200/80'} text-[11px] flex items-center gap-1`}>
                      5{authoritative ? '小时' : '小时估算'}窗口用量
                      {!authoritative && <span className="text-[9px] text-amber-400 font-mono">~EST</span>}
                    </span>
                    <span className={`font-mono font-bold tabular-nums ${authoritative ? 'text-zinc-200' : 'text-amber-300'}`}>
                      {pct5h == null ? '--' : `${pct5h}${authoritative ? '%' : '%*'}`}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct5h ?? 0}%`, backgroundColor: agent.color, opacity: authoritative ? 1 : 0.85 }}
                    />
                  </div>
                </div>

                {/* 7d */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={`${authoritative ? 'text-zinc-400' : 'text-amber-200/80'} text-[11px] flex items-center gap-1`}>
                      7{authoritative ? '天' : '天估算'}窗口用量
                      {!authoritative && <span className="text-[9px] text-amber-400 font-mono">~EST</span>}
                    </span>
                    <span className={`font-mono font-bold tabular-nums ${authoritative ? 'text-zinc-200' : 'text-amber-300'}`}>
                      {pct7d == null ? '--' : `${pct7d}${authoritative ? '%' : '%*'}`}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct7d ?? 0}%`, backgroundColor: agent.color, opacity: authoritative ? 1 : 0.85 }}
                    />
                  </div>
                </div>

                <div
                  className={`pt-2 border-t flex items-center justify-between text-[11px] ${
                    authoritative ? 'border-white/[0.06] text-zinc-400' : 'border-amber-500/20 text-amber-400/90'
                  }`}
                >
                  <span>
                    {authoritative ? '额度重置倒计时:' : '*本地兜底数据 · '}
                    {!authoritative && <span className="font-mono tabular-nums text-zinc-300">{q?.resetText ?? '--'}</span>}
                  </span>
                  {authoritative && <span className="font-mono tabular-nums text-zinc-200 font-medium">{q?.resetText ?? '--'}</span>}
                </div>

                {/* 阶段 5：最后成功拉取 + 429 退避倒计时 */}
                <div className="text-[10px] text-zinc-500 font-mono tabular-nums flex items-center justify-between">
                  <span>上次成功拉取: {lastOk ? fmtTime(lastOk) : '尚未成功'}</span>
                  {inBackoff && (
                    <span className="text-amber-400" title="429/失败退避中，到期前不会发起上游请求">
                      退避 {fmtCountdown(nextTry - now)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
          <button onClick={onClearErrors} className="text-[11px] text-zinc-500 hover:text-zinc-300 font-medium transition">
            清空日志
          </button>
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
      <section className="space-y-2.5">
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-island-accent" />
          <h2 className="text-sm font-semibold text-zinc-200">Claude Code 接入</h2>
        </div>
        <div className="p-3 rounded-lg bg-[#0e1017] border border-white/[0.04] space-y-2.5">
          <p className="text-xs text-zinc-400 leading-relaxed">
            装上后 Claude Code 的会话与工具调用会实时推给 Pulse，再由 Pulse 转发到手环。
            转发脚本用 Pulse 自带的运行时执行，<span className="text-zinc-200">不需要另外安装 Node.js</span>。
          </p>
          <div className="flex items-center gap-2">
            <span
              className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${
                hook?.installed
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                  : 'bg-zinc-500/15 border-zinc-500/30 text-zinc-400'
              }`}
            >
              {hook?.installed ? '已安装' : '未安装'}
            </span>
            <button
              onClick={() => runHook('install')}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-island-accent/15 border border-island-accent/30 text-island-accent hover:bg-island-accent/25 transition"
            >
              {hook?.installed ? '重新安装' : '安装 Hook'}
            </button>
            {hook?.installed && (
              <button
                onClick={() => runHook('uninstall')}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-500/10 border border-zinc-500/30 text-zinc-400 hover:bg-zinc-500/20 transition"
              >
                卸载
              </button>
            )}
          </div>
          {hook?.command && <div className="text-[10px] font-mono text-zinc-500 break-all">{hook.command}</div>}
          {hookMsg && (
            <div className={`text-xs ${hookMsg.ok ? 'text-emerald-400' : 'text-rose-300'}`}>{hookMsg.text}</div>
          )}
        </div>
      </section>
    </main>
  );
};
