import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager } from './session-manager';

interface CodexContext {
  sessionId?: string;
  cwd?: string;
}

export class CodexSessionTailer {
  private rootDir: string;
  private sessionManager: SessionManager;
  private filePositions: Map<string, number> = new Map();
  private contexts: Map<string, CodexContext> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(sessionManager: SessionManager, customDir?: string) {
    this.sessionManager = sessionManager;
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.rootDir = customDir || path.join(codexHome, 'sessions');
  }

  public start() {
    if (!fs.existsSync(this.rootDir)) {
      console.log(`[CodexTailer] Sessions directory does not exist: ${this.rootDir}`);
      return;
    }

    console.log(`[CodexTailer] Watching Codex sessions at: ${this.rootDir}`);
    this.scanInitialFiles();

    try {
      this.watcher = fs.watch(this.rootDir, { recursive: true }, (_, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const fullPath = path.join(this.rootDir, filename);
        this.readNewLines(fullPath);
      });
    } catch (err) {
      console.error('[CodexTailer] fs.watch recursive failed, falling back to polling:', err);
    }

    // Secondary poll every 500ms for active files to ensure near zero-latency updates
    this.pollInterval = setInterval(() => {
      this.checkActiveFiles();
    }, 500);
  }

  private scanInitialFiles() {
    try {
      const files: { path: string; mtime: number }[] = [];
      const findJsonl = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const res = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            findJsonl(res);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const stat = fs.statSync(res);
            files.push({ path: res, mtime: stat.mtimeMs });
          }
        }
      };

      findJsonl(this.rootDir);
      files.sort((a, b) => b.mtime - a.mtime);

      // Fast-forward all existing historical files so we NEVER replay past notifications!
      for (const item of files) {
        try {
          const stat = fs.statSync(item.path);
          this.filePositions.set(item.path, stat.size);
        } catch {}
      }

      // If there is an active session from the last 5 minutes, only read its recent lines for UI preview
      if (files.length > 0 && Date.now() - files[0].mtime < 5 * 60 * 1000) {
        this.readFullFile(files[0].path);
      }
    } catch (err) {
      console.error('[CodexTailer] Error scanning initial files:', err);
    }
  }

  private checkActiveFiles() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      // 1. Check existing tracked files
      for (const filePath of Array.from(this.filePositions.keys())) {
        if (fs.existsSync(filePath)) {
          this.readNewLines(filePath);
        }
      }

      // 2. Proactively discover newly created session files in ~/.codex/sessions/YYYY/MM/DD
      const now = new Date();
      const yyyy = now.getFullYear().toString();
      const mm = (now.getMonth() + 1).toString().padStart(2, '0');
      const dd = now.getDate().toString().padStart(2, '0');
      const todayDir = path.join(this.rootDir, yyyy, mm, dd);

      if (fs.existsSync(todayDir)) {
        const files = fs.readdirSync(todayDir);
        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const fullPath = path.join(todayDir, file);
            if (!this.filePositions.has(fullPath)) {
              // Brand new session created after CodeIsland started
              this.readFullFile(fullPath);
            }
          }
        }
      }
    } catch (err) {
      // Ignore transient errors
    } finally {
      this.isProcessing = false;
    }
  }

  private readFullFile(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const context: CodexContext = {};
      this.contexts.set(filePath, context);

      for (const line of lines) {
        if (!line.trim()) continue;
        this.parseLine(line, context);
      }

      this.filePositions.set(filePath, Buffer.byteLength(content, 'utf-8'));
    } catch (err) {
      console.error(`[CodexTailer] Error reading full file ${filePath}:`, err);
    }
  }

  private readNewLines(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      let pos = this.filePositions.get(filePath) ?? 0;
      if (stat.size < pos) pos = 0; // Truncated or rotated
      if (stat.size === pos) return;

      const fd = fs.openSync(filePath, 'r');
      const bytesToRead = stat.size - pos;
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, pos);
      fs.closeSync(fd);

      this.filePositions.set(filePath, stat.size);

      let context = this.contexts.get(filePath);
      if (!context) {
        context = {};
        this.contexts.set(filePath, context);
      }

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.parseLine(line, context);
      }
    } catch (err) {
      // Ignore transient file lock errors
    }
  }

  private parseLine(line: string, context: CodexContext) {
    try {
      const doc = JSON.parse(line);
      const recordType = doc.type;
      const payload = doc.payload;
      if (!payload) return;

      if (recordType === 'session_meta') {
        context.sessionId = payload.session_id || payload.id || context.sessionId;
        context.cwd = payload.cwd || context.cwd;
        if (context.sessionId) {
          this.sessionManager.updateSession(context.sessionId, 'codex', {
            cwd: context.cwd,
            title: context.cwd ? path.basename(context.cwd) : 'Codex Session',
            status: 'thinking',
          });
        }
        return;
      }

      const sessionId = context.sessionId || 'codex-active';

      if (recordType === 'event_msg') {
        const payloadType = payload.type;
        if (payloadType === 'task_started') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'thinking',
            startedAt: Date.now(),
            lastMessage: 'Task started',
          });
        } else if (payloadType === 'agent_message') {
          const msg = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message);
          this.sessionManager.updateSession(sessionId, 'codex', {
            lastMessage: msg.slice(0, 150),
          });
        } else if (payloadType === 'patch_apply_begin') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'running_tool',
            currentTool: {
              name: 'apply_patch',
              startedAt: Date.now(),
              paramsSummary: 'Modifying files...',
            },
          });
        } else if (payloadType === 'patch_apply_end') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'thinking',
            currentTool: null,
          });
        } else if (payloadType === 'mcp_tool_call_begin') {
          const toolName = payload.tool_name || payload.name || 'mcp_tool';
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'running_tool',
            currentTool: {
              name: toolName,
              startedAt: Date.now(),
              paramsSummary: payload.arguments ? JSON.stringify(payload.arguments).slice(0, 60) : undefined,
            },
          });
        } else if (payloadType === 'mcp_tool_call_end') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'thinking',
            currentTool: null,
          });
        } else if (payloadType === 'task_complete' || payloadType === 'turn_complete') {
          this.sessionManager.completeSession(sessionId, 'Completed successfully');
        } else if (payloadType === 'turn_aborted' || payloadType === 'error') {
          this.sessionManager.failSession(sessionId, payload.message || 'Task failed or aborted');
        }
      } else if (recordType === 'response_item') {
        const payloadType = payload.type;
        if (payloadType === 'reasoning') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'thinking',
          });
        } else if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
          const toolName = payload.name || 'tool';
          let paramsSummary: string | undefined;
          if (payload.arguments) {
            paramsSummary = typeof payload.arguments === 'string'
              ? payload.arguments.slice(0, 60)
              : JSON.stringify(payload.arguments).slice(0, 60);
          }
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'running_tool',
            currentTool: {
              name: toolName,
              paramsSummary,
              startedAt: Date.now(),
            },
          });
        } else if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
          this.sessionManager.updateSession(sessionId, 'codex', {
            status: 'thinking',
            currentTool: null,
          });
        } else if (payloadType === 'message' && payload.role === 'assistant') {
          if (Array.isArray(payload.content)) {
            const textPart = payload.content.find((c: any) => c.type === 'text' || c.type === 'output_text');
            if (textPart && textPart.text) {
              this.sessionManager.updateSession(sessionId, 'codex', {
                lastMessage: textPart.text.slice(0, 150),
              });
            }
          }
        }
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  public stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
