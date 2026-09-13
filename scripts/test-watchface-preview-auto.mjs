import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  shouldPrepareAutoPreview,
} from '../src/main/services/watchface-preview-decoder.ts';
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

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
