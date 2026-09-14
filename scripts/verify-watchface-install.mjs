// scripts/verify-watchface-install.mjs
// 小米手环 10 表盘整包安装（PREPARE type=4 id=4 → Mass dataType=16 → REPORT_INSTALL_RESULT id=5）
// 真机验证脚本：对 watch-face/ 目录下的表盘文件逐个安装，并以 GET_INSTALLED_LIST 复核。
//
// 判定只依据设备上报结果码与设备返回列表，不把"已发送/已应答"当成功。
// 内嵌 ID 为 1209 商店前缀或非法时，自动改用自定义 ID 安装（同上游 ID 改写语义）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('❌ LOCALAPPDATA 环境变量不存在');
  process.exit(1);
}

const watchfaceDir = process.argv[2] || path.join(process.cwd(), 'watch-face');
const runDir = path.join(localAppData, 'PulseDev', 'run');
const coreJsonPath = path.join(runDir, 'core.json');

if (!fs.existsSync(coreJsonPath)) {
  console.error('❌ 未检测到运行中的 pulse-core (core.json 不存在)');
  console.error('👉 请先启动 Core: core/target/debug/pulse-core.exe --live');
  process.exit(1);
}

function analyzeFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const isVela = bytes[0] === 0x5a && bytes[1] === 0xa5 && bytes[2] === 0x34 && bytes[3] === 0x12;
  if (!isVela) {
    return { error: `不是 Vela 表盘裸二进制（魔数 ${bytes.subarray(0, 4).toString('hex').toUpperCase()}）` };
  }
  if (bytes.length < 0x34) {
    return { error: `文件过短 (${bytes.length}B)，不足 0x34` };
  }
  const embedded = bytes.subarray(0x28, 0x28 + 12).toString('latin1').replace(/\0+$/, '').trim();
  const valid = /^[a-zA-Z0-9_-]{1,12}$/.test(embedded);
  const storePrefix = embedded.startsWith('1209');
  return {
    bytes,
    size: bytes.length,
    md5: crypto.createHash('md5').update(bytes).digest('hex'),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    embeddedId: embedded || null,
    validEmbedded: valid && !storePrefix,
    storePrefix,
  };
}

const coreInfo = JSON.parse(fs.readFileSync(coreJsonPath, 'utf8'));
const { port, token } = coreInfo;
console.log(`🔌 连接本地 Core RPC 端口: ${port}`);

const socket = net.createConnection({ host: '127.0.0.1', port }, async () => {
  try {
    await runVerification();
  } catch (err) {
    console.error('❌ 验证过程失败:', err.message);
    socket.destroy();
    process.exit(1);
  }
});

const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
let reqId = 1;
const pendingCalls = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.messageType === 'event') return;
    if (msg.id && pendingCalls.has(msg.id)) {
      pendingCalls.get(msg.id)(msg);
      pendingCalls.delete(msg.id);
    }
  } catch {
    // 忽略非 JSON 行
  }
});

function rpcCall(method, params = {}, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const id = `req_${reqId++}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`RPC ${method} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    pendingCalls.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    socket.write(JSON.stringify({ id, method, params, token }) + '\n');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectDevice() {
  const status = await rpcCall('device.status');
  if (status.result?.connected) {
    console.log('✅ 设备已连接');
    return;
  }
  console.log('设备未连接，device.connect（手环需处于: 设置 → 系统操作 → 连接新手机）');
  await rpcCall('device.connect');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const poll = await rpcCall('device.status');
    if (poll.result?.connected) {
      console.log('✅ 连接与认证成功');
      return;
    }
    process.stdout.write(`   等待认证中... (${i + 1}/30s)\r`);
  }
  console.log('');
  throw new Error('设备连接与认证超时');
}

async function fetchList() {
  const resp = await rpcCall('device.watchface.list', {}, 30000);
  if (!resp.ok) throw new Error(`获取表盘列表失败: ${resp.error?.message || '未知错误'}`);
  return resp.result?.watchfaces || [];
}

async function runVerification() {
  await connectDevice();

  const files = fs.readdirSync(watchfaceDir).filter((f) => f.toLowerCase().endsWith('.bin'));
  if (files.length === 0) throw new Error(`${watchfaceDir} 下没有 .bin 表盘文件`);

  const before = await fetchList();
  console.log(`\n安装前设备已有 ${before.length} 项表盘，开始逐个安装 (${files.length} 个文件)...\n`);
  const results = [];

  for (let i = 0; i < files.length; i++) {
    const name = files[i];
    const filePath = path.join(watchfaceDir, name);
    const info = analyzeFile(filePath);
    console.log(`---- [${i + 1}/${files.length}] ${name}`);
    if (info.error) {
      console.log(`   ⚠️ 跳过: ${info.error}`);
      results.push({ name, status: 'SKIP', detail: info.error });
      continue;
    }
    console.log(`   大小=${info.size}B MD5=${info.md5}`);
    console.log(`   内嵌ID=${info.embeddedId ?? '(空)'} ${info.storePrefix ? '(1209 商店前缀)' : ''}`);

    let explicitId;
    if (!info.validEmbedded) {
      explicitId = `pulswf${i + 1}`;
      console.log(`   → 改用自定义 ID 安装: ${explicitId}`);
    }

    const resp = await rpcCall('device.watchface.install', {
      path: filePath,
      md5: info.md5,
      ...(explicitId ? { id: explicitId } : {}),
    });

    if (!resp.ok) {
      const msg = resp.error?.message || '未知错误';
      console.log(`   ❌ 安装失败: ${msg}`);
      results.push({ name, status: 'FAIL', detail: msg, id: explicitId ?? info.embeddedId });
      continue;
    }

    const installedId = resp.result?.watchface_id;
    const code = resp.result?.result_code;
    const meaning = resp.result?.result_code_meaning;
    console.log(`   ✅ 设备上报结果: code=${code} (${meaning})，ID=${installedId}`);

    // 独立复核：重新查列表确认已存在
    const after = await fetchList();
    const found = after.find((w) => w.id === installedId);
    if (found) {
      console.log(`   ✅ 列表复核: 「${found.name}」已在设备中 (is_current=${found.is_current})`);
      results.push({ name, status: 'PASS', id: installedId, code, meaning, deviceName: found.name });
    } else {
      console.log(`   ⚠️ 列表复核未找到 ID=${installedId}（结果码已确认，但列表缺失）`);
      results.push({ name, status: 'VERIFY_MISSING', id: installedId, code });
    }
  }

  console.log('\n========================================');
  console.log('安装结论:');
  for (const r of results) {
    const tag = { PASS: '✅', FAIL: '❌', SKIP: '⚠️', VERIFY_MISSING: '⚠️' }[r.status];
    console.log(`  ${tag} ${r.name}: ${r.status}${r.id ? ` (ID=${r.id})` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const pass = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n通过 ${pass}/${results.length}${pass === results.length ? ' 🎉 传输链路全通' : ''}`);
  console.log('========================================\n');

  await rpcCall('device.disconnect', {}, 15000).catch(() => {});
  socket.destroy();
  process.exit(pass === results.length ? 0 : 1);
}
