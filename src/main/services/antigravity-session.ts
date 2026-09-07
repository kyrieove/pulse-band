import type { SessionManager } from './session-manager';
import { agRpc } from './quota-collector';
import { IDLE_GRACE_MIN_MS, nextIdleGrace } from './antigravity-policy';

/**
 * Antigravity 会话状态轮询：调 language_server 的 GetAllCascadeTrajectories，
 * 返回 map<conversationId, { status: CASCADE_RUN_STATUS_*, lastModifiedTime,
 * annotations.title, ... }>。端口/token 复用 quota 侧的动态发现（agRpc），
 * Antigravity 重启换了端口也能自己跟上。
 *
 * 这里只用会话级状态，所以 currentTool 恒 null，lastMessage 用会话标题顶着。
 * 步级数据其实拿得到：GetCascadeTrajectorySteps 的入参是 { cascadeId: <会话 id> }
 * （不是 trajectoryId，之前一直传错才报 trajectory not found），能拿到每步的
 * RUN_COMMAND / VIEW_FILE / PLANNER_RESPONSE 和状态。代价是响应没有分页，
 * 三百多步就有 1.2MB，不适合按轮询节奏拉，要用得挑时机。
 */
const ACTIVE_MS = 5_000; // Antigravity 可达时的轮询间隔
const ABSENT_MS = 30_000; // 不可达（Antigravity 没开）时的退避
// 完成判定的宽限期策略见 antigravity-policy.ts

