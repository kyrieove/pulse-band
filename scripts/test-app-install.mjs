import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AppInstallService,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_RPK_SIZE,
} from '../src/main/services/app-install-service.ts';

test('1. 正常流程: prepare -> 所有真实 Base64 chunks -> commit -> verifying', () => {
  const service = new AppInstallService();
  const progressEvents = [];
  const unsubscribe = service.onProgress((ev) => {
    progressEvents.push(ev);
  });

  const fileSize = 1024;
  const chunkSize = 512;
  const hash = 'sha256-test-hash-value';

  // prepare
  const prepareRes = service.createSession({
    packageId: 'com.pulse.bandapp',
    versionName: '1.0.0',
    versionCode: 100,
    fileSize,
    hash,
    chunkSize,
  });

  assert.ok(prepareRes.installId.startsWith('inst_'));
  assert.equal(prepareRes.status, 'preparing');
  assert.equal(prepareRes.fileSize, fileSize);
  assert.equal(prepareRes.chunkSize, chunkSize);
  assert.equal(prepareRes.totalChunks, 2);

  // 真实 512 字节分块 0
  const chunk0Data = Buffer.alloc(chunkSize, 0x11).toString('base64');
  const chunk0Res = service.handleChunk({
    installId: prepareRes.installId,
    chunkIndex: 0,
    chunkData: chunk0Data,
  });
  assert.equal(chunk0Res.status, 'transferring');
  assert.equal(chunk0Res.receivedBytes, 512);
  assert.equal(chunk0Res.chunkIndex, 0);

  // 真实 512 字节分块 1
  const chunk1Data = Buffer.alloc(chunkSize, 0x22).toString('base64');
  const chunk1Res = service.handleChunk({
    installId: prepareRes.installId,
    chunkIndex: 1,
    chunkData: chunk1Data,
  });
  assert.equal(chunk1Res.status, 'transferring');
  assert.equal(chunk1Res.receivedBytes, 1024);
  assert.equal(chunk1Res.chunkIndex, 1);

  // commit
  const commitRes = service.commit({
    installId: prepareRes.installId,
    expectedHash: hash,
  });
  assert.equal(commitRes.ok, true);
  assert.equal(commitRes.status, 'verifying');
  assert.notEqual(commitRes.status, 'completed');

  // 校验事件流
  assert.equal(progressEvents[0].status, 'preparing');
  assert.equal(progressEvents[0].percentage, 0);
  assert.equal(progressEvents[1].status, 'transferring');
  assert.equal(progressEvents[1].transferredBytes, 512);
  assert.equal(progressEvents[1].percentage, 50);
  assert.equal(progressEvents[2].status, 'transferring');
  assert.equal(progressEvents[2].transferredBytes, 1024);
  assert.equal(progressEvents[2].percentage, 100);
  assert.equal(progressEvents[3].status, 'verifying');
  assert.equal(progressEvents[3].percentage, 100);

  unsubscribe();
});

test('2. 空 chunkData 被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  assert.throws(
    () => {
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 0,
        chunkData: '',
      });
    },
    { message: /chunkData 必须为非空字符串/ }
  );

  assert.throws(
    () => {
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 0,
        chunkData: '   ',
      });
    },
    { message: /非法 Base64 数据/ }
  );
});

test('3. 非法 Base64 被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  // 长度不合规（非 4 的倍数）
  assert.throws(
    () => {
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 0,
        chunkData: 'abc',
      });
    },
    { message: /非法 Base64 数据: 长度不合法/ }
  );

  // 包含非法字符
  assert.throws(
    () => {
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 0,
        chunkData: '????',
      });
    },
    { message: /非法 Base64 数据: 包含非法字符/ }
  );
});

test('4. chunk decoded length 不正确被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  // chunk 0 需要 512 字节，实际只给 256 字节
  const invalidChunk = Buffer.alloc(256).toString('base64');
  assert.throws(
    () => {
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 0,
        chunkData: invalidChunk,
      });
    },
    { message: /分块长度不正确: 期望 512 字节, 实际解码 256 字节/ }
  );
});

test('5. 缺少一个 chunk 时 commit 被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  // 只发第 0 块，不发第 1 块
  const chunk0 = Buffer.alloc(512).toString('base64');
  service.handleChunk({
    installId: prep.installId,
    chunkIndex: 0,
    chunkData: chunk0,
  });

  assert.throws(
    () => {
      service.commit({
        installId: prep.installId,
        expectedHash: 'test-hash',
      });
    },
    { message: /分块尚未传输完整: 接收到 1\/2 块/ }
  );
});

