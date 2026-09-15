import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionManager } from './session-manager';

export class ClaudeDesktopTailer {
  private sessionManager: SessionManager;
  private projectsDir: string;
  private activeJsonlPath: string | null = null;
  private filePosition: number = 0;
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  private currentCwd: string | undefined;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
    this.projectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  public start() {
    console.log(`[ClaudeDesktopTailer] Watching Claude projects at: ${this.projectsDir}`);
    
    // Find initial newest active project file
    this.findAndTailNewestProject();

    // Poll every 500ms to detect newly written lines or new project sessions
    this.pollInterval = setInterval(() => {
      this.tick();
    }, 500);
  }

  public stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private tick() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      this.findAndTailNewestProject();
      if (this.activeJsonlPath && fs.existsSync(this.activeJsonlPath)) {
        this.readNewLines(this.activeJsonlPath);
      }
    } catch (err) {
      console.error('[ClaudeDesktopTailer] Error in tick:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  private findAndTailNewestProject() {
    if (!fs.existsSync(this.projectsDir)) return;

    try {
      let newestFile: { path: string; mtime: number } | null = null;
      const projectDirs = fs.readdirSync(this.projectsDir, { withFileTypes: true });

      for (const pDir of projectDirs) {
        if (!pDir.isDirectory()) continue;
        const fullPDir = path.join(this.projectsDir, pDir.name);
        const files = fs.readdirSync(fullPDir);

        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const filePath = path.join(fullPDir, file);
            const stat = fs.statSync(filePath);
            if (!newestFile || stat.mtimeMs > newestFile.mtime) {
              newestFile = { path: filePath, mtime: stat.mtimeMs };
            }
          }
        }
      }

      if (newestFile) {
        if (this.activeJsonlPath !== newestFile.path) {
          console.log(`[ClaudeDesktopTailer] Switching to active Claude project: ${newestFile.path}`);
          this.activeJsonlPath = newestFile.path;
          const stat = fs.statSync(newestFile.path);
          // Start near end or full file if recent
          this.filePosition = Math.max(0, stat.size - 65536);
          this.readNewLines(newestFile.path);
        }
      }
    } catch (err) {
      console.error('[ClaudeDesktopTailer] Error finding newest project:', err);
    }
  }

  private readNewLines(filePath: string) {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);

      if (stat.size < this.filePosition) {
        this.filePosition = 0;
      }
      if (stat.size === this.filePosition) return;

      const bytesToRead = stat.size - this.filePosition;
      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, bytesToRead, this.filePosition);
      } finally {
        fs.closeSync(fd);
      }

      // 只处理到最后一个换行为止。
      // 每 500ms 读一次，对方很可能正写到一半：把 filePosition 推到 stat.size 再按换行切分，
      // 尾部那半行 JSON.parse 必然失败且下一轮不会再读，会话开始/结束事件就这样漏掉；
      // 多字节 UTF-8 被切在读取边界上还会变成乱码。没找到换行就这一轮什么都不做。
      const lastNewline = buffer.lastIndexOf(0x0a);
      if (lastNewline < 0) return;

      this.filePosition += lastNewline + 1;

      const chunk = buffer.subarray(0, lastNewline).toString('utf-8');
      const lines = chunk.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;
        this.parseJsonLine(line);
      }
    } catch (err) {
      console.error('[ClaudeDesktopTailer] Error reading jsonl:', err);
    }
  }

  private parseJsonLine(line: string) {
    try {
      const data = JSON.parse(line);
      const sid = 'claude-desktop'; // Unified single active session ID to prevent tab clutter!

      if (data.cwd) {
        this.currentCwd = data.cwd;
      }

      const projectTitle = this.currentCwd ? path.basename(this.currentCwd) : 'Claude Desktop';

      // 1. Assistant messages (Tools & text)
      if (data.type === 'assistant' && data.message?.content) {
        const content = data.message.content;
        // content 也可能是纯字符串；直接 for...of 会逐字符迭代出 undefined.type
        const blocks: any[] = Array.isArray(content) ? content : [];
        let toolFound = false;

        for (const item of blocks) {
          if (item.type === 'tool_use') {
            toolFound = true;
            const toolName = item.name || 'Tool';
            const desc = item.input?.description;
            const cmd = item.input?.command ||
              item.input?.file_path ||
              (Array.isArray(item.input?.files) ? item.input.files.join(', ') : undefined) ||
              item.input?.pattern ||
              (item.input ? JSON.stringify(item.input) : undefined);

            const displaySummary = desc
              ? `[进程任务] ${desc}\n> ${cmd || ''}`
              : `> ${cmd || '执行中...'}`;

            this.sessionManager.updateSession(sid, 'claude', {
              title: projectTitle,
              status: 'running_tool',
              cwd: this.currentCwd,
              lastMessage: desc ? desc : `> 运行 ${toolName}`,
              currentTool: {
                name: toolName,
                paramsSummary: displaySummary,
                startedAt: Date.now(),
              },
            });
          }
        }

        if (!toolFound && data.message.stop_reason === 'end_turn') {
          this.sessionManager.completeSession(sid, '交互轮次已顺利完成');
        }
      }

      // 2. User messages (tool results or new prompt)
      if (data.type === 'user' && data.message?.content) {
        const content = data.message.content;
        // 同上：content 可能是字符串，字符串没有 .some
        const isToolResult =
          Array.isArray(content) && content.some((c: any) => c.type === 'tool_result');

        if (isToolResult) {
          this.sessionManager.updateSession(sid, 'claude', {
            title: projectTitle,
            status: 'thinking',
            currentTool: null,
            cwd: this.currentCwd,
            lastMessage: '分析工具执行输出中...',
          });
        } else {
          this.sessionManager.updateSession(sid, 'claude', {
            title: projectTitle,
            status: 'thinking',
            currentTool: null,
            cwd: this.currentCwd,
            lastMessage: '思考分析与推演中...',
          });
        }
      }
    } catch {
      // Ignore unparseable lines
    }
  }
}
