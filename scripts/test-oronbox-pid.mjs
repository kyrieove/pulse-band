import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { isNamedPid } from '../src/main/services/oronbox-client.ts';

/**
 * pid 判活必须核对映像名：Windows 复用 pid，core.json 里死掉的 daemon pid
 * 可能被无关进程（实测：ChatGPT 桌面版）领走，光 kill(pid,0) 会误判 daemon 活着。
 */

test('isNamedPid: 活进程按映像名匹配', async () => {
  const child = spawn('cmd.exe', ['/c', 'ping', '-n', '8', '127.0.0.1'], { stdio: 'ignore' });
  try {
    assert.equal(await isNamedPid(child.pid, ['cmd.exe']), true, '同映像名应判活');
    assert.equal(await isNamedPid(child.pid, ['pulse-core.exe']), false, '不同映像名应判死');
  } finally {
    child.kill();
  }
});

test('isNamedPid: 已退出的 pid 返回 false', async () => {
  const child = spawn('cmd.exe', ['/c', 'exit'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(await isNamedPid(child.pid, ['cmd.exe']), false);
});

test('isNamedPid: 非法输入返回 false', async () => {
  assert.equal(await isNamedPid(0, ['cmd.exe']), false);
  assert.equal(await isNamedPid(-1, ['cmd.exe']), false);
  assert.equal(await isNamedPid(Number.NaN, ['cmd.exe']), false);
});