export class AntigravitySessionPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** poll 设置：下一轮不用常规间隔，提前到这个毫秒数（IDLE 宽限到点即查） */
  private nextDelayOverride = 0;
  /** 当前跟踪的会话：只认 lastModifiedTime 最新的一个，历史会话不进面板 */
  private currentId: string | null = null;
  private lastStatus: string | null = null;
  /** 本会话当前的完成判定宽限期，见 nextIdleGrace */
  private graceMs = IDLE_GRACE_MIN_MS;
  /** 本段 IDLE 是什么时候开始的（0 = 不在计量中），用来量步间空档有多长 */
  private idleSince = 0;
  /** 上一轮看到的原始状态，用来判断这段 IDLE 前面是不是真的在跑 */
  private prevRaw: string | null = null;

  constructor(private sessionManager: SessionManager) {}

  public start() {
    this.schedule(ACTIVE_MS);
  }

  public stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      try {
        const alive = await this.poll();
        // poll 里可指定更近的复查点（IDLE 宽限到点即查），否则按常规节奏
        const delay = this.nextDelayOverride || (alive ? ACTIVE_MS : ABSENT_MS);
        this.nextDelayOverride = 0;
        this.schedule(delay);
      } catch (e) {
        console.error('[AgSessionPoller] poll threw:', e);
        this.schedule(ABSENT_MS);
      }
    }, ms);
  }

  /** 一轮轮询；返回 Antigravity 是否可达（决定下轮间隔） */
  private async poll(): Promise<boolean> {
    const data: any = await agRpc('GetAllCascadeTrajectories', {});
    if (!data) {
      console.log('[AgSessionPoller] unreachable, backing off');
      // Antigravity 没开：挂着的活动会话标记完成，别让它永远 Running
      this.finishActive('Antigravity 不可达');
      this.currentId = null;
      this.lastStatus = null;
      this.graceMs = IDLE_GRACE_MIN_MS;
      this.idleSince = 0;
      this.prevRaw = null;
      return false;
    }
    const entries: [string, any][] = Object.entries(data.trajectorySummaries ?? {});
    if (entries.length === 0) {
      this.finishActive('没有会话');
      this.currentId = null;
      this.lastStatus = null;
      this.graceMs = IDLE_GRACE_MIN_MS;
      this.idleSince = 0;
      this.prevRaw = null;
      return true;
    }

    entries.sort((a, b) => ts(b[1].lastModifiedTime) - ts(a[1].lastModifiedTime));
    const [convId, t] = entries[0];
    if (convId !== this.currentId) {
      this.finishActive('切换到新会话');
      this.currentId = convId;
      this.lastStatus = null;
      this.graceMs = IDLE_GRACE_MIN_MS;
      this.idleSince = 0;
      this.prevRaw = null;
    }

    const title = String(t.annotations?.title ?? t.summary ?? '').trim();
    const cwd = fileUriToLocal(t.workspaces?.[0]?.workspaceFolderAbsoluteUri);
    const status = String(t.status ?? '');

    // 量步间空档：从「跑着 → IDLE」开始打点，重新跑起来时结算，据此放宽宽限期。
    // 必须放在下面的「状态没变就返回」之前，否则长 IDLE 期间量不到。
    // 只认前面确实在跑的那种 IDLE：会话早就结束、静静躺着的空闲不是步间空档，
    // 拿它去放宽宽限会让之后每一次真完成都晚报几十秒。
    const wasRunning =
      this.prevRaw === 'CASCADE_RUN_STATUS_RUNNING' || this.prevRaw === 'CASCADE_RUN_STATUS_BUSY';
    this.prevRaw = status;
    if (status === 'CASCADE_RUN_STATUS_IDLE') {
      if (this.idleSince === 0 && wasRunning) this.idleSince = Date.now();
    } else if (this.idleSince !== 0) {
      const gap = Date.now() - this.idleSince;
      const widened = nextIdleGrace(this.graceMs, gap);
      if (widened !== this.graceMs) {
        console.log(
          `[AgSessionPoller] 步间空档 ${Math.round(gap / 1000)}s，完成宽限放宽到 ${Math.round(widened / 1000)}s`
        );
        this.graceMs = widened;
      }
      this.idleSince = 0;
    }

    if (status === this.lastStatus) return true;
    if (status === 'CASCADE_RUN_STATUS_RUNNING' || status === 'CASCADE_RUN_STATUS_BUSY') {
      // RUNNING 覆盖思考+工具执行，RPC 区分不了，统一按「在干活」报；
      // BUSY 偏「等待用户交互」，报 thinking
      this.sessionManager.updateSession(convId, 'antigravity', {
        status: status === 'CASCADE_RUN_STATUS_RUNNING' ? 'running_tool' : 'thinking',
        currentTool: null,
        ...(title ? { lastMessage: title } : {}),
        ...(cwd ? { cwd } : {}),
      });
      this.lastStatus = status;
      console.log(`[AgSessionPoller] ${convId.slice(0, 8)} -> ${status} (${title})`);
    } else if (status === 'CASCADE_RUN_STATUS_IDLE') {
      const quietMs = Date.now() - ts(t.lastModifiedTime);
      if (quietMs > this.graceMs) {
        // 会话可能从未以活动态创建过（Pulse 启动时它就闲着）——
        // completeSession 只改不改建，这里统一用 updateSession 落一个 completed
        this.sessionManager.updateSession(convId, 'antigravity', {
          status: 'completed',
          currentTool: null,
          ...(title ? { lastMessage: title } : {}),
          ...(cwd ? { cwd } : {}),
        });
        this.lastStatus = status;
        console.log(`[AgSessionPoller] ${convId.slice(0, 8)} -> completed (quiet ${Math.round(quietMs / 1000)}s)`);
      }
      // 宽限期内不落定也不记 lastStatus（期间又 RUNNING 也接得上）；
      // 把下一轮轮询提前到「宽限到点 + 150ms」，完成感知压进 IDLE 出现后一个宽限期。
      // 宽限被放宽后这个提前量会超过常规间隔，那就别用它——否则会漏掉重新跑起来。
      const untilVerdict = this.graceMs - quietMs + 150;
      this.nextDelayOverride = untilVerdict < ACTIVE_MS ? untilVerdict : 0;
    }
    // CANCELING / UNSPECIFIED：短暂态，等下一轮落定再报
    return true;
  }

  private finishActive(reason: string) {
    if (!this.currentId) return;
    const s = this.sessionManager.getSession(this.currentId);
    if (s && (s.status === 'thinking' || s.status === 'running_tool')) {
      this.sessionManager.completeSession(this.currentId, reason);
    }
  }
}

function ts(iso: unknown): number {
  const n = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? 0 : n;
}

function fileUriToLocal(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file:///')) return undefined;
  try {
    return decodeURIComponent(uri.slice('file:///'.length));
  } catch {
    return undefined;
  }
}
