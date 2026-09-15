/**
 * 快应用文件分块流式读取与哈希计算器 (App Install Chunk Reader & Stream Hasher)
 *
 * 职责：
 * - 随机读取指定 chunkIndex 的分块数据，绝不一次性读入整个大文件
 * - 基于 Node.js crypto 和 fs.createReadStream 流式计算真实文件的 SHA-256
 * - 纯流式与按需读取，无临时文件，不写入磁盘
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * 流式计算本地文件的 SHA-256 哈希值
 *
 * @param filePath 本地文件路径
 * @returns 64 位十六进制 SHA-256 哈希字符串
 */
export function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof filePath !== 'string') {
      return reject(new Error('无效的文件路径'));
    }
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`文件不存在: ${filePath}`));
    }

    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 流式计算本地文件的 MD5 哈希值
 *
 * 用途：Mass 传输的 data_id 与包体 MD5。上游源码确认必须是 `MD5(完整RPK)`，
 * 与用于本地完整性校验的 SHA-256 不是同一个值，不能互相截断代替。
 *
 * @param filePath 本地文件路径
 * @returns 32 位十六进制 MD5 哈希字符串
 */
export function calculateFileMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!filePath || typeof filePath !== 'string') {
      return reject(new Error('无效的文件路径'));
    }
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`文件不存在: ${filePath}`));
    }

    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => {
      hash.update(chunk);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * 根据分块索引与分块大小，随机读取本地文件对应分片
 * 使用 fs.openSync + fs.readSync，绝不一次性读取整个文件
 *
 * @param filePath 文件路径
 * @param chunkIndex 分块索引 (0-based)
 * @param chunkSize 分块规格大小 (字节数)
 * @returns 当前分块的 Buffer
 */
export function readChunk(
  filePath: string,
  chunkIndex: number,
  chunkSize: number
): Buffer {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('无效的文件路径');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }
  if (typeof chunkIndex !== 'number' || chunkIndex < 0) {
    throw new Error(`无效的 chunkIndex: ${chunkIndex}`);
  }
  if (typeof chunkSize !== 'number' || chunkSize <= 0) {
    throw new Error(`无效的 chunkSize: ${chunkSize}`);
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const offset = chunkIndex * chunkSize;

  if (offset >= fileSize) {
    throw new Error(
      `分块偏移越界: chunkIndex ${chunkIndex} 对应偏移 ${offset} 已超出文件大小 ${fileSize}`
    );
  }

  const bytesToRead = Math.min(chunkSize, fileSize - offset);
  const buffer = Buffer.alloc(bytesToRead);

  const fd = fs.openSync(filePath, 'r');
  try {
    // readSync 允许短读：读满 bytesToRead 或遇到 EOF 才停，否则会交出残缺分片
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const n = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, offset + bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead < bytesToRead) {
      return buffer.subarray(0, bytesRead);
    }
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}
