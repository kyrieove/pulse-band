/**
 * RPK 快应用包元数据检查服务 (RPK Package Metadata Inspector)
 *
 * 职责：
 * - 验证本地 .rpk 文件类型与大小边界
 * - 纯内存检测 ZIP 容器结构
 * - 纯内存解析 manifest.json 元数据
 * - 绝不落盘、不解压、不写临时文件、不调用蓝牙或设备通信
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { RpkMetadata } from '../../common/types';

export const MAX_RPK_INSPECT_SIZE = 5 * 1024 * 1024; // 5 MiB
const ZIP_LOCAL_HEADER_MAGIC = 0x04034b50; // 'PK\x03\x04'
const ZIP_CENTRAL_DIR_MAGIC = 0x02014b50;  // 'PK\x01\x02'
const ZIP_EOCD_MAGIC = 0x06054b50;         // 'PK\x05\x06'

/**
 * 从内存 ZIP Buffer 中寻找并解压指定文件的原始数据（纯内存，绝不落盘）
 */
function extractZipEntryInMemory(buffer: Buffer, targetFileName: string): Buffer | null {
  // 路径 A：顺序扫描 Local File Headers
  let offset = 0;
  while (offset < buffer.length - 30) {
    if (buffer.readUInt32LE(offset) !== ZIP_LOCAL_HEADER_MAGIC) {
      break;
    }
    const compMethod = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + nameLen + extraLen;

    if (offset + 30 + nameLen <= buffer.length) {
      const entryName = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
      if (entryName === targetFileName) {
        if (dataStart + compSize <= buffer.length) {
          const compData = buffer.subarray(dataStart, dataStart + compSize);
          if (compMethod === 0) {
            return Buffer.from(compData);
          } else if (compMethod === 8) {
            return zlib.inflateRawSync(compData);
          }
        }
      }
    }

    if (compSize > 0) {
      offset = dataStart + compSize;
    } else {
      // 若包含 data descriptor 且 compSize 在 local header 为 0，走 Central Directory 回退
      break;
    }
  }

  // 路径 B：回退通过 Central Directory 定位
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_MAGIC) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset !== -1) {
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
    let cdPtr = cdOffset;

    for (let i = 0; i < cdEntries && cdPtr + 46 <= eocdOffset; i++) {
      if (buffer.readUInt32LE(cdPtr) !== ZIP_CENTRAL_DIR_MAGIC) break;

      const compMethod = buffer.readUInt16LE(cdPtr + 10);
      const compSize = buffer.readUInt32LE(cdPtr + 20);
      const nameLen = buffer.readUInt16LE(cdPtr + 28);
      const extraLen = buffer.readUInt16LE(cdPtr + 30);
      const commentLen = buffer.readUInt16LE(cdPtr + 32);
      const localHeaderOffset = buffer.readUInt32LE(cdPtr + 42);

      const entryName = buffer.toString('utf8', cdPtr + 46, cdPtr + 46 + nameLen);
      if (entryName === targetFileName) {
        if (
          localHeaderOffset + 30 <= buffer.length &&
          buffer.readUInt32LE(localHeaderOffset) === ZIP_LOCAL_HEADER_MAGIC
        ) {
          const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
          const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
          const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
          if (dataStart + compSize <= buffer.length) {
            const compData = buffer.subarray(dataStart, dataStart + compSize);
            if (compMethod === 0) {
              return Buffer.from(compData);
            } else if (compMethod === 8) {
              return zlib.inflateRawSync(compData);
            }
          }
        }
        break;
      }

      cdPtr += 46 + nameLen + extraLen + commentLen;
    }
  }

  return null;
}

/**
 * 审查并解析本地 RPK 文件元数据
 *
 * @param filePath 本地文件路径
 * @returns RpkMetadata 解析结果
 */
export function inspectRpk(filePath: string): RpkMetadata {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('无效的文件路径');
  }

  // 1. 检查文件存在性与类型
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`路径不是普通文件: ${filePath}`);
  }

  // 2. 检查扩展名
  if (path.extname(filePath).toLowerCase() !== '.rpk') {
    throw new Error(`非法文件类型: 扩展名必须为 .rpk (${filePath})`);
  }

  // 3. 检查文件大小：0 < size <= 5 MiB
  if (stat.size <= 0) {
    throw new Error('文件大小必须大于 0');
  }
  if (stat.size > MAX_RPK_INSPECT_SIZE) {
    throw new Error(`文件大小超出最大限制 (5 MiB): 当前为 ${(stat.size / (1024 * 1024)).toFixed(2)} MiB`);
  }

  const fileSize = stat.size;

  // 4. 读取文件到内存（纯内存，禁止写临时文件）
  const buffer = fs.readFileSync(filePath);

  // 5. 校验 ZIP 容器文件头
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZIP_LOCAL_HEADER_MAGIC) {
    return {
      fileSize,
      manifestValid: false,
    };
  }

  // 6. 提取并解析 manifest.json
  try {
    const rawManifest = extractZipEntryInMemory(buffer, 'manifest.json');
    if (!rawManifest) {
      return {
        fileSize,
        manifestValid: false,
      };
    }

    const manifestJson = JSON.parse(rawManifest.toString('utf8'));
    if (!manifestJson || typeof manifestJson !== 'object') {
      return {
        fileSize,
        manifestValid: false,
      };
    }

    return {
      fileSize,
      packageId: typeof manifestJson.package === 'string' ? manifestJson.package : undefined,
      versionName: typeof manifestJson.versionName === 'string' ? manifestJson.versionName : undefined,
      versionCode: typeof manifestJson.versionCode === 'number' ? manifestJson.versionCode : undefined,
      manifestValid: true,
    };
  } catch {
    return {
      fileSize,
      manifestValid: false,
    };
  }
}
