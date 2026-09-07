/**
 * Antigravity 会话完成判定的纯策略（单独成文件，方便 node --test 直接跑）。
 *
 * cascade 步与步之间会出现 IDLE，立刻报完成会让手环动词行抖动、每步震一次；
 * IDLE 持续超过宽限期才认定真的跑完了。
 *
 * 宽限期是自适应的：起步 4s（< 轮询间隔，配合「到点即查」把完成感知压进 ~4s），
 * 之后按本会话实测到的最长步间空档往上调。实测依据：Antigravity 挂计时器等待
 * 时那一轮 cascade 是真的结束了（语言服务器如实报 IDLE，后台任务几十秒后再把
 * 它拉起来），90 秒里出现过 14s / 19s / 27s 的空档，固定 4s 宽限会反复误报完成。
 * 自适应的代价是这种会话头一次长等待仍会误报一次，之后不再横跳。
 */
export const IDLE_GRACE_MIN_MS = 4_000;
export const IDLE_GRACE_MAX_MS = 40_000;
/** 观测到空档后留的余量，也是「这次空档算不算比现有宽限更长」的判据 */
export const IDLE_GRACE_MARGIN_MS = 2_000;

/** 根据实测到的一次步间空档，算出新的宽限期 */
export function nextIdleGrace(currentMs: number, observedGapMs: number): number {
  const wanted = observedGapMs + IDLE_GRACE_MARGIN_MS;
  if (wanted <= currentMs) return currentMs;
  return Math.min(IDLE_GRACE_MAX_MS, wanted);
}
