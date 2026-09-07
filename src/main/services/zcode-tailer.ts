import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager } from './session-manager';

export class ZCodeSessionTailer {
  private logDir: string;
  private sessionManager: SessionManager;
  private currentFilePath: string | null = null;
  private filePositions: Map<string, number> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private inactivityCheckInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private lastEventTimes: Map<string, number> = new Map();

  constructor(sessionManager: SessionManager, customDir?: string) {
    this.sessionManager = sessionManager;
    const zcodeHome = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode');
    this.logDir = customDir || path.join(zcodeHome, 'cli', 'log');
  }

  public start() {
    if (!fs.existsSync(this.logDir)) {
      console.log(`[ZCodeTailer] Log directory does not exist: ${this.logDir}`);
    } else {
      console.log(`[ZCodeTailer] Watching ZCode logs at: ${this.logDir}`);
    }

    this.scanInitialFile();

    try {
      if (fs.existsSync(this.logDir)) {
        this.watcher = fs.watch(this.logDir, (_, filename) => {
          if (!filename || !filename.endsWith('.jsonl')) return;
          const fullPath = path.join(this.logDir, filename);
          if (fullPath === this.currentFilePath) {
            this.readNewLines(fullPath);
          }
        });
      }
    } catch (err) {
      console.error('[ZCodeTailer] fs.watch failed, falling back to polling:', err);
    }

    // Secondary poll every 500ms for active file to ensure zero-latency updates
    this.pollInterval = setInterval(() => {
      this.checkActiveFile();
    }, 500);

    // Inactivity check: if active session has no events for 3 minutes, transition to completed
    this.inactivityCheckInterval = setInterval(() => {
      this.checkInactivity();
    }, 5000);
  }

  private getTodayLogPath(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return path.join(this.logDir, `zcode-${yyyy}-${mm}-${dd}.jsonl`);
  }

  private scanInitialFile() {
    try {
      const todayPath = this.getTodayLogPath();
      this.currentFilePath = todayPath;

      if (fs.existsSync(todayPath)) {
        const stat = fs.statSync(todayPath);
        // Fast-forward existing file so we NEVER replay past notifications
        this.filePositions.set(todayPath, stat.size);
      } else {
        this.filePositions.set(todayPath, 0);
      }
    } catch (err) {
      console.error('[ZCodeTailer] Error scanning initial file:', err);
    }
  }

  private checkActiveFile() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      const todayPath = this.getTodayLogPath();

      // Midnight rollover handling: switch to new day's file
      if (this.currentFilePath && this.currentFilePath !== todayPath) {
        if (fs.existsSync(this.currentFilePath)) {
          this.readNewLines(this.currentFilePath);
        }
        this.currentFilePath = todayPath;
        if (!this.filePositions.has(todayPath)) {
          this.filePositions.set(todayPath, 0);
        }
      }

      if (this.currentFilePath && fs.existsSync(this.currentFilePath)) {
        this.readNewLines(this.currentFilePath);
      }
    } catch (err) {
      // Ignore transient errors
    } finally {
      this.isProcessing = false;
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

      const chunk = buffer.toString('utf-8');
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) {
        // No complete line yet, wait for next cycle
        return;
      }

      const completeChunk = chunk.slice(0, lastNewline);
      const bytesProcessed = Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf-8');
      this.filePositions.set(filePath, pos + bytesProcessed);

      const lines = completeChunk.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.parseLine(line);
      }
    } catch (err) {
      // Ignore transient file lock errors
    }
  }

  private parseLine(line: string) {
    try {
      const doc = JSON.parse(line);
      const msg = doc.message;
      if (typeof msg !== 'string') return;

      const sessionId = doc.sessionId || 'zcode-active';
      this.lastEventTimes.set(sessionId, Date.now());

      if (msg === 'Model request started') {
        this.sessionManager.updateSession(sessionId, 'zcode', {
          status: 'thinking',
          currentTool: null,
          lastMessage: 'Thinking...',
        });
      } else if (msg === 'Tool call started') {
        const toolName =
          (doc.context && typeof doc.context.toolName === 'string' && doc.context.toolName) ||
          (doc.context && typeof doc.context.name === 'string' && doc.context.name) ||
          '';
        this.sessionManager.updateSession(sessionId, 'zcode', {
          status: 'running_tool',
          currentTool: {
            name: toolName,
            startedAt: Date.now(),
          },
          lastMessage: toolName ? `Running ${toolName}` : 'Running tool',
        });
      } else if (msg === 'Tool call completed' || msg === 'Tool call failed') {
        this.sessionManager.updateSession(sessionId, 'zcode', {
          status: 'thinking',
          currentTool: null,
        });
      } else if (msg === 'Model request completed') {
        const finishReason = doc.context?.finishReason;
        const toolCallCount = doc.context?.toolCallCount;
        if (finishReason === 'stop' || toolCallCount === 0) {
          this.sessionManager.completeSession(sessionId, 'Model request completed');
          this.lastEventTimes.delete(sessionId);
        } else {
          this.sessionManager.updateSession(sessionId, 'zcode', {
            status: 'thinking',
            currentTool: null,
          });
        }
      } else if (msg === 'Turn completed') {
        this.sessionManager.completeSession(sessionId, 'Turn completed');
        this.lastEventTimes.delete(sessionId);
      } else if (msg === 'Turn failed') {
        this.sessionManager.failSession(sessionId, 'Turn failed');
        this.lastEventTimes.delete(sessionId);
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  private checkInactivity() {
    const now = Date.now();
    const sessions = this.sessionManager.getAllSessions();
    for (const s of sessions) {
      if (s.agent === 'zcode' && (s.status === 'thinking' || s.status === 'running_tool')) {
        const lastTime = this.lastEventTimes.get(s.id) || s.updatedAt || s.startedAt;
        if (now - lastTime > 3 * 60 * 1000) {
          this.sessionManager.completeSession(s.id, 'Completed (inactivity timeout)');
          this.lastEventTimes.delete(s.id);
        }
      }
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
    if (this.inactivityCheckInterval) {
      clearInterval(this.inactivityCheckInterval);
      this.inactivityCheckInterval = null;
    }
  }
}
