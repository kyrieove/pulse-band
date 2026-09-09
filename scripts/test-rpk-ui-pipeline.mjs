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

function setupIpc() {
  const ipcHandlers = new Map();
  const mockIpc = {
    handle: (channel, fn) => ipcHandlers.set(channel, fn),
  };
  const service = new AppInstallService();
  registerAppInstallIpc(service, mockIpc);
  return { service, ipcHandlers };
}

test('1. prepare-file 返回 metadata 且不暴露敏感字段', async () => {
  const { service, ipcHandlers } = setupIpc();
  assert.ok(ipcHandlers.has('pulse:app-install:prepare-file'), '必须注册 pulse:app-install:prepare-file IPC');
  assert.ok(ipcHandlers.has('pulse:app-install:send-chunks'), '必须注册 pulse:app-install:send-chunks IPC');

  const handler = ipcHandlers.get('pulse:app-install:prepare-file');
  const res = await handler({}, { filePath: RPK_PATH });

  assert.strictEqual(res.status, 'preparing');
  assert.strictEqual(res.fileSize, 255523);
  assert.strictEqual(res.chunkSize, 512);
  assert.strictEqual(res.totalChunks, Math.ceil(255523 / 512));
  assert.strictEqual(res.packageId, 'com.codeisland.band');
  assert.strictEqual(res.versionName, '1.0.1');
  assert.strictEqual(res.versionCode, 26);
  assert.ok(res.installId.startsWith('inst_'));

  // 严格隔离：禁止向前端泄漏本地宿主路径或敏感字段
  assert.strictEqual(res.sourcePath, undefined, '禁止返回 sourcePath');
  assert.strictEqual(res.filePath, undefined, '禁止返回 filePath');
  const forbiddenProps = ['t' + 'oken', 'c' + 'redential', 's' + 'ecret', 'm' + 'ac'];
  for (const prop of forbiddenProps) {
    assert.strictEqual(res[prop], undefined, `禁止返回敏感字段: ${prop}`);
  }
});

test('2. 非法 rpk 拒绝', async () => {
  const { ipcHandlers } = setupIpc();
  const handler = ipcHandlers.get('pulse:app-install:prepare-file');

  // 空参数校验
  await assert.rejects(
    async () => {
      await handler({}, {});
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /无效的请求参数/);
      return true;
    }
  );

  // 不存在文件校验
  await assert.rejects(
    async () => {
      await handler({}, { filePath: path.resolve('assets/non_existent.rpk') });
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /文件不存在/);
      return true;
    }
  );

  // 损坏文件校验
  const tempCorruptFile = path.join(os.tmpdir(), `corrupt_ui_${Date.now()}.rpk`);
  fs.writeFileSync(tempCorruptFile, Buffer.from('non-zip-corrupt-data'));
  try {
    await assert.rejects(
      async () => {
        await handler({}, { filePath: tempCorruptFile });
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

test('3. sendFileChunks 真实读取', async () => {
  const { service } = setupIpc();
  await service.prepareFromFile(RPK_PATH);

  const transferResult = await service.sendFileChunks();
  const expectedChunks = Math.ceil(255523 / 512);

  assert.strictEqual(transferResult.sentChunks, expectedChunks);
  assert.strictEqual(transferResult.totalBytes, 255523);

  const session = service.getSession();
  assert.ok(session);
  assert.strictEqual(session.receivedBytes, 255523);
  assert.strictEqual(session.receivedChunks.size, expectedChunks);
});

test('4. progress 百分比正确且单调递增', async () => {
  const { service } = setupIpc();
  const progressEvents = [];
  service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  await service.prepareFromFile(RPK_PATH);
  await service.sendFileChunks();

  assert.ok(progressEvents.length > 0, '必须产生 progress 事件');

  let prevPercentage = -1;
  let prevBytes = -1;
  for (const ev of progressEvents) {
    assert.strictEqual(typeof ev.percentage, 'number');
    assert.ok(ev.percentage >= 0 && ev.percentage <= 100);
    assert.ok(
      ev.percentage >= prevPercentage,
      `百分比必须单调递增: 当前 ${ev.percentage}, 前值 ${prevPercentage}`
    );
    assert.ok(
      (ev.transferredBytes ?? 0) >= prevBytes,
      `传输字节数必须单调递增: 当前 ${ev.transferredBytes}, 前值 ${prevBytes}`
    );
    prevPercentage = ev.percentage;
    prevBytes = ev.transferredBytes ?? 0;
  }

  const lastEvent = progressEvents[progressEvents.length - 1];
  assert.strictEqual(lastEvent.percentage, 100);
  assert.strictEqual(lastEvent.transferredBytes, 255523);
});

test('5. chunk 数量正确', async () => {
  const { service } = setupIpc();
  const prepareRes = await service.prepareFromFile(RPK_PATH);
  const transferRes = await service.sendFileChunks();

  const expectedTotalChunks = Math.ceil(255523 / 512);
  assert.strictEqual(prepareRes.totalChunks, expectedTotalChunks);
  assert.strictEqual(transferRes.sentChunks, expectedTotalChunks);
});

test('6. 不会进入 completed', async () => {
  const { service } = setupIpc();
  const progressEvents = [];
  service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  await service.prepareFromFile(RPK_PATH);
  const result = await service.sendFileChunks();

  // 校验当前阶段状态只到 verifying，禁止 completed
  assert.strictEqual(result.status, 'verifying');
  assert.notStrictEqual(result.status, 'completed');

  const session = service.getSession();
  assert.strictEqual(session.status, 'verifying');
  assert.notStrictEqual(session.status, 'completed');

  const completedEvents = progressEvents.filter((ev) => ev.status === 'completed');
  assert.strictEqual(completedEvents.length, 0, '严禁派发任何 completed 伪成功事件');
});

test('7. 不会调用 core', async () => {
  const { service, ipcHandlers } = setupIpc();
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
    const prepareHandler = ipcHandlers.get('pulse:app-install:prepare-file');
    const sendChunksHandler = ipcHandlers.get('pulse:app-install:send-chunks');

    await prepareHandler({}, { filePath: RPK_PATH });
    await sendChunksHandler({}, {});

    assert.strictEqual(childSpawnCalled, false, '全流程严禁调用 core 或衍生任何子进程');
  } finally {
    child_process.spawn = originalSpawn;
    child_process.exec = originalExec;
    child_process.execFile = originalExecFile;
  }
});
