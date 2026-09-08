// 冒烟测试:直接对 pulse-core --fake 走一遍 RPC 往返(不经过 Electron)。
// 客户端行为按 oronbox-client.ts 的线协议手工模拟。
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const CORE = 'C:\\dev\\pulse-band2\\core\\target\\release\\pulse-core.exe';
const EP = process.env.LOCALAPPDATA + '\\PulseDev\\run\\core.json';
const REC = process.env.LOCALAPPDATA + '\\PulseDev\\run\\last-fetch-response.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) failures++;
};

// 0. 清理上次状态
fs.rmSync(EP, { force: true });
fs.rmSync(REC, { force: true });

// 1. 启动 core
const core = spawn(CORE, ['--fake'], { stdio: ['ignore', 'pipe', 'pipe'] });
core.stdout.on('data', (d) => process.stdout.write('[core] ' + d));
core.stderr.on('data', (d) => process.stdout.write('[core] ' + d));

let ep = null;
for (let i = 0; i < 50 && !ep; i++) {
  await sleep(100);
  try { ep = JSON.parse(fs.readFileSync(EP, 'utf-8')); } catch {}
}
ok(ep && Number.isInteger(ep.port) && typeof ep.token === 'string', '端点文件出现且字段齐全');
ok(ep?.protocolVersion === 6, '端点文件 protocolVersion=6');
if (!ep) { core.kill(); process.exit(1); }

// 2. 连接 + daemon.info
const sock = net.connect(ep.port, '127.0.0.1');
const lines = [];
let buf = '';
sock.on('data', (d) => {
  buf += d.toString('utf-8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (l) lines.push(JSON.parse(l));
  }
});
await new Promise((r) => sock.once('connect', r));
let seq = 0;
const pending = new Map();
const call = (method, params = {}, token = ep.token) =>
  new Promise((resolve) => {
    const id = 'r' + ++seq;
    pending.set(id, resolve);
    sock.write(JSON.stringify({ id, method, params, token }) + '\n');
  });
sock.on('data', () => {
  for (const l of lines.splice(0)) {
    if (l.messageType === 'event') events.push(l);
    else pending.get(l.id)?.(l);
  }
});
const events = [];
sock.on('error', () => { /* daemon.stop 的 FIN/退出时序里可能出现,不影响已收到的行 */ });

const info = await call('daemon.info');
ok(info.ok === true && info.result.protocolVersion === 6, 'daemon.info 返回 protocolVersion=6');
ok(typeof info.result.pid === 'number' && typeof info.result.platform === 'string', 'daemon.info 带 pid/platform');

const bad = await call('daemon.info', {}, 'wrong-token');
ok(bad.ok === false && bad.error?.code === 'unauthorized', '错误 token 被拒');

// 3. device.connect → 状态事件 + 握手事件
const st0 = await call('device.status');
ok(st0.result.connected === false, '连接前 device.status connected=false');

await call('device.connect');
await sleep(700); // connecting(0ms) → ready(250ms) → 握手(350ms)
const states = events.filter((e) => e.event === 'device.state');
ok(states.some((e) => e.state.protocolState === 'connecting'), '发了 connecting 事件');
const ready = states.find((e) => e.state.protocolState === 'ready');
ok(!!ready, '发了 ready 事件');
ok(ready?.state.currentDevice?.name === 'PulseDev Fake Band' && ready.state.currentDevice.disconnected === false, 'ready 事件带 currentDevice 且 disconnected=false');
ok(!JSON.stringify(ready).toLowerCase().includes('authkey'), 'device.state 事件不含 authkey(不复刻 OronBox 缺陷)');
const hs = events.find((e) => e.event === 'device.interconnect');
ok(!!hs && hs.packageName === 'com.codeisland.band', '发了 device.interconnect 事件,packageName 正确');
const hsPacket = hs ? JSON.parse(Buffer.from(hs.payload).toString('utf-8')) : null;
ok(hsPacket?.tag === '__hs__' && hsPacket.count === 0 && hsPacket.caps?.version === 3, '握手包形状与 band-app 一致');

