// scripts/install-and-restore.mjs — 一次性流程：安装表盘 → 列表复核 → 恢复原表盘 → 复核 → 断开
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';

const coreJsonPath = path.join(process.env.LOCALAPPDATA, 'PulseDev', 'run', 'core.json');
const { port, token } = JSON.parse(fs.readFileSync(coreJsonPath, 'utf8'));

const filePath = process.argv[2];          // 表盘文件绝对路径
const restoreId = process.argv[3] || '120917423094'; // 安装完成后恢复为当前的表盘 ID
if (!filePath) { console.error('用法: node install-and-restore.mjs <文件绝对路径> [恢复ID]'); process.exit(1); }

const bytes = fs.readFileSync(filePath);
const md5 = crypto.createHash('md5').update(bytes).digest('hex');
const embedded = bytes.subarray(0x28, 0x28 + 12).toString('latin1').replace(/\0+$/, '').trim();
const validEmbedded = /^[a-zA-Z0-9_-]{1,12}$/.test(embedded) && !/^0+$/.test(embedded) && !embedded.startsWith('1209');
const explicitId = validEmbedded ? undefined : 'pulswf9';
console.log(`文件: ${filePath}\n大小=${bytes.length}B MD5=${md5} 内嵌ID=${embedded || '(空)'} → 使用ID=${explicitId ?? embedded}`);

const socket = net.createConnection({ host: '127.0.0.1', port }, async () => { try { await main(); } catch (e) { console.error('❌', e.message); socket.destroy(); process.exit(1); } });
const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
let reqId = 1; const pending = new Map();
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.messageType === 'event') return; if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} });
const rpc = (method, params = {}, timeoutMs = 300000) => new Promise((res, rej) => {
  const id = `r${reqId++}`; const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  socket.write(JSON.stringify({ id, method, params, token }) + '\n');
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = async () => (await rpc('device.watchface.list', {}, 30000)).result?.watchfaces || [];

async function main() {
  const st = await rpc('device.status');
  if (!st.result?.connected) { throw new Error('设备未连接（先 device.connect 或由脚本触发）'); }

  console.log('\n[1/4] 安装...');
  const inst = await rpc('device.watchface.install', { path: filePath, md5, ...(explicitId ? { id: explicitId } : {}) });
  if (!inst.ok) throw new Error(`安装失败: ${inst.error?.message}`);
  const newId = inst.result?.watchface_id;
  console.log(`   ✅ code=${inst.result?.result_code} (${inst.result?.result_code_meaning}) ID=${newId}`);

  console.log('[2/4] 列表复核新表盘...');
  const l1 = await list();
  const f1 = l1.find((w) => w.id === newId);
  if (!f1) throw new Error(`列表中未找到 ID=${newId}`);
  console.log(`   ✅ 「${f1.name}」已存在 (is_current=${f1.is_current})`);

  console.log(`[3/4] 恢复当前表盘 → ${restoreId}...`);
  const set = await rpc('device.watchface.set', { id: restoreId });
  if (!set.ok) throw new Error(`恢复失败: ${set.error?.message}`);
  console.log('   ✅ 设备已确认');

  console.log('[4/4] 最终列表复核...');
  const l2 = await list();
  const orig = l2.find((w) => w.id === restoreId);
  const fresh = l2.find((w) => w.id === newId);
  const ok = orig?.is_current && fresh && !fresh.is_current;
  console.log(`   当前=${l2.find((w) => w.is_current)?.name}(${l2.find((w) => w.is_current)?.id}) 新表盘 is_current=${fresh?.is_current}`);
  console.log(`\n${ok ? '🎉 全部完成：安装成功且已恢复原表盘' : '⚠️ 状态未达预期，请人工核对手环'}`);
  await rpc('device.disconnect', {}, 15000).catch(() => {});
  socket.destroy();
  process.exit(ok ? 0 : 1);
}
