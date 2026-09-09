/**
 * 快应用安装主进程会话管理服务 (Main App Install Service)
 *
 * 职责：
 * - 维护内存 Install Session（单任务模式，暂存会话状态）
 * - 计算分块数、累加传输进度、派发进度广播
 * - 纯内存流转，无磁盘写入，不调用硬件/蓝牙/Core
 */

import type { BrowserWindow } from 'electron';
import type {
  InstallSessionStatus,
  InstallPrepareRequest,
  InstallPrepareResult,
  InstallChunkRequest,
  InstallChunkResult,
  InstallCommitRequest,
  InstallCancelRequest,
  InstallProgressEvent,
} from '../../common/types';

export interface InstallSession {
  installId: string;
  status: InstallSessionStatus;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedBytes: number;
  receivedChunks: Set<number>;
  createdAt: number;
}

export class AppInstallService {
  private session: InstallSession | null = null;
  private win: BrowserWindow | null = null;
  private listeners: Set<(event: InstallProgressEvent) => void> = new Set();

  attach(win: BrowserWindow | null): void {
    this.win = win;
  }

  onProgress(cb: (event: InstallProgressEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private broadcastProgress(event: InstallProgressEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[AppInstallService] Progress listener error:', err);
      }
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pulse:app-install-progress', event);
    }
  }

  getSession(): InstallSession | null {
    if (!this.session) return null;
    return {
      ...this.session,
      receivedChunks: new Set(this.session.receivedChunks),
    };
  }

  createSession(req: InstallPrepareRequest): InstallPrepareResult {
    if (
      this.session &&
      (this.session.status === 'preparing' ||
        this.session.status === 'transferring' ||
        this.session.status === 'verifying')
    ) {
      throw new Error('已有正在进行的安装会话');
    }
    if (!req.fileSize || req.fileSize <= 0) {
      throw new Error('无效的 fileSize');
    }

    const chunkSize = req.chunkSize && req.chunkSize > 0 ? req.chunkSize : 512;
    const totalChunks = Math.ceil(req.fileSize / chunkSize);
    const installId =
      'inst_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);

    this.session = {
      installId,
      status: 'preparing',
      fileSize: req.fileSize,
      chunkSize,
      totalChunks,
      receivedBytes: 0,
      receivedChunks: new Set<number>(),
      createdAt: Date.now(),
    };

    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId,
      status: 'preparing',
      fileSize: req.fileSize,
      transferredBytes: 0,
      percentage: 0,
    });

    return {
      installId,
      status: 'preparing',
      fileSize: req.fileSize,
      chunkSize,
      totalChunks,
    };
  }

  handleChunk(req: InstallChunkRequest): InstallChunkResult {
    if (!this.session || this.session.installId !== req.installId) {
      throw new Error('无效的 installId 或会话已过期');
    }
    if (this.session.status !== 'preparing' && this.session.status !== 'transferring') {
      throw new Error(`当前会话状态 (${this.session.status}) 不允许接收分块`);
    }
    if (req.chunkIndex < 0 || req.chunkIndex >= this.session.totalChunks) {
      throw new Error(`分块索引 ${req.chunkIndex} 越界 (总数: ${this.session.totalChunks})`);
    }

    if (!this.session.receivedChunks.has(req.chunkIndex)) {
      this.session.receivedChunks.add(req.chunkIndex);
      let bytesInChunk = this.session.chunkSize;
      if (req.chunkIndex === this.session.totalChunks - 1) {
        const rem = this.session.fileSize % this.session.chunkSize;
        bytesInChunk = rem === 0 ? this.session.chunkSize : rem;
      }
      this.session.receivedBytes = Math.min(
        this.session.fileSize,
        this.session.receivedBytes + bytesInChunk
      );
    }

    this.session.status = 'transferring';
    const percentage = Math.min(
      100,
      Math.round((this.session.receivedBytes / this.session.fileSize) * 100)
    );

    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId: this.session.installId,
      status: 'transferring',
      fileSize: this.session.fileSize,
      transferredBytes: this.session.receivedBytes,
      percentage,
    });

    return {
      installId: this.session.installId,
      status: 'transferring',
      chunkIndex: req.chunkIndex,
      receivedBytes: this.session.receivedBytes,
      totalChunks: this.session.totalChunks,
    };
  }

  commit(req: InstallCommitRequest): { ok: boolean; status: InstallSessionStatus; error?: string } {
    if (!this.session || this.session.installId !== req.installId) {
      throw new Error('无效的 installId 或会话已过期');
    }
    if (this.session.status !== 'transferring' && this.session.status !== 'preparing') {
      throw new Error(`当前会话状态 (${this.session.status}) 不允许 commit`);
    }

    // 阶段规范：只进入 verifying，禁止 completed
    this.session.status = 'verifying';
    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId: this.session.installId,
      status: 'verifying',
      fileSize: this.session.fileSize,
      transferredBytes: this.session.receivedBytes,
      percentage: 100,
    });

    return {
      ok: true,
      status: 'verifying',
    };
  }

  cancel(req: InstallCancelRequest): { ok: boolean; status: InstallSessionStatus } {
    if (!this.session || this.session.installId !== req.installId) {
      return { ok: false, status: 'cancelled' };
    }

    this.session.status = 'cancelled';
    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId: this.session.installId,
      status: 'cancelled',
      fileSize: this.session.fileSize,
      transferredBytes: this.session.receivedBytes,
      percentage: Math.round((this.session.receivedBytes / this.session.fileSize) * 100) || 0,
      error: req.reason ?? '用户取消安装',
    });

    this.cleanup();
    return { ok: true, status: 'cancelled' };
  }

  cleanup(): void {
    this.session = null;
  }
}

export function registerAppInstallIpc(
  service: AppInstallService,
  ipc: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void },
  winGetter?: () => BrowserWindow | null
): void {
  ipc.handle('pulse:app-install:prepare', (_e, req: InstallPrepareRequest) => {
    if (winGetter) service.attach(winGetter());
    return service.createSession(req);
  });

  ipc.handle('pulse:app-install:chunk', (_e, req: InstallChunkRequest) => {
    if (winGetter) service.attach(winGetter());
    return service.handleChunk(req);
  });

  ipc.handle('pulse:app-install:commit', (_e, req: InstallCommitRequest) => {
    if (winGetter) service.attach(winGetter());
    return service.commit(req);
  });

  ipc.handle('pulse:app-install:cancel', (_e, req: InstallCancelRequest) => {
    if (winGetter) service.attach(winGetter());
    return service.cancel(req);
  });
}
