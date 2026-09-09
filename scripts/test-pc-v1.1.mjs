import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

// 记录真实环境状态元数据（只记录存在性、大小与修改时间，严禁读取/解析真实文件内容）
const REAL_RUN_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
  'PulseDev',
  'run',
);
const REAL_CORE_FILE = path.join(REAL_RUN_DIR, 'core.json');
const REAL_DEVICE_FILE = path.join(REAL_RUN_DIR, 'device.json');
const INITIAL_CORE_EXISTS = fs.existsSync(REAL_CORE_FILE);
const INITIAL_CORE_STAT = INITIAL_CORE_EXISTS ? fs.statSync(REAL_CORE_FILE) : null;
const INITIAL_DEVICE_EXISTS = fs.existsSync(REAL_DEVICE_FILE);
const INITIAL_DEVICE_STAT = INITIAL_DEVICE_EXISTS ? fs.statSync(REAL_DEVICE_FILE) : null;

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
    'authkey=0123456789abcdef0123456789abcdef token=abc123 00:11:22:33:44:55 C:\\Users\\TestUser\\secret.log';
  const output = redactSupportText(input);
  assert.doesNotMatch(output, /0123456789abcdef|abc123|00:11:22:33:44:55|TestUser/);
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

test('package.json extraResources configures pulse-core.exe packaging', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const extraResources = pkg?.build?.extraResources || [];
  const target = extraResources.find(
    (item) => item.from === 'core/target/release/pulse-core.exe' && item.to === 'pulse-core.exe',
  );
  assert.ok(target, 'package.json build.extraResources 必须配置 pulse-core.exe 打包');
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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-port-test-'));
  const epDir = path.join(tempDir, 'PulseDev', 'run');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'core.json');

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

    const client = new OronBoxClient({ endpointFile: epFile });

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
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('OronBoxClient: recovers band connection intent after daemon restart and respects explicit disconnect', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-intent-test-'));
  const epDir = path.join(tempDir, 'PulseDev', 'run');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'core.json');

  const createMockDaemon = (pid) => {
    const receivedMethods = [];
    const sockets = new Set();
    let statusResponse = { connected: false, protocolState: 'disconnected', device: null };
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', (data) => {
        for (const line of data.toString('utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line);
            receivedMethods.push(req.method);
            if (req.method === 'daemon.info') {
              socket.write(
                JSON.stringify({
                  id: req.id,
                  ok: true,
                  result: {
                    protocolVersion: 6,
                    pid,
                    platform: 'windows',
                    endpoint: `127.0.0.1:${server.address().port}`,
                    uptimeSeconds: 1,
                  },
                }) + '\n',
              );
            } else if (req.method === 'device.connect') {
              statusResponse = { connected: true, protocolState: 'connected' };
              socket.write(
                JSON.stringify({
                  id: req.id,
                  ok: true,
                  result: statusResponse,
                }) + '\n',
              );
            } else if (req.method === 'device.disconnect') {
              statusResponse = { connected: false, protocolState: 'disconnected' };
              socket.write(
                JSON.stringify({
                  id: req.id,
                  ok: true,
                  result: statusResponse,
                }) + '\n',
              );
            } else if (req.method === 'device.status') {
              socket.write(
                JSON.stringify({
                  id: req.id,
                  ok: true,
                  result: statusResponse,
                }) + '\n',
              );
            }
          } catch {}
        }
      });
    });

    return {
      server,
      receivedMethods,
      closeSockets: () => {
        for (const s of sockets) s.destroy();
      },
    };
  };

  const dummy1 = spawn('node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const dummy2 = spawn('node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const dummy3 = spawn('node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });

  const d1 = createMockDaemon(dummy1.pid);
  const d2 = createMockDaemon(dummy2.pid);
  const d3 = createMockDaemon(dummy3.pid);

  await new Promise((r) => d1.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => d2.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => d3.server.listen(0, '127.0.0.1', r));

  let client = null;
  try {
    // 1. 旧 daemon 写入端点
    fs.writeFileSync(
      epFile,
      JSON.stringify({
        port: d1.server.address().port,
        token: 'token_d1',
        pid: dummy1.pid,
        protocolVersion: 6,
      }),
    );

    client = new OronBoxClient({ endpointFile: epFile });
    const connected1 = await client.connectIfRunning();
    assert.equal(connected1, true, '连上旧 daemon');
    assert.equal(client.bandConnectionDesired, false, '初始连接意图为 false');

    // 2. 旧 daemon 收到 device.connect
    const connRes = await client.call('device.connect');
    assert.equal(connRes.connected, true);
    assert.equal(client.bandConnectionDesired, true, 'device.connect 成功后意图置为 true');
    assert.ok(d1.receivedMethods.includes('device.connect'), '旧 daemon 收到 device.connect');

    // 3. 旧 daemon 被终止，新端点 (d2) 出现
    fs.writeFileSync(
      epFile,
      JSON.stringify({
        port: d2.server.address().port,
        token: 'token_d2',
        pid: dummy2.pid,
        protocolVersion: 6,
      }),
    );
    dummy1.kill();
    d1.closeSockets();
    d1.server.close();

    // 等待 client 自动重连上新 daemon 并补发 device.connect
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (d2.receivedMethods.includes('device.connect')) break;
    }

    assert.ok(d2.receivedMethods.includes('daemon.info'), '新 daemon 收到协议校验请求');
    assert.ok(
      d2.receivedMethods.includes('device.connect'),
      '旧 daemon 崩溃重启后，客户端自动向新 daemon 补发 device.connect',
    );
    assert.equal(client.bandConnectionDesired, true, '连接意图依然保持 true');

    // 4. 用户主动调用 device.disconnect
    const disconnRes = await client.call('device.disconnect');
    assert.equal(disconnRes.connected, false);
    assert.equal(client.bandConnectionDesired, false, 'device.disconnect 成功后意图置为 false');
    assert.ok(d2.receivedMethods.includes('device.disconnect'), '新 daemon 收到 device.disconnect');

    // 5. 再次重启 daemon，验证主动 disconnect 后新 daemon 启动不收到 device.connect
    fs.writeFileSync(
      epFile,
      JSON.stringify({
        port: d3.server.address().port,
        token: 'token_d3',
        pid: dummy3.pid,
        protocolVersion: 6,
      }),
    );
    dummy2.kill();
    d2.closeSockets();
    d2.server.close();

    // 等待 client 重连上 d3
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (d3.receivedMethods.includes('daemon.info')) break;
    }
    assert.ok(d3.receivedMethods.includes('daemon.info'), 'daemon 3 收到协议校验请求');
    await sleep(400); // 留出足够时间确认没有多余补发
    assert.equal(
      d3.receivedMethods.includes('device.connect'),
      false,
      '主动调用 device.disconnect 后重启，新 daemon 不收到 device.connect',
    );

    client.dispose();
    assert.equal(client.bandConnectionDesired, false, 'dispose 后意图重置为 false');
  } finally {
    client?.dispose();
    dummy1.kill();
    dummy2.kill();
    dummy3.kill();
    d1.closeSockets();
    d2.closeSockets();
    d3.closeSockets();
    d1.server.close();
    d2.server.close();
    d3.server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('OronBoxClient: when same daemon survives transient RPC drop, checks device.status before reconnecting', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-same-daemon-test-'));
  const epDir = path.join(tempDir, 'PulseDev', 'run');
  fs.mkdirSync(epDir, { recursive: true });
  const epFile = path.join(epDir, 'core.json');

  const dummy = spawn('node', ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const receivedMethods = [];
  let activeSocket = null;
  let currentDeviceState = 'disconnected';

  const server = net.createServer((socket) => {
    activeSocket = socket;
    socket.on('data', (data) => {
      for (const line of data.toString('utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          receivedMethods.push(req.method);
          if (req.method === 'daemon.info') {
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result: {
                  protocolVersion: 6,
                  pid: dummy.pid,
                  platform: 'windows',
                  endpoint: `127.0.0.1:${server.address().port}`,
                  uptimeSeconds: 1,
                },
              }) + '\n',
            );
          } else if (req.method === 'device.connect') {
            currentDeviceState = 'connected';
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result: { connected: true, protocolState: 'connected' },
              }) + '\n',
            );
          } else if (req.method === 'device.status') {
            socket.write(
              JSON.stringify({
                id: req.id,
                ok: true,
                result: {
                  connected: currentDeviceState === 'connected',
                  protocolState: currentDeviceState,
                },
              }) + '\n',
            );
          }
        } catch {}
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  let client = null;
  try {
    fs.writeFileSync(
      epFile,
      JSON.stringify({
        port: server.address().port,
        token: 'token_same',
        pid: dummy.pid,
        protocolVersion: 6,
      }),
    );

    client = new OronBoxClient({ endpointFile: epFile });
    await client.connectIfRunning();
    await client.call('device.connect');
    assert.equal(client.bandConnectionDesired, true);

    // 场景 A: 原 daemon 仍存活，手环状态依然是 connected。RPC 短暂断线重连后先查 device.status，不重发 device.connect
    receivedMethods.length = 0;
    activeSocket.destroy(); // 仅断开 RPC 连接

    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (receivedMethods.includes('device.status')) break;
    }
    assert.ok(receivedMethods.includes('daemon.info'));
    assert.ok(receivedMethods.includes('device.status'), '同 PID 重连后先查 device.status');
    await sleep(300);
    assert.equal(
      receivedMethods.filter((m) => m === 'device.connect').length,
      0,
      '手环已在 connected 状态，不重复发送 device.connect',
    );

    // 场景 B: 原 daemon 仍存活，但手环已处于 disconnected。RPC 短暂断线重连后查到 disconnected，补发一次 device.connect
    currentDeviceState = 'disconnected';
    receivedMethods.length = 0;
    activeSocket.destroy();

    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if (receivedMethods.includes('device.connect')) break;
    }
    assert.ok(receivedMethods.includes('device.status'));
    assert.ok(receivedMethods.includes('device.connect'), '手环处于 disconnected 时补发 device.connect');

    client.dispose();
  } finally {
    client?.dispose();
    dummy.kill();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('pulse-core --live: starts in disconnected state and exits cleanly on daemon.stop (isolated)', async () => {
  const coreExe = path.resolve('core/target/release/pulse-core.exe');
  if (!fs.existsSync(coreExe)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-live-test-'));
  const epDir = path.join(tempDir, 'PulseDev', 'run');
  const epFile = path.join(epDir, 'core.json');

  // 严禁在隔离目录创建 device.json，确保不读取真实凭据
  assert.equal(fs.existsSync(path.join(epDir, 'device.json')), false);

  const proc = spawn(coreExe, ['--live'], {
    env: { ...process.env, LOCALAPPDATA: tempDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let ep = null;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      try {
        ep = JSON.parse(fs.readFileSync(epFile, 'utf-8'));
        if (ep?.port) break;
      } catch {}
    }
    assert.ok(ep?.port, 'pulse-core --live 成功启动并写入隔离端点');

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

    // 1. 验证仅启动 daemon、未调用 device.connect 时，保持 Disconnected，不建立物理蓝牙连接
    const st0 = await callRpc('device.status');
    assert.equal(st0.result.connected, false, '启动后未收到 connect 请求前 connected=false');
    assert.equal(st0.result.protocolState, 'disconnected', '启动后 protocolState 为 disconnected');
    assert.equal(st0.result.device, null, '未连接时 device 为 null（不伪造假设备）');

    // 保持静默 1.2 秒，确认状态未发生自发改变（不主动连接手环）
    await sleep(1200);
    const st1 = await callRpc('device.status');
    assert.equal(st1.result.connected, false);
    assert.equal(st1.result.protocolState, 'disconnected');

    // 2. 严禁在此调用会触发 RFCOMM 连接的 device.connect；直接验证 daemon.stop 干净退出
    await callRpc('daemon.stop');
    await sleep(500);
    assert.equal(proc.exitCode, 0, 'daemon.stop 后进程退出码为 0');
    assert.equal(fs.existsSync(epFile), false, 'daemon.stop 后端点文件已清理');
    client.destroy();
  } finally {
    if (proc.exitCode === null) {
      proc.kill();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('audit: real environment files (%LOCALAPPDATA%/PulseDev/run) were not modified or deleted', () => {
  assert.equal(
    fs.existsSync(REAL_CORE_FILE),
    INITIAL_CORE_EXISTS,
    '真实 core.json 存在性未被改变',
  );
  if (INITIAL_CORE_EXISTS && INITIAL_CORE_STAT) {
    const stat = fs.statSync(REAL_CORE_FILE);
    assert.equal(stat.size, INITIAL_CORE_STAT.size, '真实 core.json size 未被改变');
    assert.equal(stat.mtimeMs, INITIAL_CORE_STAT.mtimeMs, '真实 core.json mtime 未被改变');
  }
  assert.equal(
    fs.existsSync(REAL_DEVICE_FILE),
    INITIAL_DEVICE_EXISTS,
    '真实 device.json 存在性未被改变',
  );
  if (INITIAL_DEVICE_EXISTS && INITIAL_DEVICE_STAT) {
    const currentStat = fs.statSync(REAL_DEVICE_FILE);
    assert.equal(currentStat.size, INITIAL_DEVICE_STAT.size, '真实 device.json size 未被改变');
    assert.equal(currentStat.mtimeMs, INITIAL_DEVICE_STAT.mtimeMs, '真实 device.json mtime 未被改变');
  }
});



