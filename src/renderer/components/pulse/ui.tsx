/**
 * Pulse 2.0 共享小部件（照原型 main.html / diagnostics.html 的视觉规格）
 */
import React from 'react';

export const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`rounded-xl bg-[var(--bg-surface)] border border-[var(--border-default)] ${className}`}>{children}</div>
);

/** 双编码状态徽章：颜色 + 圆点 + 文字（main.html 的 statusBadge） */
export function StatusBadge(props: { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string; pulse?: boolean }) {
  const tone = {
    success: 'bg-[var(--accent-wash)] border-[var(--accent-wash)] text-[var(--status-success)]',
    warning: 'bg-[var(--quota-warning-wash)] border-[var(--quota-warning-wash)] text-[var(--quota-warning)]',
    danger: 'bg-[var(--quota-critical-wash)] border-[var(--quota-critical-wash)] text-[var(--quota-critical)]',
    neutral: 'bg-[var(--bg-subtle)] border-[var(--border-default)] text-[var(--text-muted)]',
  }[props.tone];
  const dot = {
    success: 'bg-[var(--status-success)]',
    warning: 'bg-[var(--status-warning)] animate-ping',
    danger: 'bg-[var(--status-error)]',
    neutral: 'bg-[var(--text-muted)]',
  }[props.tone];
  return (
    <span className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border font-medium text-xs transition-all duration-300 ${tone}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span>{props.text}</span>
    </span>
  );
}

/** 开关（main.html 的 toggle-label/dot 结构） */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <label className={`relative inline-flex items-center ${props.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="sr-only peer"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className={`w-8 h-4 rounded-full transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent-primary)] peer-focus-visible:outline-offset-2 ${props.checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-strong)]'}`}>
        <div
          className={`w-4 h-4 bg-white rounded-full shadow transition-transform ${props.checked ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </div>
    </label>
  );
}

/** 时间戳 → HH:MM:SS */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 秒 → 「18分 12秒」 */
export function fmtUptime(seconds: number | null | undefined): string {
  if (seconds == null) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}时 ${m}分 ${s}秒`;
  if (m > 0) return `${m}分 ${s}秒`;
  return `${s}秒`;
}

/** 文件字节数 → 「184 KB」 */
export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * MAC 打码。用户会截图发 issue，界面上直接印着设备唯一标识不合适。
 * 保留首尾各两段，够定位是不是同一台设备，又不足以标识出来。
 */
export const maskMac = (mac: string): string =>
  /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/.test(mac) ? mac.replace(/^(.{5}):.{5}(:.{5})$/, '$1:••:••$2') : mac;
