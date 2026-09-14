/**
 * 表盘预览图本地缓存（主进程；纯 node，无 electron 依赖，可在 node 下直接单测）
 *
 * 位置：`<userData>/watchface-previews/`
 *   index.json                 索引：watchface id -> 条目
 *   <sha1(id) 前 16 位>.png    归一化后的预览图
 *
 * 为什么放在 userData：这是"用户自己标注的本地数据"，不进仓库、不上传、
 * 不参与任何设备协议。卸载前一直有效，一次设置长期可用。
 *
 * 安全边界：文件名由 id 的 sha1 派生，id 本身不参与路径拼接，
 * 因此设备返回的 id 即使包含 `../` 也写不到目录外。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WatchfacePreviewSource = 'manual' | 'auto';

export interface WatchfacePreviewEntry {
  /** store 目录内的文件名，保证不含任何路径分隔符 */
  file: string;
  source: WatchfacePreviewSource;
  sourceHash?: string;
  name?: string;
  /** ISO 时间戳 */
  addedAt: string;
  width: number;
  height: number;
  bytes: number;
}

export interface WatchfacePreviewIndex {
  version: 1;
  entries: Record<string, WatchfacePreviewEntry>;
}

export const WATCHFACE_PREVIEW_DIR_NAME = 'watchface-previews';

const INDEX_FILE = 'index.json';
const MAX_ID_LENGTH = 128;
const MAX_HASH_LENGTH = 128;
const MAX_NAME_LENGTH = 128;

/** id 只用来做 hash 与索引键，但仍限制长度，避免异常输入撑爆索引 */
export function isValidWatchfacePreviewId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH && !trimmed.includes('\0');
}

function previewFileName(id: string): string {
  return `${createHash('sha1').update(id, 'utf8').digest('hex').slice(0, 16)}.png`;
}

function sanitizeEntry(raw: unknown): WatchfacePreviewEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<WatchfacePreviewEntry>;
  if (typeof entry.file !== 'string' || !entry.file) return null;
  if (entry.file.includes('/') || entry.file.includes('\\')) return null;
  if (entry.source !== 'manual' && entry.source !== 'auto') return null;
  if (typeof entry.addedAt !== 'string') return null;
  if (typeof entry.width !== 'number' || typeof entry.height !== 'number') return null;
  if (typeof entry.bytes !== 'number') return null;
  let sourceHash: string | undefined;
  if (typeof entry.sourceHash === 'string') {
    const trimmed = entry.sourceHash.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_HASH_LENGTH) {
      sourceHash = trimmed;
    }
  }
  let name: string | undefined;
  if (typeof entry.name === 'string') {
    const trimmed = entry.name.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH) {
      name = trimmed;
    }
  }
  return {
    file: entry.file,
    source: entry.source,
    ...(sourceHash ? { sourceHash } : {}),
    ...(name ? { name } : {}),
    addedAt: entry.addedAt,
    width: entry.width,
    height: entry.height,
    bytes: entry.bytes,
  };
}

export class WatchfacePreviewStore {
  private readonly dir: string;

  // 不用 TS 参数属性：node 的 strip-only 模式不支持，测试要能直接 import 这个文件
  constructor(dir: string) {
    this.dir = dir;
  }

  get directory(): string {
    return this.dir;
  }

