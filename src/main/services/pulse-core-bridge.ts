/** pulse-core 状态与设备操作的主进程 IPC 桥。 */
import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { PulseCoreClient } from './pulse-core-client';
import { DirectFetchBridge, BAND_PACKAGE } from './fetch-bridge-direct';
import { pushError, getRecentErrors, clearErrors, onErrorLog, PulseErrorEntry } from './error-log';
import { getHookStatus } from './claude-hook-install';
import { buildDiagnosticReport, probeJson } from './diagnostics';
import { shouldConnectBand, type BandConnectionReason } from './pulse-core-policy';
import { formatDiagnosticReport, formatErrorLog } from './support-report';

export interface PulseCoreState {
  daemon: {
    rpcConnected: boolean;
    degraded: boolean;
    degradation: { expected: number; actual: number | null } | null;
    pid: number | null;
    endpoint: string | null;
    protocolVersion: number | null;
    uptimeSeconds: number | null;
    platform: string | null;
  };
  device: { name: string; address: string; codename?: string; connectType: string; disconnected: boolean } | null;
  connection: { state: 'connected' | 'connecting' | 'disconnected' | 'error'; error?: string };
  bridge: {
    running: boolean;
    packageName: string;
    requestCount: number;
    lastRequestAt: number | null;
    lastLatencyMs: number | null;
  };
}

interface DeviceWire {
  name?: unknown;
  addr?: unknown;
  address?: unknown;
  codename?: unknown;
  connectType?: unknown;
  disconnected?: unknown;
}

/** 白名单式重建设备对象 —— authkey / 未知字段到不了渲染进程 */
function safeDevice(raw: DeviceWire | null | undefined): PulseCoreState['device'] {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  const address = typeof raw.addr === 'string' ? raw.addr : typeof raw.address === 'string' ? raw.address : null;
  if (!name || !address) return null;
  return {
    name,
    address,
    codename: typeof raw.codename === 'string' ? raw.codename : undefined,
    connectType: typeof raw.connectType === 'string' ? raw.connectType : 'unknown',
    disconnected: raw.disconnected !== false,
  };
}

export class PulseCoreBridge {
  private state: PulseCoreState;
  private pollTimer: NodeJS.Timeout | null = null;
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private responder: DirectFetchBridge;

  constructor(private client: PulseCoreClient) {
    this.responder = new DirectFetchBridge(client, {
      onRequest: () => {
        /* 计数统一在 device.interconnect 监听里做 */
      },
      onResponse: ({ latencyMs }) => {
        this.state.bridge.lastLatencyMs = latencyMs;
      },
    });
    this.state = {
      daemon: {
        rpcConnected: false,
        degraded: false,
        degradation: null,
        pid: null,
        endpoint: null,
        protocolVersion: null,
        uptimeSeconds: null,
        platform: null,
      },
      device: null,
      connection: { state: 'disconnected' },
      bridge: {
        running: false,
        packageName: BAND_PACKAGE,
        requestCount: 0,
        lastRequestAt: null,
        lastLatencyMs: null,
      },
    };
  }

  attach(win: BrowserWindow | null): void {
    this.win = win;
    const c = this.client;

    // 错误环形日志变化 → 推给诊断屏
    onErrorLog((entries) => {
      if (this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('pulse-error-log', entries);
      }
    });

    c.on('connected', () => {
      this.state.daemon.rpcConnected = true;
      this.push();
      void this.refreshDaemonHealth();
    });
    c.on('disconnected', () => {
      this.state.daemon.rpcConnected = false;
      this.state.connection = { state: 'disconnected' };
      this.push();
    });
    c.on('degraded', (info) => {
      pushError('daemon', `protocolVersion 不匹配（${JSON.stringify(info)}），已进入降级链路`, 'warn');
      this.state.daemon.degraded = true;
      this.state.daemon.degradation = info;
      this.push();
    });
    c.on('degraded-cleared', () => {
      this.state.daemon.degraded = false;
      this.state.daemon.degradation = null;
      this.push();
    });
    c.on('reconnect-failed', (err: Error) => pushError('daemon', `重连失败: ${err?.message ?? err}`, 'warn'));

    // ⚠️ device.state 的 state 字段来自 _deviceStateJson，含 authkey —— 只取安全字段
    c.on('device.state', (data: { state?: Record<string, unknown> }) => {
      const s = data?.state;
      if (!s || typeof s !== 'object') return;
      this.applyDeviceState(s);
    });

    // FetchBridge 请求计数：只数发给手环快应用的 interconnect 消息
    c.on('device.interconnect', (data: { packageName?: unknown }) => {
      if (data?.packageName === BAND_PACKAGE) {
        this.state.bridge.requestCount++;
        this.state.bridge.lastRequestAt = Date.now();
        this.push();
      }
    });

    this.registerIpc();
  }

  /**
   * 连上之后把手环的钟对一次。
   *
   * 绕开米家 App 的代价：Pulse Core 连上不会自动同步时间，表盘和系统通知的时间会
   * 一直是错的。Pulse 页面内那个钟走的是服务端 ts，所以这个坑一直没暴露出来。
   * daemon 有现成的 device.sync.time，不用传参，返回 {synced:true}。
   * 对钟失败只记一条日志——绝不让它挡住连接流程。
   */
  private async syncBandTime(): Promise<void> {
    try {
      await this.client.call('device.sync.time', {}, 15_000);
    } catch (err: any) {
      pushError('device', `对时失败（不影响连接）: ${err?.message ?? err}`, 'warn');
    }
  }

