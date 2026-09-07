/**
 * FetchBridge 直连响应器（阶段 7 第二步）。
 *
 * Pulse 订阅 device.interconnect 事件，自己解析手环请求并在进程内取数，
 * 不再经过 FetchBridge 插件和它那层 HTTP 自跳。
 *
 * 协议（FETCHBRIDGE_PROTOCOL.md 第 2 节 + 插件 main.js 实测形状）：
 * - 握手：手环发 {tag:"__hs__", count, caps}；count < 2 时必须回
 *   {tag:"__hs__", count: count+1, caps}，caps 与插件逐字段一致（手环 1.2.4 按 v3 协商）。
 * - 请求：{tag:"fetch", id, url, options:{method,headers,body}}。
 * - 响应：单帧 {tag:"fetch", id, resp:{ok,status,statusText,headers,body,raw}}，
 *   body 为 UTF-8 文本（text 编码不需要 bodyEncoding 字段）。
 *   失败：{ok:false, status:0, statusText:<错误>, headers:{}, body:"", raw:false}。
 * - 只实现 v1 单帧：/api/status/compact 报文 ~531 字节，远小于 16KB 单帧上限，
 *   分片与累计 ACK 不会触发；caps 仍照抄插件（含 chunk/ack 声明）以保证手环侧兼容。
 * - ❌ 禁止调用任何 device.sync* 方法（OronBox syncTime 有 +4h 硬编码 bug，issue #6）。
 */
import { OronBoxClient } from './oronbox-client';
import { pushError } from './error-log';

export const BAND_PACKAGE = 'com.codeisland.band';

const LOCAL_CAPS = {
  version: 3,
  chunk: true,
  maxChunkSize: 768,
  encodings: ['base64', 'text', 'hex'],
  compressions: ['none'],
  ack: true,
  ackWindow: 4,
};

const FETCH_TIMEOUT_MS = 10_000;

export interface DirectBridgeMetrics {
  onRequest: (info: { bytes: number; url: string }) => void;
  onResponse: (info: { latencyMs: number; status: number }) => void;
}

export class DirectFetchBridge {
  private handler: ((data: any) => void) | null = null;

  constructor(
    private client: OronBoxClient,
    private metrics: DirectBridgeMetrics,
  ) {}

  start(): void {
    if (this.handler) return;
    this.handler = (data: { packageName?: unknown; deviceId?: unknown; payload?: unknown }) => {
      void this.onMessage(data);
    };
    this.client.on('device.interconnect', this.handler);
    pushError('bridge', '直连模式已启动（FetchBridge 插件链路停用）', 'info');
  }

  stop(): void {
    if (!this.handler) return;
    this.client.off('device.interconnect', this.handler);
    this.handler = null;
    pushError('bridge', '直连模式已停止', 'info');
  }

  get running(): boolean {
    return this.handler !== null;
  }

  private async onMessage(data: { packageName?: unknown; deviceId?: unknown; payload?: unknown }): Promise<void> {
    if (data?.packageName !== BAND_PACKAGE) return;
    if (!Array.isArray(data.payload)) return;
    const raw = Buffer.from(data.payload as number[]);
    let packet: any;
    try {
      packet = JSON.parse(raw.toString('utf-8'));
    } catch {
      return; // 非 JSON，静默忽略（与插件一致）
    }
    if (!packet || typeof packet !== 'object') return;

    if (packet.tag === '__hs__') {
      await this.handleHandshake(packet);
      return;
    }
    if (packet.tag === 'fetch') {
      await this.handleFetch(packet);
      return;
    }
    // fetch-ack 等其他 tag：v1 单帧用不到，忽略
  }

  private async handleHandshake(packet: any): Promise<void> {
    const count = Number(packet.count) || 0;
    if (count < 2) {
      await this.send(BAND_PACKAGE, { tag: '__hs__', count: count + 1, caps: LOCAL_CAPS });
    }
  }

  private async handleFetch(packet: any): Promise<void> {
    const id = typeof packet.id === 'string' ? packet.id : '';
    const url = typeof packet.url === 'string' ? packet.url : '';
    const options = (packet.options && typeof packet.options === 'object' ? packet.options : {}) as {
      method?: unknown;
      headers?: unknown;
      body?: unknown;
    };
    const started = Date.now();
    if (!/^https?:\/\//i.test(url)) {
      await this.sendFetchError(id, `unsupported url: ${url.slice(0, 80)}`);
      return;
    }
    const method = typeof options.method === 'string' ? options.method : 'GET';
    const headers =
      options.headers && typeof options.headers === 'object'
        ? Object.fromEntries(
            Object.entries(options.headers as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          )
        : undefined;
    const body = typeof options.body === 'string' ? options.body : undefined;

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      const contentType = res.headers.get('content-type');
      const latencyMs = Date.now() - started;
      this.metrics.onResponse({ latencyMs, status: res.status });
      await this.send(BAND_PACKAGE, {
        tag: 'fetch',
        ...(id ? { id } : {}),
        resp: {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          statusText: res.statusText || (res.ok ? 'OK' : 'Error'),
          headers: contentType ? { 'content-type': contentType } : {},
          body: text,
          raw: false,
        },
      });
    } catch (err: any) {
      this.metrics.onResponse({ latencyMs: Date.now() - started, status: 0 });
      await this.sendFetchError(id, String(err?.message ?? err).slice(0, 120));
    }
  }

  private async sendFetchError(id: string, message: string): Promise<void> {
    await this.send(BAND_PACKAGE, {
      tag: 'fetch',
      ...(id ? { id } : {}),
      resp: { ok: false, status: 0, statusText: message, headers: {}, body: '', raw: false },
    });
  }

  private async send(packageName: string, message: Record<string, unknown>): Promise<void> {
    const payload = Array.from(Buffer.from(JSON.stringify(message), 'utf-8'));
    await this.client.call('device.interconnect.send', { package: packageName, payload }, 15_000);
  }
}
