/**
 * OronBox daemon 客户端（阶段 2）。
 *
 * 职责：
 * - 从 %LOCALAPPDATA%\OronBox\run\daemon.json 读端点；文件缺失或 pid 已死（端点文件会残留陈旧内容）
 *   时 spawn `oronbox.exe --nogui daemon run` 并轮询等端点文件**内容变化**（上限 20 秒）
 * - 回环 TCP + 行分隔 JSON，token 鉴权，按请求 id 关联响应
 * - 事件订阅：所有 daemon 事件转发到 EventEmitter（`device.state`、`device.interconnect`、…）
 * - 断线重连：指数退避，上限 60 秒；重连前重读端点（端口是动态的，daemon 重启会换端口）
 * - protocolVersion 严格相等校验：不等时设 `degraded` 标志并发 `degraded` 事件，
 *   **不抛异常、不停 daemon**，继续用旧链路（硬约束 6）
 *
 * 方法签名见 docs/ORONBOX_DAEMON_RPC.md。
 * 纯 Node 实现（net/fs/child_process），不 import electron：
 * scripts/test-daemon-client.mjs 由 node 24 直接运行本文件（erasable TS），
 * Electron 主进程则经 vite 打包进 dist-electron。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// macOS 版 OronBox 的 daemon 不写 daemon.json（TCP+token），而是监听 Unix domain
// socket（$TMPDIR/oronbox/daemon.sock，权限 0600，无需 token），RPC 报文与 Windows 完全一致。
export const ORONBOX_EXE =
  process.platform === 'darwin'
    ? '/Applications/OronBox.app/Contents/MacOS/OronBox'
    : 'C:\\Program Files\\OronBox\\oronbox.exe';
export const DAEMON_SOCK_FILE = path.join(os.tmpdir(), 'oronbox', 'daemon.sock');
export const DAEMON_ENDPOINT_FILE =
  process.platform === 'darwin'
    ? DAEMON_SOCK_FILE
    : path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
        'OronBox',
        'run',
        'daemon.json',
      );
export const IS_MAC_DAEMON = process.platform === 'darwin';
export const EXPECTED_PROTOCOL_VERSION = 6;

const SPAWN_WAIT_MS = 20_000;
const RECONNECT_MAX_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECT_RETRIES = 8;

export interface DaemonEndpoint {
  port: number;
  token: string;
  pid: number;
  protocolVersion: number;
  /** macOS：Unix socket 路径；存在时优先于 TCP port 连接 */
  socketPath?: string;
}

