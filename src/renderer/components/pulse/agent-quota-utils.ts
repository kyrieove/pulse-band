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

export interface FormattedResetInfo {
  /** 倒计时中文可读文本，如 "51 分钟后重置", "4 小时 22 分钟后重置", "2 天 7 小时后重置", "重置时间未知" */
  countdownText: string;
  /** 明确的本地重置日期与时间，如 "重置于 今天 18:40"，无可靠钟点时为 null */
  absoluteTimeText: string | null;
}

/**
 * 将采集器回传的 resetText 格式化为层级清晰的中文可读倒计时与绝对时间。
 * 严格基于可信数据，无可靠绝对钟点时不随意猜测，缺失数据时标为未知。
 */
export function parseResetTimeInfo(rawText: string | null | undefined): FormattedResetInfo {
  if (!rawText || rawText.trim() === '' || rawText === '--') {
    return {
      countdownText: '重置时间未知',
      absoluteTimeText: null,
    };
  }

  const trimmed = rawText.trim();
  if (trimmed === 'ready') {
    return {
      countdownText: '等待额度刷新',
      absoluteTimeText: null,
    };
  }

  // 格式形如：`4h 22min · 18:40` 或 `51min · 18:40` 或 `2d 7h` 或 `51min`
  const parts = trimmed.split('·').map((s) => s.trim());
  const relativePart = parts[0];
  const timePart = parts[1];

  let countdownText = '重置时间未知';
  if (relativePart) {
    let cn = relativePart
      .replace(/(\d+)\s*d/g, '$1 天 ')
      .replace(/(\d+)\s*h/g, '$1 小时 ')
      .replace(/(\d+)\s*min/g, '$1 分钟')
      .replace(/\s+/g, ' ')
      .trim();
    if (cn) {
      countdownText = `${cn}后重置`;
    }
  }

  let absoluteTimeText: string | null = null;
  if (timePart && /^\d{1,2}:\d{2}$/.test(timePart)) {
    absoluteTimeText = `重置于 今天 ${timePart}`;
  }

  return {
    countdownText,
    absoluteTimeText,
  };
}
