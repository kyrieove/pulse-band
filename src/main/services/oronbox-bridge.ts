/**
 * OronBox 客户端 → 渲染进程的 IPC 桥（阶段 4）。
 *
 * 职责：
 * - 把 daemon 状态整理成**已消毒**的快照推给 UI（⚠️ device.state/device.snapshot 里带
 *   authkey 明文，此文件是唯一出口，任何原始设备对象不得直接下发 —— 见 docs/ORONBOX_DAEMON_RPC.md）
 * - 设备操作：按需启动 daemon、手动连接 / 断开 / 校时
 * - FetchBridge 插件开关 + 请求数统计（订阅 device.interconnect 事件计数）
 * - .rpk 装包：**已停用**。Pulse 2.0 禁止调用 install.local / OronBox daemon / 任何外部安装器；
 *   新装包通路是 `pulse:app-install:*` IPC → AppInstallService → `device.app.install.*` Core RPC。
 *   本文件保留的旧入口只返回明确的 not implemented，绝不假装成功（见 pushRpk）。
 * - 诊断：转发 status-server 的 /api/status（quota + quotaMeta）与错误环形日志
 */
import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { OronBoxClient } from './oronbox-client';
import { DirectFetchBridge, BAND_PACKAGE } from './fetch-bridge-direct';
import { pushError, getRecentErrors, clearErrors, onErrorLog, PulseErrorEntry } from './error-log';
import { getHookStatus } from './claude-hook-install';
import { buildDiagnosticReport, probeJson } from './diagnostics';
import { shouldConnectBand, type BandConnectionReason } from './oronbox-policy';
import { formatDiagnosticReport, formatErrorLog } from './support-report';

const FETCH_BRIDGE_ID = 'org.zxor.oronbox.miwear-interconnect-fetch';

export type BridgeMode = 'plugin' | 'direct';

export interface PulseOronboxState {
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
    installed: boolean;
    running: boolean;
    version: string | null;
    packageName: string;
    requestCount: number;
    lastRequestAt: number | null;
    /** 'plugin' = 插件代理（阶段 3 链路）；'direct' = Pulse 直连（阶段 7） */
    mode: BridgeMode;
    /** 直连模式下最近一次 fetch 的进程内耗时；插件模式下测不到，为 null */
    lastLatencyMs: number | null;
  };
  installing: { fileName: string; progress: number } | null;
}

interface DeviceWire {
  name?: unknown;
  addr?: unknown;
  address?: unknown;
  codename?: unknown;
  connectType?: unknown;
  disconnected?: unknown;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 白名单式重建设备对象 —— authkey / 未知字段到不了渲染进程 */
function safeDevice(raw: DeviceWire | null | undefined): PulseOronboxState['device'] {
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

/**
 * 旧版装包通道的统一拒绝入口。
 *
 * 真实状态是 not implemented：Pulse 2.0 尚无自研 core 完成的 RPK 安装能力，
 * 因此这里必须明确失败，而不是返回 `ok: true` 之类的假成功。
 */
export function refuseLegacyInstall(channel: string) {
  const error = `Pulse 2.0 已停用旧版装包通道 (not implemented): ${channel}`;
  pushError('install', error);
  return { ok: false as const, error };
}

export class OronBoxBridge {
  private state: PulseOronboxState;
  private pollTimer: NodeJS.Timeout | null = null;
  private win: BrowserWindow | null = null;
  private installing = false;
  private ready: Promise<void> | null = null;
  private responder: DirectFetchBridge;
  private modeFilePath: string;

  constructor(
    private client: OronBoxClient,
    modeFilePath: string,
  ) {
    this.modeFilePath = modeFilePath;
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
        installed: false,
        running: false,
        version: null,
        packageName: BAND_PACKAGE,
        requestCount: 0,
        lastRequestAt: null,
        mode: this.loadMode(),
        lastLatencyMs: null,
      },
      installing: null,
    };
  }

  private loadMode(): BridgeMode {
    try {
      const raw = JSON.parse(fs.readFileSync(this.modeFilePath, 'utf-8'));
      return raw?.bridgeMode === 'direct' ? 'direct' : 'plugin';
    } catch {
      // 默认直连：Pulse 自己应答手环的 interconnect 请求，用户不必在 OronBox 里
      // 安装 FetchBridge 插件、也不必手动添加包名，配对流程少一整步。
      // 插件模式仍保留，作为直连不通时的备选（界面上可切）。
      return 'direct';
    }
  }

