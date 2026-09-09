import test from 'node:test';
import assert from 'node:assert/strict';
import { AppInstallService } from '../src/main/services/app-install-service.ts';

test('AppInstallService: 正常安装全流程 (prepare -> chunks -> commit)', () => {
  const service = new AppInstallService();
  const progressEvents = [];
  const unsubscribe = service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  // 1. prepare
  const prepareRes = service.createSession({
    packageId: 'com.pulse.bandapp',
    versionName: '1.0.0',
    versionCode: 100,
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  assert.ok(prepareRes.installId.startsWith('inst_'));
  assert.equal(prepareRes.status, 'preparing');
  assert.equal(prepareRes.fileSize, 1024);
  assert.equal(prepareRes.chunkSize, 512);
  assert.equal(prepareRes.totalChunks, 2);

  // 检查 prepare 事件推送
  assert.equal(progressEvents.length, 1);
  assert.equal(progressEvents[0].status, 'preparing');
  assert.equal(progressEvents[0].percentage, 0);

  // 2. chunk 0
  const chunk0Res = service.handleChunk({
    installId: prepareRes.installId,
    chunkIndex: 0,
    chunkData: 'AAAA',
  });
  assert.equal(chunk0Res.status, 'transferring');
  assert.equal(chunk0Res.receivedBytes, 512);
  assert.equal(chunk0Res.chunkIndex, 0);
  assert.equal(progressEvents.length, 2);
  assert.equal(progressEvents[1].status, 'transferring');
  assert.equal(progressEvents[1].percentage, 50);

  // 3. chunk 1
  const chunk1Res = service.handleChunk({
    installId: prepareRes.installId,
    chunkIndex: 1,
    chunkData: 'BBBB',
  });
  assert.equal(chunk1Res.status, 'transferring');
  assert.equal(chunk1Res.receivedBytes, 1024);
  assert.equal(progressEvents.length, 3);
  assert.equal(progressEvents[2].percentage, 100);

  // 4. commit
  const commitRes = service.commit({
    installId: prepareRes.installId,
    expectedHash: 'test-hash',
  });
  assert.equal(commitRes.ok, true);
  assert.equal(commitRes.status, 'verifying');
  // 纪律约束：禁止进入 completed
  assert.notEqual(commitRes.status, 'completed');
  assert.equal(progressEvents[progressEvents.length - 1].status, 'verifying');

  unsubscribe();
});

test('AppInstallService: 无效 installId 异常拦截', () => {
  const service = new AppInstallService();
  service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
  });

  assert.throws(
    () => {
      service.handleChunk({
        installId: 'invalid_id',
        chunkIndex: 0,
        chunkData: 'AAAA',
      });
    },
    { message: /无效的 installId/ }
  );

  assert.throws(
    () => {
      service.commit({
        installId: 'invalid_id',
        expectedHash: 'test-hash',
      });
    },
    { message: /无效的 installId/ }
  );
});

test('AppInstallService: cancel 后资源释放与无法继续 chunk', () => {
  const service = new AppInstallService();
  const progressEvents = [];
  service.onProgress((ev) => progressEvents.push(ev));

  const prepareRes = service.createSession({
    fileSize: 2048,
    hash: 'test-hash',
    chunkSize: 512,
  });

  service.handleChunk({
    installId: prepareRes.installId,
    chunkIndex: 0,
    chunkData: 'AAAA',
  });

  // 主动 cancel
  const cancelRes = service.cancel({
    installId: prepareRes.installId,
    reason: '测试取消',
  });

  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(service.getSession(), null);
  assert.equal(progressEvents[progressEvents.length - 1].status, 'cancelled');

  // cancel 后再次尝试发送 chunk 必须被拒绝抛错
  assert.throws(
    () => {
      service.handleChunk({
        installId: prepareRes.installId,
        chunkIndex: 1,
        chunkData: 'BBBB',
      });
    },
    { message: /无效的 installId 或会话已过期/ }
  );
});

test('AppInstallService: 单任务互斥保护', () => {
  const service = new AppInstallService();
  service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
  });

  // 未结束时尝试开启新任务必须报错
  assert.throws(
    () => {
      service.createSession({
        fileSize: 2048,
        hash: 'test-hash-2',
      });
    },
    { message: /已有正在进行的安装会话/ }
  );
});
