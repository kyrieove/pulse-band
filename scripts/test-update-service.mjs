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

test('downloadInstaller: body 永不结束时按空闲超时 reject，不会永远卡住', async () => {
  const good = createHash('sha256').update(Buffer.from('x')).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-update-idle-'));
  // 真的 fetch 会把 signal 接到 body 上；这里照做，否则 abort() 对假 body 没有任何效果。
  const hangingFetch = (url, init) => {
    if (String(url).endsWith('.sha256')) {
      return Promise.resolve({ ok: true, text: async () => `${good}  Pulse-Setup-2.0.2.exe\n` });
    }
    // 只吐一个 chunk，然后既不结束也不关闭 —— 模拟连接半开
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(1024));
        init.signal.addEventListener('abort', () => c.error(new Error('aborted')));
      },
    });
    return Promise.resolve({ ok: true, body, headers: { get: () => null } });
  };

  try {
    const started = Date.now();
    await assert.rejects(
      downloadInstaller(
        { name: 'Pulse-Setup-2.0.2.exe', url: 'https://example.invalid/a.exe', size: 999999, checksumUrl: 'https://example.invalid/a.exe.sha256' },
        dir,
        () => {},
        hangingFetch,
        200
      ),
      /下载超时/
    );
    assert.ok(Date.now() - started < 5000, '应该在空闲超时后很快返回，而不是一直挂着');
    assert.equal(fs.existsSync(path.join(dir, 'Pulse-Setup-2.0.2.exe.part')), false, '超时后不能留下 .part');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('downloadInstaller: 写入流出错时 reject，不崩进程', async () => {
  const exe = Buffer.alloc(128 * 1024, 3);
  const good = createHash('sha256').update(exe).digest('hex');
  const server = await serve({ '/a.exe': exe, '/a.exe.sha256': `${good}  Pulse-Setup-2.0.2.exe\n` });
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-update-werr-'));
  try {
    // name 里带一层不存在的目录 → createWriteStream 打开 .part 时必定 ENOENT。
    // 没有 'error' 监听的话这就是未捕获异常，整个进程直接没了。
    await assert.rejects(
      downloadInstaller(
        { name: 'missing-dir/x.exe', url: `${base}/a.exe`, size: exe.length, checksumUrl: `${base}/a.exe.sha256` },
        dir,
        () => {}
      ),
      (err) => err?.code === 'ENOENT'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