  detach(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.responder.stop();
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.client.start();
        this.responder.start();
        this.state.bridge.running = this.responder.running;
        if (!this.pollTimer) this.pollTimer = setInterval(() => void this.refreshAll(), 5_000);
        await this.refreshAll();
      })().catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    return this.ready;
  }

  private async connectBand(reason: BandConnectionReason) {
    if (!shouldConnectBand(reason)) return { ok: false, error: '仅允许用户手动连接手环' };
    try {
      await this.ensureReady();
      const status = await this.client.call<{ connected: boolean; device?: unknown }>('device.status');
      const device = status?.connected ? status.device : await this.client.call('device.connect', {}, 60_000);
      await this.syncBandTime();
      return { ok: true, device };
    } catch (err: any) {
      pushError('device', `device.connect 失败: ${err?.message ?? err}`);
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      if (this.client.connected) await this.refreshBandState();
      this.push();
    }
  }

  private registerIpc(): void {
    ipcMain.handle('pulse:core:get-state', () => this.state);

    ipcMain.handle('pulse:band:connect', () => this.connectBand('manual-connect'));

    ipcMain.handle('pulse:band:disconnect', async () => {
      try {
        await this.ensureReady();
        await this.client.call('device.disconnect', {});
        return { ok: true };
      } catch (err: any) {
        pushError('device', `device.disconnect 失败: ${err?.message ?? err}`);
        return { ok: false, error: String(err?.message ?? err) };
      } finally {
        await this.refreshBandState();
        this.push();
      }
    });

    ipcMain.handle('pulse:get-diagnostics', async () => {
      // 本进程内的 status-server（127.0.0.1:8765），经 main 转发避免 renderer 的 CORS/端口耦合
      try {
        const res = await fetch(`http://127.0.0.1:8765/api/status`);
        if (!res.ok) throw new Error(`/api/status 返回 ${res.status}`);
        return { ok: true, data: await res.json() };
      } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

    ipcMain.handle('pulse:run-diagnostics', async () => {
      const [statusService, hookService] = await Promise.all([
        probeJson('http://127.0.0.1:8765/api/status'),
        probeJson('http://127.0.0.1:41789/health'),
      ]);
      const limits =
        statusService.ok && statusService.data && typeof statusService.data === 'object'
          ? (statusService.data as { limits?: Record<string, unknown> }).limits
          : undefined;
      const bundledRpk = path.join(import.meta.dirname, '../../assets/band-app.rpk');

      return buildDiagnosticReport({
        statusService,
        hookInstalled: getHookStatus().installed,
        hookService,
        daemonConnected: this.state.daemon.rpcConnected,
        daemonDegraded: this.state.daemon.degraded,
        bandConnected: this.state.connection.state === 'connected',
        bundledRpkExists: fs.existsSync(bundledRpk),
        usableQuotaCount: Object.values(limits ?? {}).filter(Boolean).length,
      });
    });

    ipcMain.handle('pulse:get-error-log', () => getRecentErrors(20));
    ipcMain.handle('pulse:clear-error-log', () => {
      clearErrors();
      return { ok: true };
    });
    ipcMain.handle('pulse:format-error-log', () => formatErrorLog(getRecentErrors(20)));
    ipcMain.handle('pulse:format-diagnostic-report', (_e, report) => formatDiagnosticReport(report));
  }

  /** 把 daemon 的设备状态映射成 UI 的连接态（不含 authkey） */
  private applyDeviceState(s: Record<string, unknown>): void {
    this.state.device = safeDevice(s.currentDevice as DeviceWire);
    const protocolState = typeof s.protocolState === 'string' ? s.protocolState : 'disconnected';
    const connecting = s.connecting === true;
    const connected = protocolState === 'ready';
    const error = typeof s.error === 'string' && s.error ? s.error : undefined;
    this.state.connection = connected
      ? { state: 'connected' }
      : connecting
        ? { state: 'connecting' }
        : protocolState === 'error'
          ? { state: 'error', error }
          : { state: 'disconnected' };
    this.push();
  }

  private async refreshBandState(): Promise<void> {
    try {
      const status = await this.client.call<{ connected: boolean; protocolState: string; device?: DeviceWire; error?: string }>(
        'device.status',
      );
      this.state.device = safeDevice(status?.device);
      const protocolState = status?.protocolState ?? 'disconnected';
      this.state.connection = status?.connected
        ? { state: 'connected' }
        : protocolState === 'error'
          ? { state: 'error', error: status?.error }
          : { state: 'disconnected' };
    } catch {
      /* RPC 未连上时保持当前状态 */
    }
  }

  private async refreshDaemonHealth(): Promise<void> {
    try {
      const info = await this.client.call<{
        pid: number;
        protocolVersion: number;
        platform: string;
        endpoint: string;
        uptimeSeconds: number;
      }>('daemon.info');
      this.state.daemon = {
        rpcConnected: true,
        degraded: this.state.daemon.degraded,
        degradation: this.state.daemon.degradation,
        pid: info?.pid ?? null,
        endpoint: info?.endpoint ?? null,
        protocolVersion: info?.protocolVersion ?? null,
        uptimeSeconds: info?.uptimeSeconds ?? null,
        platform: info?.platform ?? null,
      };
    } catch {
      /* 未连接 */
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([this.refreshBandState(), this.refreshDaemonHealth()]);
    this.push();
  }

  private push(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('pulse:core:state', this.state);
    }
  }
}

export type { PulseErrorEntry };
