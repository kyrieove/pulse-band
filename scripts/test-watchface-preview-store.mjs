/**
 * WatchfacePreviewStore 单元测试（层 2：本地预览图缓存）
 * 运行方式：node --test scripts/test-watchface-preview-store.mjs
 *
 * 覆盖边界：只覆盖纯 node 的存储层（目录/索引/替换/清除/路径安全）。
 * 不覆盖：nativeImage 解码与缩放、IPC 通道、React 渲染 —— 这些需要 Electron 运行时，
 * 见 watchface-preview-service.ts 的说明。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  WatchfacePreviewStore,
  isValidWatchfacePreviewId,
  WATCHFACE_PREVIEW_DIR_NAME,
} from '../src/main/services/watchface-preview-store.ts';

const tmpRoot = path.join(os.tmpdir(), `pulse-wf-preview-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

/** 每个用例一个干净目录，避免互相污染 */
let caseIndex = 0;
function freshStore() {
  const dir = path.join(tmpRoot, `case-${caseIndex++}`, WATCHFACE_PREVIEW_DIR_NAME);
  return { store: new WatchfacePreviewStore(dir), dir };
}

const PNG_A = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
const PNG_B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd, 0xfc]);

test('空目录：list 为空、resolve 为 null，且不抛异常', () => {
  const { store, dir } = freshStore();
  assert.deepEqual(store.list(), {});
  assert.equal(store.getEntry('976603977'), null);
  assert.equal(store.resolve('976603977'), null);
  assert.equal(fs.existsSync(dir), false, '只读不应该创建目录');
});

test('set：写入文件 + 索引，list/resolve/getEntry 都能拿到', () => {
  const { store, dir } = freshStore();
  const entry = store.set('976603977', { bytes: PNG_A, source: 'manual', width: 192, height: 490 });

  assert.equal(entry.source, 'manual');
  assert.equal(entry.width, 192);
  assert.equal(entry.height, 490);
  assert.equal(entry.bytes, PNG_A.length);
  assert.ok(Number.isFinite(Date.parse(entry.addedAt)), 'addedAt 必须是可解析的 ISO 时间');

  const filePath = store.resolve('976603977');
  assert.ok(filePath, 'resolve 必须给出路径');
  assert.equal(path.dirname(filePath), dir, '文件必须落在 store 目录内');
  assert.deepEqual(fs.readFileSync(filePath), PNG_A);

  assert.deepEqual(Object.keys(store.list()), ['976603977']);
  assert.equal(store.getEntry('976603977')?.file, entry.file);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')), '索引文件必须落盘');
  assert.equal(fs.existsSync(path.join(dir, 'index.json.tmp')), false, '原子写不应残留 .tmp');
});

test('set 同一个 id 即替换：文件不新增、内容被覆盖', () => {
  const { store, dir } = freshStore();
  const first = store.set('976603977', { bytes: PNG_A, source: 'manual', width: 192, height: 490 });
  const second = store.set('976603977', { bytes: PNG_B, source: 'manual', width: 96, height: 245 });

  assert.equal(second.file, first.file, '同一 id 必须复用同一个文件名');
  assert.equal(second.width, 96);
  assert.deepEqual(fs.readFileSync(store.resolve('976603977')), PNG_B);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  assert.equal(files.length, 1, '替换不应产生第二个图片文件');
  assert.equal(Object.keys(store.list()).length, 1);
});

test('不同 id 各自一个文件，互不影响', () => {
  const { store, dir } = freshStore();
  store.set('976603977', { bytes: PNG_A, source: 'manual', width: 192, height: 490 });
  store.set('120917361', { bytes: PNG_B, source: 'auto', width: 192, height: 490 });

  assert.equal(Object.keys(store.list()).length, 2);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.png')).length, 2);
  assert.equal(store.getEntry('120917361')?.source, 'auto');
  assert.deepEqual(fs.readFileSync(store.resolve('976603977')), PNG_A);
  assert.deepEqual(fs.readFileSync(store.resolve('120917361')), PNG_B);
});

test('clear：索引与文件同时移除；对不存在的 id 返回 false 且不抛', () => {
  const { store } = freshStore();
  store.set('976603977', { bytes: PNG_A, source: 'manual', width: 192, height: 490 });
  const filePath = store.resolve('976603977');

  assert.equal(store.clear('976603977'), true);
  assert.equal(store.resolve('976603977'), null);
  assert.equal(fs.existsSync(filePath), false, 'clear 必须删掉图片文件');
  assert.deepEqual(store.list(), {});
  assert.equal(store.clear('976603977'), false, '重复 clear 返回 false（幂等由上层保证）');
  assert.equal(store.clear('不存在的id'), false);
});

test('路径安全：含 ../ 或分隔符的 id 不会写到 store 目录外', () => {
  const { store, dir } = freshStore();
  const evil = '../../evil';
  store.set(evil, { bytes: PNG_A, source: 'manual', width: 192, height: 490 });

  const filePath = store.resolve(evil);
  assert.ok(filePath);
  assert.equal(path.dirname(filePath), dir, '文件名必须由 id 派生，不能直接拼 id');
  assert.equal(fs.existsSync(path.join(tmpRoot, 'evil.png')), false, '目录外不得出现任何文件');
  assert.equal(path.basename(filePath).includes('..'), false);
  assert.equal(path.basename(filePath).includes('/'), false);
});

test('索引损坏 / 形状不对：退化为空索引，不抛异常', () => {
  const { store, dir } = freshStore();
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'index.json'), '{ 这不是 JSON');
  assert.deepEqual(store.list(), {});

  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1 }));
  assert.deepEqual(store.list(), {});

  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, entries: 'nope' }));
  assert.deepEqual(store.list(), {});
});

