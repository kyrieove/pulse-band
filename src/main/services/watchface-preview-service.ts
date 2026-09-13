/**
 * 表盘预览图主进程服务（层 2：用户自己补图）
 *
 * 职责：把用户选定的本地图片用 Electron nativeImage 归一化成固定宽度的 PNG，
 * 交给 WatchfacePreviewStore 落到 `<userData>/watchface-previews/`，再把结果以
 * data URL 回给渲染层。不联网、不碰 core、不碰设备协议。
 *
 * 与层 3 的关系：将来若从 .bin 提取出缩略图，写的是同一套 store，source='auto'；
 * 读取侧 manual 优先，因此自动图永远不会覆盖用户自己指定的图。
 *
 * 解码能力边界：nativeImage.createFromBuffer 只可靠解码 PNG / JPEG，
 * 所以 UI 侧也只接受这两种后缀，不做"看起来支持其实解不开"的承诺。
 */

import { nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeWatchfacePreview,
  shouldPrepareAutoPreview,
} from './watchface-preview-decoder';
import {
  WatchfacePreviewStore,
  isValidWatchfacePreviewId,
  type WatchfacePreviewSource,
} from './watchface-preview-store';

export { shouldPrepareAutoPreview } from './watchface-preview-decoder';

/** 归一化目标宽度 = 手环屏宽度；卡片最宽约 100 DIP，192 已够 2x */
export const WATCHFACE_PREVIEW_TARGET_WIDTH = 192;
/** 源图上限：超过这个体积基本是选错了文件 */
export const WATCHFACE_PREVIEW_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export interface WatchfacePreviewView {
  id: string;
  dataUrl: string;
  source: WatchfacePreviewSource;
  addedAt: string;
  width: number;
  height: number;
}

export type WatchfacePreviewResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

export class WatchfacePreviewService {
  /** data URL 缓存，按文件 mtime 失效；避免每次进表盘页都重新 base64 编码 */
  private dataUrlCache = new Map<string, { mtimeMs: number; dataUrl: string }>();

  private readonly store: WatchfacePreviewStore;
  private preparationPromise: Promise<void> | null = null;

  // 不用 TS 参数属性：与 store 保持一致的写法，方便将来单独测这个类
  constructor(store: WatchfacePreviewStore) {
    this.store = store;
  }

  private async toView(id: string): Promise<WatchfacePreviewView | null> {
    const entry = this.store.getEntry(id);
    const filePath = this.store.resolve(id);
    if (!entry || !filePath) {
      this.dataUrlCache.delete(id);
      return null;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      this.dataUrlCache.delete(id);
      return null;
    }
    const cached = this.dataUrlCache.get(id);
    let dataUrl: string;
    if (cached && cached.mtimeMs === mtimeMs) {
      dataUrl = cached.dataUrl;
    } else {
      const bytes = await readFile(filePath);
      dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
      this.dataUrlCache.set(id, { mtimeMs, dataUrl });
    }
    return {
      id,
      dataUrl,
      source: entry.source,
      addedAt: entry.addedAt,
      width: entry.width,
      height: entry.height,
    };
  }

