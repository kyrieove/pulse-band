import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeWatchfacePreview,
  shouldPrepareAutoPreview,
} from '../src/main/services/watchface-preview-decoder.ts';
import {
  WatchfacePreviewService,
} from '../src/main/services/watchface-preview-service.ts';
import {
  WatchfacePreviewStore,
  WATCHFACE_PREVIEW_DIR_NAME,
} from '../src/main/services/watchface-preview-store.ts';

const tmpRoot = path.join(os.tmpdir(), `pulse-wf-auto-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

let caseIndex = 0;
function freshStore() {
  const dir = path.join(tmpRoot, `case-${caseIndex++}`, WATCHFACE_PREVIEW_DIR_NAME);
  return { store: new WatchfacePreviewStore(dir), dir };
}

const DUMMY_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const mockPngEncoder = (bgra, width, height) => {
  return Buffer.concat([PNG_MAGIC, Buffer.from(`mock-png-${width}x${height}-${bgra.length}`)]);
};

const MAIN_HEADER_SIZE = 0xa8;
const IMAGE_HEADER_SIZE = 12;
const MAGIC = Buffer.from([0x5a, 0xa5, 0x34, 0x12]);

function buildTestBin({
  id = '123456789',
  name = 'Fixture',
  previewOffset = MAIN_HEADER_SIZE,
  sign = 0,
  width = 2,
  height = 1,
  payload = Buffer.from([
    0x00, 0x00, 0xff, 0xff, // red in BGRA
    0x00, 0xff, 0x00, 0xff, // green in BGRA
  ]),
}) {
  const minSize = Math.max(MAIN_HEADER_SIZE, previewOffset + IMAGE_HEADER_SIZE + payload.length);
  const file = Buffer.alloc(minSize);
  MAGIC.copy(file, 0);
  file.writeUInt32LE(previewOffset, 0x20);
  file.write(id, 0x28, 'ascii');
  file.write(name, 0x68, 'utf8');

  file[previewOffset] = sign;
  file.writeUInt16LE(width, previewOffset + 4);
  file.writeUInt16LE(height, previewOffset + 6);
  file.writeUInt32LE(payload.length, previewOffset + 8);
  if (payload.length > 0) {
    payload.copy(file, previewOffset + IMAGE_HEADER_SIZE);
  }
  return file;
}

test('shouldPrepareAutoPreview: missing entry returns true', () => {
  assert.equal(shouldPrepareAutoPreview(null, 'hash-1'), true);
});

test('shouldPrepareAutoPreview: manual entry returns false regardless of hash', () => {
  const entry = {
    file: 'a.png',
    source: 'manual',
    addedAt: '2026-09-13T00:00:00.000Z',
    width: 212,
    height: 520,
    bytes: 100,
  };
  assert.equal(shouldPrepareAutoPreview(entry, 'any-hash'), false);
  assert.equal(shouldPrepareAutoPreview({ ...entry, sourceHash: 'old-hash' }, 'new-hash'), false);
});

test('shouldPrepareAutoPreview: auto entry with same hash returns false (cached)', () => {
  const entry = {
    file: 'a.png',
    source: 'auto',
    sourceHash: 'sha-abc',
    addedAt: '2026-09-13T00:00:00.000Z',
    width: 212,
    height: 520,
    bytes: 100,
  };
  assert.equal(shouldPrepareAutoPreview(entry, 'sha-abc'), false);
});

test('shouldPrepareAutoPreview: auto entry with different hash returns true (rebuild)', () => {
  const entry = {
    file: 'a.png',
    source: 'auto',
    sourceHash: 'sha-old',
    addedAt: '2026-09-13T00:00:00.000Z',
    width: 212,
    height: 520,
    bytes: 100,
  };
  assert.equal(shouldPrepareAutoPreview(entry, 'sha-new'), true);
});

test('shouldPrepareAutoPreview: legacy auto entry without hash returns true', () => {
  const entry = {
    file: 'a.png',
    source: 'auto',
    addedAt: '2026-09-13T00:00:00.000Z',
    width: 212,
    height: 520,
    bytes: 100,
  };
  assert.equal(shouldPrepareAutoPreview(entry, 'sha-new'), true);
});

test('store integration with shouldPrepareAutoPreview', () => {
  const { store } = freshStore();
  // 1. Initial state: not prepared
  assert.equal(shouldPrepareAutoPreview(store.getEntry('wf-1'), 'hash-v1'), true);

  // 2. Set auto with hash-v1
  store.set('wf-1', {
    bytes: DUMMY_PNG,
    source: 'auto',
    sourceHash: 'hash-v1',
    width: 212,
    height: 520,
  });
  assert.equal(shouldPrepareAutoPreview(store.getEntry('wf-1'), 'hash-v1'), false);
  assert.equal(shouldPrepareAutoPreview(store.getEntry('wf-1'), 'hash-v2'), true);

  // 3. User sets manual
  store.set('wf-1', {
    bytes: DUMMY_PNG,
    source: 'manual',
    width: 212,
    height: 520,
  });
  // Manual must never be replaced by auto
  assert.equal(shouldPrepareAutoPreview(store.getEntry('wf-1'), 'hash-v2'), false);
  assert.equal(shouldPrepareAutoPreview(store.getEntry('wf-1'), 'hash-v3'), false);
});

test('regression 1: already existing matching-hash auto cache calls decoder 0 times on startup', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-reg1-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '111111111' });
  fs.writeFileSync(path.join(seedDir, 'test.bin'), binContent);
  const expectedMd5 = createHash('md5').update(binContent).digest('hex');

  // 预先存入同哈希的 auto 缓存
  store.set('111111111', {
    bytes: DUMMY_PNG,
    source: 'auto',
    sourceHash: expectedMd5,
    width: 2,
    height: 1,
  });

  let decodeCalls = 0;
  const decoder = (bytes) => {
    decodeCalls++;
    return decodeWatchfacePreview(bytes);
  };

  const service = new WatchfacePreviewService(store, {
    decoder,
    pngEncoder: mockPngEncoder,
  });

  service.startBackgroundPreparation([seedDir]);
  await service.list();

  assert.equal(decodeCalls, 0, 'decodeWatchfacePreview 必须调用 0 次');
});

test('regression 2: already existing manual cache calls decoder 0 times on startup', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-reg2-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '222222222' });
  fs.writeFileSync(path.join(seedDir, 'test.bin'), binContent);

  // 预先存入 manual 缓存
  store.set('222222222', {
    bytes: DUMMY_PNG,
    source: 'manual',
    width: 100,
    height: 200,
  });

  let decodeCalls = 0;
  const decoder = (bytes) => {
    decodeCalls++;
    return decodeWatchfacePreview(bytes);
  };

  const service = new WatchfacePreviewService(store, {
    decoder,
    pngEncoder: mockPngEncoder,
  });

  service.startBackgroundPreparation([seedDir]);
  await service.list();

  assert.equal(decodeCalls, 0, 'decodeWatchfacePreview 必须调用 0 次');
  const entry = store.getEntry('222222222');
  assert.equal(entry.source, 'manual', 'manual 缓存必须保留');
});

test('regression 3: same .bin produces identical MD5 sourceHash via startup scan and prepareFromBin', async () => {
  const seedDir = path.join(tmpRoot, `seed-reg3-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '333333333' });
  const binPath = path.join(seedDir, 'test.bin');
  fs.writeFileSync(binPath, binContent);
  const expectedMd5 = createHash('md5').update(binContent).digest('hex');

  // 路径 A：启动准备扫描
  const { store: storeA } = freshStore();
  const serviceA = new WatchfacePreviewService(storeA, { pngEncoder: mockPngEncoder });
  serviceA.startBackgroundPreparation([seedDir]);
  await serviceA.list();
  const entryA = storeA.getEntry('333333333');
  assert.ok(entryA, 'storeA 必须包含条目');
  assert.equal(entryA.sourceHash, expectedMd5, '启动扫描必须产生 MD5 哈希');

  // 路径 B：prepareFromBin 无传入 hash（回退计算 MD5）
  const { store: storeB } = freshStore();
  const serviceB = new WatchfacePreviewService(storeB, { pngEncoder: mockPngEncoder });
  const resB = await serviceB.prepareFromBin('333333333', binPath);
  assert.equal(resB.status, 'written');
  const entryB = storeB.getEntry('333333333');
  assert.ok(entryB, 'storeB 必须包含条目');
  assert.equal(entryB.sourceHash, expectedMd5, 'prepareFromBin 回退必须产生 MD5 哈希');

  // 路径 C：prepareFromBin 显式传入 MD5（例如 WatchfaceService.install）
  const { store: storeC } = freshStore();
  const serviceC = new WatchfacePreviewService(storeC, { pngEncoder: mockPngEncoder });
  const resC = await serviceC.prepareFromBin('333333333', binPath, expectedMd5);
  assert.equal(resC.status, 'written');
  const entryC = storeC.getEntry('333333333');
  assert.ok(entryC, 'storeC 必须包含条目');
  assert.equal(entryC.sourceHash, expectedMd5, 'prepareFromBin 传入 MD5 必须一致');

  // 交叉验证：已由 prepareFromBin 生成后，启动扫描检测同 MD5 缓存，调用 decode 0 次
  let decodeCalls = 0;
  const serviceCached = new WatchfacePreviewService(storeB, {
    decoder: () => {
      decodeCalls++;
      return decodeWatchfacePreview(binContent);
    },
    pngEncoder: mockPngEncoder,
  });
  serviceCached.startBackgroundPreparation([seedDir]);
  await serviceCached.list();
  assert.equal(decodeCalls, 0, '启动扫描对已由 prepareFromBin 写入的同 hash 缓存调用 0 次解码');
});

