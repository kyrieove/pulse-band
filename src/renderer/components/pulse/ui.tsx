/**
 * Pulse 2.0 共享小部件（照原型 main.html / diagnostics.html 的视觉规格）
 */
import React from 'react';

export const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`rounded-xl bg-island-surface border border-white/[0.08] ${className}`}>{children}</div>
);

/** 双编码状态徽章：颜色 + 圆点 + 文字（main.html 的 statusBadge） */
export function StatusBadge(props: { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string; pulse?: boolean }) {
  const tone = {
    success: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400',
    warning: 'bg-amber-500/15 border-amber-500/30 text-amber-400',
    danger: 'bg-rose-500/15 border-rose-500/30 text-rose-400',
    neutral: 'bg-zinc-800 border-zinc-700 text-zinc-400',
  }[props.tone];
  const dot = {
    success: 'bg-emerald-500 shadow-[0_0_8px_#10b981]',
    warning: 'bg-amber-500 animate-ping',
    danger: 'bg-rose-500',
    neutral: 'bg-zinc-500',
  }[props.tone];
  return (
    <span className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border font-medium text-xs transition-all duration-300 ${tone}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span>{props.text}</span>
    </span>
  );
}

/** 开关（main.html 的 toggle-label/dot 结构） */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`relative inline-flex items-center ${props.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="sr-only"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className={`w-8 h-4 rounded-full transition-colors ${props.checked ? 'bg-island-accent' : 'bg-zinc-700'}`}>
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
