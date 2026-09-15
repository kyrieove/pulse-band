/**
 * tailer 半行处理自检：写入方还在写的时候，读取方不能把尾部那半行吃掉。
 * 跑法：node scripts/test-tailer-partial-line.mjs
 *
 * 两个 tailer 都是「每 500ms 读一次 + 把位置推进到 stat.size」。如果读取时对方正写到一半，
 * 尾部那半行 JSON.parse 必然失败，而位置已经推到文件末尾 —— 这一行永远不会再被读，
 * 会话开始 / 结束事件就这样漏掉；多字节 UTF-8 被切在读取边界上还会变成乱码。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeDesktopTailer } from '../src/main/services/claude-desktop-tailer.ts';
import { CodexSessionTailer } from '../src/main/services/codex-tailer.ts';

/** 假 SessionManager：只记录调用，不碰真实状态 */
const makeSM = () => {
  const calls = [];
  return {
    calls,
    updateSession: (id, agent, patch) => calls.push({ kind: 'update', id, agent, patch }),
    completeSession: (id, msg) => calls.push({ kind: 'complete', id, msg }),
    failSession: (id, msg) => calls.push({ kind: 'fail', id, msg }),
  };
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-tailer-test-'));

// 1. Claude：写一半 → 读 → 补全 → 读，事件只能出现一次
{
  const file = path.join(tmpDir, 'claude.jsonl');
  const sm = makeSM();
  const tailer = new ClaudeDesktopTailer(sm);
  tailer.activeJsonlPath = file;
  tailer.filePosition = 0;

  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result' }] },
    cwd: 'C:/proj',
  });

  fs.writeFileSync(file, line.slice(0, 20), 'utf8');
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 0, '半行不能被解析成事件');

  fs.appendFileSync(file, line.slice(20) + '\n', 'utf8');
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 1, '补全后应恰好解析出一次事件');
  assert.equal(sm.calls[0].kind, 'update');
  assert.equal(sm.calls[0].id, 'claude-desktop');
  assert.equal(sm.calls[0].agent, 'claude');
  assert.equal(sm.calls[0].patch.lastMessage, '分析工具执行输出中...');
  assert.equal(sm.calls[0].patch.cwd, 'C:/proj');

  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 1, '没有新数据时不能重复解析');
}

// 2. Claude：多字节字符被切在读取边界上，补全后不能变乱码
{
  const file = path.join(tmpDir, 'claude-utf8.jsonl');
  const sm = makeSM();
  const tailer = new ClaudeDesktopTailer(sm);
  tailer.activeJsonlPath = file;
  tailer.filePosition = 0;

  const line = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result' }] },
    cwd: 'C:/项目',
  });
  const buf = Buffer.from(line + '\n', 'utf8');
  const cut = buf.indexOf(Buffer.from('项', 'utf8')) + 1; // 切在「项」的中间

  fs.writeFileSync(file, buf.subarray(0, cut));
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 0, '半个多字节字符不能被解析');

  fs.appendFileSync(file, buf.subarray(cut));
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 1, '补全后应恰好解析出一次事件');
  assert.equal(sm.calls[0].patch.cwd, 'C:/项目', '多字节字符不能被切坏');
}

// 3. Codex：同一套「半行 → 补全」流程
{
  const root = path.join(tmpDir, 'codex');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'session.jsonl');
  const sm = makeSM();
  const tailer = new CodexSessionTailer(sm, root);

  const line = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'agent_message', message: 'hello world' },
  });

  fs.writeFileSync(file, line.slice(0, 25), 'utf8');
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 0, '半行不能被解析成事件');

  fs.appendFileSync(file, line.slice(25) + '\n', 'utf8');
  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 1, '补全后应恰好解析出一次事件');
  assert.equal(sm.calls[0].id, 'codex-active');
  assert.equal(sm.calls[0].agent, 'codex');
  assert.equal(sm.calls[0].patch.lastMessage, 'hello world');

  tailer.readNewLines(file);
  assert.equal(sm.calls.length, 1, '没有新数据时不能重复解析');
  tailer.stop();
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ tailer 半行自检通过（3 组）');