test('regression 4: modifying .bin file content triggers re-decode exactly 1 time', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-reg4-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binPath = path.join(seedDir, 'test.bin');
  const initialBin = buildTestBin({
    id: '444444444',
    payload: Buffer.from([0, 0, 0xff, 0xff, 0, 0xff, 0, 0xff]),
  });
  fs.writeFileSync(binPath, initialBin);
  const initialMd5 = createHash('md5').update(initialBin).digest('hex');

  let decodeCalls = 0;
  const decoder = (bytes) => {
    decodeCalls++;
    return decodeWatchfacePreview(bytes);
  };

  // 初始扫描
  const service1 = new WatchfacePreviewService(store, { decoder, pngEncoder: mockPngEncoder });
  service1.startBackgroundPreparation([seedDir]);
  await service1.list();
  assert.equal(decodeCalls, 1, '初始运行调用解码 1 次');
  assert.equal(store.getEntry('444444444').sourceHash, initialMd5);

  // 修改文件内容（颜色变化导致 MD5 改变）
  const modifiedBin = buildTestBin({
    id: '444444444',
    payload: Buffer.from([0xff, 0, 0, 0xff, 0xff, 0xff, 0, 0xff]),
  });
  fs.writeFileSync(binPath, modifiedBin);
  const modifiedMd5 = createHash('md5').update(modifiedBin).digest('hex');
  assert.notEqual(initialMd5, modifiedMd5);

  // 再次运行准备服务
  const service2 = new WatchfacePreviewService(store, { decoder, pngEncoder: mockPngEncoder });
  service2.startBackgroundPreparation([seedDir]);
  await service2.list();

  assert.equal(decodeCalls, 2, '文件内容修改后必须触发重新解码 1 次（总计 2 次）');
  assert.equal(store.getEntry('444444444').sourceHash, modifiedMd5, 'sourceHash 必须更新为新 MD5');
});