  /** 全部本地预览图（只含文件仍存在的条目） */
  async list(): Promise<WatchfacePreviewResult<{ previews: Record<string, WatchfacePreviewView> }>> {
    if (this.preparationPromise) {
      try {
        await this.preparationPromise;
      } catch (err) {
        console.warn(
          '[WatchfacePreview] 启动准备未正常完成:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const previews: Record<string, WatchfacePreviewView> = {};
    for (const id of Object.keys(this.store.list())) {
      const view = await this.toView(id);
      if (view) previews[id] = view;
    }
    return { ok: true, data: { previews } };
  }

  /** 关联 / 替换某个表盘的本地预览图 */
  async setFromFile(
    id: string,
    filePath: string,
  ): Promise<WatchfacePreviewResult<{ preview: WatchfacePreviewView }>> {
    if (!isValidWatchfacePreviewId(id)) {
      return { ok: false, code: 'invalid_params', message: '缺少表盘 id' };
    }
    if (!filePath || typeof filePath !== 'string') {
      return { ok: false, code: 'invalid_params', message: '缺少图片路径' };
    }

    let size: number;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return { ok: false, code: 'file_read_failed', message: '所选路径不是文件' };
      }
      size = info.size;
    } catch (err) {
      const code = (err as any)?.code;
      return {
        ok: false,
        code: 'file_read_failed',
        message: code === 'ENOENT' ? '图片文件不存在' : '无法访问该图片文件',
      };
    }
    if (size === 0) {
      return { ok: false, code: 'invalid_params', message: '图片文件为空' };
    }
    if (size > WATCHFACE_PREVIEW_MAX_SOURCE_BYTES) {
      return {
        ok: false,
        code: 'file_too_large',
        message: `图片超过 ${Math.round(WATCHFACE_PREVIEW_MAX_SOURCE_BYTES / 1024 / 1024)} MB`,
      };
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      return { ok: false, code: 'file_read_failed', message: '读取图片文件失败' };
    }

    const decoded = nativeImage.createFromBuffer(bytes);
    if (decoded.isEmpty()) {
      return { ok: false, code: 'image_decode_failed', message: '这个文件不是能识别的图片（支持 PNG / JPEG）' };
    }
    const original = decoded.getSize();
    if (!original.width || !original.height) {
      return { ok: false, code: 'image_decode_failed', message: '图片尺寸无效' };
    }
    const normalized =
      original.width > WATCHFACE_PREVIEW_TARGET_WIDTH
        ? decoded.resize({ width: WATCHFACE_PREVIEW_TARGET_WIDTH, quality: 'best' })
        : decoded;
    const png = normalized.toPNG();
    if (!png || png.length === 0) {
      return { ok: false, code: 'image_encode_failed', message: '图片转码失败' };
    }

    const finalSize = normalized.getSize();
    try {
      this.store.set(id, {
        bytes: png,
        source: 'manual',
        width: finalSize.width,
        height: finalSize.height,
      });
    } catch {
      return { ok: false, code: 'preview_write_failed', message: '写入本地预览缓存失败' };
    }

    this.dataUrlCache.delete(id);
    const view = await this.toView(id);
    if (!view) {
      return { ok: false, code: 'preview_write_failed', message: '写入本地预览缓存失败' };
    }
    return { ok: true, data: { preview: view } };
  }

  /** 清除本地预览图。幂等：本来就没有也算成功，UI 不需要区分 */
  async clear(id: string): Promise<WatchfacePreviewResult<{ id: string }>> {
    if (!isValidWatchfacePreviewId(id)) {
      return { ok: false, code: 'invalid_params', message: '缺少表盘 id' };
    }
    this.dataUrlCache.delete(id);
    this.store.clear(id);
    return { ok: true, data: { id } };
  }

  /**
   * 启动后台种子目录解析（幂等，整个进程只执行一次）
   */
  startBackgroundPreparation(seedDirectories: string[]): void {
    if (this.preparationPromise) return;
    this.preparationPromise = this.runBackgroundPreparation(seedDirectories);
  }

  private async runBackgroundPreparation(seedDirectories: string[]): Promise<void> {
    for (const dir of seedDirectories) {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        // 种子目录不存在或无法读取时静默忽略
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
        const fullPath = path.join(dir, entry.name);
        try {
          const info = await stat(fullPath);
          if (!info.isFile() || info.size === 0 || info.size > WATCHFACE_PREVIEW_MAX_SOURCE_BYTES) {
            continue;
          }

          const fileBytes = await readFile(fullPath);
          const sha256 = createHash('sha256').update(fileBytes).digest('hex');

          const decoded = decodeWatchfacePreview(fileBytes);
          const embeddedId = decoded.id ? decoded.id.trim() : '';
          if (!embeddedId || /^0+$/.test(embeddedId) || !isValidWatchfacePreviewId(embeddedId)) {
            continue;
          }

          const existing = this.store.getEntry(embeddedId);
          if (!shouldPrepareAutoPreview(existing, sha256)) {
            continue;
          }

          const image = nativeImage.createFromBitmap(decoded.bgra, {
            width: decoded.width,
            height: decoded.height,
          });
          if (image.isEmpty()) {
            console.warn(`[WatchfacePreview] 自动预览为空图像: ${entry.name}`);
            continue;
          }

          const png = image.toPNG();
          if (!png || png.length === 0) {
            console.warn(`[WatchfacePreview] 自动预览转 PNG 失败: ${entry.name}`);
            continue;
          }

          this.store.set(embeddedId, {
            bytes: png,
            source: 'auto',
            sourceHash: sha256,
            width: decoded.width,
            height: decoded.height,
          });
          this.dataUrlCache.delete(embeddedId);
        } catch (err) {
          console.warn(
            `[WatchfacePreview] 种子表盘解析跳过 [${entry.name}]:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  /**
   * 从指定 .bin 文件为目标 id 准备预览图（用于安装后自动提取或种子构建）
   */
  async prepareFromBin(
    id: string,
    filePath: string,
    sourceHash?: string,
  ): Promise<{ status: 'written' | 'cached' | 'manual-preserved' | 'skipped'; id: string }> {
    if (!isValidWatchfacePreviewId(id)) {
      return { status: 'skipped', id };
    }

    const existing = this.store.getEntry(id);
    if (existing?.source === 'manual') {
      return { status: 'manual-preserved', id };
    }

    if (sourceHash && existing && !shouldPrepareAutoPreview(existing, sourceHash)) {
      return { status: 'cached', id };
    }

    let info;
    try {
      info = await stat(filePath);
    } catch (err) {
      console.warn(
        `[WatchfacePreview] 无法读取表盘文件 [${filePath}]:`,
        err instanceof Error ? err.message : String(err),
      );
      return { status: 'skipped', id };
    }

    if (!info.isFile() || info.size === 0 || info.size > WATCHFACE_PREVIEW_MAX_SOURCE_BYTES) {
      return { status: 'skipped', id };
    }

    const fileBytes = await readFile(filePath);
    const hash = sourceHash || createHash('sha256').update(fileBytes).digest('hex');

    if (existing && !shouldPrepareAutoPreview(existing, hash)) {
      return { status: 'cached', id };
    }

    const decoded = decodeWatchfacePreview(fileBytes);
    const image = nativeImage.createFromBitmap(decoded.bgra, {
      width: decoded.width,
      height: decoded.height,
    });
    if (image.isEmpty()) {
      throw new Error('nativeImage.createFromBitmap produced empty image');
    }

    const png = image.toPNG();
    if (!png || png.length === 0) {
      throw new Error('toPNG produced empty buffer');
    }

    this.store.set(id, {
      bytes: png,
      source: 'auto',
      sourceHash: hash,
      width: decoded.width,
      height: decoded.height,
    });
    this.dataUrlCache.delete(id);
    return { status: 'written', id };
  }
}

export function registerWatchfacePreviewIpc(
  service: WatchfacePreviewService,
  ipc: { handle: (channel: string, listener: (event: any, ...args: any[]) => any) => void },
): void {
  ipc.handle('pulse:watchface:preview:list', () => service.list());

  ipc.handle('pulse:watchface:preview:set', (_e, req: { id?: unknown; filePath?: unknown }) => {
    const id = typeof req?.id === 'string' ? req.id : '';
    const filePath = typeof req?.filePath === 'string' ? req.filePath : '';
    return service.setFromFile(id, filePath);
  });

  ipc.handle('pulse:watchface:preview:clear', (_e, req: { id?: unknown }) => {
    const id = typeof req?.id === 'string' ? req.id : '';
    return service.clear(id);
  });
}
