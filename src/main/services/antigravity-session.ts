import type { SessionManager } from './session-manager';
import { agRpc } from './quota-collector';

/**
 * Antigravity 会话状态轮询：调 language_server 的 GetAllCascadeTrajectories，
 * 返回 map<conversationId, { status: CASCADE_RUN_STATUS_*, lastModifiedTime,
 * annotations.title, ... }>。端口/token 复用 quota 侧的动态发现（agRpc），
 * Antigravity 重启换了端口也能自己跟上。
 *
 * RPC 只给会话级状态，拿不到当前工具名 —— GetCascadeTrajectory /
 * GetCascadeTrajectorySteps 换 trajectoryId / conversationId 三种入参都报
 * trajectory not found，所以 currentTool 恒 null，lastMessage 用会话标题顶着。
 */
const ACTIVE_MS = 5_000; // Antigravity 可达时的轮询间隔
const ABSENT_MS = 30_000; // 不可达（Antigravity 没开）时的退避
// cascade 步与步之间会出现秒级 IDLE，立刻报完成会让手环动词行抖动、每步震一次；
// IDLE 持续超过这个宽限期才认定真的跑完了。4s（< 轮询间隔）配合「到点即查」的
// 快速复查，完成感知压进 ~4s（用户要求 5s 内）；4s 以上的步间停顿会误报一次
// Done（下一轮 RUNNING 会接回来），换取实时性是用户点头的取舍
const IDLE_GRACE_MS = 4_000;

export class AntigravitySessionPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** poll 设置：下一轮不用常规间隔，提前到这个毫秒数（IDLE 宽限到点即查） */
  private nextDelayOverride = 0;
  /** 当前跟踪的会话：只认 lastModifiedTime 最新的一个，历史会话不进面板 */
  private currentId: string | null = null;
  private lastStatus: string | null = null;

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
      return false;
    }
    const entries: [string, any][] = Object.entries(data.trajectorySummaries ?? {});
    if (entries.length === 0) {
      this.finishActive('没有会话');
      this.currentId = null;
      this.lastStatus = null;
      return true;
    }

    entries.sort((a, b) => ts(b[1].lastModifiedTime) - ts(a[1].lastModifiedTime));
    const [convId, t] = entries[0];
    if (convId !== this.currentId) {
      this.finishActive('切换到新会话');
      this.currentId = convId;
      this.lastStatus = null;
    }

    const title = String(t.annotations?.title ?? t.summary ?? '').trim();
    const cwd = fileUriToLocal(t.workspaces?.[0]?.workspaceFolderAbsoluteUri);
    const status = String(t.status ?? '');
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
      if (quietMs > IDLE_GRACE_MS) {
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
      // 把下一轮轮询提前到「宽限到点 + 150ms」——完成感知压进 IDLE 出现后 ~4s，
      // 不用再干等一个完整轮询周期（用户要求 5s 内）
      this.nextDelayOverride = IDLE_GRACE_MS - quietMs + 150;
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
