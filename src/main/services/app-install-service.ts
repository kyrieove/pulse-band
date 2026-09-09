/**
 * 快应用安装主进程会话管理服务 (Main App Install Service)
 *
 * 职责：
 * - 维护内存 Install Session（单任务模式，暂存会话状态）
 * - 严格解码并校验 Base64 分块真实字节长度
 * - 计算分块数、累加真实传输字节、派发进度广播
 * - commit 阶段进行完整性前置断言（全分块接收 + 声明哈希一致性）
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
import { inspectRpk } from './rpk-inspector.ts';
import { calculateFileHash } from './app-install-reader.ts';

export { calculateFileHash } from './app-install-reader.ts';
export const MIN_CHUNK_SIZE = 256;
export const MAX_CHUNK_SIZE = 64 * 1024; // 64 KiB
export const DEFAULT_CHUNK_SIZE = 512;
export const MAX_RPK_SIZE = 5 * 1024 * 1024; // 5 MiB

const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Strict(data: string): Buffer {
  if (!data || typeof data !== 'string') {
    throw new Error('chunkData 必须为非空字符串');
  }
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) {
    throw new Error('非法 Base64 数据: 长度不合法');
  }
  if (!BASE64_REGEX.test(trimmed)) {
    throw new Error('非法 Base64 数据: 包含非法字符');
  }
  const buf = Buffer.from(trimmed, 'base64');
  if (buf.length === 0) {
    throw new Error('非法 Base64 数据: 解码后为空数据');
  }
  return buf;
}

export interface InstallSession {
  installId: string;
  status: InstallSessionStatus;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedBytes: number;
  receivedChunks: Set<number>;
  sourcePath: string;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  expectedHash: string;
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
    if (!req.fileSize || typeof req.fileSize !== 'number' || req.fileSize <= 0) {
      throw new Error('无效的 fileSize: 必须大于 0');
    }
    if (req.fileSize > MAX_RPK_SIZE) {
      throw new Error(`fileSize 超出最大限制 (${MAX_RPK_SIZE / (1024 * 1024)} MiB)`);
    }
    if (!req.hash || typeof req.hash !== 'string' || req.hash.trim() === '') {
      throw new Error('无效的 hash: 必须为非空字符串');
    }

    let chunkSize = DEFAULT_CHUNK_SIZE;
    if (req.chunkSize !== undefined && req.chunkSize !== null) {
      if (
        typeof req.chunkSize !== 'number' ||
        req.chunkSize < MIN_CHUNK_SIZE ||
        req.chunkSize > MAX_CHUNK_SIZE
      ) {
        throw new Error(
          `无效的 chunkSize: 必须在 [${MIN_CHUNK_SIZE}, ${MAX_CHUNK_SIZE}] 范围内`
        );
      }
      chunkSize = req.chunkSize;
    }

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
      sourcePath: '',
      packageId: req.packageId,
      versionName: req.versionName,
      versionCode: req.versionCode,
      expectedHash: req.hash.trim(),
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

  async prepareFromFile(
    filePath: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE
  ): Promise<InstallPrepareResult> {
    if (
      this.session &&
      (this.session.status === 'preparing' ||
        this.session.status === 'transferring' ||
        this.session.status === 'verifying')
    ) {
      throw new Error('已有正在进行的安装会话');
    }

    if (!filePath || typeof filePath !== 'string') {
      throw new Error('无效的文件路径');
    }

    if (
      typeof chunkSize !== 'number' ||
      chunkSize < MIN_CHUNK_SIZE ||
      chunkSize > MAX_CHUNK_SIZE
    ) {
      throw new Error(
        `无效的 chunkSize: 必须在 [${MIN_CHUNK_SIZE}, ${MAX_CHUNK_SIZE}] 范围内`
      );
    }

    const meta = inspectRpk(filePath);
    if (!meta.manifestValid) {
      throw new Error('RPK manifest 无效或不是合法 ZIP 容器');
    }

    const hash = await calculateFileHash(filePath);
    const totalChunks = Math.ceil(meta.fileSize / chunkSize);
    const installId =
      'inst_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);

    this.session = {
      installId,
      status: 'preparing',
      fileSize: meta.fileSize,
      chunkSize,
      totalChunks,
      receivedBytes: 0,
      receivedChunks: new Set<number>(),
      sourcePath: filePath,
      packageId: meta.packageId,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      expectedHash: hash,
      createdAt: Date.now(),
    };

    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId,
      status: 'preparing',
      fileSize: meta.fileSize,
      transferredBytes: 0,
      percentage: 0,
    });

    return {
      installId,
      status: 'preparing',
      fileSize: meta.fileSize,
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
    if (
      typeof req.chunkIndex !== 'number' ||
      req.chunkIndex < 0 ||
      req.chunkIndex >= this.session.totalChunks
    ) {
      throw new Error(`分块索引 ${req.chunkIndex} 越界 (总数: ${this.session.totalChunks})`);
    }

    // 1. 严格 Base64 解码与空数据校验
    const decodedBuffer = decodeBase64Strict(req.chunkData);
    const decodedLength = decodedBuffer.length;

    // 2. 校验真实分块大小
    const isLastChunk = req.chunkIndex === this.session.totalChunks - 1;
    const expectedLength = isLastChunk
      ? this.session.fileSize - req.chunkIndex * this.session.chunkSize
      : this.session.chunkSize;

    if (decodedLength !== expectedLength) {
      throw new Error(
        `分块长度不正确: 期望 ${expectedLength} 字节, 实际解码 ${decodedLength} 字节`
      );
    }

    // 3. 幂等处理 duplicate chunk：不得重复累加 receivedBytes
    if (!this.session.receivedChunks.has(req.chunkIndex)) {
      this.session.receivedChunks.add(req.chunkIndex);
      this.session.receivedBytes = Math.min(
        this.session.fileSize,
        this.session.receivedBytes + decodedLength
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

    // 检查 expectedHash 与 prepare 声明一致性（声明值对账）
    if (!req.expectedHash || req.expectedHash !== this.session.expectedHash) {
      throw new Error('expectedHash 与 prepare 声明不一致');
    }

    // 检查分块完整性：必须收到全部 chunk 且累计字节精确等于 fileSize
    if (
      this.session.receivedChunks.size !== this.session.totalChunks ||
      this.session.receivedBytes !== this.session.fileSize
    ) {
      throw new Error(
        `分块尚未传输完整: 接收到 ${this.session.receivedChunks.size}/${this.session.totalChunks} 块, 字节数 ${this.session.receivedBytes}/${this.session.fileSize}`
      );
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
