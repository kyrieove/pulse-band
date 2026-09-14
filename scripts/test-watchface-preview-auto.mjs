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
  normalizeWatchfaceName,
  isAllZerosId,
} from '../src/main/services/watchface-preview-service.ts';
import { WatchfaceService } from '../src/main/services/watchface-service.ts';
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

test('normalizeWatchfaceName: strict trim and NFC only', () => {
  assert.equal(normalizeWatchfaceName('  Hello  '), 'Hello');
  assert.equal(normalizeWatchfaceName('Cafe\u0301'), 'Caf\u00e9');
  assert.equal(normalizeWatchfaceName('  Caf\u00e9  '), 'Caf\u00e9');
  assert.equal(normalizeWatchfaceName('ABC'), 'ABC'); // 不改变大小写
  assert.equal(normalizeWatchfaceName(null), '');
  assert.equal(normalizeWatchfaceName(undefined), '');
  assert.equal(normalizeWatchfaceName(123), '');
});

test('reconciliation test 1: exact ID already hit -> no copy, no decode', async () => {
  const { store } = freshStore();
  store.set('976603977', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '丝柯克',
    width: 2,
    height: 1,
  });

  let decodeCalls = 0;
  const service = new WatchfacePreviewService(store, {
    decoder: (bytes) => {
      decodeCalls++;
      return decodeWatchfacePreview(bytes);
    },
    pngEncoder: mockPngEncoder,
  });

  const res = await service.reconcileInstalledWatchfaces([
    { id: '976603977', name: '丝柯克' },
  ]);

  assert.equal(decodeCalls, 0, 'decoder 调用次数必须为 0');
  assert.equal(res.reconciled.length, 0, '完全相同的 ID 不需要对齐拷贝');
  assert.ok(res.skipped.includes('976603977'));
  assert.equal(Object.keys(store.list()).length, 1);
});

test('reconciliation test 2: unique strict name match with different ID -> copies to real device ID', async () => {
  const { store } = freshStore();
  store.set('120917361', {
    bytes: DUMMY_PNG,
    source: 'auto',
    sourceHash: 'hash-wf-design',
    name: '简约1+',
    width: 2,
    height: 1,
  });

  let decodeCalls = 0;
  const service = new WatchfacePreviewService(store, {
    decoder: (bytes) => {
      decodeCalls++;
      return decodeWatchfacePreview(bytes);
    },
    pngEncoder: mockPngEncoder,
  });

  const res = await service.reconcileInstalledWatchfaces([
    { id: 'pulswf2', name: '简约1+' },
  ]);

  assert.equal(decodeCalls, 0, '对齐时 decoder 调用次数必须为 0');
  assert.ok(res.reconciled.includes('pulswf2'));

  const entry = store.getEntry('pulswf2');
  assert.ok(entry, '必须在 store 中为 pulswf2 建立条目');
  assert.equal(entry.source, 'auto');
  assert.equal(entry.name, '简约1+');
  assert.equal(entry.sourceHash, 'hash-wf-design');
  assert.equal(entry.width, 2);
  assert.equal(entry.height, 1);

  const pngPath = store.resolve('pulswf2');
  assert.ok(pngPath && fs.existsSync(pngPath));
  assert.deepEqual(fs.readFileSync(pngPath), DUMMY_PNG);
  // 原有 120917361 保持完好
  assert.ok(store.getEntry('120917361'));
});

test('reconciliation test 3: manual target exists -> not overwritten', async () => {
  const { store } = freshStore();
  const MANUAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x99, 0x88, 0x77]);
  store.set('120917361', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '简约1+',
    width: 2,
    height: 1,
  });
  store.set('pulswf2', {
    bytes: MANUAL_PNG,
    source: 'manual',
    name: '用户自选',
    width: 10,
    height: 20,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res = await service.reconcileInstalledWatchfaces([
    { id: 'pulswf2', name: '简约1+' },
  ]);

  assert.ok(res.skipped.includes('pulswf2'), '已有 manual 必须跳过');
  const entry = store.getEntry('pulswf2');
  assert.equal(entry.source, 'manual', 'manual 属性不能被 auto 覆盖');
  assert.deepEqual(fs.readFileSync(store.resolve('pulswf2')), MANUAL_PNG, '用户手动设置的图片内容必须保留');
});

