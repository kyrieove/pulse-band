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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { calculateFileHash, calculateFileMd5, readChunk } from './app-install-reader.ts';
import type { CoreAppInstallBridge } from './core-app-install-bridge.ts';

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
  cancelRequested: boolean;
  createdAt: number;
  coreSessionId?: string;
  /**
   * pulse-core 上报的真实安装结论（例如 completed / failed / unknown）。
   *
   * 与 `status` 分开保存：`status` 是本地会话阶段，禁止凭本地动作进入 completed；
   * 只有 core 依据真实设备结果给出的结论才写进这里。
   */
  coreStatus?: string | null;
}

/** 内置手环端安装包信息（来自真实 rpk manifest，不写死版本号） */
export interface BundledAppInfo {
  exists: boolean;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  manifestValid?: boolean;
}

/** 一键安装内置手环端的结果 */
export interface BundledInstallResult {
  installId: string;
  status: InstallSessionStatus;
  /** core 依据真实设备结果给出的结论；completed 表示设备已确认安装且已安装列表命中 */
  coreStatus: string | null;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize: number;
  totalChunks: number;
  sentChunks: number;
}

/**
 * 解析随桌面端发布的内置手环端 .rpk 路径（无需用户选择文件）。
 *
 * 依次尝试几种布局，命中第一个真实存在的文件：
 * - 构建产物 / 打包：`dist-electron/main` 或 `app.asar` 内的 `../../assets`
 * - 源码直跑（脚本、测试）：`src/main/services` 的 `../../../assets`
 * - 仓库根直接运行
 *
 * 打包后资源位于 app.asar 内：Node 的 fs 能透明读取，但 zip 随机读在 asar 上
 * 行为不一致，因此统一复制到临时文件，保证读取确定性并在用完后可清理。
 */
