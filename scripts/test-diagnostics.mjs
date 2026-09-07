import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticReport } from '../src/main/services/diagnostics.ts';

const healthy = (patch = {}) => ({
  statusService: { ok: true },
  hookInstalled: true,
  hookService: { ok: true },
  daemonConnected: true,
  daemonDegraded: false,
  bridgeMode: 'direct',
  bridgeInstalled: false,
  bridgeRunning: false,
  bandConnected: true,
  bundledRpkExists: true,
  usableQuotaCount: 3,
  ...patch,
});

const find = (report, id) => report.checks.find((item) => item.id === id);

test('healthy observations produce nine passing checks', () => {
  const report = buildDiagnosticReport(healthy());
  assert.equal(report.checks.length, 9);
  assert.equal(report.checks.every((item) => item.status === 'pass'), true);
});

test('turns a status timeout into a readable failure', () => {
  const report = buildDiagnosticReport(
    healthy({ statusService: { ok: false, error: 'request ETIMEDOUT' } }),
  );
  const check = find(report, 'status-service');
  assert.equal(check.status, 'fail');
  assert.match(check.summary, /响应超时/);
  assert.match(check.nextStep, /重启 Pulse/);
});

test('reports missing Hook files as a repairable failure', () => {
  const check = find(buildDiagnosticReport(healthy({ hookInstalled: false })), 'claude-hook');
  assert.equal(check.status, 'fail');
  assert.match(check.nextStep, /安装 Hook/);
});

test('treats a degraded daemon protocol as a warning', () => {
  const check = find(buildDiagnosticReport(healthy({ daemonDegraded: true })), 'protocol');
  assert.equal(check.status, 'warn');
  assert.match(check.summary, /兼容模式/);
});

test('requires FetchBridge only in plugin mode', () => {
  const pluginCheck = find(
    buildDiagnosticReport(healthy({ bridgeMode: 'plugin', bridgeInstalled: false })),
    'bridge',
  );
  const directCheck = find(buildDiagnosticReport(healthy()), 'bridge');
  assert.equal(pluginCheck.status, 'fail');
  assert.equal(directCheck.status, 'pass');
});

test('reports a missing bundled RPK', () => {
  const check = find(buildDiagnosticReport(healthy({ bundledRpkExists: false })), 'bundled-rpk');
  assert.equal(check.status, 'fail');
  assert.match(check.summary, /缺少/);
});

test('reports unavailable quota sources as a warning', () => {
  const check = find(buildDiagnosticReport(healthy({ usableQuotaCount: 0 })), 'quota');
  assert.equal(check.status, 'warn');
  assert.match(check.nextStep, /登录/);
});