  private persistMode(): void {
    try {
      fs.mkdirSync(path.dirname(this.modeFilePath), { recursive: true });
      fs.writeFileSync(this.modeFilePath, JSON.stringify({ bridgeMode: this.state.bridge.mode }), 'utf-8');
    } catch (err) {
      pushError('bridge', `模式持久化失败: ${String(err)}`, 'warn');
    }
  }

  get mode(): BridgeMode {
    return this.state.bridge.mode;
  }

  /**
   * 模式互斥（阶段 7 第三步的硬约束）：两边同时监听 device.interconnect 会让同一个
   * 请求 id 被应答两次（插件 network.fetch 一帧 + Pulse 直连一帧），手环端按 id 匹配
   * Promise，第二帧要么被忽略要么重复解析，症状是偶发闪烁/回退旧数据。
   * 因此：切直连 = 先 plugin.close 并**回查确认已停**（daemon 特殊分支下插件被其他
   * 客户端持有时 close 只解除持有并不真关），才允许启动响应器；切回插件 = 先停响应器再 plugin.open。
   */
  async setBridgeMode(mode: BridgeMode): Promise<{ ok: boolean; error?: string }> {
    if (mode === this.state.bridge.mode) return { ok: true };
    if (this.installing) return { ok: false, error: '装包进行中，稍后再切' };

    if (mode === 'direct') {
      try {
        await this.client.call('plugin.close', { id: FETCH_BRIDGE_ID }, 30_000);
      } catch (err: any) {
        /* 插件可能本来就没在跑 */
      }
      await sleep(500);
      if (await this.isPluginRunning()) {
        pushError('bridge', 'plugin.close 后插件仍在运行（被其他客户端持有），拒绝进入直连模式以防双重应答', 'error');
        await this.refreshBridgePlugin();
        this.push();
        return { ok: false, error: 'FetchBridge 插件未能关闭（可能被 OronBox GUI 等其他客户端持有），已保持插件模式' };
      }
      this.responder.start();
    } else {
      this.responder.stop();
      try {
        await this.client.call('plugin.open', { id: FETCH_BRIDGE_ID }, 30_000);
      } catch (err: any) {
        pushError('bridge', `plugin.open 失败: ${err?.message ?? err}`);
      }
    }

    this.state.bridge.mode = mode;
    if (mode === 'plugin') this.state.bridge.lastLatencyMs = null;
    this.persistMode();
    await this.refreshBridgePlugin();
    this.push();
    pushError('bridge', `桥接模式已切换为 ${mode === 'direct' ? '直连' : '插件'}`, 'info');
    return { ok: true };
  }

  /** 启动时按持久化模式落位（direct：确认插件已关再起响应器；plugin：不动作） */
  async applyBootMode(): Promise<void> {
    if (this.state.bridge.mode !== 'direct') return;
    if (await this.isPluginRunning()) {
      try {
        await this.client.call('plugin.close', { id: FETCH_BRIDGE_ID }, 30_000);
      } catch {
        /* 同上 */
      }
      await sleep(500);
      if (await this.isPluginRunning()) {
        pushError('bridge', '启动时插件无法关闭（被其他客户端持有），本次保持插件模式', 'error');
        this.state.bridge.mode = 'plugin';
        this.persistMode();
        return;
      }
    }
    this.responder.start();
    pushError('bridge', '启动时恢复直连模式（插件链路已停用）', 'info');
  }

  private async isPluginRunning(): Promise<boolean> {
    try {
      const plugins = await this.client.call<Array<{ id: string; running?: boolean }>>('plugin.list', {
        includeIcons: false,
      });
      return plugins?.find((p) => p.id === FETCH_BRIDGE_ID)?.running === true;
    } catch {
      return false;
    }
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

    // install.local 的进度 / 完成事件（daemon 侧 CommandEvent）
    c.on('progress', (data: { progress?: unknown; path?: unknown }) => {
      if (!this.installing) return;
      const pct = typeof data?.progress === 'number' ? Math.round(data.progress * 100) : undefined;
      if (pct !== undefined) {
        this.state.installing = { fileName: this.state.installing?.fileName ?? '', progress: pct };
        this.win?.webContents.send('oronbox-install-progress', {
          fileName: this.state.installing.fileName,
          progress: pct,
          done: false,
        });
      }
    });
    c.on('completed', () => {
      if (!this.installing) return;
      this.installing = false;
      this.state.installing = null;
      this.win?.webContents.send('oronbox-install-progress', {
        fileName: '',
        progress: 100,
        done: true,
      });
    });

    this.registerIpc();
  }