test('reconciliation test 4: multiple local candidates with same name -> skipped', async () => {
  const { store } = freshStore();
  store.set('cand-1', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '重名表盘',
    width: 2,
    height: 1,
  });
  store.set('cand-2', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '重名表盘',
    width: 4,
    height: 2,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res = await service.reconcileInstalledWatchfaces([
    { id: 'dev-target', name: '重名表盘' },
  ]);

  assert.ok(res.skipped.includes('dev-target'));
  assert.equal(store.getEntry('dev-target'), null, '本地有歧义时不得猜测关联');
});

test('reconciliation test 5: multiple device targets with same name -> skipped', async () => {
  const { store } = freshStore();
  store.set('cand-1', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '多目标表盘',
    width: 2,
    height: 1,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res = await service.reconcileInstalledWatchfaces([
    { id: 'dev-1', name: '多目标表盘' },
    { id: 'dev-2', name: '多目标表盘' },
  ]);

  assert.ok(res.skipped.includes('dev-1'));
  assert.ok(res.skipped.includes('dev-2'));
  assert.equal(store.getEntry('dev-1'), null);
  assert.equal(store.getEntry('dev-2'), null);
});

test('reconciliation test 6: trim / NFC differences -> match allowed', async () => {
  const { store } = freshStore();
  // NFD 分解格式 'e' + combining acute accent
  const decomposed = 'Cafe\u0301';
  // NFC 组合格式
  const composed = 'Caf\u00e9';

  store.set('cand-accent', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: `  ${decomposed}  `,
    width: 2,
    height: 1,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res = await service.reconcileInstalledWatchfaces([
    { id: 'dev-cafe', name: `\t${composed}\n` },
  ]);

  assert.ok(res.reconciled.includes('dev-cafe'), 'trim 与 NFC 归一化后必须能够匹配');
  assert.ok(store.getEntry('dev-cafe'));
});

test('reconciliation test 7: fuzzy/substring match -> rejected', async () => {
  const { store } = freshStore();
  store.set('cand-1', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '简约1',
    width: 2,
    height: 1,
  });
  store.set('cand-2', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: 'CyberPulse',
    width: 2,
    height: 1,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res = await service.reconcileInstalledWatchfaces([
    { id: 'dev-1', name: '简约1+' },
    { id: 'dev-2', name: 'cyberpulse' }, // 大小写不同，禁止模糊匹配
  ]);

  assert.ok(res.skipped.includes('dev-1'));
  assert.ok(res.skipped.includes('dev-2'));
  assert.equal(store.getEntry('dev-1'), null, '子串匹配必须拒绝');
  assert.equal(store.getEntry('dev-2'), null, '大小写模糊匹配必须拒绝');
});

test('reconciliation test 8: all-zero embedded ID startup scan and real target reconciliation', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-zero-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '000000000', name: 'BetaUI-黑塔' });
  fs.writeFileSync(path.join(seedDir, 'BetaUI-黑塔.bin'), binContent);

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  service.startBackgroundPreparation([seedDir]);

  // 1. 扫描全零 ID 的 bin 后，preview.list 中不存在 000000000，且 store 中不产生 000000000
  const initialList = await service.list();
  assert.ok(initialList.ok);
  assert.equal(initialList.data.previews['000000000'], undefined, '全零 ID 不得出现在公开 preview.list 中');
  assert.equal(store.getEntry('000000000'), null, '全零 ID 不得作为条目写入 store');

  // 2. 没有唯一真实目标时不生成任何目标 ID
  const unrelatedRes = await service.reconcileInstalledWatchfaces([
    { id: 'random-dev-id', name: '无关表盘' },
  ]);
  assert.ok(unrelatedRes.skipped.includes('random-dev-id'));
  assert.equal(store.getEntry('random-dev-id'), null, '无关设备目标不生成预览');
  assert.equal(store.getEntry('000000000000'), null, '未匹配时不生成真实设备目标');

  // 3. 唯一匹配 BetaUI 后，只出现 000000000000，不出现 000000000
  const matchRes = await service.reconcileInstalledWatchfaces([
    { id: '000000000000', name: 'BetaUI-黑塔' },
  ]);
  assert.ok(matchRes.reconciled.includes('000000000000'));
  assert.ok(store.getEntry('000000000000'), '匹配成功后必须写入 000000000000');
  assert.equal(store.getEntry('000000000'), null, '全零 ID 000000000 仍不得存在于 store');

  const afterList = await service.list();
  assert.ok(afterList.data.previews['000000000000'], '公开映射中必须出现 000000000000');
  assert.equal(afterList.data.previews['000000000'], undefined, '公开映射中不得出现 000000000');
});

