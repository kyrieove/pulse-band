import type { DiagnosticReport } from './diagnostics';
import type { PulseErrorEntry } from './error-log';

export function redactSupportText(value: string): string {
  return value
    .replace(/\b(authkey|token)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\b[0-9a-f]{32}\b/gi, '<redacted>')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, '<redacted-mac>')
    .replace(/([a-z]:\\users\\)[^\\\s]+/gi, '$1<redacted>');
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines = [`Pulse 诊断报告`, `检查时间: ${new Date(report.checkedAt).toISOString()}`];
  for (const check of report.checks) {
    lines.push('', `[${check.status.toUpperCase()}] ${check.label}`, check.summary);
    if (check.nextStep) lines.push(`下一步: ${check.nextStep}`);
  }
  return redactSupportText(lines.join('\n'));
}

export function formatErrorLog(entries: PulseErrorEntry[]): string {
  if (entries.length === 0) return 'Pulse 异常日志\n当前暂无异常日志。';
  const lines = ['Pulse 异常日志'];
  for (const entry of entries) {
    lines.push(`${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`);
  }
  return redactSupportText(lines.join('\n'));
}