// 4. 模拟客户端回握手 → 应收到 fetch 请求
await call('device.interconnect.send', {
  package: 'com.codeisland.band',
  payload: Array.from(Buffer.from(JSON.stringify({ tag: '__hs__', count: 1, caps: { version: 3, chunk: true, maxChunkSize: 768, encodings: ['base64', 'text', 'hex'], compressions: ['none'], ack: true, ackWindow: 4 } }))),
});
await sleep(200);
const fetchReq = events.filter((e) => e.event === 'device.interconnect').map((e) => JSON.parse(Buffer.from(e.payload).toString('utf-8'))).find((p) => p.tag === 'fetch');
ok(!!fetchReq, '握手应答后发了 fetch 请求');
ok(fetchReq?.url === 'http://127.0.0.1:8765/api/status/compact?all=1' && fetchReq.options?.method === 'GET', 'fetch 请求 URL/method 与真机一致');
ok(fetchReq?.options && !('headers' in fetchReq.options), 'fetch 请求 options 形状照抄 icFetch');

// 5. 模拟客户端回 fetch 响应(带合规额度字段)
await call('device.interconnect.send', {
  package: 'com.codeisland.band',
  payload: Array.from(Buffer.from(JSON.stringify({
    tag: 'fetch', id: fetchReq.id,
    resp: { ok: true, status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, raw: false,
      body: JSON.stringify({ ts: Date.now(), sessions: { claude: { status: null, tool: null }, codex: { status: null, tool: null }, antigravity: { status: null, tool: null } },
        limits: { claude: { pct5h: 62, pct7d: 38, level5h: 'normal', level7d: 'normal', resetText: '2h', reset7dText: null, authoritative: true }, codex: null, antigravity: null } }) },
  }))),
});
await sleep(300);
const rec = JSON.parse(fs.readFileSync(REC, 'utf-8'));
for (const c of rec.checks) if (!c.passed) console.log('  断言失败:', c.name, '|', c.detail);
ok(rec.passed === true, '合规响应通过全部断言(last-fetch-response.json passed=true)');
ok(Array.isArray(rec.checks) && rec.checks.every((c) => c.passed), '每一条断言都 PASS: ' + rec.checks.map((c) => c.name).join(' / '));

// 6. 坏响应:id 不匹配 → FAIL
await call('device.interconnect.send', {
  package: 'com.codeisland.band',
  payload: Array.from(Buffer.from(JSON.stringify({ tag: 'fetch', id: 'r999', resp: { ok: false, status: 0, statusText: 'x', headers: {}, body: 'not json', raw: false } }))),
});
await sleep(300);
const rec2 = JSON.parse(fs.readFileSync(REC, 'utf-8'));
ok(rec2.passed === false, '坏响应(id 不匹配/ok=false/body 非 JSON)被断言拦下');

// 7. settings.set / plugin.list 降级
const ss = await call('settings.set', { key: 'auto_reconnect', value: false });
ok(ss.ok === true, 'settings.set 返回 ok(它在 ensureReady 里没有 try/catch)');
const pl = await call('plugin.list', { includeIcons: false });
ok(pl.ok === true && Array.isArray(pl.result) && pl.result.length === 0, 'plugin.list 返回空列表');
const po = await call('plugin.open', { id: 'x' });
ok(po.ok === false && po.error?.code === 'method_not_found', 'plugin.open 报 method_not_found');
const sync = await call('device.sync.time');
ok(sync.ok === false && sync.error?.code === 'method_not_found', 'device.sync.time 报 method_not_found(禁止实现)');

// 8. daemon.stop
await call('daemon.stop');
await sleep(500);
ok(core.exitCode === 0, 'daemon.stop 后进程干净退出(exitCode=0)');
ok(!fs.existsSync(EP), '端点文件已删除');
sock.destroy();

console.log(failures === 0 ? '\nSMOKE: ALL PASS' : `\nSMOKE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