test('索引里带路径分隔符或非法 source 的条目被丢弃（不信任磁盘内容）', () => {
  const { store, dir } = freshStore();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'outside.png'), PNG_A);
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      entries: {
        evil: { file: '../outside.png', source: 'manual', addedAt: 'x', width: 1, height: 1, bytes: 1 },
        badSource: { file: 'a.png', source: 'wat', addedAt: 'x', width: 1, height: 1, bytes: 1 },
        missing: { file: 'gone.png', source: 'manual', addedAt: 'x', width: 1, height: 1, bytes: 1 },
      },
    }),
  );
  assert.deepEqual(store.list(), {}, '非法条目 + 文件不存在的条目都不能出现');
  assert.equal(store.resolve('evil'), null);
});

test('图片文件被外部删掉后，list 与 resolve 都视作没有', () => {
  const { store } = freshStore();
  store.set('976603977', { bytes: PNG_A, source: 'manual', width: 192, height: 490 });
  fs.rmSync(store.resolve('976603977'));

  assert.deepEqual(store.list(), {});
  assert.equal(store.resolve('976603977'), null);
  assert.equal(store.getEntry('976603977'), null);
});

test('set 拒绝空内容与非法 id', () => {
  const { store } = freshStore();
  assert.throws(() => store.set('', { bytes: PNG_A, source: 'manual', width: 1, height: 1 }));
  assert.throws(() => store.set('x', { bytes: Buffer.alloc(0), source: 'manual', width: 1, height: 1 }));
});

test('isValidWatchfacePreviewId: 长度与空值边界', () => {
  assert.equal(isValidWatchfacePreviewId('976603977'), true);
  assert.equal(isValidWatchfacePreviewId('a'.repeat(128)), true);
  assert.equal(isValidWatchfacePreviewId('a'.repeat(129)), false);
  assert.equal(isValidWatchfacePreviewId(''), false);
  assert.equal(isValidWatchfacePreviewId('   '), false);
  assert.equal(isValidWatchfacePreviewId(undefined), false);
  assert.equal(isValidWatchfacePreviewId(null), false);
  assert.equal(isValidWatchfacePreviewId(123), false);
  assert.equal(isValidWatchfacePreviewId('a\0b'), false);
});

test('sourceHash: set 保存并读回 sourceHash，旧版无 hash 索引仍可读取，非法 hash 被安全丢弃', () => {
  const { store, dir } = freshStore();
  const auto = store.set('face-a', {
    bytes: PNG_A,
    source: 'auto',
    sourceHash: 'abc123',
    width: 212,
    height: 520,
  });
  assert.equal(auto.sourceHash, 'abc123');
  assert.equal(store.readIndex().entries['face-a'].sourceHash, 'abc123');

  // 旧版无 sourceHash 的条目仍可读取
  fs.writeFileSync(path.join(dir, 'legacy.png'), PNG_A);
  const index = store.readIndex();
  index.entries['legacy'] = {
    file: 'legacy.png',
    source: 'auto',
    addedAt: new Date().toISOString(),
    width: 212,
    height: 520,
    bytes: PNG_A.length,
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));

  const loadedLegacy = store.getEntry('legacy');
  assert.ok(loadedLegacy);
  assert.equal(loadedLegacy.sourceHash, undefined);

  // 非法或非字符串 hash 被丢弃，但条目本身依然有效
  index.entries['bad-hash'] = {
    file: 'legacy.png',
    source: 'auto',
    sourceHash: 12345, // invalid type
    addedAt: new Date().toISOString(),
    width: 212,
    height: 520,
    bytes: PNG_A.length,
  };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  const loadedBadHash = store.getEntry('bad-hash');
  assert.ok(loadedBadHash);
  assert.equal(loadedBadHash.sourceHash, undefined);
});

test('copyEntry: safely copies existing preview to new ID with overrides', () => {
  const { store, dir } = freshStore();
  store.set('source-1', {
    bytes: PNG_A,
    source: 'auto',
    sourceHash: 'hash-abc',
    name: 'OriginalName',
    width: 212,
    height: 520,
  });

  const copied = store.copyEntry('source-1', 'target-1', { name: 'DeviceName' });
  assert.equal(copied.source, 'auto');
  assert.equal(copied.sourceHash, 'hash-abc');
  assert.equal(copied.name, 'DeviceName');
  assert.equal(copied.width, 212);
  assert.equal(copied.height, 520);
  assert.equal(copied.bytes, PNG_A.length);

  const targetPath = store.resolve('target-1');
  assert.ok(targetPath);
  assert.ok(fs.existsSync(targetPath));
  assert.deepEqual(fs.readFileSync(targetPath), PNG_A);

  // 校验不存在的源 ID 会抛出异常
  assert.throws(() => store.copyEntry('non-existent', 'target-2'), /源表盘预览不存在/);
  // 非法 ID 会抛出异常
  assert.throws(() => store.copyEntry('', 'target-2'), /非法表盘 id/);
});

test('updateName: updates name in index without touching image file', () => {
  const { store } = freshStore();
  store.set('wf-1', {
    bytes: PNG_A,
    source: 'auto',
    sourceHash: 'hash-abc',
    width: 212,
    height: 520,
  });
  assert.equal(store.getEntry('wf-1')?.name, undefined);

  const updated = store.updateName('wf-1', '新名称');
  assert.equal(updated, true);
  assert.equal(store.getEntry('wf-1')?.name, '新名称');

  // 对不存在的 id 返回 false
  assert.equal(store.updateName('non-existent', '新名称'), false);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
