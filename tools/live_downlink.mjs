#!/usr/bin/env node
// 阶段 6B 下行验证脚本（模拟客户端，最小 fetch-bridge）：
// 连到 pulse-core --live 的 RPC，收到手环 fetch 上行 → 对 url 发 HTTP GET(8765) → 构造 fetch 响应
// → device.interconnect.send 回 --live → --live 下发 id=8 给手环。
// 前置：--live 在跑（core.json 有 port/token）；127.0.0.1:8765 在线（Pulse Dev）。
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const corePath = path.join(process.env.LOCALAPPDATA, 'PulseDev', 'run', 'core.json');
const ep = JSON.parse(fs.readFileSync(corePath, 'utf8'));
const port = ep.port;
const token = ep.token;
let seq = 1;

function httpGet(url, method) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url ' + url)); }
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: method || 'GET', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const sock = net.connect(port, '127.0.0.1', () => {
  console.log('[downlink] 已连到 --live core port=' + port);
});
let buf = '';
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch (e) { continue; }
    if (!msg || msg.messageType !== 'event' || msg.event !== 'device.interconnect') continue;
    const payload = Array.isArray(msg.payload) ? msg.payload : [];
    const bytes = Buffer.from(payload);
    let j;
    try { j = JSON.parse(bytes.toString('utf8')); } catch (e) { continue; }
    if (!j || j.tag !== 'fetch') continue;
    const fid = j.id;
    const url = j.url || 'http://127.0.0.1:8765/api/status/compact?all=1';
    const method = (j.options && j.options.method) || 'GET';
    console.log('[downlink] 收到 fetch ' + fid + ' -> GET ' + url);
    httpGet(url, method).then((r) => {
      const resp = { tag: 'fetch', id: fid, resp: { ok: true, status: r.status || 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: r.body } };
      send(resp, fid, bytes.length);
    }).catch((err) => {
      console.log('[downlink] GET 失败 ' + String(err));
      const resp = { tag: 'fetch', id: fid, resp: { ok: false, status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: String(err) }) } };
      send(resp, fid, bytes.length);
    });
  }
});
sock.on('error', (e) => console.log('[downlink] socket 错误 ' + String(e)));

function send(resp, fid, len) {
  const b = Buffer.from(JSON.stringify(resp), 'utf8');
  const payload = Array.from(b);
  const req = JSON.stringify({ id: 'r' + seq++, method: 'device.interconnect.send', params: { package: 'com.codeisland.band', payload }, token });
  sock.write(req + '\n');
  console.log('[downlink] 已回传 fetch 响应 ' + fid + ' (len=' + b.length + ')');
}
