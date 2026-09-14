/**
 * 检查更新 / 下载安装包自检。跑法：node --test scripts/test-update-service.mjs
 * 最要紧的是第 3 条：哈希对不上时安装包必须被删掉，不能留下一个可以被启动的 exe。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseRelease, downloadInstaller } from '../src/main/services/update-service.ts';

const DL = 'https://github.com/kyrieove/pulse-band/releases/download/v2.0.2/';
const release = (assets) => ({ tag_name: 'v2.0.2', html_url: 'https://github.com/kyrieove/pulse-band/releases/tag/v2.0.2', assets });

test('parseRelease: 找到安装包和校验文件，判断有新版本', () => {
  const info = parseRelease(
    release([
      { name: 'Pulse-Setup-2.0.2.exe', size: 123, browser_download_url: `${DL}Pulse-Setup-2.0.2.exe` },
      { name: 'Pulse-Setup-2.0.2.exe.sha256', size: 89, browser_download_url: `${DL}Pulse-Setup-2.0.2.exe.sha256` },
    ]),
    '2.0.1'
  );
  assert.equal(info.latestVersion, '2.0.2');
  assert.equal(info.updateAvailable, true);
  assert.equal(info.installer.url, `${DL}Pulse-Setup-2.0.2.exe`);
  assert.equal(parseRelease(release([]), '2.0.2').updateAvailable, false);
});

test('parseRelease: 缺校验文件或地址不是本仓库 release 时不给下载', () => {
  assert.equal(parseRelease(release([{ name: 'Pulse-Setup-2.0.2.exe', browser_download_url: `${DL}Pulse-Setup-2.0.2.exe` }]), '2.0.1').installer, undefined);
  const evil = parseRelease(
    release([
      { name: 'Pulse-Setup-2.0.2.exe', browser_download_url: 'https://evil.example/Pulse-Setup-2.0.2.exe' },
      { name: 'Pulse-Setup-2.0.2.exe.sha256', browser_download_url: `${DL}Pulse-Setup-2.0.2.exe.sha256` },
    ]),
    '2.0.1'
  );
  assert.equal(evil.installer, undefined);
});

function serve(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = files[req.url];
      if (body === undefined) return res.writeHead(404).end();
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('downloadInstaller: 哈希一致时落盘并报告进度；不一致时删除并报错', async () => {
  const exe = Buffer.alloc(256 * 1024, 7);
  const good = createHash('sha256').update(exe).digest('hex');
  const server = await serve({ '/a.exe': exe, '/a.exe.sha256': `${good}  Pulse-Setup-2.0.2.exe\n`, '/bad.sha256': `${'0'.repeat(64)}  x\n` });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-update-test-'));
  try {
    const progress = [];
    const file = await downloadInstaller(
      { name: 'Pulse-Setup-2.0.2.exe', url: `${base}/a.exe`, size: exe.length, checksumUrl: `${base}/a.exe.sha256` },
      dir,
      (p) => progress.push(p)
    );
    assert.deepEqual(fs.readFileSync(file), exe);
    assert.equal(progress.at(-1).received, exe.length);
    assert.equal(progress.at(-1).total, exe.length);

    await assert.rejects(
      downloadInstaller({ name: 'Bad.exe', url: `${base}/a.exe`, size: exe.length, checksumUrl: `${base}/bad.sha256` }, dir, () => {}),
      /校验失败/
    );
    assert.equal(fs.existsSync(path.join(dir, 'Bad.exe')), false, '校验失败不能留下 exe');
    assert.equal(fs.existsSync(path.join(dir, 'Bad.exe.part')), false, '校验失败不能留下 .part');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
