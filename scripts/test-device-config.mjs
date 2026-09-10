/**
 * DeviceConfigService 自动化单元测试
 * 运行方式：node scripts/test-device-config.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeviceConfigService,
  formatMacAddress,
  maskMacAddress,
} from '../src/main/services/device-config-service.ts';

// 1. MAC 格式化与脱敏测试
assert.equal(formatMacAddress('0434c3979a06'), '04:34:C3:97:9A:06');
assert.equal(formatMacAddress('04:34:C3:97:9A:06'), '04:34:C3:97:9A:06');
assert.equal(maskMacAddress('0434c3979a06'), '04:34:**:**:9A:06');
assert.equal(maskMacAddress('04:34:C3:97:9A:06'), '04:34:**:**:9A:06');
assert.equal(maskMacAddress('invalid'), '***');

// 2. 临时测试环境创建
const tempDir = path.join(os.tmpdir(), `pulse-test-config-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
const testConfigPath = path.join(tempDir, 'device.json');
const service = new DeviceConfigService(testConfigPath);

try {
  // 3. 不存在文件
  const s1 = service.getDeviceConfigStatus();
  assert.equal(s1.exists, false);
  assert.equal(s1.valid, false);

  // 4. 非法 JSON
  fs.writeFileSync(testConfigPath, '{ bad json');
  const s2 = service.getDeviceConfigStatus();
  assert.equal(s2.exists, true);
  assert.equal(s2.valid, false);

  // 5. 缺少 authkey
  fs.writeFileSync(testConfigPath, JSON.stringify({ addr: '04:34:C3:97:9A:06' }));
  const s3 = service.getDeviceConfigStatus();
  assert.equal(s3.valid, false);

  // 6. authkey 长度不对
  fs.writeFileSync(testConfigPath, JSON.stringify({ addr: '04:34:C3:97:9A:06', authkey: 'short' }));
  const s4 = service.getDeviceConfigStatus();
  assert.equal(s4.valid, false);

  // 7. addr 长度不对
  fs.writeFileSync(
    testConfigPath,
    JSON.stringify({ addr: 'invalid', authkey: 'e9c3e378a217c27156075f19bc41e01b' })
  );
  const s5 = service.getDeviceConfigStatus();
  assert.equal(s5.valid, false);

  // 8. 正确配置
  const validConfig = {
    name: 'Xiaomi Smart Band 10',
    addr: '04:34:C3:97:9A:06',
    connectType: 'spp',
    authkey: 'e9c3e378a217c27156075f19bc41e01b',
    codename: 'o66',
  };
  fs.writeFileSync(testConfigPath, JSON.stringify(validConfig));
  const s6 = service.getDeviceConfigStatus();
  assert.equal(s6.exists, true);
  assert.equal(s6.valid, true);
  assert.equal(s6.deviceName, 'Xiaomi Smart Band 10');
  assert.equal(s6.maskedAddr, '04:34:**:**:9A:06');
  assert.equal(s6.codename, 'o66');
  assert.equal('authkey' in s6, false, '脱敏状态对象绝不能包含 authkey');

  // 9. saveDeviceConfig: 直接使用有效配置
  const r1 = await service.saveDeviceConfig({ useExisting: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.deviceName, 'Xiaomi Smart Band 10');
  assert.equal(r1.maskedAddr, '04:34:**:**:9A:06');

  // 10. saveDeviceConfig: 日志文件缺失报错
  const r2 = await service.saveDeviceConfig({ logPath: 'nonexistent.log' });
  assert.equal(r2.ok, false);

  // ===== 以下覆盖真正的写入分支 =====
  // 注意：上面的 useExisting 分支只做校验、**不写文件**，所以原有测试从未进入写入路径。
  // 这里构造最小日志 fixture，并注入"已配对手环"（避免依赖本机真实蓝牙设备树）。

  // 11. 原子写入：成功写入，且 authkey / addr 满足 core 的解析契约
  const logPath = path.join(tempDir, 'XiaomiFit.main.log');
  fs.writeFileSync(
    logPath,
    'INFO device bind ok deviceKey=5029183764a3f7c2e19b4d6058a1c3e7f2b9d40856 model=o66'
  );
  service.getPairedBandDevices = async () => [
    {
      id: 'bth\\dev_0434c3979a06',
      name: 'Xiaomi Smart Band 10',
      maskedMac: '04:34:**:**:9A:06',
      isXiaomiBand: true,
      rawMac: '0434c3979a06',
    },
  ];

  const w1 = await service.saveDeviceConfig({ logPath });
  assert.equal(w1.ok, true, `写入应成功: ${w1.error || ''}`);

  const written = JSON.parse(fs.readFileSync(testConfigPath, 'utf8'));
  assert.match(written.authkey, /^[0-9a-f]{32}$/, 'authkey 必须是 32 位 hex');
  assert.equal(written.addr, '04:34:C3:97:9A:06', 'addr 必须是 core 可解析的 MAC');
  assert.equal(fs.existsSync(`${testConfigPath}.tmp`), false, '成功写入后不应残留 .tmp');

  // 12. 原子性核心断言：rename 失败时旧配置必须逐字节不变（不能出现截断/半写配置）
  const beforeBytes = fs.readFileSync(testConfigPath, 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error('模拟 rename 失败');
  };
  let w2;
  try {
    w2 = await service.saveDeviceConfig({ logPath });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(w2.ok, false, 'rename 失败时必须返回 ok:false');
  assert.equal(
    fs.readFileSync(testConfigPath, 'utf8'),
    beforeBytes,
    '写入失败后旧配置必须保持不变（原子替换语义）'
  );
  assert.equal(fs.existsSync(`${testConfigPath}.tmp`), false, '写入失败后不应残留 .tmp');

  // 13. 失败后仍能正常再次写入（临时文件已清理，不阻塞后续保存）
  const w3 = await service.saveDeviceConfig({ logPath });
  assert.equal(w3.ok, true, '失败后应能重新写入');

  console.log('✅ DeviceConfigService 单元测试全部通过（14 项断言）');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
