import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { inspectRpk } from '../src/main/services/rpk-inspector.ts';
import { AppInstallService } from '../src/main/services/app-install-service.ts';
import { readChunk, calculateFileHash } from '../src/main/services/app-install-reader.ts';

const RPK_PATH = path.resolve('assets/band-app.rpk');

test('1. 真实 band-app.rpk inspect 成功', () => {
  assert.strictEqual(fs.existsSync(RPK_PATH), true, 'assets/band-app.rpk 必须存在');
  const meta = inspectRpk(RPK_PATH);

  assert.strictEqual(meta.manifestValid, true);
  assert.strictEqual(typeof meta.fileSize, 'number');
  assert.strictEqual(meta.fileSize > 0, true);
  assert.strictEqual(typeof meta.packageId, 'string');
  assert.strictEqual(meta.packageId.length > 0, true);
  assert.strictEqual(typeof meta.versionName, 'string');
  assert.strictEqual(typeof meta.versionCode, 'number');
});

test('2. prepareFromFile 成功生成 session', async () => {
  const service = new AppInstallService();
  const meta = inspectRpk(RPK_PATH);
  const result = await service.prepareFromFile(RPK_PATH);

  assert.strictEqual(result.status, 'preparing');
  assert.strictEqual(result.fileSize, meta.fileSize);
  assert.strictEqual(result.chunkSize, 512);
  assert.strictEqual(result.totalChunks, Math.ceil(meta.fileSize / 512));
  assert.ok(result.installId.startsWith('inst_'));
});

test('3. 校验返回哈希为真实 sha256', async () => {
  const service = new AppInstallService();
  await service.prepareFromFile(RPK_PATH);
  const session = service.getSession();
  assert.ok(session);

  const fileBuffer = fs.readFileSync(RPK_PATH);
  const expectedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  assert.strictEqual(session.expectedHash, expectedSha256);
  assert.strictEqual(/^[0-9a-f]{64}$/.test(session.expectedHash), true);

  const readerSha256 = await calculateFileHash(RPK_PATH);
  assert.strictEqual(readerSha256, expectedSha256);
});

test('4. 校验 metadata 正确保存到 session', async () => {
  const service = new AppInstallService();
  const meta = inspectRpk(RPK_PATH);
  await service.prepareFromFile(RPK_PATH);
  const session = service.getSession();
  assert.ok(session);

  assert.strictEqual(session.packageId, meta.packageId);
  assert.strictEqual(session.versionName, meta.versionName);
  assert.strictEqual(session.versionCode, meta.versionCode);
  assert.strictEqual(session.sourcePath, RPK_PATH);
});

test('5. 校验 readChunk 读取第 0 块', () => {
  const fullContent = fs.readFileSync(RPK_PATH);
  const chunk0 = readChunk(RPK_PATH, 0, 512);

  assert.ok(Buffer.isBuffer(chunk0));
  assert.strictEqual(chunk0.length, 512);
  assert.deepStrictEqual(chunk0, fullContent.subarray(0, 512));
});

test('6. 校验 readChunk 读取末尾块', () => {
  const fullContent = fs.readFileSync(RPK_PATH);
  const stat = fs.statSync(RPK_PATH);
  const chunkSize = 512;
  const totalChunks = Math.ceil(stat.size / chunkSize);
  const lastChunkIndex = totalChunks - 1;
  const expectedLastChunkSize = stat.size - lastChunkIndex * chunkSize;

  const lastChunk = readChunk(RPK_PATH, lastChunkIndex, chunkSize);

  assert.ok(Buffer.isBuffer(lastChunk));
  assert.strictEqual(lastChunk.length, expectedLastChunkSize);
  assert.deepStrictEqual(lastChunk, fullContent.subarray(lastChunkIndex * chunkSize));
});

test('7. 校验不存在文件报错', async () => {
  const service = new AppInstallService();
  const fakePath = path.resolve('assets/non_existent_file.rpk');

  await assert.rejects(
    async () => {
      await service.prepareFromFile(fakePath);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /文件不存在/);
      return true;
    }
  );

  assert.throws(
    () => {
      readChunk(fakePath, 0, 512);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /文件不存在/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await calculateFileHash(fakePath);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /文件不存在/);
      return true;
    }
  );
});

test('8. 校验损坏文件 / 非法 manifest 报错', async () => {
  const service = new AppInstallService();
  const tempCorruptFile = path.join(os.tmpdir(), `corrupt_${Date.now()}.rpk`);
  fs.writeFileSync(tempCorruptFile, Buffer.from('corrupt non-zip binary content'));

  try {
    await assert.rejects(
      async () => {
        await service.prepareFromFile(tempCorruptFile);
      },
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /RPK manifest 无效|不是合法 ZIP/);
        return true;
      }
    );
  } finally {
    if (fs.existsSync(tempCorruptFile)) {
      fs.unlinkSync(tempCorruptFile);
    }
  }
});

test('9. 校验全程无磁盘写入（没有多余临时文件）', async () => {
  const rootFilesBefore = fs.readdirSync(process.cwd());
  const assetsFilesBefore = fs.readdirSync(path.resolve('assets'));

  const service = new AppInstallService();
  const result = await service.prepareFromFile(RPK_PATH);
  assert.strictEqual(result.status, 'preparing');

  // 模拟按块流式读取全文件校验无遗留临时文件
  for (let i = 0; i < Math.min(result.totalChunks, 5); i++) {
    const chunk = readChunk(RPK_PATH, i, 512);
    assert.ok(chunk.length > 0);
  }

  const rootFilesAfter = fs.readdirSync(process.cwd());
  const assetsFilesAfter = fs.readdirSync(path.resolve('assets'));

  assert.deepStrictEqual(rootFilesAfter, rootFilesBefore);
  assert.deepStrictEqual(assetsFilesAfter, assetsFilesBefore);
});