export interface Degradation {
  expected: number;
  actual: number | null;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

function readEndpoint(): DaemonEndpoint | null {
  if (IS_MAC_DAEMON) {
    try {
      const stat = fs.statSync(DAEMON_SOCK_FILE);
      if (!stat.isSocket()) return null;
      // pid 填 1（恒活）让 ensureDaemon 跳过 spawn；socket 由 daemon 自身管理
      return { port: 0, token: '', pid: 1, protocolVersion: EXPECTED_PROTOCOL_VERSION, socketPath: DAEMON_SOCK_FILE };
    } catch {
      return null;
    }
  }
  try {
    const ep = JSON.parse(fs.readFileSync(DAEMON_ENDPOINT_FILE, 'utf-8'));
    return Number.isInteger(ep?.port) && typeof ep?.token === 'string' ? ep : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** macOS：读 daemon.sock 的 mtime，用于检测 socket 是否被 daemon 重建过 */
function sockMtimeMs(): number {
  try {
    return fs.statSync(DAEMON_SOCK_FILE).mtimeMs;
  } catch {
    return -1;
  }
}

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENOTFOUND']);

export class OronBoxClient extends EventEmitter {
  private endpoint: DaemonEndpoint | null = null;
  private socket: net.Socket | null = null;
  private buf = '';
  private seq = 0;
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private ensuring: Promise<DaemonEndpoint> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private disposed = false;
  private degradedInfo: Degradation | null = null;

  get connected(): boolean {
    return this.socket !== null;
  }
  get endpointInfo(): DaemonEndpoint | null {
    return this.endpoint ? { ...this.endpoint } : null;
  }
  get degraded(): boolean {
    return this.degradedInfo !== null;
  }
  get degradation(): Degradation | null {
    return this.degradedInfo ? { ...this.degradedInfo } : null;
  }

  /** 确保 daemon 进程在跑（必要时 spawn），返回可用端点。并发调用会合并。 */
  ensureDaemon(): Promise<DaemonEndpoint> {
    if (!this.ensuring) {
      this.ensuring = this.doEnsureDaemon().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  private async doEnsureDaemon(): Promise<DaemonEndpoint> {
    const ep = readEndpoint();
    if (ep && pidAlive(ep.pid)) {
      this.endpoint = ep;
      return ep;
    }
    const oldRaw = IS_MAC_DAEMON
      ? String(sockMtimeMs())
      : fs.existsSync(DAEMON_ENDPOINT_FILE)
        ? fs.readFileSync(DAEMON_ENDPOINT_FILE, 'utf-8')
        : null;
    if (!fs.existsSync(ORONBOX_EXE)) throw new Error('找不到 ' + ORONBOX_EXE);
    const child = spawn(ORONBOX_EXE, ['--nogui', 'daemon', 'run'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    this.emit('daemon-spawned', child.pid);
    const deadline = Date.now() + SPAWN_WAIT_MS;
    for (;;) {
      await sleep(400);
      if (Date.now() > deadline) {
        throw new Error('spawn daemon 后 20 秒内端点文件没有出现新内容（daemon 没起来？）');
      }
      let raw: string | null = null;
      try {
        raw = IS_MAC_DAEMON ? String(sockMtimeMs()) : fs.readFileSync(DAEMON_ENDPOINT_FILE, 'utf-8');
      } catch {
        /* 文件尚未出现 */
      }
      // 等内容变化（或文件新出现），不是等文件存在 —— 端点文件会残留陈旧内容
      if (raw === null || raw === oldRaw) continue;
      const fresh = readEndpoint();
      if (fresh) {
        this.endpoint = fresh;
        return fresh;
      }
    }
  }

  /** 启动：确保 daemon 在跑并建立连接。断线后内部自动重连。 */
  async start(): Promise<void> {
    this.disposed = false;
    await this.ensureDaemon();
    await this.ensureConnected();
  }

  /** 仅连接已经在运行的 daemon；不存在时绝不拉起新进程。 */
  async connectIfRunning(): Promise<boolean> {
    const ep = readEndpoint();
    if (!ep || !pidAlive(ep.pid)) return false;
    this.disposed = false;
    this.endpoint = ep;
    await this.ensureConnected();
    return true;
  }

  /** 幂等建立连接；并发调用合并为同一次。 */
  ensureConnected(): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (!this.connecting) {
      this.connecting = this.connectOnce().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const ep = this.endpoint ?? (await this.ensureDaemon());
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
      if (this.disposed) throw new Error('客户端已销毁');
      try {
        await this.openSocket(ep);
        await this.checkProtocolVersion();
        this.reconnectAttempt = 0;
        return;
      } catch (err: any) {
        lastErr = err;
        if (this.disposed) throw err;
        const transient = TRANSIENT_CODES.has(err?.code) || String(err?.message ?? '').includes('超时');
        if (!transient) throw err;
        // daemon 可能刚写完端点文件还没监听端口；重读端点（端口可能变了）再试
        const fresh = readEndpoint();
        if (fresh && pidAlive(fresh.pid)) this.endpoint = fresh;
        await sleep(1_000);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('daemon 连接失败: ' + String(lastErr));
  }

  private openSocket(ep: DaemonEndpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = ep.socketPath ? net.connect(ep.socketPath) : net.connect(ep.port, '127.0.0.1');
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          socket.destroy();
          reject(err);
        } else {
          resolve();
        }
      };
      socket.setTimeout(10_000, () => done(new Error('连接 daemon 超时（10 秒）')));
      socket.once('error', (err) => done(err));
      socket.once('close', () => {
        // 只有成功建立过的 socket 才算「断线」；连接失败的 close 不触发重连调度
        if (this.socket === socket) {
          this.socket = null;
          this.buf = '';
          this.emit('disconnected');
          this.rejectAllPending(new Error('daemon 连接已断开'));
          this.scheduleReconnect();
        }
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.once('connect', () => {
        socket.setTimeout(0);
        this.socket = socket;
        this.buf = '';
        this.emit('connected');
        done();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.socket) return;
    this.reconnectAttempt++;
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** (this.reconnectAttempt - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed || this.socket) return;
      (async () => {
        await this.ensureDaemon(); // daemon 若已死会重新拉起；端点变了会拿到新端口
        await this.connectOnce();
      })().catch((err) => {
        this.emit('reconnect-failed', err);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async checkProtocolVersion(): Promise<void> {
    try {
      const info = await this.call('daemon.info', {}, 10_000);
      const actual = Number(info?.protocolVersion);
      if (actual === EXPECTED_PROTOCOL_VERSION) {
        if (this.degradedInfo) {
          this.degradedInfo = null;
          this.emit('degraded-cleared');
        }
      } else {
        this.setDegraded(Number.isFinite(actual) ? actual : null);
      }
    } catch {
      // 连 daemon.info 都不认识 —— 协议必然不兼容，但同样不抛异常、不停 daemon
      this.setDegraded(null);
    }
  }

  private setDegraded(actual: number | null): void {
    const changed = !this.degradedInfo || this.degradedInfo.actual !== actual;
    this.degradedInfo = { expected: EXPECTED_PROTOCOL_VERSION, actual };
    if (changed) this.emit('degraded', this.degradedInfo);
  }

  /** 发起一次 RPC；断线期间调用会先等重连。 */
  async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket) throw new Error('daemon 未连接');
    const id = 'r' + ++this.seq;
    const payload = JSON.stringify({ id, method, params, token: this.endpoint?.token ?? '' }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`daemon.call ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(payload);
    });
  }

  /** 请求 daemon 自行退出（仅托盘「彻底退出」允许调用；protocolVersion 不匹配时禁止 —— 硬约束 6）。 */
  async stopDaemon(): Promise<void> {
    // 先正经断开手环，再停 daemon。直接停 daemon 的话手环那头不知道链路已经没了，
    // 会继续占着，手机要在手环上手动点「连接新手机」才连得回去（2026-09-05 实测）。
    // 空参数 = 断开当前设备（local_command_bus.dart:1227 `_disconnect(null)`）。
    try {
      await this.call('device.disconnect', {}, 3_000);
    } catch {
      /* 本来就没连设备 / 已经断了：继续走退出流程 */
    }
    try {
      await this.call('daemon.stop', {}, 3_000);
    } catch {
      /* daemon 可能已退出或协议不兼容；退出流程继续 */
    }
    this.dispose();
  }

  /** 退出 Pulse 时清理由谁启动都无关；但 daemon 不存在时不能为了退出反而把它拉起来。 */
  async stopDaemonIfRunning(): Promise<void> {
    if (!this.connected && !(await this.connectIfRunning())) return;
    await this.stopDaemon();
  }

  /** 只断开本地连接，daemon 继续常驻（普通退出用）。 */
  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.destroy();
    this.rejectAllPending(new Error('客户端已销毁'));
  }

  private rejectAllPending(reason: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8');
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.messageType === 'event') {
        const { messageType: _mt, event, ...data } = obj;
        if (typeof event === 'string') {
          this.emit('event', { event, data });
          this.emit(event, data);
        }
        continue;
      }
      const p = typeof obj?.id === 'string' ? this.pending.get(obj.id) : undefined;
      if (!p) continue;
      this.pending.delete(obj.id);
      clearTimeout(p.timer);
      if (obj.ok) p.resolve(obj.result);
      else {
        const err = new Error(`daemon ${obj.error?.code ?? 'unknown'}: ${obj.error?.message ?? line}`);
        (err as any).code = obj.error?.code;
        p.reject(err);
      }
    }
  }
}