test('reconciliation test 8a: all-zero embedded ID second run -> no duplicate decode or rewrite', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-zero-cache-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '000000000', name: 'BetaUI-黑塔' });
  fs.writeFileSync(path.join(seedDir, 'BetaUI-黑塔.bin'), binContent);

  // 第一次启动并完成对齐
  const service1 = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  service1.startBackgroundPreparation([seedDir]);
  await service1.reconcileInstalledWatchfaces([
    { id: '000000000000', name: 'BetaUI-黑塔' },
  ]);
  assert.ok(store.getEntry('000000000000'));

  // 模拟应用重启：第二次启动同一个 seedDir 和 store
  let decodeCalls = 0;
  const countingDecoder = (bytes) => {
    decodeCalls++;
    return decodeWatchfacePreview(bytes);
  };

  const service2 = new WatchfacePreviewService(store, {
    decoder: countingDecoder,
    pngEncoder: mockPngEncoder,
  });

  service2.startBackgroundPreparation([seedDir]);
  const listRes = await service2.list();
  assert.ok(listRes.ok);
  assert.equal(decodeCalls, 0, '第二次启动扫描已有缓存不得重新解码');

  let setCalls = 0;
  const originalSet = store.set.bind(store);
  store.set = (...args) => {
    setCalls++;
    return originalSet(...args);
  };

  const matchRes2 = await service2.reconcileInstalledWatchfaces([
    { id: '000000000000', name: 'BetaUI-黑塔' },
  ]);
  assert.equal(decodeCalls, 0, '第二次对齐不得调用解码');
  assert.equal(setCalls, 0, '第二次对齐不得重写 store');
  assert.ok(matchRes2.skipped.includes('000000000000'), '已存在的目标 ID 必须跳过重写');
});

test('reconciliation test 8b: all-zero embedded ID bilateral ambiguity and manual target skipped', async () => {
  // A. 设备端同名歧义：手环上有两款叫 BetaUI-黑塔
  {
    const { store } = freshStore();
    const seedDir = path.join(tmpRoot, `seed-zero-amb1-${caseIndex++}`);
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'test.bin'), buildTestBin({ id: '000000000', name: 'BetaUI-黑塔' }));

    const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
    service.startBackgroundPreparation([seedDir]);
    await service.list();

    const res = await service.reconcileInstalledWatchfaces([
      { id: 'dev-1', name: 'BetaUI-黑塔' },
      { id: 'dev-2', name: 'BetaUI-黑塔' },
    ]);
    assert.ok(res.skipped.includes('dev-1'));
    assert.ok(res.skipped.includes('dev-2'));
    assert.equal(store.getEntry('dev-1'), null, '设备端同名歧义不得写入');
    assert.equal(store.getEntry('dev-2'), null, '设备端同名歧义不得写入');
  }

  // B. 本地候选同名歧义：本地有两个全零 bin 都叫 BetaUI-黑塔
  {
    const { store } = freshStore();
    const seedDir = path.join(tmpRoot, `seed-zero-amb2-${caseIndex++}`);
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'bin1.bin'), buildTestBin({ id: '000000000', name: 'BetaUI-黑塔', width: 2, height: 1, payload: Buffer.alloc(8) }));
    fs.writeFileSync(path.join(seedDir, 'bin2.bin'), buildTestBin({ id: '000000000', name: 'BetaUI-黑塔', width: 4, height: 1, payload: Buffer.alloc(16) }));

    const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
    service.startBackgroundPreparation([seedDir]);
    await service.list();

    const res = await service.reconcileInstalledWatchfaces([
      { id: '000000000000', name: 'BetaUI-黑塔' },
    ]);
    assert.ok(res.skipped.includes('000000000000'), '本地候选同名歧义必须跳过');
    assert.equal(store.getEntry('000000000000'), null, '本地歧义不得写入');
  }

  // C. manual 目标不得覆盖
  {
    const { store } = freshStore();
    store.set('000000000000', {
      bytes: DUMMY_PNG,
      source: 'manual',
      name: '用户自选',
      width: 2,
      height: 1,
    });

    const seedDir = path.join(tmpRoot, `seed-zero-manual-${caseIndex++}`);
    fs.mkdirSync(seedDir, { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'test.bin'), buildTestBin({ id: '000000000', name: 'BetaUI-黑塔' }));

    const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
    service.startBackgroundPreparation([seedDir]);
    await service.list();

    const res = await service.reconcileInstalledWatchfaces([
      { id: '000000000000', name: 'BetaUI-黑塔' },
    ]);
    assert.ok(res.skipped.includes('000000000000'), '已存在 manual 目标必须跳过');
    assert.equal(store.getEntry('000000000000')?.source, 'manual', 'manual 目标必须保持未修改');
  }
});

