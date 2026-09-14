import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectRpk, MAX_RPK_INSPECT_SIZE } from '../src/main/services/rpk-inspector.ts';

function createSimpleZipBuffer(filename, content) {
  const nameBuf = Buffer.from(filename, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');

  // Local File Header
  const localHeader = Buffer.alloc(30 + nameBuf.length + dataBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // Signature
  localHeader.writeUInt16LE(20, 4);          // Version needed
  localHeader.writeUInt16LE(0, 6);           // Flags
  localHeader.writeUInt16LE(0, 8);           // Method: 0 (Stored)
  localHeader.writeUInt16LE(0, 10);          // Time
  localHeader.writeUInt16LE(0, 12);          // Date
  localHeader.writeUInt32LE(0, 14);          // CRC-32 (0 for simple mock)
  localHeader.writeUInt32LE(dataBuf.length, 18); // Comp size
  localHeader.writeUInt32LE(dataBuf.length, 22); // Uncomp size
  localHeader.writeUInt16LE(nameBuf.length, 26); // Name length
  localHeader.writeUInt16LE(0, 28);          // Extra length
  nameBuf.copy(localHeader, 30);
  dataBuf.copy(localHeader, 30 + nameBuf.length);

  // Central Directory Header
  const cdHeader = Buffer.alloc(46 + nameBuf.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);     // Signature
  cdHeader.writeUInt16LE(20, 4);              // Ver made by
  cdHeader.writeUInt16LE(20, 6);              // Ver needed
  cdHeader.writeUInt16LE(0, 8);               // Flags
  cdHeader.writeUInt16LE(0, 10);              // Method: 0
  cdHeader.writeUInt16LE(0, 12);              // Time
  cdHeader.writeUInt16LE(0, 14);              // Date
  cdHeader.writeUInt32LE(0, 16);              // CRC-32
  cdHeader.writeUInt32LE(dataBuf.length, 20); // Comp size
  cdHeader.writeUInt32LE(dataBuf.length, 24); // Uncomp size
  cdHeader.writeUInt16LE(nameBuf.length, 28); // Name length
  cdHeader.writeUInt16LE(0, 30);              // Extra length
  cdHeader.writeUInt16LE(0, 32);              // Comment length
  cdHeader.writeUInt16LE(0, 34);              // Disk start
  cdHeader.writeUInt16LE(0, 36);              // Int attr
  cdHeader.writeUInt32LE(0, 38);              // Ext attr
  cdHeader.writeUInt32LE(0, 42);              // Local header offset: 0
  nameBuf.copy(cdHeader, 46);

  // End of Central Directory Record (EOCD)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);         // Signature
  eocd.writeUInt16LE(0, 4);                  // Disk num
  eocd.writeUInt16LE(0, 6);                  // Start disk
  eocd.writeUInt16LE(1, 8);                  // Entries on disk
  eocd.writeUInt16LE(1, 10);                 // Total entries
  eocd.writeUInt32LE(cdHeader.length, 12);   // CD size
  eocd.writeUInt32LE(localHeader.length, 16);// CD offset
  eocd.writeUInt16LE(0, 20);                 // Comment length

  return Buffer.concat([localHeader, cdHeader, eocd]);
}

const testDir = path.join(os.tmpdir(), `pulse-rpk-test-${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

test.after(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

test('1. 不存在文件拒绝', () => {
  const missingPath = path.join(testDir, 'missing.rpk');
  assert.throws(
    () => inspectRpk(missingPath),
    { message: /文件不存在/ }
  );
});

test('2. txt 文件拒绝', () => {
  const txtPath = path.join(testDir, 'sample.txt');
  fs.writeFileSync(txtPath, 'some text content', 'utf8');

  assert.throws(
    () => inspectRpk(txtPath),
    { message: /非法文件类型: 扩展名必须为 .rpk/ }
  );
});

test('3. 超过5MB拒绝', () => {
  const oversizePath = path.join(testDir, 'oversize.rpk');
  // 创建 5MB + 1 字节的文件
  const fd = fs.openSync(oversizePath, 'w');
  fs.writeSync(fd, Buffer.from('X'), 0, 1, MAX_RPK_INSPECT_SIZE);
  fs.closeSync(fd);

  assert.throws(
    () => inspectRpk(oversizePath),
    { message: /文件大小超出最大限制 \(5 MiB\)/ }
  );
});

test('4. 非ZIP rpk返回 manifestValid false', () => {
  const corruptRpkPath = path.join(testDir, 'not-a-zip.rpk');
  fs.writeFileSync(corruptRpkPath, 'Plain text header that is definitely not PK\x03\x04', 'utf8');

  const meta = inspectRpk(corruptRpkPath);
  assert.equal(meta.manifestValid, false);
  assert.ok(meta.fileSize > 0);
  assert.equal(meta.packageId, undefined);
});

test('5. 合法ZIP+manifest解析成功', () => {
  // A. 内存合成的完整 package 测试
  const validRpkPath = path.join(testDir, 'valid.rpk');
  const manifestData = JSON.stringify({
    name: 'Sample App',
    package: 'com.example.sample',
    versionName: '2.1.0',
    versionCode: 210,
  });
  fs.writeFileSync(validRpkPath, createSimpleZipBuffer('manifest.json', manifestData));

  const meta = inspectRpk(validRpkPath);
  assert.equal(meta.manifestValid, true);
  assert.equal(meta.packageId, 'com.example.sample');
  assert.equal(meta.versionName, '2.1.0');
  assert.equal(meta.versionCode, 210);
  assert.ok(meta.fileSize > 0);

  // B. 真实 assets/band-app.rpk 测试
  const realRpkPath = path.resolve('assets/band-app.rpk');
  if (fs.existsSync(realRpkPath)) {
    const realMeta = inspectRpk(realRpkPath);
    assert.equal(realMeta.manifestValid, true);
    assert.equal(realMeta.packageId, 'com.codeisland.band');
    assert.equal(realMeta.versionName, '1.0.1');
    assert.equal(realMeta.versionCode, 26);
    assert.equal(realMeta.fileSize, fs.statSync(realRpkPath).size);
  }
});

test('6. manifest缺少version字段仍可解析', () => {
  const partialRpkPath = path.join(testDir, 'partial-manifest.rpk');
  const partialManifest = JSON.stringify({
    name: 'Partial App',
    package: 'com.example.partial',
    // 缺少 versionName 与 versionCode
  });
  fs.writeFileSync(partialRpkPath, createSimpleZipBuffer('manifest.json', partialManifest));

  const meta = inspectRpk(partialRpkPath);
  assert.equal(meta.manifestValid, true);
  assert.equal(meta.packageId, 'com.example.partial');
  assert.equal(meta.versionName, undefined);
  assert.equal(meta.versionCode, undefined);
  assert.ok(meta.fileSize > 0);
});

test('7. 不产生临时文件 (纯内存解压)', () => {
  const targetRpk = path.join(testDir, 'temp-check.rpk');
  fs.writeFileSync(targetRpk, createSimpleZipBuffer('manifest.json', JSON.stringify({ package: 'com.test.temp' })));

  const beforeFiles = fs.readdirSync(testDir);
  const meta = inspectRpk(targetRpk);
  const afterFiles = fs.readdirSync(testDir);

  assert.equal(meta.manifestValid, true);
  // 确保解析前后目录下的文件完全一致，没有落盘任何中间解压文件
  assert.deepEqual(beforeFiles, afterFiles);
});