function resolveBundledRpk(): { filePath: string; cleanup: () => void } | null {
  const candidates = [
    path.join(import.meta.dirname, '../../assets/band-app.rpk'),
    path.join(import.meta.dirname, '../../../assets/band-app.rpk'),
    path.join(process.cwd(), 'assets/band-app.rpk'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) return null;
  if (!found.includes('app.asar')) {
    return { filePath: found, cleanup: () => {} };
  }
  const tmp = path.join(os.tmpdir(), `pulse-bundled-band-app-${process.pid}.rpk`);
  fs.writeFileSync(tmp, fs.readFileSync(found));
  return { filePath: tmp, cleanup: () => fs.rmSync(tmp, { force: true }) };
}

export class AppInstallService {
  private session: InstallSession | null = null;
  private win: BrowserWindow | null = null;
  private listeners: Set<(event: InstallProgressEvent) => void> = new Set();
  private coreBridge: CoreAppInstallBridge | null = null;
  private bundledInfoCache: BundledAppInfo | null = null;

  constructor(coreBridge?: CoreAppInstallBridge | null) {
    this.coreBridge = coreBridge ?? null;
  }

  setCoreBridge(bridge: CoreAppInstallBridge | null): void {
    this.coreBridge = bridge;
  }

  getCoreBridge(): CoreAppInstallBridge | null {
    return this.coreBridge ?? null;
  }

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

  /**
   * 读取内置手环端安装包信息（版本号来自真实 manifest，不写死）。
   * 结果做进程内缓存，避免每次渲染都解压 asar。
   */
  getBundledInfo(): BundledAppInfo {
    if (this.bundledInfoCache) return this.bundledInfoCache;
    const resolved = resolveBundledRpk();
    if (!resolved) {
      this.bundledInfoCache = { exists: false };
      return this.bundledInfoCache;
    }
    try {
      const meta = inspectRpk(resolved.filePath);
      this.bundledInfoCache = {
        exists: true,
        packageId: meta.packageId,
        versionName: meta.versionName,
        versionCode: meta.versionCode,
        fileSize: meta.fileSize,
        manifestValid: meta.manifestValid,
      };
    } catch {
      this.bundledInfoCache = { exists: false };
    } finally {
      resolved.cleanup();
    }
    return this.bundledInfoCache;
  }

  /**
   * 一键安装内置手环端快应用：prepare -> 全部分块 -> commit。
   *
   * 用户不需要选择文件；内置包随桌面端发布。
   * 只有 pulse-core 依据真实设备结果返回 completed 时，coreStatus 才会是 completed。
   */
  async installBundled(): Promise<BundledInstallResult> {
    const resolved = resolveBundledRpk();
    if (!resolved) {
      throw new Error('内置手环端安装包缺失：assets/band-app.rpk 不在发布包里');
    }
    try {
      const prepared = await this.prepareFromFile(resolved.filePath);
      const sent = await this.sendFileChunks(prepared.installId);
      const session = this.getSession();
      return {
        installId: prepared.installId,
        status: (session?.status ?? sent.status) as InstallSessionStatus,
        coreStatus: session?.coreStatus ?? null,
        packageId: prepared.packageId,
        versionName: prepared.versionName,
        versionCode: prepared.versionCode,
        fileSize: prepared.fileSize,
        totalChunks: prepared.totalChunks,
        sentChunks: sent.sentChunks,
      };
    } finally {
      resolved.cleanup();
    }
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
      cancelRequested: false,
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
    const md5 = await calculateFileMd5(filePath);
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
      cancelRequested: false,
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

    if (this.coreBridge) {
      try {
        const coreRes = await this.coreBridge.prepare({
          packageId: meta.packageId || 'com.pulse.bandapp',
          versionName: meta.versionName || '1.0.0',
          versionCode: meta.versionCode || 1,
          fileSize: meta.fileSize,
          hash,
          md5,
        });
        if (coreRes?.sessionId) {
          this.session.coreSessionId = coreRes.sessionId;
        }
      } catch (err: any) {
        this.session.status = 'failed';
        this.broadcastProgress({
          messageType: 'event',
          event: 'device.app.install.progress',
          installId,
          status: 'failed',
          fileSize: meta.fileSize,
          transferredBytes: 0,
          percentage: 0,
          error: {
            code: err?.code || 'CORE_PREPARE_FAILED',
            userMessage: err?.userMessage || err?.message || '设备安装准备失败',
          },
        });
        throw err;
      }
    }

    return {
      installId,
      status: 'preparing',
      fileSize: meta.fileSize,
      chunkSize,
      totalChunks,
      packageId: meta.packageId,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
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

    const immediateResult = {
      ok: true,
      status: 'verifying' as InstallSessionStatus,
    };

    if (this.coreBridge) {
      const targetSessionId = this.session.coreSessionId || this.session.installId;
      const p = (async () => {
        try {
          const coreRes = await this.coreBridge!.commit(targetSessionId);
          if (this.session) {
            // 记录 core 的真实结论（含 completed），但不把它当作本地阶段使用
            this.session.coreStatus = coreRes?.status ?? null;
            if (coreRes?.status && coreRes.status !== 'completed' && coreRes.status !== 'installed') {
              this.session.status = coreRes.status as InstallSessionStatus;
            }
          }
          return {
            ok: true,
            status: (this.session?.status || 'verifying') as InstallSessionStatus,
          };
        } catch (err: any) {
          if (this.session) {
            this.session.status = 'failed';
          }
          const errCode = err?.code || 'CORE_COMMIT_FAILED';
          const userMsg = err?.userMessage || err?.message || '设备校验安装失败';
          const wrapped = new Error(userMsg);
          (wrapped as any).code = errCode;
          (wrapped as any).userMessage = userMsg;
          throw wrapped;
        }
      })();
      Object.assign(p, immediateResult);
      return p as any;
    }

    return immediateResult;
  }

  cancelFileTransfer(installId?: string): { ok: boolean; status: InstallSessionStatus } {
    if (!this.session || (installId && this.session.installId !== installId)) {
      return { ok: false, status: 'cancelled' };
    }

    const currentInstallId = this.session.installId;
    const coreSessionId = this.session.coreSessionId || currentInstallId;
    const currentFileSize = this.session.fileSize;

    this.session.status = 'cancelled';
    this.session.cancelRequested = true;

    this.broadcastProgress({
      messageType: 'event',
      event: 'device.app.install.progress',
      installId: currentInstallId,
      status: 'cancelled',
      fileSize: currentFileSize,
      transferredBytes: 0,
      percentage: 0,
      error: '传输已取消',
    });

    let cancelPromise: Promise<any> | null = null;
    if (this.coreBridge && coreSessionId) {
      cancelPromise = this.coreBridge.cancel(coreSessionId).catch((err) => {
        console.warn('[AppInstallService] Core cancel notify error:', err);
      });
    }

    this.cleanup();
    const immediateResult = { ok: true, status: 'cancelled' as InstallSessionStatus };
    if (cancelPromise) {
      const p = cancelPromise.then(() => immediateResult);
      Object.assign(p, immediateResult);
      return p as any;
    }
    return immediateResult;
  }

  cancel(req: InstallCancelRequest): { ok: boolean; status: InstallSessionStatus } {
    return this.cancelFileTransfer(req.installId);
  }

  async sendFileChunks(installId?: string): Promise<{
    sentChunks: number;
    totalBytes: number;
    status: InstallSessionStatus;
    /** pulse-core 依据真实设备结果给出的结论；completed 才代表设备已确认安装 */
    coreStatus: string | null;
  }> {
    if (!this.session) {
      throw new Error('未找到当前活动的安装会话');
    }
    if (installId && this.session.installId !== installId) {
      throw new Error(`installId 不匹配: 期望 ${this.session.installId}, 实际 ${installId}`);
    }
    if (this.session.status !== 'preparing' && this.session.status !== 'transferring') {
      throw new Error(`当前会话状态 (${this.session.status}) 不允许发送分块`);
    }
    if (!this.session.sourcePath) {
      throw new Error('当前会话未绑定 sourcePath 本地文件源');
    }

    const { sourcePath, totalChunks, chunkSize } = this.session;
    let sentChunks = 0;

    try {
      if (!fs.existsSync(sourcePath)) {
        throw new Error('FILE_NOT_FOUND');
      }
      const currentStat = fs.statSync(sourcePath);
      if (currentStat.size !== this.session.fileSize) {
        throw new Error('FILE_SIZE_CHANGED');
      }

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        if (!this.session || this.session.cancelRequested || (this.session.status as string) === 'cancelled') {
          throw new Error('cancelled');
        }

        let chunkBuf: Buffer;
        try {
          chunkBuf = readChunk(sourcePath, chunkIndex, chunkSize);
        } catch {
          throw new Error('READ_CHUNK_FAILED');
        }

        const chunkData = chunkBuf.toString('base64');
        this.handleChunk({
          installId: this.session.installId,
          chunkIndex,
          chunkData,
        });

        if (this.coreBridge) {
          try {
            await this.coreBridge.sendChunk({
              sessionId: this.session.coreSessionId || this.session.installId,
              index: chunkIndex,
              size: chunkBuf.length,
              data: Array.from(chunkBuf),
            });
          } catch (err: any) {
            const errCode = err?.code || 'CORE_CHUNK_FAILED';
            const userMsg = err?.userMessage || err?.message || '设备分块写入失败';
            const wrapped = new Error(userMsg);
            (wrapped as any).code = errCode;
            (wrapped as any).userMessage = userMsg;
            throw wrapped;
          }
        }

        sentChunks++;
      }

      try {
        await this.commit({
          installId: this.session.installId,
          expectedHash: this.session.expectedHash,
        });
      } catch (err: any) {
        if (err?.code || err?.userMessage) {
          throw err;
        }
        throw new Error('HASH_VERIFY_FAILED');
      }

      return {
        sentChunks,
        totalBytes: this.session.receivedBytes,
        status: this.session.status,
        coreStatus: this.session.coreStatus ?? null,
      };
    } catch (err: any) {
      if (err?.message === 'cancelled') {
        throw err;
      }

      const code =
        err?.code ||
        (err?.message === 'FILE_NOT_FOUND'
          ? 'FILE_NOT_FOUND'
          : err?.message === 'FILE_SIZE_CHANGED'
          ? 'FILE_SIZE_CHANGED'
          : err?.message === 'READ_CHUNK_FAILED'
          ? 'READ_CHUNK_FAILED'
          : err?.message === 'HASH_VERIFY_FAILED'
          ? 'HASH_VERIFY_FAILED'
          : 'TRANSFER_ERROR');

      const userMessage =
        err?.userMessage ||
        (code === 'FILE_NOT_FOUND'
          ? '安装包文件不存在或已被移除'
          : code === 'FILE_SIZE_CHANGED'
          ? '安装包文件大小发生变更，传输中止'
          : code === 'READ_CHUNK_FAILED'
          ? '读取安装包分块失败'
          : code === 'HASH_VERIFY_FAILED'
          ? '安装包完整性校验不通过'
          : '安装包处理失败');

      if (this.session) {
        this.session.status = 'failed';
        this.broadcastProgress({
          messageType: 'event',
          event: 'device.app.install.progress',
          installId: this.session.installId,
          status: 'failed',
          fileSize: this.session.fileSize,
          transferredBytes: this.session.receivedBytes,
          percentage: Math.min(
            100,
            Math.round((this.session.receivedBytes / this.session.fileSize) * 100)
          ),
          error: {
            code,
            userMessage,
          },
        });
      }

      throw new Error(userMessage);
    }
  }

  cleanup(): void {
    this.session = null;
    this.listeners.clear();
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

  ipc.handle('pulse:app-install:prepare-file', async (_e, req: { filePath: string }) => {
    if (winGetter) service.attach(winGetter());
    if (!req || typeof req.filePath !== 'string') {
      throw new Error('无效的请求参数: 必须包含 filePath');
    }
    const result = await service.prepareFromFile(req.filePath);
    return {
      installId: result.installId,
      status: result.status,
      fileSize: result.fileSize,
      chunkSize: result.chunkSize,
      totalChunks: result.totalChunks,
      packageId: result.packageId,
      versionName: result.versionName,
      versionCode: result.versionCode,
    };
  });

  ipc.handle('pulse:app-install:chunk', (_e, req: InstallChunkRequest) => {
    if (winGetter) service.attach(winGetter());
    return service.handleChunk(req);
  });

  ipc.handle('pulse:app-install:send-chunks', async (_e, req?: { installId?: string }) => {
    if (winGetter) service.attach(winGetter());
    return service.sendFileChunks(req?.installId);
  });

  ipc.handle('pulse:app-install:commit', async (_e, req: InstallCommitRequest) => {
    if (winGetter) service.attach(winGetter());
    return await service.commit(req);
  });

  ipc.handle('pulse:app-install:cancel', async (_e, req: InstallCancelRequest) => {
    if (winGetter) service.attach(winGetter());
    return await service.cancel(req);
  });

  ipc.handle('pulse:app-install:cancel-transfer', async (_e, req: { installId: string } | string) => {
    if (winGetter) service.attach(winGetter());
    const installId = typeof req === 'string' ? req : req?.installId;
    return await service.cancelFileTransfer(installId);
  });

  // 内置手环端快应用：一键安装，不需要用户选择文件
  ipc.handle('pulse:app-install:bundled-info', () => service.getBundledInfo());

  ipc.handle('pulse:app-install:install-bundled', async () => {
    if (winGetter) service.attach(winGetter());
    return await service.installBundled();
  });
}
