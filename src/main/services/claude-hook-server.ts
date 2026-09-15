import http from 'node:http';
import path from 'node:path';
import type { SessionManager } from './session-manager';
import type { ClaudeHookPayload } from '../../common/types';

/** /events 单次请求体上限：hook 载荷只有几 KB，1MB 足够，超出直接 413 */
const MAX_BODY_BYTES = 1024 * 1024;

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
        // 不设 CORS 头：真正的调用方是 Node（scripts/claude-hook.cjs 的 http.request
        // 和主进程转发），都不是浏览器。放开通配头只会让用户浏览器里的任意页面
        // 能读 /health、能伪造 /events。

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
          // 只收 application/json：浏览器用 text/plain 发的简单请求不触发预检，
          // 是唯一能绕过上面「没有 CORS 头」的路径，这里把它挡在门外。
          const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
          if (!contentType.startsWith('application/json')) {
            res.writeHead(415, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unsupported Media Type' }));
            return;
          }

          let body = '';
          let received = 0;
          let aborted = false;
          req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            received += chunk.length;
            if (received > MAX_BODY_BYTES) {
              aborted = true;
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payload Too Large' }));
              req.destroy();
              return;
            }
            body += chunk;
          });
          req.on('error', (err) => {
            // 客户端半路断开是常态（hook 有 500ms 超时），记一笔即可，不要往外抛
            console.error('[ClaudeHookServer] request error:', err);
          });
          req.on('end', () => {
            if (aborted) return;
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
    const sessionId = payload.session_id || 'claude-session';
    const eventName = payload.hook_event_name || payload.event_type || 'Event';
    const cwd = payload.cwd;

    if (eventName === 'SessionStart') {
      this.sessionManager.updateSession(sessionId, 'claude', {
        status: 'thinking',
        startedAt: Date.now(),
        cwd,
        title: cwd ? path.basename(cwd) : 'Claude Session',
        lastMessage: 'Session started',
      });
    } else if (eventName === 'UserPromptSubmit') {
      // 唯一在 t=0 触发的事件。其余几个都在模型生成完之后，
      // 只有这个能让手环在按下回车的瞬间就亮绿灯，不用等 transcript 落盘。
      const prompt = (payload as { prompt?: string }).prompt;
      this.sessionManager.updateSession(sessionId, 'claude', {
        status: 'thinking',
        startedAt: Date.now(),
        cwd,
        title: cwd ? path.basename(cwd) : 'Claude Session',
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

      this.sessionManager.updateSession(sessionId, 'claude', {
        status: 'running_tool',
        cwd,
        currentTool: {
          name: toolName,
          paramsSummary: summary,
          startedAt: Date.now(),
        },
      });
    } else if (eventName === 'PostToolUse') {
      this.sessionManager.updateSession(sessionId, 'claude', {
        status: 'thinking',
        currentTool: null,
      });
    } else if (eventName === 'Stop') {
      this.sessionManager.completeSession(sessionId, 'Task finished');
    } else if (eventName === 'error' || payload.error) {
      this.sessionManager.failSession(sessionId, payload.error || payload.message || 'Error occurred');
    } else if (payload.message) {
      this.sessionManager.updateSession(sessionId, 'claude', {
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
