import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { OronBoxClient } from '../src/main/services/oronbox-client.ts';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('OronBoxClient: connectOnce switches to new port and token when fresh endpoint appears during retries', async () => {
  let receivedToken = null;
  const server = net.createServer((socket) => {
    socket.on('data', (data) => {
      for (const line of data.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          receivedToken = req.token;
          if (req.method === 'daemon.info') {
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result: {
                  protocolVersion: 6,
                  pid: process.pid,
                  platform: 'windows',
                  endpoint: `127.0.0.1:${server.address().port}`,
                  uptimeSeconds: 1,
                },
              }) + '\n',
            );
          }
        } catch {}
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const newPort = server.address().port;

  // 找一个当前未监听的死端口
  const closedServer = net.createServer();
  await new Promise((resolve) => closedServer.listen(0, '127.0.0.1', resolve));
  const deadPort = closedServer.address().port;
  await new Promise((resolve) => closedServer.close(resolve));

  const epDir = path.join(process.env.LOCALAPPDATA || '.', 'PulseDev', 'run');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'core.json');
  const backup = fs.existsSync(epFile) ? fs.readFileSync(epFile, 'utf-8') : null;

  try {
    // 初始写入 deadPort 和旧 token
    fs.writeFileSync(
      epFile,
      JSON.stringify({
        port: deadPort,
        token: 'old_token_initial',
        pid: process.pid,
        protocolVersion: 6,
      }),
    );

    const client = new OronBoxClient();

    // 延迟 400ms 后（处于重试等待期间）将 core.json 刷新为有效 newPort 和新 token
    const timer = setTimeout(() => {
      fs.writeFileSync(
        epFile,
        JSON.stringify({
          port: newPort,
          token: 'fresh_token_switched',
          pid: process.pid,
          protocolVersion: 6,
        }),
      );
    }, 400);

    const connected = await client.connectIfRunning();
    clearTimeout(timer);

    assert.equal(connected, true, 'client 成功连上新端口');
    assert.equal(client.connected, true);
    assert.equal(client.endpointInfo?.port, newPort, '端点端口已刷新为新端口');
    assert.equal(client.endpointInfo?.token, 'fresh_token_switched', '端点token已刷新为新token');
    assert.equal(receivedToken, 'fresh_token_switched', '服务器收到的RPC请求携带新token');

    client.dispose();
  } finally {
    server.close();
    if (backup) {
      fs.writeFileSync(epFile, backup);
    } else {
      fs.rmSync(epFile, { force: true });
    }
  }
});

test('pulse-core --live: starts in disconnected state and does not reconnect after active disconnect', async () => {
  const coreExe = path.resolve('core/target/release/pulse-core.exe');
  if (!fs.existsSync(coreExe)) return;

  const epDir = path.join(process.env.LOCALAPPDATA || '.', 'PulseDev', 'run');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'core.json');
  fs.rmSync(epFile, { force: true });

  const proc = spawn(coreExe, ['--live'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let ep = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      try {
        ep = JSON.parse(fs.readFileSync(epFile, 'utf-8'));
        if (ep?.port) break;
      } catch {}
    }
    assert.ok(ep?.port, 'pulse-core --live 成功启动并写入端点');

    const client = net.connect(ep.port, '127.0.0.1');
    await new Promise((r) => client.once('connect', r));

    let seq = 0;
    const callRpc = (method, params = {}) =>
      new Promise((resolve) => {
        const id = 'r' + ++seq;
        const handler = (data) => {
          for (const line of data.toString('utf-8').split('\n')) {
            if (!line.trim()) continue;
            try {
              const resp = JSON.parse(line);
              if (resp.id === id) {
                client.off('data', handler);
                resolve(resp);
                return;
              }
            } catch {}
          }
        };
        client.on('data', handler);
        client.write(JSON.stringify({ id, method, params, token: ep.token }) + '\n');
      });

    // 1. 验证仅启动 daemon、未调用 device.connect 时，保持 Disconnected，不建立蓝牙连接
    const st0 = await callRpc('device.status');
    assert.equal(st0.result.connected, false, '启动后未收到 connect 请求前 connected=false');
    assert.equal(st0.result.protocolState, 'disconnected', '启动后 protocolState 为 disconnected');
    assert.equal(st0.result.device, null, '未连接时 device 为 null（不伪造假设备）');

    // 保持静默 1.2 秒，确认状态未发生自发改变
    await sleep(1200);
    const st1 = await callRpc('device.status');
    assert.equal(st1.result.connected, false);
    assert.equal(st1.result.protocolState, 'disconnected');

    // 2. 模拟调用 device.connect（设置 desired_connected=true）
    const connResp = await callRpc('device.connect');
    assert.equal(connResp.ok, true);

    // 3. 模拟用户主动调用 device.disconnect
    const disconnResp = await callRpc('device.disconnect');
    assert.equal(disconnResp.ok, true);

    const stAfterDisconn = await callRpc('device.status');
    assert.equal(stAfterDisconn.result.connected, false);
    assert.equal(stAfterDisconn.result.protocolState, 'disconnected');

    // 4. 等待 3.5 秒（超过 3 秒的重连周期），断言不会自发重连
    await sleep(3500);
    const stAfterWait = await callRpc('device.status');
    assert.equal(stAfterWait.result.connected, false, '主动断开 3 秒后依然保持 disconnected，不会自动重连');
    assert.equal(stAfterWait.result.protocolState, 'disconnected');

    // 5. 验证 daemon.stop 干净退出
    await callRpc('daemon.stop');
    await sleep(500);
    assert.equal(proc.exitCode, 0, 'daemon.stop 后进程退出码为 0');
    assert.equal(fs.existsSync(epFile), false, 'daemon.stop 后端点文件已清理');
    client.destroy();
  } finally {
    if (proc.exitCode === null) {
      proc.kill();
    }
  }
});



