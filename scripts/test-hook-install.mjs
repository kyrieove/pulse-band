/**
 * settings.json hooks 合并 / 摘除的自检。
 * 跑法：node scripts/test-hook-install.mjs
 * 这段逻辑会改用户自己的 ~/.claude/settings.json —— 摘错了会毁掉他们别的 hook，所以必须有这个检查。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeHooks, removeHooks, HOOK_EVENTS } from '../src/main/services/claude-hook-merge.ts';
import { readSettings, writeSettings } from '../src/main/services/claude-hook-settings.ts';

const cmd = (event) => `"C:/Users/x/AppData/Roaming/Pulse/hook/pulse-hook.cmd" ${event}`;

// 用户原有的 hook：一个别人的 PreToolUse、一个我们完全没碰的事件
const existing = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"python.exe" "block.py"', timeout: 10 }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: '"python.exe" "replay.py"', timeout: 30 }] }],
};

const installed = mergeHooks(existing, cmd);

// 1. 4 个事件都装上了
for (const e of HOOK_EVENTS) {
  assert.equal(installed[e].filter((x) => x.hooks[0].command.includes('pulse-hook.cmd')).length, 1, `${e} 应有且只有一条我们的条目`);
}
// 2. 别人的条目原样保留
assert.equal(installed.PreToolUse[0].hooks[0].command, '"python.exe" "block.py"');
assert.deepEqual(installed.SessionEnd, existing.SessionEnd);
// 3. PreToolUse / PostToolUse 带 matcher，SessionStart / Stop 不带
assert.equal(installed.PreToolUse.at(-1).matcher, '*');
assert.equal(installed.SessionStart.at(-1).matcher, undefined);

// 4. 重复安装不堆积
const twice = mergeHooks(installed, cmd);
for (const e of HOOK_EVENTS) {
  assert.equal(twice[e].filter((x) => x.hooks[0].command.includes('pulse-hook.cmd')).length, 1, `${e} 重装后不应堆积`);
}

// 5. 卸载只摘我们的，别人的一个不动，空掉的事件键删除
const removed = removeHooks(twice);
assert.deepEqual(removed.PreToolUse, existing.PreToolUse);
assert.deepEqual(removed.SessionEnd, existing.SessionEnd);
assert.equal(removed.SessionStart, undefined, 'SessionStart 只有我们的条目，摘完应整键删除');
assert.equal(removed.Stop, undefined);
assert.equal(removed.PostToolUse, undefined);

// 6. 装了再卸，回到原样
assert.deepEqual(removeHooks(mergeHooks(existing, cmd)), existing);

// 7. 坏 JSON 必须报错，且不能碰用户的文件（旧实现吞掉解析错误 → 无条件覆盖 → 配置全丢）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-hook-test-'));
const p = path.join(tmpDir, 'settings.json');
const broken = '{ "hooks": {';
fs.writeFileSync(p, broken, 'utf8');

assert.throws(() => readSettings(p), /不是合法 JSON/, '坏 JSON 必须抛出，不能返回 {}');

let installedOk = false;
try {
  const settings = readSettings(p);
  settings.hooks = mergeHooks(settings.hooks ?? {}, cmd);
  writeSettings(p, settings);
  installedOk = true;
} catch {
  /* 预期路径：读失败 → 在写之前中止 */
}
assert.equal(installedOk, false, '坏 JSON 时安装必须失败');
assert.equal(fs.readFileSync(p, 'utf8'), broken, '坏 JSON 时文件内容必须逐字节保持不变');
assert.equal(fs.existsSync(`${p}.pulse-backup`), false, '读失败时不应留下备份');
assert.equal(fs.existsSync(`${p}.tmp`), false, '读失败时不应留下临时文件');

// 8. 备份只在第一次写，第二次安装不能冲掉原始配置
const original = JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2);
fs.writeFileSync(p, original, 'utf8');
writeSettings(p, { hooks: {} });
writeSettings(p, { hooks: {}, touched: true });
assert.equal(fs.readFileSync(`${p}.pulse-backup`, 'utf8'), original, '备份必须保留第一次安装前的原始内容');
assert.equal(fs.existsSync(`${p}.tmp`), false, '原子写不能把 .tmp 留在磁盘上');
assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { hooks: {}, touched: true }, '第二次写入应正常生效');

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ hook 合并/摘除自检通过（8 项）');
