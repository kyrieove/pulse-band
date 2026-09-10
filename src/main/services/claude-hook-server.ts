import http from 'node:http';
import path from 'node:path';
import type { SessionManager } from './session-manager';
import type { ClaudeHookPayload } from '../../common/types';
import type { AgentKind } from '../../common/types';

const HOOK_AGENTS = new Set<AgentKind>(['claude', 'opencode', 'zcode']);

export function resolveAgentKind(payload: ClaudeHookPayload): AgentKind {
  const requested = payload.agent;
  return HOOK_AGENTS.has(requested) ? requested : 'claude';
}

export function resolveSessionId(payload: ClaudeHookPayload, agent: AgentKind): string {
  return payload.session_id || `${agent}-session`;
}

export class ClaudeHookServer {
  private server: http.Server | null = null;
  private port: number;
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager, port = 41789) {
    this.sessionManager = sessionManager;
    this.port = port;
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Set CORS headers for local tools
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'CodeIsland-Windows' }));
          return;
        }

        if (req.method === 'POST' && req.url === '/events') {
          let body = '';
          req.on('data', (chunk) => {
            body += chunk;
          });
          req.on('end', () => {
            try {
              const payload: ClaudeHookPayload = JSON.parse(body);
              this.handleClaudeEvent(payload);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'ok' }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.server.on('error', (err) => {
        console.error('[ClaudeHookServer] Server error:', err);
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`[ClaudeHookServer] Listening on http://127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  private handleClaudeEvent(payload: ClaudeHookPayload) {
    const agentKind = resolveAgentKind(payload);
    const sessionId = resolveSessionId(payload, agentKind);
    const eventName = payload.hook_event_name || payload.event_type || 'Event';
    const cwd = payload.cwd;
    const agentTitle =
      agentKind === 'opencode'
        ? 'OpenCode Session'
        : agentKind === 'zcode'
          ? 'ZCode Session'
          : 'Claude Session';

    // 只记录路由元数据，不记录 prompt/tool_input，便于定位“事件到了但卡片没跳变”。
    console.log(`[ClaudeHookServer] ${agentKind} ${eventName} session=${sessionId}`);

    if (eventName === 'SessionStart') {
      this.sessionManager.updateSession(sessionId, agentKind, {
        status: 'thinking',
        startedAt: Date.now(),
        cwd,
        title: cwd ? path.basename(cwd) : agentTitle,
        lastMessage: 'Session started',
      });
    } else if (eventName === 'UserPromptSubmit') {
      // 唯一在 t=0 触发的事件。其余几个都在模型生成完之后，
      // 只有这个能让手环在按下回车的瞬间就亮绿灯，不用等 transcript 落盘。
      const prompt = (payload as { prompt?: string }).prompt;
      this.sessionManager.updateSession(sessionId, agentKind, {
        status: 'thinking',
        startedAt: Date.now(),
        cwd,
        title: cwd ? path.basename(cwd) : agentTitle,
        lastMessage: prompt ? String(prompt).slice(0, 60) : 'Thinking...',
      });
    } else if (eventName === 'PreToolUse') {
      const toolName = payload.tool_name || 'tool';
      let summary: string | undefined;
      if (payload.tool_input) {
        if (typeof payload.tool_input === 'string') {
          summary = payload.tool_input.slice(0, 60);
        } else if (payload.tool_input.command) {
          summary = String(payload.tool_input.command).slice(0, 60);
        } else if (payload.tool_input.path || payload.tool_input.file_path) {
          summary = String(payload.tool_input.path || payload.tool_input.file_path).slice(0, 60);
        } else {
          summary = JSON.stringify(payload.tool_input).slice(0, 60);
        }
      }

      this.sessionManager.updateSession(sessionId, agentKind, {
        status: 'running_tool',
        cwd,
        currentTool: {
          name: toolName,
          paramsSummary: summary,
          startedAt: Date.now(),
        },
      });
    } else if (eventName === 'PostToolUse') {
      this.sessionManager.updateSession(sessionId, agentKind, {
        status: 'thinking',
        currentTool: null,
      });
    } else if (eventName === 'Stop') {
      this.sessionManager.completeSession(sessionId, 'Task finished');
    } else if (eventName === 'error' || payload.error) {
      this.sessionManager.failSession(sessionId, payload.error || payload.message || 'Error occurred');
    } else if (payload.message) {
      this.sessionManager.updateSession(sessionId, agentKind, {
        lastMessage: payload.message.slice(0, 150),
      });
    }
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
