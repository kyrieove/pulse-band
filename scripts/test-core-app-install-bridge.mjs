import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import child_process from 'node:child_process';
import {
  CoreAppInstallBridge,
  desensitizeCoreError,
} from '../src/main/services/core-app-install-bridge.ts';
import { AppInstallService } from '../src/main/services/app-install-service.ts';

const RPK_PATH = path.resolve('assets/band-app.rpk');

class MockRpcClient {
  constructor() {
    this.calls = [];
    this.customHandler = null;
  }

  async call(method, params, timeoutMs) {
    this.calls.push({ method, params, timeoutMs });
    if (this.customHandler) {
      return this.customHandler(method, params);
    }
    if (method === 'device.app.install.prepare') {
      return {
        status: 'preparing',
        sessionId: 'inst_core_session_mock',
        fileSize: params?.fileSize ?? 255523,
        chunkSize: 512,
        totalChunks: Math.ceil((params?.fileSize ?? 255523) / 512),
      };
    }
    if (method === 'device.app.install.chunk') {
      return {
        status: 'transferring',
        sessionId: params?.sessionId,
        index: params?.index,
        receivedBytes: ((params?.index ?? 0) + 1) * 512,
      };
    }
    if (method === 'device.app.install.commit') {
      return {
        status: 'verifying',
      };
    }
    if (method === 'device.app.install.cancel') {
      return {
        status: 'cancelled',
      };
    }
    throw new Error('未知的 RPC 方法: ' + method);
  }
}

test('1. CoreAppInstallBridge 独立单元测试: 验证 4 个 RPC 方法名与参数映射', async () => {
  const mockClient = new MockRpcClient();
  const bridge = new CoreAppInstallBridge(mockClient);

  // 1. prepare
  const prepRes = await bridge.prepare({
    packageId: 'com.pulse.bandapp',
    versionName: '1.0.0',
    versionCode: 26,
    fileSize: 255523,
    hash: 'sha256-mock-hash',
  });
  assert.strictEqual(prepRes.status, 'preparing');
  assert.strictEqual(prepRes.sessionId, 'inst_core_session_mock');
  assert.strictEqual(mockClient.calls[0].method, 'device.app.install.prepare');
  assert.strictEqual(mockClient.calls[0].params.packageId, 'com.pulse.bandapp');
  assert.strictEqual(mockClient.calls[0].params.fileSize, 255523);

  // 2. sendChunk
  const chunkRes = await bridge.sendChunk({
    sessionId: 'inst_core_session_mock',
    index: 0,
    size: 512,
    data: [1, 2, 3],
  });
  assert.strictEqual(chunkRes.status, 'transferring');
  assert.strictEqual(chunkRes.index, 0);
  assert.strictEqual(mockClient.calls[1].method, 'device.app.install.chunk');
  assert.strictEqual(mockClient.calls[1].params.sessionId, 'inst_core_session_mock');
  assert.strictEqual(mockClient.calls[1].params.index, 0);

  // 3. commit
  const commitRes = await bridge.commit('inst_core_session_mock');
  assert.strictEqual(commitRes.status, 'verifying');
  assert.notStrictEqual(commitRes.status, 'completed');
  assert.strictEqual(mockClient.calls[2].method, 'device.app.install.commit');
  assert.strictEqual(mockClient.calls[2].params.sessionId, 'inst_core_session_mock');

  // 4. cancel
  const cancelRes = await bridge.cancel('inst_core_session_mock');
  assert.strictEqual(cancelRes.status, 'cancelled');
  assert.strictEqual(mockClient.calls[3].method, 'device.app.install.cancel');
  assert.strictEqual(mockClient.calls[3].params.sessionId, 'inst_core_session_mock');
});

test('2. AppInstallService 集成测试: 验证 Main 调用 Core 各接口的精确次数', async () => {
  const mockClient = new MockRpcClient();
  const bridge = new CoreAppInstallBridge(mockClient);
  const service = new AppInstallService(bridge);

  // 1. prepare
  const prepResult = await service.prepareFromFile(RPK_PATH);
  assert.strictEqual(prepResult.status, 'preparing');
  const prepCalls = mockClient.calls.filter((c) => c.method === 'device.app.install.prepare');
  assert.strictEqual(prepCalls.length, 1, 'prepare 必须只调用 1 次 Core');

  // 2. sendChunks -> 499 块 -> 自动 commit
  const expectedTotalChunks = Math.ceil(255523 / 512); // 499
  const transferResult = await service.sendFileChunks();
  assert.strictEqual(transferResult.status, 'verifying');
  assert.notStrictEqual(transferResult.status, 'completed');

  const chunkCalls = mockClient.calls.filter((c) => c.method === 'device.app.install.chunk');
  assert.strictEqual(
    chunkCalls.length,
    expectedTotalChunks,
    `分块 RPC 调用次数必须精确匹配文件总块数 (${expectedTotalChunks})`
  );

  const commitCalls = mockClient.calls.filter((c) => c.method === 'device.app.install.commit');
  assert.strictEqual(commitCalls.length, 1, 'commit 必须只调用 1 次 Core');

  // 3. cancel
  await service.cancelFileTransfer();
  const cancelCalls = mockClient.calls.filter((c) => c.method === 'device.app.install.cancel');
  assert.strictEqual(cancelCalls.length, 1, 'cancel 必须同步通知 Core 1 次');
});

