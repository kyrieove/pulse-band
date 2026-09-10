/**
 * Main 进程至 Rust Core 原生快应用安装 RPC 桥接 (Core App Install Bridge)
 *
 * 职责：
 * - 封装 Main 到 Rust Core 的 app install RPC 调用
 * - 提供 prepare, sendChunk, commit, cancel 四个标准方法
 * - 映射至 device.app.install.* Core 协议
 * - 将 Core 返回的底层错误转换为脱敏的安全用户错误
 */

export interface CoreRpcClient {
  call<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface CoreInstallMetadata {
  packageId: string;
  versionName: string;
  versionCode: number;
  fileSize: number;
  hash: string;
}

export interface CoreInstallChunk {
  sessionId: string;
  index: number;
  size: number;
  data?: number[];
}

export interface CorePrepareResult {
  status: string;
  sessionId: string;
  fileSize: number;
  chunkSize: number;
  totalChunks: number;
}

export interface CoreChunkAck {
  status: string;
  sessionId: string;
  index: number;
  receivedBytes: number;
}

export interface CoreCommitResult {
  status: string;
}

export interface CoreCancelResult {
  status: string;
}

export interface SanitizedInstallError {
  code: string;
  userMessage: string;
}

/** 将 Core RPC 错误转换为脱敏的用户错误 */
export function desensitizeCoreError(err: any): SanitizedInstallError {
  const codeStr = String(err?.code || err?.message || 'UNKNOWN_ERROR');
  if (codeStr.includes('install_prepare_failed')) {
    return { code: 'CORE_PREPARE_FAILED', userMessage: '设备安装准备失败' };
  }
  if (codeStr.includes('install_chunk_failed')) {
    return { code: 'CORE_CHUNK_FAILED', userMessage: '设备分块写入失败' };
  }
  if (codeStr.includes('install_commit_failed')) {
    return { code: 'CORE_COMMIT_FAILED', userMessage: '设备校验安装失败' };
  }
  if (codeStr.includes('not_live') || codeStr.includes('未连接') || codeStr.includes('ECONNREFUSED')) {
    return { code: 'CORE_NOT_CONNECTED', userMessage: '核心守护进程未就绪' };
  }
  return { code: 'CORE_RPC_ERROR', userMessage: '设备通信错误' };
}

export class CoreAppInstallBridge {
  private client: CoreRpcClient;

  constructor(client: CoreRpcClient) {
    this.client = client;
  }

  async prepare(metadata: CoreInstallMetadata): Promise<CorePrepareResult> {
    try {
      return await this.client.call<CorePrepareResult>('device.app.install.prepare', metadata as any);
    } catch (err: any) {
      const sanitized = desensitizeCoreError(err);
      const wrapped = new Error(sanitized.userMessage);
      (wrapped as any).code = sanitized.code;
      (wrapped as any).userMessage = sanitized.userMessage;
      throw wrapped;
    }
  }

  async sendChunk(chunk: CoreInstallChunk): Promise<CoreChunkAck> {
    try {
      return await this.client.call<CoreChunkAck>('device.app.install.chunk', chunk as any);
    } catch (err: any) {
      const sanitized = desensitizeCoreError(err);
      const wrapped = new Error(sanitized.userMessage);
      (wrapped as any).code = sanitized.code;
      (wrapped as any).userMessage = sanitized.userMessage;
      throw wrapped;
    }
  }

  async commit(sessionId: string): Promise<CoreCommitResult> {
    try {
      return await this.client.call<CoreCommitResult>('device.app.install.commit', { sessionId });
    } catch (err: any) {
      const sanitized = desensitizeCoreError(err);
      const wrapped = new Error(sanitized.userMessage);
      (wrapped as any).code = sanitized.code;
      (wrapped as any).userMessage = sanitized.userMessage;
      throw wrapped;
    }
  }

  async cancel(sessionId: string): Promise<CoreCancelResult> {
    try {
      return await this.client.call<CoreCancelResult>('device.app.install.cancel', { sessionId });
    } catch (err: any) {
      const sanitized = desensitizeCoreError(err);
      const wrapped = new Error(sanitized.userMessage);
      (wrapped as any).code = sanitized.code;
      (wrapped as any).userMessage = sanitized.userMessage;
      throw wrapped;
    }
  }
}
