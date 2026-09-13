/**
 * pulse-core 客户端（阶段 7，支持打包路径优先与 --live / --fake 自适应启动）。
 *
 * 职责：
 * - 从 %LOCALAPPDATA%\PulseDev\run\core.json 读端点；文件缺失或 pid 已死时自动 spawn pulse-core
 *   （正式设备连接启动 --live，测试/明确假设备场景启动 --fake）并轮询等端点文件内容变化
 * - 回环 TCP + 行分隔 JSON，token 鉴权，按请求 id 关联响应
 * - 事件订阅：所有 daemon 事件转发到 EventEmitter（`device.state`、`device.interconnect`、…）
 * - 断线重连：指数退避，上限 60 秒；重连前重读端点（端口是动态的，daemon 重启会换端口）
 * - protocolVersion 严格相等校验：不等时设 `degraded` 标志并发 `degraded` 事件，
 *   **不抛异常、不停 daemon**，继续用旧链路（硬约束 6）
 *
 * 方法签名以 docs/protocol/rpc-contract.md 为准。
 * 纯 Node 实现（net/fs/child_process），不 import electron：
 * node 24 可直接运行本文件（erasable TS），
 * Electron 主进程则经 vite 打包进 dist-electron。
 */
import { exec, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { resolveCoreExePath, resolveDaemonArgs } from './oronbox-policy.ts';

const DEV_CORE_EXE = path.join(import.meta.dirname, '../../core/target/release/pulse-core.exe');
export const CORE_EXE = resolveCoreExePath(
  (process as any).resourcesPath,
  (p) => fs.existsSync(p),
  DEV_CORE_EXE,
);
export function getDaemonEndpointFile(): string {
  return path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
    'PulseDev',
    'run',
    'core.json',
  );
}
export function getDeviceConfigFile(): string {
  return path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local'),
    'PulseDev',
    'run',
    'device.json',
  );
}
export const DAEMON_ENDPOINT_FILE = getDaemonEndpointFile();
export const DEVICE_CONFIG_FILE = getDeviceConfigFile();
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

const DAEMON_IMAGE = 'pulse-core.exe';

/**
 * pid 是否对应指定映像名的进程（tasklist 异步查，不在主进程同步等）。
 *
 * Windows 会复用 pid：core.json 里的 pid 死掉后，同号可能被无关进程领走
 * （实测 2026-09-13：被 ChatGPT 桌面版占用），光用 kill(pid,0) 判活会把
 * 别人的进程当成 daemon，端点陈旧也不重新拉起 → ECONNREFUSED 旧端口。
 */
export function isNamedPid(pid: number, imageNames: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) {
      resolve(false);
      return;
    }
    exec(
      `tasklist /FI "PID eq ${pid}" /FO CSV /NH`,
      { windowsHide: true, timeout: 3_000 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        const line = String(stdout ?? '').toLowerCase();
        resolve(imageNames.some((n) => line.includes(`"${n.toLowerCase()}"`)));
      }
    );
  });
}

/** daemon pid 判活：pid 存在且映像名是 pulse-core */
async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e?.code === 'EPERM') return isNamedPid(pid, [DAEMON_IMAGE]);
    return false; // ESRCH：pid 不存在
  }
  return isNamedPid(pid, [DAEMON_IMAGE]);
}

