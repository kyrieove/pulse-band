import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  canConnectBand,
  shouldConnectBand,
  resolveCoreExePath,
  resolveDaemonArgs,
  shouldRetryLiveConnect,
} from '../src/main/services/oronbox-policy.ts';
import { nextIdleGrace } from '../src/main/services/antigravity-policy.ts';
import {
  formatDiagnosticReport,
  formatErrorLog,
  redactSupportText,
} from '../src/main/services/support-report.ts';
import { resolveMiniBarVisibility } from '../src/main/services/minibar-preference.ts';
import { isVersionNewer } from '../src/main/services/version-check.ts';

test('only an explicit connect action may connect the band', () => {
  assert.equal(shouldConnectBand('startup'), false);
  assert.equal(shouldConnectBand('poll'), false);
  assert.equal(shouldConnectBand('diagnostics'), false);
  assert.equal(shouldConnectBand('manual-connect'), true);
});

test('completion grace widens to the longest gap actually seen', () => {
  // 实测：Antigravity 挂计时器等待时步间空档能到 14s / 19s / 27s，固定 4s 宽限会反复误报完成
  assert.equal(nextIdleGrace(4_000, 1_000), 4_000); // 短空档不动
  assert.equal(nextIdleGrace(4_000, 14_000), 16_000); // 空档 + 2s 余量
  assert.equal(nextIdleGrace(16_000, 12_000), 16_000); // 更短的空档不会把宽限调回去
  assert.equal(nextIdleGrace(16_000, 27_000), 29_000);
  assert.equal(nextIdleGrace(4_000, 120_000), 40_000); // 封顶
});

test('a failed connection stays retryable', () => {
  assert.equal(canConnectBand('disconnected', false), true);
  // 回归：连接失败后状态是 error，按钮曾经被永久置灰，没有任何重试入口
  assert.equal(canConnectBand('error', false), true);
  assert.equal(canConnectBand('connected', false), false);
  assert.equal(canConnectBand('connecting', false), false);
  assert.equal(canConnectBand('error', true), false);
});

test('support text removes credentials, complete MACs, and user paths', () => {
  const input =
    'authkey=e9c3e378a217c27156075f19bc41e01b token=abc123 04:34:C3:97:9A:06 C:\\Users\\ASUS\\secret.log';
  const output = redactSupportText(input);
  assert.doesNotMatch(output, /e9c3e378|abc123|04:34:C3:97:9A:06|ASUS/);
  assert.match(output, /<redacted>/);
});

test('diagnostic report is readable and redacts every field', () => {
  const output = formatDiagnosticReport({
    checkedAt: Date.UTC(2026, 8, 7, 12, 0, 0),
    checks: [
      {
        id: 'daemon',
        label: 'OronBox 后台',
        status: 'fail',
        summary: 'token=private-value',
        nextStep: '查看 C:\\Users\\ASUS\\daemon.log',
      },
    ],
  });
  assert.match(output, /OronBox 后台/);
  assert.match(output, /下一步/);
  assert.doesNotMatch(output, /private-value|ASUS/);
});

test('error log formatter includes time, source, and message without secrets', () => {
  const output = formatErrorLog([
    {
      ts: Date.UTC(2026, 8, 7, 12, 0, 0),
      source: 'device',
      level: 'error',
      message: 'Auth failed authkey=1234567890abcdef1234567890abcdef',
    },
  ]);
  assert.match(output, /device/);
  assert.match(output, /Auth failed/);
  assert.doesNotMatch(output, /1234567890abcdef/);
});

test('MiniBar is visible on first install and remembers explicit choices', () => {
  assert.equal(resolveMiniBarVisibility(undefined), true);
  assert.equal(resolveMiniBarVisibility(false), false);
  assert.equal(resolveMiniBarVisibility(true), true);
});

test('version comparison follows major, minor, and patch order', () => {
  assert.equal(isVersionNewer('1.1.0', '1.0.9'), true);
  assert.equal(isVersionNewer('1.1.0', '1.1.0'), false);
  assert.equal(isVersionNewer('2.0.0', '1.9.9'), true);
  assert.equal(isVersionNewer('1.0.9', '1.1.0'), false);
});

test('resolveCoreExePath: uses packaged path when it exists', () => {
  const fakeResources = 'C:/Program Files/Pulse Dev/resources';
  const existsFn = (p) => p === 'C:/Program Files/Pulse Dev/resources/pulse-core.exe';
  const fallback = 'C:/dev/pulse-band2/core/target/release/pulse-core.exe';

  const resolved = resolveCoreExePath(fakeResources, existsFn, fallback);
  assert.equal(resolved, 'C:/Program Files/Pulse Dev/resources/pulse-core.exe');
});

test('resolveCoreExePath: falls back to dev path when packaged exe does not exist', () => {
  const fakeResources = 'C:/Program Files/Pulse Dev/resources';
  const existsFn = () => false;
  const fallback = 'C:/dev/pulse-band2/core/target/release/pulse-core.exe';

  const resolved = resolveCoreExePath(fakeResources, existsFn, fallback);
  assert.equal(resolved, fallback);
});

test('resolveCoreExePath: falls back to dev path when resourcesPath is undefined', () => {
  const existsFn = () => true;
  const fallback = 'C:/dev/pulse-band2/core/target/release/pulse-core.exe';

  const resolved = resolveCoreExePath(undefined, existsFn, fallback);
  assert.equal(resolved, fallback);
});

test('resolveDaemonArgs: explicit options mode takes highest priority', () => {
  assert.deepEqual(resolveDaemonArgs({ mode: 'fake', deviceConfigExists: true, envMode: 'live' }), ['--fake']);
  assert.deepEqual(resolveDaemonArgs({ mode: 'live', deviceConfigExists: false, envMode: 'fake' }), ['--live']);
});

test('resolveDaemonArgs: envMode takes priority over device config when mode is unset', () => {
  assert.deepEqual(resolveDaemonArgs({ envMode: 'fake', deviceConfigExists: true }), ['--fake']);
  assert.deepEqual(resolveDaemonArgs({ envMode: 'live', deviceConfigExists: false }), ['--live']);
});

test('resolveDaemonArgs: selects --live for formal device when device.json exists', () => {
  assert.deepEqual(resolveDaemonArgs({ deviceConfigExists: true }), ['--live']);
});

test('resolveDaemonArgs: selects --fake for test/unpaired environment when device.json is missing', () => {
  assert.deepEqual(resolveDaemonArgs({ deviceConfigExists: false }), ['--fake']);
  assert.deepEqual(resolveDaemonArgs({}), ['--fake']);
});

test('shouldRetryLiveConnect: allows retrying up to 3 attempts and stops', () => {
  assert.equal(shouldRetryLiveConnect(0, 3), true);
  assert.equal(shouldRetryLiveConnect(1, 3), true);
  assert.equal(shouldRetryLiveConnect(2, 3), true);
  assert.equal(shouldRetryLiveConnect(3, 3), false);
  assert.equal(shouldRetryLiveConnect(4, 3), false);
});

test('packaged win-unpacked resources contains pulse-core.exe and CORE_EXE resolves to it', () => {
  const unpackedResources = path.resolve('release/win-unpacked/resources');
  const packagedExe = path.join(unpackedResources, 'pulse-core.exe');
  assert.equal(fs.existsSync(packagedExe), true, 'resources/pulse-core.exe 必须存在于打包解包目录');
  const resolved = resolveCoreExePath(unpackedResources, (p) => fs.existsSync(p), 'fallback');
  assert.equal(resolved.replace(/\\/g, '/'), packagedExe.replace(/\\/g, '/'));
});


