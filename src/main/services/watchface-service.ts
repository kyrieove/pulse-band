/**
 * 表盘管理主进程服务 (Watchface Service)
 *
 * 职责：
 * - 封装 Main 到 Rust Core 的 device.watchface.* RPC（list / set / install）
 * - install 在本层用 Node 内置 crypto 计算完整文件 MD5（32 位小写 hex，即 core 侧 data_id），
 *   渲染层只传本地路径，不接触哈希
 * - install 是阻塞式调用且无进度事件（真机验证脚本用 300 秒超时），本层不做任何进度推送，
 *   调用方只能呈现长时 busy 态
 * - 统一错误形状为 { ok, code, message }，渲染层无需解析 core 原始错误结构
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { CoreRpcClient } from './core-app-install-bridge.ts';

/** install 阻塞式传输+安装的全量超时（与真机验证脚本一致） */
export const WATCHFACE_INSTALL_TIMEOUT_MS = 300_000;
const WATCHFACE_LIST_TIMEOUT_MS = 30_000;
const WATCHFACE_SET_TIMEOUT_MS = 60_000;

/** device.watchface.list 返回的单个表盘条目（字段形状来自 core/src/rpc.rs） */
export interface WatchfaceItem {
  id: string;
  name: string;
  is_current: boolean;
  can_remove: boolean;
  version_code: number;
  can_edit: boolean;
  background_color: string;
  background_image: string;
  style: string;
}

export interface WatchfaceListData {
  watchfaces: WatchfaceItem[];
}

export interface WatchfaceSetData {
  watchface: WatchfaceItem;
}

/** result_code === 2 为新装成功（INSTALL_SUCCESS），其余为设备上已存在（INSTALL_USED，成功路径） */
export interface WatchfaceInstallData {
  watchface_id: string;
  result_code: number;
  result_code_meaning: 'INSTALL_SUCCESS' | 'INSTALL_USED';
}

export type WatchfaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

/** 流式计算完整文件 MD5（32 位小写 hex），避免整文件读入内存 */
function computeFileMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export interface WatchfacePreviewPreparer {
  prepareFromBin(id: string, filePath: string, sourceHash?: string): Promise<unknown>;
}

export class WatchfaceService {
  private client: CoreRpcClient;
  private previewPreparer?: WatchfacePreviewPreparer;

  constructor(client: CoreRpcClient, previewPreparer?: WatchfacePreviewPreparer) {
    this.client = client;
    this.previewPreparer = previewPreparer;
  }

  private toError(err: unknown, fallbackCode: string, fallbackMessage: string): WatchfaceResult<never> {
    const code = (err as any)?.code;
    const message = (err as any)?.message ?? String(err ?? '');
    // 连接/超时类错误不带 core 错误码，给统一的安全文案，不透传底层细节
    if (typeof code !== 'string' || code.length === 0) {
      if (message.includes('超时')) {
        return { ok: false, code: 'rpc_timeout', message: `${fallbackMessage}：请求超时，请重试` };
      }
      if (message.includes('未连接') || message.includes('ECONNREFUSED') || message.includes('连接')) {
        return { ok: false, code: 'not_connected', message: '核心服务未就绪或手环未连接' };
      }
      return { ok: false, code: fallbackCode, message: fallbackMessage };
    }
    // core 错误码本身可展示（invalid_params / watchface_*_failed），message 是设备侧原因
    return { ok: false, code, message: message || fallbackMessage };
  }

  async list(): Promise<WatchfaceResult<WatchfaceListData>> {
    try {
      const data = await this.client.call<WatchfaceListData>(
        'device.watchface.list',
        {},
        WATCHFACE_LIST_TIMEOUT_MS,
      );
      return { ok: true, data };
    } catch (err) {
      return this.toError(err, 'watchface_list_failed', '读取表盘列表失败');
    }
  }

  async set(id: string): Promise<WatchfaceResult<WatchfaceSetData>> {
    // 空字符串会被 core 拒为 invalid_params，在本层提前挡住
    if (!id || typeof id !== 'string') {
      return { ok: false, code: 'invalid_params', message: '缺少表盘 id' };
    }
    try {
      const data = await this.client.call<WatchfaceSetData>(
        'device.watchface.set',
        { id },
        WATCHFACE_SET_TIMEOUT_MS,
      );
      return { ok: true, data };
    } catch (err) {
      return this.toError(err, 'watchface_set_failed', '切换表盘失败');
    }
  }

  async install(filePath: string): Promise<WatchfaceResult<WatchfaceInstallData>> {
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, code: 'invalid_params', message: '缺少表盘文件路径' };
    }
    let md5: string;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { ok: false, code: 'invalid_params', message: '表盘文件路径无效' };
      }
      if (info.size === 0) {
        return { ok: false, code: 'invalid_params', message: '表盘文件为空' };
      }
      md5 = await computeFileMd5(filePath);
    } catch (err: any) {
      return {
        ok: false,
        code: 'file_read_failed',
        message: `读取表盘文件失败：${err?.code === 'ENOENT' ? '文件不存在' : '无法访问该文件'}`,
      };
    }
    try {
      const data = await this.client.call<WatchfaceInstallData>(
        'device.watchface.install',
        { path: filePath, md5 },
        WATCHFACE_INSTALL_TIMEOUT_MS,
      );
      if (this.previewPreparer) {
        try {
          await this.previewPreparer.prepareFromBin(data.watchface_id, filePath, md5);
        } catch (error) {
          console.warn('[WatchfacePreview] 自动生成失败:', error instanceof Error ? error.message : String(error));
        }
      }
      return { ok: true, data };
    } catch (err) {
      return this.toError(err, 'watchface_install_failed', '表盘安装失败');
    }
  }
}

export function registerWatchfaceIpc(
  service: WatchfaceService,
  ipc: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void },
): void {
  ipc.handle('pulse:watchface:list', () => service.list());

  ipc.handle('pulse:watchface:set', (_e, req: { id?: unknown }) => {
    const id = typeof req?.id === 'string' ? req.id : '';
    return service.set(id);
  });

  ipc.handle('pulse:watchface:install', (_e, req: { filePath?: unknown }) => {
    const filePath = typeof req?.filePath === 'string' ? req.filePath : '';
    return service.install(filePath);
  });
}
