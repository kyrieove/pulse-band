// scripts/verify-watchface-list.mjs
// 小米手环 10 表盘第一阶段（GET_INSTALLED_LIST 只读）真机验证脚本

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';

const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error('❌ LOCALAPPDATA 环境变量不存在');
  process.exit(1);
}

const runDir = path.join(localAppData, 'PulseDev', 'run');
const coreJsonPath = path.join(runDir, 'core.json');

if (!fs.existsSync(coreJsonPath)) {
  console.error('❌ 未检测到运行中的 pulse-core (core.json 不存在)');
  console.error('👉 请先在终端启动 Core:');
  console.error('   cargo run --manifest-path core/Cargo.toml --bin pulse-core -- --live');
  process.exit(1);
}

let coreInfo;
try {
  coreInfo = JSON.parse(fs.readFileSync(coreJsonPath, 'utf8'));
} catch (e) {
  console.error('❌ 解析 core.json 失败:', e.message);
  process.exit(1);
}

const { port, token } = coreInfo;
console.log(`🔌 连接本地 Core RPC 端口: ${port}`);

const socket = net.createConnection({ host: '127.0.0.1', port }, async () => {
  console.log('✅ TCP 连接成功，正在进行 RPC 通信...');
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
    if (msg.messageType === 'event') {
      if (msg.event === 'device.state') {
        console.log(`📡 [事件] 设备状态: state=${msg.state} connecting=${msg.connecting} err=${msg.error || '无'}`);
      }
      return;
    }
    if (msg.id && pendingCalls.has(msg.id)) {
      const { resolve } = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      resolve(msg);
    }
  } catch (e) {
    // 忽略非 JSON 行
  }
});

function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `req_${reqId++}`;
    pendingCalls.set(id, { resolve, reject });
    const payload = JSON.stringify({ id, method, params, token }) + '\n';
    socket.write(payload);
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runVerification() {
  console.log('1. 查询当前设备连接状态...');
  const statusResp = await rpcCall('device.status');
  console.log('   当前设备状态:', JSON.stringify(statusResp.result));

  if (!statusResp.result?.connected) {
    console.log('2. 设备未连接，发送 device.connect 触发真机 RFCOMM 连接与认证...');
    console.log('   (请确保小米手环 10 已进入: 设置 → 系统操作 → 连接新手机)');
    await rpcCall('device.connect');

    let connected = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const poll = await rpcCall('device.status');
      if (poll.result?.connected) {
        connected = true;
        console.log('   ✅ 设备已连接且认证成功！');
        break;
      }
      process.stdout.write(`   等待认证中... (${i + 1}/20s)\r`);
    }
    console.log('');
    if (!connected) {
      throw new Error('设备连接与认证超时，请确认手环是否处于「连接新手机」就绪态');
    }
  } else {
    console.log('   ✅ 设备当前已处于连接就绪态');
  }

  console.log('3. 下发 GET_INSTALLED_LIST (type=4, id=0) 查询表盘列表...');
  const listResp = await rpcCall('device.watchface.list');
  console.log('   RPC 返回结果:', JSON.stringify(listResp));

  if (!listResp.ok) {
    throw new Error(`获取表盘列表失败: ${listResp.error?.message || '未知错误'}`);
  }

  const watchfaces = listResp.result?.watchfaces || [];
  console.log(`\n🎉 成功取得真机表盘列表！共 ${watchfaces.length} 项表盘：`);
  console.log('--------------------------------------------------------------------------------');
  console.log('| 表盘 ID       | 名称                 | 当前使用 | 可删除 | 版本号   | 可编辑 |');
  console.log('--------------------------------------------------------------------------------');
  for (const wf of watchfaces) {
    const id = (wf.id || '').padEnd(13);
    const name = (wf.name || '').padEnd(20);
    const current = wf.is_current ? ' 是 ' : ' 否 ';
    const canRemove = wf.can_remove ? ' 是 ' : ' 否 ';
    const version = String(wf.version_code || 0).padEnd(8);
    const canEdit = wf.can_edit ? ' 是 ' : ' 否 ';
    console.log(`| ${id} | ${name} | ${current}   | ${canRemove} | ${version} | ${canEdit} |`);
  }
  console.log('--------------------------------------------------------------------------------\n');

  console.log('4. 验证完成，优雅释放连接...');
  await rpcCall('device.disconnect');
  console.log('✅ 已释放设备链路');

  socket.destroy();
  process.exit(0);
}