test('6. prepare 后零 chunk 直接 commit 被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  assert.throws(
    () => {
      service.commit({
        installId: prep.installId,
        expectedHash: 'test-hash',
      });
    },
    { message: /分块尚未传输完整: 接收到 0\/2 块/ }
  );
});

test('7. duplicate chunk 不重复增加 receivedBytes', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  const chunk0 = Buffer.alloc(512).toString('base64');
  const res1 = service.handleChunk({
    installId: prep.installId,
    chunkIndex: 0,
    chunkData: chunk0,
  });
  assert.equal(res1.receivedBytes, 512);

  // 再次重复提交第 0 块
  const res2 = service.handleChunk({
    installId: prep.installId,
    chunkIndex: 0,
    chunkData: chunk0,
  });
  assert.equal(res2.receivedBytes, 512); // 未重复累加

  // 提交第 1 块后满足完整性
  const chunk1 = Buffer.alloc(512).toString('base64');
  const res3 = service.handleChunk({
    installId: prep.installId,
    chunkIndex: 1,
    chunkData: chunk1,
  });
  assert.equal(res3.receivedBytes, 1024);

  const commitRes = service.commit({
    installId: prep.installId,
    expectedHash: 'test-hash',
  });
  assert.equal(commitRes.ok, true);
  assert.equal(commitRes.status, 'verifying');
});

test('8. expectedHash 与 prepare 声明不一致时 commit 被拒绝', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 512,
    hash: 'correct-declared-hash',
    chunkSize: 512,
  });

  const chunk0 = Buffer.alloc(512).toString('base64');
  service.handleChunk({
    installId: prep.installId,
    chunkIndex: 0,
    chunkData: chunk0,
  });

  assert.throws(
    () => {
      service.commit({
        installId: prep.installId,
        expectedHash: 'wrong-hash-value',
      });
    },
    { message: /expectedHash 与 prepare 声明不一致/ }
  );
});

test('9. fileSize 超过 5 MiB 被拒绝', () => {
  const service = new AppInstallService();

  assert.throws(
    () => {
      service.createSession({
        fileSize: MAX_RPK_SIZE + 1,
        hash: 'test-hash',
      });
    },
    { message: /fileSize 超出最大限制/ }
  );

  assert.throws(
    () => {
      service.createSession({
        fileSize: 0,
        hash: 'test-hash',
      });
    },
    { message: /无效的 fileSize/ }
  );
});

test('10. 无效 chunkSize 被拒绝', () => {
  const service = new AppInstallService();

  assert.throws(
    () => {
      service.createSession({
        fileSize: 1024,
        hash: 'test-hash',
        chunkSize: MIN_CHUNK_SIZE - 1, // 255
      });
    },
    { message: /无效的 chunkSize: 必须在 \[256, 65536\] 范围内/ }
  );

  assert.throws(
    () => {
      service.createSession({
        fileSize: 1024,
        hash: 'test-hash',
        chunkSize: MAX_CHUNK_SIZE + 1, // 65537
      });
    },
    { message: /无效的 chunkSize: 必须在 \[256, 65536\] 范围内/ }
  );
});

test('11. cancel 后不能继续 chunk', () => {
  const service = new AppInstallService();
  const prep = service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
    chunkSize: 512,
  });

  const chunk0 = Buffer.alloc(512).toString('base64');
  service.handleChunk({
    installId: prep.installId,
    chunkIndex: 0,
    chunkData: chunk0,
  });

  const cancelRes = service.cancel({
    installId: prep.installId,
    reason: '测试取消',
  });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, 'cancelled');
  assert.equal(service.getSession(), null);

  assert.throws(
    () => {
      const chunk1 = Buffer.alloc(512).toString('base64');
      service.handleChunk({
        installId: prep.installId,
        chunkIndex: 1,
        chunkData: chunk1,
      });
    },
    { message: /无效的 installId 或会话已过期/ }
  );
});

test('12. 单任务互斥仍通过', () => {
  const service = new AppInstallService();
  service.createSession({
    fileSize: 1024,
    hash: 'test-hash',
  });

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
