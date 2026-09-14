import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import child_process from 'node:child_process';
import {
  AppInstallService,
  registerAppInstallIpc,
} from '../src/main/services/app-install-service.ts';

const RPK_PATH = path.resolve('assets/band-app.rpk');
// 包体大小不硬编码：assets/band-app.rpk 刷新后跟着变
const RPK_SIZE = fs.statSync(RPK_PATH).size;

function setupLifecycleIpc() {
  const ipcHandlers = new Map();
  const mockIpc = {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
  };
  const service = new AppInstallService();
  registerAppInstallIpc(service, mockIpc);
  return { service, ipcHandlers };
}

test('1. 正常 prepare 建立生命周期会话', async () => {
  const { service } = setupLifecycleIpc();
  const res = await service.prepareFromFile(RPK_PATH);

  assert.strictEqual(res.status, 'preparing');
  assert.strictEqual(res.fileSize, RPK_SIZE);
  assert.strictEqual(res.chunkSize, 512);

  const session = service.getSession();
  assert.ok(session);
  assert.strictEqual(session.status, 'preparing');
  assert.strictEqual(session.cancelRequested, false);
});

test('2. cancel 中断 chunk 传输', async () => {
  const { service, ipcHandlers } = setupLifecycleIpc();
  const res = await service.prepareFromFile(RPK_PATH);
  const cancelHandler = ipcHandlers.get('pulse:app-install:cancel-transfer');

  // 触发取消逻辑
  const cancelRes = await cancelHandler({}, { installId: res.installId });
  assert.strictEqual(cancelRes.status, 'cancelled');

  // 取消后再发起传输必须立即被拒绝中断
  await assert.rejects(
    async () => {
      await service.sendFileChunks(res.installId);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /未找到当前活动的安装会话|cancelled/);
      return true;
    }
  );
});

test('3. cancel 后不能继续发送', async () => {
  const { service } = setupLifecycleIpc();
  const res = await service.prepareFromFile(RPK_PATH);

  service.cancelFileTransfer(res.installId);

  // handleChunk 必须拒绝
  assert.throws(
    () => {
      service.handleChunk({
        installId: res.installId,
        chunkIndex: 0,
        chunkData: Buffer.alloc(512).toString('base64'),
      });
    },
    /无效的 installId 或会话已过期/
  );

  // sendFileChunks 必须拒绝
  await assert.rejects(
    async () => {
      await service.sendFileChunks(res.installId);
    },
    /未找到当前活动的安装会话/
  );
});

test('4. readChunk 异常进入 failed 并派发脱敏结构化错误', async () => {
  const tempDir = os.tmpdir();
  const tempRpk = path.join(tempDir, `test_lifecycle_fail_${Date.now()}.rpk`);
  fs.copyFileSync(RPK_PATH, tempRpk);

  const service = new AppInstallService();
  const progressEvents = [];
  service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  try {
    await service.prepareFromFile(tempRpk);
    // 模拟文件突发被删除或无法读取
    fs.unlinkSync(tempRpk);

    await assert.rejects(
      async () => {
        await service.sendFileChunks();
      },
      /安装包文件不存在/
    );

    const failedEvents = progressEvents.filter((ev) => ev.status === 'failed');
    assert.strictEqual(failedEvents.length, 1);

    const failedEv = failedEvents[0];
    assert.strictEqual(failedEv.status, 'failed');
    assert.ok(failedEv.error);
    assert.strictEqual(typeof failedEv.error, 'object');
    assert.strictEqual(failedEv.error.code, 'FILE_NOT_FOUND');
    assert.strictEqual(typeof failedEv.error.userMessage, 'string');

    // 严格检查：禁止泄露真实路径或系统底层错误
    assert.strictEqual(failedEv.error.userMessage.includes(tempRpk), false);
    assert.strictEqual(failedEv.error.userMessage.includes('ENOENT'), false);
    assert.strictEqual(failedEv.error.userMessage.includes('stack'), false);
  } finally {
    if (fs.existsSync(tempRpk)) {
      fs.unlinkSync(tempRpk);
    }
  }
});

test('5. session 释放逻辑与内存清理', async () => {
  const service = new AppInstallService();
  await service.prepareFromFile(RPK_PATH);

  assert.ok(service.getSession() !== null);

  service.cleanup();
  assert.strictEqual(service.getSession(), null);
});

test('6. UI listener cleanup 避免内存泄漏', () => {
  const service = new AppInstallService();
  let callCount = 0;

  const unsubscribe = service.onProgress(() => {
    callCount++;
  });

  // 测试注销机制
  assert.strictEqual(typeof unsubscribe, 'function');
  unsubscribe();

  // 注销后调用 cleanup 或产生事件不应再触发计数
  service.cleanup();
  assert.strictEqual(callCount, 0);
});

test('7. 全流程绝不会进入 completed', async () => {
  const service = new AppInstallService();
  const progressEvents = [];
  service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  await service.prepareFromFile(RPK_PATH);
  const result = await service.sendFileChunks();

  assert.strictEqual(result.status, 'verifying');
  assert.notStrictEqual(result.status, 'completed');

  const session = service.getSession();
  assert.ok(session);
  assert.strictEqual(session.status, 'verifying');
  assert.notStrictEqual(session.status, 'completed');

  const completedEvents = progressEvents.filter((ev) => ev.status === 'completed');
  assert.strictEqual(completedEvents.length, 0, '状态机严禁产生 completed');
});

test('8. 全生命周期绝不会调用 core', async () => {
  const { service, ipcHandlers } = setupLifecycleIpc();
  let processSpawned = false;

  const originalSpawn = child_process.spawn;
  const originalExec = child_process.exec;
  const originalExecFile = child_process.execFile;

  child_process.spawn = (...args) => {
    processSpawned = true;
    return originalSpawn.apply(child_process, args);
  };
  child_process.exec = (...args) => {
    processSpawned = true;
    return originalExec.apply(child_process, args);
  };
  child_process.execFile = (...args) => {
    processSpawned = true;
    return originalExecFile.apply(child_process, args);
  };

  try {
    const prepareHandler = ipcHandlers.get('pulse:app-install:prepare-file');
    const cancelHandler = ipcHandlers.get('pulse:app-install:cancel-transfer');

    const res = await prepareHandler({}, { filePath: RPK_PATH });
    await cancelHandler({}, { installId: res.installId });

    assert.strictEqual(processSpawned, false, '全生命周期禁止调用 Core');
  } finally {
    child_process.spawn = originalSpawn;
    child_process.exec = originalExec;
    child_process.execFile = originalExecFile;
  }
});