  /**
   * 连上之后把手环的钟对一次。
   *
   * 绕开米家 App 的代价：OronBox 连上不会自动同步时间，表盘和系统通知的时间会
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
        await this.client.call('settings.set', { key: 'auto_reconnect', value: false });
        await this.applyBootMode();
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
    ipcMain.handle('oronbox:get-state', () => this.state);

    // 阶段 7 第三步：插件/直连模式开关（互斥在 setBridgeMode 内验证式保证）
    ipcMain.handle('oronbox:set-bridge-mode', async (_e, mode: unknown) => {
      if (mode !== 'plugin' && mode !== 'direct') return { ok: false, error: '无效模式' };
      await this.ensureReady();
      return this.setBridgeMode(mode);
    });

    ipcMain.handle('oronbox:connect', () => this.connectBand('manual-connect'));

    ipcMain.handle('oronbox:disconnect', async () => {
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

    // FetchBridge 插件开关（仅插件模式有意义）。直连模式下插件必须保持关闭 ——
    // 两边同时监听会对手环的同一请求 id 双重应答，这里从 IPC 层再挡一道。
    ipcMain.handle('oronbox:bridge-toggle', async (_e, running: boolean) => {
      await this.ensureReady();
      if (running && this.state.bridge.mode === 'direct') {
        return { ok: false, error: '当前为直连模式，插件必须保持关闭；请先切回插件模式' };
      }
      try {
        if (running) {
          await this.client.call('plugin.open', { id: FETCH_BRIDGE_ID }, 30_000);
        } else {
          await this.client.call('plugin.close', { id: FETCH_BRIDGE_ID }, 30_000);
        }
        await this.refreshBridgePlugin();
        this.push();
        return { ok: true, running: this.state.bridge.running };
      } catch (err: any) {
        pushError('bridge', `plugin.${running ? 'open' : 'close'} 失败: ${err?.message ?? err}`);
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

    // Pulse 2.0 硬约束：禁止调用 install.local / OronBox daemon / 任何外部安装器。
    // 旧版装包入口一律返回明确 not implemented，不触碰文件系统、不启动 daemon、绝不假装成功。
    ipcMain.handle('oronbox:install-rpk', async () => {
      return refuseLegacyInstall('oronbox:install-rpk');
    });

    // 内置手环端 .rpk 的旧版推送通道同样停用。
    ipcMain.handle('oronbox:install-bundled-rpk', async () => {
      return refuseLegacyInstall('oronbox:install-bundled-rpk');
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
        bridgeMode: this.state.bridge.mode,
        bridgeInstalled: this.state.bridge.installed,
        bridgeRunning: this.state.bridge.running,
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
    ipcMain.handle('oronbox:sync-time', async () => {
      try {
        await this.ensureReady();
        await this.client.call('device.sync.time', {}, 15_000);
        return { ok: true };
      } catch (err: any) {
        pushError('device', `对时失败: ${err?.message ?? err}`, 'warn');
        return { ok: false, error: String(err?.message ?? err) };
      }
    });
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

  private async refreshBridgePlugin(): Promise<void> {
    try {
      const plugins = await this.client.call<Array<{ id: string; version?: string; running?: boolean }>>('plugin.list', {
        includeIcons: false,
      });
      const bridge = plugins?.find((p) => p.id === FETCH_BRIDGE_ID);
      this.state.bridge = {
        installed: !!bridge,
        running: bridge?.running === true,
        version: bridge?.version ?? null,
        packageName: BAND_PACKAGE,
        requestCount: this.state.bridge.requestCount,
        lastRequestAt: this.state.bridge.lastRequestAt,
        mode: this.state.bridge.mode,
        lastLatencyMs: this.state.bridge.lastLatencyMs,
      };
    } catch {
      /* 未连接 */
    }
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([this.refreshBandState(), this.refreshDaemonHealth(), this.refreshBridgePlugin()]);
    this.push();
  }

  private push(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('oronbox-state', this.state);
    }
  }
}

export type { PulseErrorEntry };