  private indexFilePath(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 读索引。文件缺失 / JSON 损坏 / 形状不对一律退化为空索引：
   * 索引坏掉只应该表现为"没有本地预览图"，不能让整个表盘页报错。
   */
  readIndex(): WatchfacePreviewIndex {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFilePath(), 'utf8')) as {
        entries?: unknown;
      };
      if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
        return { version: 1, entries: {} };
      }
      const entries: Record<string, WatchfacePreviewEntry> = {};
      for (const [id, value] of Object.entries(parsed.entries as Record<string, unknown>)) {
        const entry = sanitizeEntry(value);
        if (entry) entries[id] = entry;
      }
      return { version: 1, entries };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  /** 原子写：先写 .tmp 再 rename，避免半截 JSON 覆盖掉可用索引 */
  private writeIndex(index: WatchfacePreviewIndex): void {
    this.ensureDir();
    const target = this.indexFilePath();
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  }

  /** 只返回文件确实还在的条目 */
  list(): Record<string, WatchfacePreviewEntry> {
    const out: Record<string, WatchfacePreviewEntry> = {};
    for (const [id, entry] of Object.entries(this.readIndex().entries)) {
      if (fs.existsSync(path.join(this.dir, entry.file))) out[id] = entry;
    }
    return out;
  }

  getEntry(id: string): WatchfacePreviewEntry | null {
    if (!isValidWatchfacePreviewId(id)) return null;
    const entry = this.readIndex().entries[id];
    if (!entry) return null;
    return fs.existsSync(path.join(this.dir, entry.file)) ? entry : null;
  }

  /** 条目对应的绝对路径；索引里没有或文件已丢失时返回 null */
  resolve(id: string): string | null {
    const entry = this.getEntry(id);
    return entry ? path.join(this.dir, entry.file) : null;
  }

  /**
   * 写入 / 替换某个 id 的预览图。同一 id 覆盖同一个文件，不产生垃圾文件。
   * source 区分「用户手动指定」与「层 3 自动提取」，读取侧以 manual 优先。
   */
  set(
    id: string,
    input: {
      bytes: Buffer;
      source: WatchfacePreviewSource;
      sourceHash?: string;
      name?: string;
      width: number;
      height: number;
    },
  ): WatchfacePreviewEntry {
    if (!isValidWatchfacePreviewId(id)) throw new Error('非法表盘 id');
    if (!input.bytes || input.bytes.length === 0) throw new Error('预览图内容为空');
    this.ensureDir();
    const file = previewFileName(id);
    const target = path.join(this.dir, file);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, input.bytes);
    fs.renameSync(tmp, target);

    let sourceHash: string | undefined;
    if (typeof input.sourceHash === 'string') {
      const trimmed = input.sourceHash.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_HASH_LENGTH) {
        sourceHash = trimmed;
      }
    }

    let name: string | undefined;
    if (typeof input.name === 'string') {
      const trimmed = input.name.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH) {
        name = trimmed;
      }
    }

    const entry: WatchfacePreviewEntry = {
      file,
      source: input.source,
      ...(sourceHash ? { sourceHash } : {}),
      ...(name ? { name } : {}),
      addedAt: new Date().toISOString(),
      width: input.width,
      height: input.height,
      bytes: input.bytes.length,
    };
    const index = this.readIndex();
    index.entries[id] = entry;
    this.writeIndex(index);
    return entry;
  }

  /**
   * 仅在条目已存在但缺少 name 时更新 name 索引字段（不改动图片与 mtime）
   */
  updateName(id: string, name: string): boolean {
    if (!isValidWatchfacePreviewId(id)) return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return false;
    const index = this.readIndex();
    const entry = index.entries[id];
    if (!entry) return false;
    if (entry.name === trimmed) return true;
    entry.name = trimmed;
    this.writeIndex(index);
    return true;
  }

  /**
   * 将一个已有的本地预览图条目及文件安全复制到新的 id（用于将 .bin 内嵌预览关联到手环实际 id）。
   * 仅在目标 id 不存在或满足特定条件时调用，不执行图像重新解码。
   */
  copyEntry(
    fromId: string,
    toId: string,
    overrides?: {
      name?: string;
      source?: WatchfacePreviewSource;
    },
  ): WatchfacePreviewEntry {
    if (!isValidWatchfacePreviewId(fromId) || !isValidWatchfacePreviewId(toId)) {
      throw new Error('非法表盘 id');
    }
    const sourceEntry = this.getEntry(fromId);
    const sourceFilePath = this.resolve(fromId);
    if (!sourceEntry || !sourceFilePath) {
      throw new Error(`源表盘预览不存在 [${fromId}]`);
    }

    this.ensureDir();
    const file = previewFileName(toId);
    const target = path.join(this.dir, file);
    const tmp = `${target}.tmp`;
    fs.copyFileSync(sourceFilePath, tmp);
    fs.renameSync(tmp, target);

    let name = overrides?.name ?? sourceEntry.name;
    if (typeof name === 'string') {
      const trimmed = name.trim();
      name = trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH ? trimmed : undefined;
    }

    const entry: WatchfacePreviewEntry = {
      file,
      source: overrides?.source ?? sourceEntry.source,
      ...(sourceEntry.sourceHash ? { sourceHash: sourceEntry.sourceHash } : {}),
      ...(name ? { name } : {}),
      addedAt: new Date().toISOString(),
      width: sourceEntry.width,
      height: sourceEntry.height,
      bytes: sourceEntry.bytes,
    };

    const index = this.readIndex();
    index.entries[toId] = entry;
    this.writeIndex(index);
    return entry;
  }

  /** 清除某个 id 的预览图（索引 + 文件）。返回是否确实删掉了条目 */
  clear(id: string): boolean {
    if (!isValidWatchfacePreviewId(id)) return false;
    const index = this.readIndex();
    const entry = index.entries[id];
    if (!entry) return false;
    delete index.entries[id];
    this.writeIndex(index);
    try {
      fs.rmSync(path.join(this.dir, entry.file), { force: true });
    } catch {
      // 文件已经不在，不影响索引已清理的事实
    }
    return true;
  }
}
