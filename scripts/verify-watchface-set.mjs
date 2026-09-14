// scripts/verify-watchface-set.mjs
// 小米手环 10 表盘第二阶段（SET_WATCH_FACE type=4 id=1）真机验证脚本
//
// 流程：查列表 → 切换到目标表盘 → 列表复核 is_current → 切回原表盘（恢复现场）→ 再次复核。
// 判定只依据设备返回的列表数据，不把"已发送/已应答"当成功。

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
  console.error('👉 请先启动 Core: cargo run --manifest-path core/Cargo.toml --bin pulse-core -- --live');
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
    if (msg.messageType === 'event') return;
    if (msg.id && pendingCalls.has(msg.id)) {
      const { resolve } = pendingCalls.get(msg.id);
      pendingCalls.delete(msg.id);
      resolve(msg);
    }
  } catch (e) {
    // 忽略非 JSON 行
  }
});

function rpcCall(method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const id = `req_${reqId++}`;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`RPC ${method} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    pendingCalls.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
    const payload = JSON.stringify({ id, method, params, token }) + '\n';
    socket.write(payload);
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchList() {
  const resp = await rpcCall('device.watchface.list', {}, 30000);
  if (!resp.ok) throw new Error(`获取表盘列表失败: ${resp.error?.message || '未知错误'}`);
  return resp.result?.watchfaces || [];
}

async function setCurrent(id) {
  const resp = await rpcCall('device.watchface.set', { id }, 60000);
  return resp;
}

function summary(items) {
  const cur = items.find((i) => i.is_current);
  return cur ? `${cur.name}(${cur.id})` : '无 is_current 项';
}

async function runVerification() {
  console.log('1. 查询当前设备连接状态...');
  const statusResp = await rpcCall('device.status');
  if (!statusResp.result?.connected) {
    console.log('   设备未连接，发送 device.connect (手环需处于: 设置 → 系统操作 → 连接新手机)');
    await rpcCall('device.connect');
    let connected = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const poll = await rpcCall('device.status');
      if (poll.result?.connected) {
        connected = true;
        console.log('   ✅ 设备已连接且认证成功！');
        break;
      }
      process.stdout.write(`   等待认证中... (${i + 1}/30s)\r`);
    }
    console.log('');
    if (!connected) throw new Error('设备连接与认证超时，请确认手环是否处于「连接新手机」就绪态');
  } else {
    console.log('   ✅ 设备当前已处于连接就绪态');
  }

  console.log('2. 查询已安装表盘列表，确定原表盘与目标表盘...');
  const before = await fetchList();
  const original = before.find((i) => i.is_current);
  if (!original) throw new Error('列表中没有任何 is_current=true 的表盘，无法确定恢复基准');
  const target = before.find((i) => !i.is_current && i.id !== original.id);
  if (!target) throw new Error('列表中没有可用于切换的其他表盘');
  console.log(`   原当前表盘: ${original.name} (${original.id})`);
  console.log(`   切换目标:   ${target.name} (${target.id})`);

  console.log(`3. 下发 SET_WATCH_FACE (type=4, id=1) 目标=${target.id}...`);
  const setResp = await setCurrent(target.id);
  if (!setResp.ok) {
    throw new Error(`SET_WATCH_FACE 失败: ${setResp.error?.message || '未知错误'}`);
  }
  console.log(`   ✅ Core 返回设备侧确认: ${setResp.result?.watchface?.name} is_current=${setResp.result?.watchface?.is_current}`);

  console.log('4. 独立复核：重新查询列表验证 is_current 已切换...');
  const after = await fetchList();
  const afterTarget = after.find((i) => i.id === target.id);
  const afterOriginal = after.find((i) => i.id === original.id);
  const switched = afterTarget?.is_current === true && afterOriginal?.is_current === false;
  console.log(`   切换后当前表盘: ${summary(after)}`);
  console.log(`   目标 is_current=${afterTarget?.is_current} / 原表盘 is_current=${afterOriginal?.is_current} → ${switched ? '✅ 切换生效' : '❌ 切换未生效'}`);

  let restored = false;
  if (switched) {
    console.log(`5. 恢复现场：切回原表盘 ${original.id}...`);
    const restoreResp = await setCurrent(original.id);
    if (restoreResp.ok) {
      const restoredList = await fetchList();
      const rOriginal = restoredList.find((i) => i.id === original.id);
      const rTarget = restoredList.find((i) => i.id === target.id);
      restored = rOriginal?.is_current === true && rTarget?.is_current === false;
      console.log(`   恢复后当前表盘: ${summary(restoredList)} → ${restored ? '✅ 已恢复' : '❌ 未恢复'}`);
    } else {
      console.error(`   ❌ 恢复失败: ${restoreResp.error?.message || '未知错误'}`);
    }
  }

  console.log('6. 释放设备链路...');
  await rpcCall('device.disconnect', {}, 15000).catch(() => {});

  console.log('\n========================================');
  console.log('验证结论:');
  console.log(`  SET_WATCH_FACE 切换: ${switched ? 'PASS (设备列表 is_current 复核通过)' : 'FAIL'}`);
  console.log(`  恢复原表盘:         ${restored ? 'PASS' : switched ? 'FAIL (手环仍停留在目标表盘，请手动切回或重跑脚本)' : 'SKIP (切换未成功，无需恢复)'}`);
  console.log('========================================\n');

  socket.destroy();
  process.exit(switched && restored ? 0 : 1);
}
