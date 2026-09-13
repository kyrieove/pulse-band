import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WatchfaceService } from '../src/main/services/watchface-service.ts';

const tmpDir = path.join(os.tmpdir(), `pulse-wf-install-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const testBin = path.join(tmpDir, 'test.bin');
fs.writeFileSync(testBin, Buffer.from('hello watchface'));

test('install: calls prepareFromBin on install success', async () => {
  let calledWith = null;
  const mockClient = {
    call: async (method, params) => {
      assert.equal(method, 'device.watchface.install');
      return { watchface_id: 'dev-12345', result_code: 2, result_code_meaning: 'INSTALL_SUCCESS' };
    },
  };
  const mockPreparer = {
    prepareFromBin: async (id, filePath, hash) => {
      calledWith = { id, filePath, hash };
    },
  };
  const service = new WatchfaceService(mockClient, mockPreparer);
  const res = await service.install(testBin);
  assert.equal(res.ok, true);
  assert.equal(res.data.watchface_id, 'dev-12345');
  assert.deepEqual(calledWith, {
    id: 'dev-12345',
    filePath: testBin,
    hash: 'ca7fa31d172307494e493fd9e3438af1',
  });
});

test('install: preview error does not fail install', async () => {
  const mockClient = {
    call: async () => ({ watchface_id: 'dev-12345', result_code: 2, result_code_meaning: 'INSTALL_SUCCESS' }),
  };
  const mockPreparer = {
    prepareFromBin: async () => {
      throw new Error('Disk full or decode error');
    },
  };
  const service = new WatchfaceService(mockClient, mockPreparer);
  const res = await service.install(testBin);
  assert.equal(res.ok, true);
  assert.equal(res.data.watchface_id, 'dev-12345');
});

test('install: core install failure never calls prepareFromBin', async () => {
  let called = false;
  const mockClient = {
    call: async () => {
      throw new Error('BLE disconnect');
    },
  };
  const mockPreparer = {
    prepareFromBin: async () => {
      called = true;
    },
  };
  const service = new WatchfaceService(mockClient, mockPreparer);
  const res = await service.install(testBin);
  assert.equal(res.ok, false);
  assert.equal(called, false);
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
