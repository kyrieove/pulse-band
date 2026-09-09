/**
 * 将配额采集器的已使用百分比 (used_percent) 转换为剩余百分比 (remaining_percent)
 * 公式：Math.max(0, Math.min(100, Math.round(100 - usedPct)))
 */
export function toRemainingPercent(usedPct: number | null | undefined): number | null {
  if (usedPct == null || Number.isNaN(usedPct)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - usedPct)));
}

/**
 * 根据服务端返回的告警等级或已使用百分比判定额度告警状态
 * 优先消费 level (danger -> critical, warn -> warning, normal -> idle)
 * 兜底使用已使用百分比阈值 (used >= 95 -> critical, used >= 80 -> warning)
 */
export function resolveQuotaStatus(
  level?: 'normal' | 'warn' | 'danger' | null,
  usedPct?: number | null
): 'idle' | 'warning' | 'critical' {
  if (level === 'danger') return 'critical';
  if (level === 'warn') return 'warning';
  if (level === 'normal') return 'idle';

  if (usedPct != null && !Number.isNaN(usedPct)) {
    if (usedPct >= 95) return 'critical';
    if (usedPct >= 80) return 'warning';
  }
  return 'idle';
}