test('reconciliation test 9: second reconciliation call -> cache hit, no rewrite', async () => {
  const { store } = freshStore();
  store.set('120917361', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '简约1+',
    width: 2,
    height: 1,
  });

  const service = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  const res1 = await service.reconcileInstalledWatchfaces([
    { id: 'pulswf2', name: '简约1+' },
  ]);
  assert.ok(res1.reconciled.includes('pulswf2'));

  let copyCalls = 0;
  const originalCopy = store.copyEntry.bind(store);
  store.copyEntry = (...args) => {
    copyCalls++;
    return originalCopy(...args);
  };

  const res2 = await service.reconcileInstalledWatchfaces([
    { id: 'pulswf2', name: '简约1+' },
  ]);
  assert.equal(copyCalls, 0, '第二次调用必须命中缓存，不执行重写');
  assert.ok(res2.skipped.includes('pulswf2'));
});

test('reconciliation test 10: loading order -> previews visible on initial page load', async () => {
  const { store } = freshStore();
  const seedDir = path.join(tmpRoot, `seed-reg10-${caseIndex++}`);
  fs.mkdirSync(seedDir, { recursive: true });

  const binContent = buildTestBin({ id: '120917361', name: '简约1+' });
  fs.writeFileSync(path.join(seedDir, 'wf_design.bin'), binContent);

  const previewService = new WatchfacePreviewService(store, { pngEncoder: mockPngEncoder });
  previewService.startBackgroundPreparation([seedDir]);

  const mockCoreClient = {
    call: async (method) => {
      assert.equal(method, 'device.watchface.list');
      return {
        watchfaces: [{ id: 'pulswf2', name: '简约1+', is_current: false }],
      };
    },
  };

  const watchfaceService = new WatchfaceService(mockCoreClient, previewService);

  // 模拟并发/首屏加载：watchfaceService.list 与 previewService.list
  const [wfRes, previewRes] = await Promise.all([
    watchfaceService.list(),
    (async () => {
      return await previewService.list();
    })(),
  ]);

  assert.equal(wfRes.ok, true);
  assert.equal(previewRes.ok, true);

  // 再次读取（模拟 useWatchFace 在 watchface.list 成功后调用 loadPreviews）
  const finalPreviews = await previewService.list();
  assert.ok(finalPreviews.data.previews['pulswf2'], '首屏加载后必须可查到 pulswf2 预览图');
  assert.equal(finalPreviews.data.previews['pulswf2'].source, 'auto');
});

test('reconciliation test 11: decoder calls remain 0 during reconciliation', async () => {
  const { store } = freshStore();
  store.set('cand-1', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '表盘1',
    width: 2,
    height: 1,
  });
  store.set('cand-2', {
    bytes: DUMMY_PNG,
    source: 'auto',
    name: '表盘2',
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

  const res = await service.reconcileInstalledWatchfaces([
    { id: 'target-1', name: '表盘1' },
    { id: 'target-2', name: '表盘2' },
    { id: 'target-3', name: '不存在的表盘' },
  ]);

  assert.equal(decodeCalls, 0, '对齐全流程 decoder 调用次数必须严格保持为 0');
  assert.equal(res.reconciled.length, 2);
  assert.ok(store.getEntry('target-1'));
  assert.ok(store.getEntry('target-2'));
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
