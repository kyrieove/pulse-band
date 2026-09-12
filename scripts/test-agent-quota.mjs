import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toRemainingPercent,
  resolveQuotaStatus,
  resolveQuotaLiveTier,
} from '../src/renderer/components/pulse/agent-quota-utils.ts';

test('resolveQuotaLiveTier: 额度权威 + 检测方式决定实时/轮询', () => {
  assert.equal(resolveQuotaLiveTier({ authoritative: true }, 'event'), 'realtime');
  assert.equal(resolveQuotaLiveTier({ authoritative: true }, 'polling'), 'polling');
  // 检测方式缺省（旧状态对象）按轮询保守处理，不谎报实时
  assert.equal(resolveQuotaLiveTier({ authoritative: true }, undefined), 'polling');
});

test('resolveQuotaLiveTier: 估算压过会话维度', () => {
  assert.equal(resolveQuotaLiveTier({ authoritative: false }, 'event'), 'estimated');
  assert.equal(resolveQuotaLiveTier({ authoritative: false }, undefined), 'estimated');
  assert.equal(resolveQuotaLiveTier(undefined, 'event'), 'estimated');
});

test('toRemainingPercent: accurately converts used percentage to remaining percentage', () => {
  assert.equal(toRemainingPercent(0), 100);
  assert.equal(toRemainingPercent(35), 65);
  assert.equal(toRemainingPercent(80), 20);
  assert.equal(toRemainingPercent(95), 5);
  assert.equal(toRemainingPercent(100), 0);
});

test('toRemainingPercent: clamps negative and overflowing used percentages', () => {
  assert.equal(toRemainingPercent(-10), 100);
  assert.equal(toRemainingPercent(115), 0);
});

test('toRemainingPercent: safely handles null, undefined, and NaN inputs', () => {
  assert.equal(toRemainingPercent(null), null);
  assert.equal(toRemainingPercent(undefined), null);
  assert.equal(toRemainingPercent(NaN), null);
});

test('resolveQuotaStatus: maps service quota levels correctly', () => {
  assert.equal(resolveQuotaStatus('danger'), 'critical');
  assert.equal(resolveQuotaStatus('warn'), 'warning');
  assert.equal(resolveQuotaStatus('normal'), 'idle');
});

test('resolveQuotaStatus: falls back to used percentage thresholds when level is absent', () => {
  assert.equal(resolveQuotaStatus(null, 95), 'critical');
  assert.equal(resolveQuotaStatus(null, 96), 'critical');
  assert.equal(resolveQuotaStatus(null, 80), 'warning');
  assert.equal(resolveQuotaStatus(null, 85), 'warning');
  assert.equal(resolveQuotaStatus(null, 79), 'idle');
  assert.equal(resolveQuotaStatus(null, 0), 'idle');
  assert.equal(resolveQuotaStatus(null, null), 'idle');
});
