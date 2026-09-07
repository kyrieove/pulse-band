import test from 'node:test';
import assert from 'node:assert/strict';
import { canConnectBand, shouldConnectBand } from '../src/main/services/oronbox-policy.ts';
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
