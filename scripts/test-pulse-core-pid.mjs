import test from 'node:test';
import assert from 'node:assert/strict';
import { isNamedPid, tasklistHasImage } from '../src/main/services/pulse-core-client.ts';

/**
 * pid 判活必须核对映像名：Windows 复用 pid，core.json 里死掉的 daemon pid
 * 可能被无关进程（实测：ChatGPT 桌面版）领走，光 kill(pid,0) 会误判 daemon 活着。
 */

test('tasklistHasImage: 按 CSV 映像名精确匹配', () => {
  const output = '"pulse-core.exe","23932","Console","1","12,340 K"';
  assert.equal(tasklistHasImage(output, ['pulse-core.exe']), true);
  assert.equal(tasklistHasImage(output, ['electron.exe']), false);
});

test('tasklistHasImage: 空输出不匹配', () => {
  assert.equal(tasklistHasImage('', ['pulse-core.exe']), false);
});

test('isNamedPid: 非法输入返回 false', async () => {
  assert.equal(await isNamedPid(0, ['cmd.exe']), false);
  assert.equal(await isNamedPid(-1, ['cmd.exe']), false);
  assert.equal(await isNamedPid(Number.NaN, ['cmd.exe']), false);
});
