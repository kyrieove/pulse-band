/**
 * settings.json 的 hooks 合并 / 摘除 —— 纯函数，无任何依赖，便于 scripts/test-hook-install.mjs 自检。
 * 这段逻辑会改用户自己的 ~/.claude/settings.json，写坏了会连带毁掉他们别的 hook，所以单独拆出来测。
 */

/** 装这 4 个事件：会话开始 / 工具前后 / 会话结束，与手环上的状态一一对应 */
export const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
/** PreToolUse / PostToolUse 按 Claude Code 的惯例要带 matcher */
const NEEDS_MATCHER = new Set<string>(['PreToolUse', 'PostToolUse']);

/** 我们写进去的条目靠命令里含 pulse-hook.cmd 认出来 */
export const isOurs = (entry: any): boolean =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('pulse-hook.cmd'));

/** 并进我们的条目：先摘掉旧的同类条目再追加，重复安装不会堆积 */
export function mergeHooks(
  hooks: Record<string, any[]>,
  command: (event: string) => string
): Record<string, any[]> {
  const next: Record<string, any[]> = { ...hooks };
  for (const event of HOOK_EVENTS) {
    const kept = (next[event] ?? []).filter((e) => !isOurs(e));
    const entry: any = { hooks: [{ type: 'command', command: command(event), timeout: 5 }] };
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*';
    next[event] = [...kept, entry];
  }
  return next;
}

/** 摘掉我们的条目；空掉的事件键一并删除，别人的 hook 一个不动 */
export function removeHooks(hooks: Record<string, any[]>): Record<string, any[]> {
  const next: Record<string, any[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries ?? []).filter((e) => !isOurs(e));
    if (kept.length) next[event] = kept;
  }
  return next;
}