test('regression 5: missing cache successfully generates PNG file and store entry', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-reg5-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '555555555', width: 2, height: 1 });
  fs.writeFileSync(path.join(seedDir, 'test.bin'), binContent);
  const expectedMd5 = createHash('md5').update(binContent).digest('hex');

  let decodeCalls = 0;
  const decoder = (bytes) => {
    decodeCalls++;
    return decodeWatchfacePreview(bytes);
  };

  const service = new WatchfacePreviewService(store, {
    decoder,
    pngEncoder: mockPngEncoder,
  });

  service.startBackgroundPreparation([seedDir]);
  const listRes = await service.list();
  assert.ok(listRes.ok);
  assert.equal(decodeCalls, 1, '缺失缓存时必须调用解码 1 次');

  const entry = store.getEntry('555555555');
  assert.ok(entry, 'Store 中必须已写入条目');
  assert.equal(entry.source, 'auto');
  assert.equal(entry.sourceHash, expectedMd5);
  assert.equal(entry.width, 2);
  assert.equal(entry.height, 1);

  const pngPath = store.resolve('555555555');
  assert.ok(pngPath, 'PNG 文件路径必须能解析');
  assert.ok(fs.existsSync(pngPath), 'PNG 文件必须存在于磁盘');

  const pngBytes = fs.readFileSync(pngPath);
  assert.ok(pngBytes.length > 0, 'PNG 文件不得为空');
  assert.ok(
    pngBytes.subarray(0, 8).equals(PNG_MAGIC),
    '生成的文件必须以 PNG 魔数开头',
  );
});

test('seed scanning: case-insensitive .bin extension matching (.BIN)', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-case-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '666666666' });
  fs.writeFileSync(path.join(seedDir, 'test_upper.BIN'), binContent);

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  service.startBackgroundPreparation([seedDir]);
  await service.list();

  const entry = store.getEntry('666666666');
  assert.ok(entry, '大写 .BIN 后缀的文件也必须被识别并处理');
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