test('3. 错误脱敏: 验证 prepare 异常被转换为安全的用户错误', async () => {
  const mockClient = new MockRpcClient();
  mockClient.customHandler = (method) => {
    if (method === 'device.app.install.prepare') {
      const err = new Error('daemon install_prepare_failed: invalid format');
      err.code = 'install_prepare_failed';
      throw err;
    }
  };

  const bridge = new CoreAppInstallBridge(mockClient);
  const service = new AppInstallService(bridge);

  let capturedEvent = null;
  service.onProgress((ev) => {
    if (ev.status === 'failed') capturedEvent = ev;
  });

  await assert.rejects(
    async () => {
      await service.prepareFromFile(RPK_PATH);
    },
    (err) => {
      assert.strictEqual(err.code, 'CORE_PREPARE_FAILED');
      assert.strictEqual(err.userMessage, '设备安装准备失败');
      assert.strictEqual(err.message, '设备安装准备失败');
      return true;
    }
  );

  assert.ok(capturedEvent);
  assert.strictEqual(capturedEvent.status, 'failed');
  assert.strictEqual(capturedEvent.error.code, 'CORE_PREPARE_FAILED');
  assert.strictEqual(capturedEvent.error.userMessage, '设备安装准备失败');
});

test('4. 错误脱敏: 验证 chunk 传输异常被转换为安全的用户错误', async () => {
  const mockClient = new MockRpcClient();
  let chunkCount = 0;
  mockClient.customHandler = (method) => {
    if (method === 'device.app.install.chunk') {
      chunkCount++;
      if (chunkCount === 2) {
        const err = new Error('daemon install_chunk_failed: buffer overflow');
        err.code = 'install_chunk_failed';
        throw err;
      }
    }
  };

  const bridge = new CoreAppInstallBridge(mockClient);
  const service = new AppInstallService(bridge);

  await service.prepareFromFile(RPK_PATH);

  await assert.rejects(
    async () => {
      await service.sendFileChunks();
    },
    (err) => {
      assert.strictEqual(err.message, '设备分块写入失败');
      return true;
    }
  );

  const session = service.getSession();
  assert.strictEqual(session.status, 'failed');
});

test('5. 错误脱敏: 验证 commit 异常被转换为安全的用户错误', async () => {
  const mockClient = new MockRpcClient();
  mockClient.customHandler = (method) => {
    if (method === 'device.app.install.commit') {
      const err = new Error('daemon install_commit_failed: hash mismatch');
      err.code = 'install_commit_failed';
      throw err;
    }
  };

  const bridge = new CoreAppInstallBridge(mockClient);
  const service = new AppInstallService(bridge);

  await service.prepareFromFile(RPK_PATH);

  await assert.rejects(
    async () => {
      await service.sendFileChunks();
    },
    (err) => {
      assert.strictEqual(err.message, '设备校验安装失败');
      return true;
    }
  );

  const session = service.getSession();
  assert.strictEqual(session.status, 'failed');
});

test('6. 验证全生命周期绝不产生 completed 或 installed 假成功状态', async () => {
  const mockClient = new MockRpcClient();
  const bridge = new CoreAppInstallBridge(mockClient);
  const service = new AppInstallService(bridge);

  const progressEvents = [];
  service.onProgress((ev) => progressEvents.push(ev));

  await service.prepareFromFile(RPK_PATH);
  const res = await service.sendFileChunks();

  assert.strictEqual(res.status, 'verifying');
  assert.notStrictEqual(res.status, 'completed');
  assert.notStrictEqual(res.status, 'installed');

  const session = service.getSession();
  assert.strictEqual(session.status, 'verifying');
  assert.notStrictEqual(session.status, 'completed');
  assert.notStrictEqual(session.status, 'installed');

  const forbiddenEvents = progressEvents.filter(
    (ev) => ev.status === 'completed' || ev.status === 'installed'
  );
  assert.strictEqual(forbiddenEvents.length, 0, '严禁派发 completed/installed 伪成功事件');
});

test('7. 验证没有真实设备调用 (零子进程、零底层硬件操作)', async () => {
  let childSpawnCalled = false;
  const originalSpawn = child_process.spawn;
  const originalExec = child_process.exec;
  const originalExecFile = child_process.execFile;

  child_process.spawn = (...args) => {
    childSpawnCalled = true;
    return originalSpawn.apply(child_process, args);
  };
  child_process.exec = (...args) => {
    childSpawnCalled = true;
    return originalExec.apply(child_process, args);
  };
  child_process.execFile = (...args) => {
    childSpawnCalled = true;
    return originalExecFile.apply(child_process, args);
  };

  try {
    const mockClient = new MockRpcClient();
    const bridge = new CoreAppInstallBridge(mockClient);
    const service = new AppInstallService(bridge);

    await service.prepareFromFile(RPK_PATH);
    await service.sendFileChunks();
    await service.cancelFileTransfer();

    assert.strictEqual(childSpawnCalled, false, '全链路严禁调用真实硬件或衍生子进程');
  } finally {
    child_process.spawn = originalSpawn;
    child_process.exec = originalExec;
    child_process.execFile = originalExecFile;
  }
});
