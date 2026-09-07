import { EventEmitter } from 'node:events';
import type { AgentSession, AgentKind, SessionState, ToolCallInfo } from '../../common/types';

export class SessionManager extends EventEmitter {
  private sessions: Map<string, AgentSession> = new Map();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startTick();
  }

  private startTick() {
    this.timer = setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const session of this.sessions.values()) {
        if (session.status === 'thinking' || session.status === 'running_tool') {
          session.durationSeconds = Math.floor((now - session.startedAt) / 1000);
          changed = true;
        }
      }
      if (changed) {
        this.emit('update', this.getAllSessions());
      }
    }, 1000);
  }

  public getSession(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  public getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public updateSession(
    id: string,
    agent: AgentKind,
    patch: Partial<AgentSession> & {
      status?: SessionState;
      currentTool?: ToolCallInfo | null;
      lastMessage?: string;
      cwd?: string;
    }
  ): AgentSession {
    const now = Date.now();
    let session = this.sessions.get(id);

    if (!session) {
      session = {
        id,
        agent,
        status: patch.status || 'thinking',
        startedAt: now,
        updatedAt: now,
        durationSeconds: 0,
        cwd: patch.cwd,
        lastMessage: patch.lastMessage,
        currentTool: patch.currentTool || null,
        ...patch,
      };
      this.sessions.set(id, session);
    } else {
      if (patch.status) session.status = patch.status;
      if (patch.startedAt !== undefined) session.startedAt = patch.startedAt;
      if (patch.cwd) session.cwd = patch.cwd;
      if (patch.lastMessage !== undefined) session.lastMessage = patch.lastMessage;
      if (patch.currentTool !== undefined) {
        session.currentTool = patch.currentTool;
      }
      if (patch.error !== undefined) session.error = patch.error;
      session.updatedAt = now;
      session.durationSeconds = Math.floor((now - session.startedAt) / 1000);
    }

    this.emit('update', this.getAllSessions());
    return session;
  }

  public completeSession(id: string, message?: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'completed';
    session.currentTool = null;
    if (message) session.lastMessage = message;
    session.updatedAt = Date.now();
    this.emit('update', this.getAllSessions());
  }

  public failSession(id: string, error: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'error';
    session.error = error;
    session.currentTool = null;
    session.updatedAt = Date.now();
    this.emit('update', this.getAllSessions());
  }

  public removeSession(id: string) {
    if (this.sessions.delete(id)) {
      this.emit('update', this.getAllSessions());
    }
  }

  public clearAll() {
    this.sessions.clear();
    this.emit('update', this.getAllSessions());
  }

  public dispose() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
  }
}