export function readEndpoint(file = getDaemonEndpointFile()): DaemonEndpoint | null {
  try {
    const ep = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Number.isInteger(ep?.port) && typeof ep?.token === 'string' ? ep : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENOTFOUND']);

export interface OronBoxClientOptions {
  mode?: 'live' | 'fake';
  endpointFile?: string;
  deviceConfigFile?: string;
  /** daemon pid 判活注入（测试用）：默认按映像名核对 pulse-core 进程 */
  pidAlive?: (pid: number) => Promise<boolean>;
}

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
  private options: OronBoxClientOptions;
  private pidAliveImpl: (pid: number) => Promise<boolean>;
  private _bandConnectionDesired = false;
  private lastConnectedPid: number | null = null;

  constructor(options: OronBoxClientOptions = {}) {
    super();
    this.options = options;
    this.pidAliveImpl = options.pidAlive ?? pidAlive;
  }

  get bandConnectionDesired(): boolean {
    return this._bandConnectionDesired;
  }
  get endpointFile(): string {
    return this.options.endpointFile || getDaemonEndpointFile();
  }
  get deviceConfigFile(): string {
    return this.options.deviceConfigFile || getDeviceConfigFile();
  }
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
    const ep = readEndpoint(this.endpointFile);
    if (ep && (await this.pidAliveImpl(ep.pid))) {
      this.endpoint = ep;
      return ep;
    }
    const oldRaw = fs.existsSync(this.endpointFile)
      ? fs.readFileSync(this.endpointFile, 'utf-8')
      : null;
    if (!fs.existsSync(CORE_EXE)) throw new Error('找不到 ' + CORE_EXE + '（先在 core/ 下 cargo build --release）');
    const args = resolveDaemonArgs({
      mode: this.options.mode,
      deviceConfigExists: fs.existsSync(this.deviceConfigFile),
      envMode: process.env.PULSE_CORE_MODE,
    });
    const child = spawn(CORE_EXE, args, {
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
        raw = fs.readFileSync(this.endpointFile, 'utf-8');
      } catch {
        /* 文件尚未出现 */
      }
      // 等内容变化（或文件新出现），不是等文件存在 —— 端点文件会残留陈旧内容
      if (raw === null || raw === oldRaw) continue;
      const fresh = readEndpoint(this.endpointFile);
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
    const ep = readEndpoint(this.endpointFile);
    if (!ep || !(await this.pidAliveImpl(ep.pid))) return false;
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
    if (!this.endpoint) {
      this.endpoint = await this.ensureDaemon();
    }
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
      if (this.disposed) throw new Error('客户端已销毁');
      // daemon 可能刚写完端点文件或已重启；每次尝试前读取最新端点
      const fresh = readEndpoint(this.endpointFile);
      if (fresh && (await this.pidAliveImpl(fresh.pid))) this.endpoint = fresh;
      const currentEp = this.endpoint;
      try {
        await this.openSocket(currentEp);
        await this.checkProtocolVersion();
        this.lastConnectedPid = this.endpoint?.pid ?? null;
        this.reconnectAttempt = 0;
        return;
      } catch (err: any) {
        lastErr = err;
        if (this.disposed) throw err;
        const transient = TRANSIENT_CODES.has(err?.code) || String(err?.message ?? '').includes('超时');
        if (!transient) throw err;
        await sleep(1_000);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('daemon 连接失败: ' + String(lastErr));
  }

  private openSocket(ep: DaemonEndpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(ep.port, '127.0.0.1');
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
        const previousPid = this.lastConnectedPid;
        await this.ensureDaemon(); // daemon 若已死会重新拉起；端点变了会拿到新端口
        await this.connectOnce();
        const currentPid = this.endpoint?.pid ?? null;
        this.lastConnectedPid = currentPid;

        // 重新连通后恢复用户手环连接意图
        if (this._bandConnectionDesired) {
          const isNewDaemon = previousPid !== null && currentPid !== previousPid;
          if (isNewDaemon) {
            try {
              await this.sendDirect('device.connect', {}, 60_000);
            } catch {
              /* 补发失败由后续状态刷新处理 */
            }
          } else {
            try {
              const status = await this.sendDirect<{ connected: boolean; protocolState?: string }>(
                'device.status',
                {},
                10_000,
              );
              if (status && (!status.connected || status.protocolState === 'disconnected')) {
                await this.sendDirect('device.connect', {}, 60_000);
              }
            } catch {
              /* 状态查询失败 */
            }
          }
        }
      })().catch((err) => {
        this.emit('reconnect-failed', err);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async checkProtocolVersion(): Promise<void> {
    try {
      const info = await this.sendDirect('daemon.info', {}, 10_000);
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

  /** 直接向当前已连接 socket 发送 RPC，不经过 ensureConnected 门禁，避免重入 */
  private sendDirect<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
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

  /** 发起一次 RPC；断线期间调用会先等重连。维护用户手环连接意图状态。 */
  async call<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureConnected();
    const res = await this.sendDirect<T>(method, params, timeoutMs);
    if (method === 'device.connect') {
      this._bandConnectionDesired = true;
    } else if (method === 'device.disconnect') {
      this._bandConnectionDesired = false;
    }
    return res;
  }

  /** 请求 daemon 自行退出（仅托盘「彻底退出」允许调用；protocolVersion 不匹配时禁止 —— 硬约束 6）。 */
  async stopDaemon(): Promise<void> {
    this._bandConnectionDesired = false;
    this.lastConnectedPid = null;
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
    this._bandConnectionDesired = false;
    this.lastConnectedPid = null;
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
