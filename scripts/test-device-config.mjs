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
  const r1 = service.saveDeviceConfig({ useExisting: true });
  assert.equal(r1.ok, true);
  assert.equal(r1.deviceName, 'Xiaomi Smart Band 10');
  assert.equal(r1.maskedAddr, '04:34:**:**:9A:06');

  // 10. saveDeviceConfig: 日志文件缺失报错
  const r2 = service.saveDeviceConfig({ logPath: 'nonexistent.log' });
  assert.equal(r2.ok, false);

  console.log('✅ DeviceConfigService 单元测试全部通过（10 项断言）');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
