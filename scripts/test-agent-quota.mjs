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

import { parseAgQuotaSummary, fetchAntigravityUsage } from '../src/main/services/quota-collector.ts';

// ---------------------------------------------------------------------------
// Antigravity 云端兜底
// ---------------------------------------------------------------------------
const agGroups = (rem5h, remWeek) => [
  { displayName: 'Claude and GPT models', buckets: [{ window: '5h', remainingFraction: 0 }] },
  {
    displayName: 'Gemini Models',
    buckets: [
      { window: '5h', remainingFraction: rem5h, resetTime: '2026-10-04T05:00:00Z' },
      { window: 'weekly', remainingFraction: remWeek },
    ],
  },
];

test('parseAgQuotaSummary: 云端顶层 groups 与本地 response.groups 都收，只取 Gemini 组', () => {
  const want = { primary: { pct: 75, resetMs: Date.parse('2026-10-04T05:00:00Z') }, secondary: { pct: 10, resetMs: 0 } };
  assert.deepEqual(parseAgQuotaSummary({ groups: agGroups(0.25, 0.9) }), want);
  assert.deepEqual(parseAgQuotaSummary({ response: { groups: agGroups(0.25, 0.9) } }), want);
});

test('parseAgQuotaSummary: 没有 Gemini 组或没有桶 → null', () => {
  assert.equal(parseAgQuotaSummary({ groups: [{ displayName: 'Claude and GPT models', buckets: [] }] }), null);
  assert.equal(parseAgQuotaSummary({ groups: [{ displayName: 'Gemini Models', buckets: [] }] }), null);
  assert.equal(parseAgQuotaSummary({}), null);
});

test('fetchAntigravityUsage: 本地可用时不打云端', async () => {
  let cloudCalls = 0;
  const r = await fetchAntigravityUsage(
    async () => ({ response: { groups: agGroups(0.5, 0.5) } }),
    async () => (cloudCalls++, null)
  );
  assert.equal(r.primary.pct, 50);
  assert.equal(cloudCalls, 0);
});

test('fetchAntigravityUsage: 本地拿不到 → 云端真值；5 分钟内不再打云端，返回上次结果', async () => {
  const absent = async () => null;
  const first = await fetchAntigravityUsage(absent, async () => parseAgQuotaSummary({ groups: agGroups(0.6, 0.8) }));
  assert.equal(first.primary.pct, 40);
  let cloudCalls = 0;
  const again = await fetchAntigravityUsage(absent, async () => (cloudCalls++, null));
  assert.equal(cloudCalls, 0, '节流期内不打云端');
  assert.deepEqual(again, first);
});
