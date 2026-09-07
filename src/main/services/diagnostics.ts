export type DiagnosticStatus = 'pass' | 'warn' | 'fail';

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  summary: string;
  nextStep?: string;
}

export interface DiagnosticReport {
  checkedAt: number;
  checks: DiagnosticCheck[];
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
}

export interface JsonProbeResult extends ProbeResult {
  data?: unknown;
}

export async function probeJson(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<JsonProbeResult> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
    return { ok: true, data: await response.json() };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export interface DiagnosticObservation {
  statusService: ProbeResult;
  hookInstalled: boolean;
  hookService: ProbeResult;
  daemonConnected: boolean;
  daemonDegraded: boolean;
  bridgeMode: 'plugin' | 'direct';
  bridgeInstalled: boolean;
  bridgeRunning: boolean;
  bandConnected: boolean;
  bundledRpkExists: boolean;
  usableQuotaCount: number;
}

const pass = (id: string, label: string, summary: string): DiagnosticCheck => ({
  id,
  label,
  status: 'pass',
  summary,
});

export function describeProbeFailure(
  service: 'status' | 'hook',
  error = '',
): Pick<DiagnosticCheck, 'summary' | 'nextStep'> {
  const name = service === 'status' ? '状态服务' : 'Hook 服务';
  if (/timeout|timedout|aborted/i.test(error)) {
    return { summary: `${name}响应超时。`, nextStep: '请重启 Pulse；如果仍然失败，请检查本地端口是否被占用。' };
  }
  if (/refused|fetch failed/i.test(error)) {
    return { summary: `${name}没有启动。`, nextStep: '请重启 Pulse；如果仍然失败，请检查本地端口是否被占用。' };
  }
  return { summary: `${name}不可用。`, nextStep: '请重启 Pulse 后重新运行诊断。' };
}

export function buildDiagnosticReport(input: DiagnosticObservation): DiagnosticReport {
  const checks: DiagnosticCheck[] = [];

  checks.push(
    input.statusService.ok
      ? pass('status-service', 'Pulse 状态服务', '本地状态接口响应正常。')
      : { id: 'status-service', label: 'Pulse 状态服务', status: 'fail', ...describeProbeFailure('status', input.statusService.error) },
  );
  checks.push(
    input.hookInstalled
      ? pass('claude-hook', 'Claude Code Hook', 'Hook 配置与转发脚本完整。')
      : {
          id: 'claude-hook',
          label: 'Claude Code Hook',
          status: 'fail',
          summary: 'Hook 未安装或转发脚本缺失。',
          nextStep: '请前往“设置与维护”安装 Hook，然后重开 Claude Code 会话。',
        },
  );
  checks.push(
    input.hookService.ok
      ? pass('hook-service', 'Hook 接收服务', 'Claude Code 事件接收端口响应正常。')
      : { id: 'hook-service', label: 'Hook 接收服务', status: 'fail', ...describeProbeFailure('hook', input.hookService.error) },
  );
  checks.push(
    input.daemonConnected
      ? pass('daemon', 'OronBox 后台', 'OronBox daemon 与 Pulse 通信正常。')
      : {
          id: 'daemon',
          label: 'OronBox 后台',
          status: 'warn',
          summary: 'OronBox daemon 尚未启动或未连接。',
          nextStep: '这是纯手动模式的正常状态；需要使用手环时，请回到设备管理页点击连接。',
        },
  );
  checks.push(
    !input.daemonConnected
      ? {
          id: 'protocol',
          label: 'OronBox 协议',
          status: 'warn',
          summary: 'daemon 未连接，暂时无法确认协议版本。',
          nextStep: '请先恢复 OronBox 后台连接。',
        }
      : input.daemonDegraded
      ? {
          id: 'protocol',
          label: 'OronBox 协议',
          status: 'warn',
          summary: '当前正在使用兼容模式，部分功能可能不稳定。',
          nextStep: '请更新 OronBox；若功能正常，也可以暂时继续使用。',
        }
      : pass('protocol', 'OronBox 协议', '协议版本兼容。'),
  );

  if (!input.daemonConnected) {
    checks.push({
      id: 'bridge',
      label: '手环联网桥接',
      status: 'warn',
      summary: 'daemon 未连接，暂时无法确认桥接状态。',
      nextStep: '请先恢复 OronBox 后台连接。',
    });
  } else if (input.bridgeMode === 'direct') {
    checks.push(pass('bridge', '手环联网桥接', 'Pulse 直连模式已启用。'));
  } else if (!input.bridgeInstalled) {
    checks.push({
      id: 'bridge',
      label: '手环联网桥接',
      status: 'fail',
      summary: '没有找到 FetchBridge 插件。',
      nextStep: '请在 OronBox 插件市场安装 FetchBridge，或切换到 Pulse 直连模式。',
    });
  } else if (!input.bridgeRunning) {
    checks.push({
      id: 'bridge',
      label: '手环联网桥接',
      status: 'fail',
      summary: 'FetchBridge 插件未运行。',
      nextStep: '请启动 FetchBridge，或在 Pulse 中重新开启桥接。',
    });
  } else {
    checks.push(pass('bridge', '手环联网桥接', 'FetchBridge 插件正在运行。'));
  }

  checks.push(
    input.bandConnected
      ? pass('band', '手环连接', '手环已通过 OronBox 连接。')
      : {
          id: 'band',
          label: '手环连接',
          status: 'warn',
          summary: '手环当前未连接。',
          nextStep: '需要使用手环时，请先阅读设备管理页警告，再手动点击连接。',
        },
  );
  checks.push(
    input.bundledRpkExists
      ? pass('bundled-rpk', '内置手环应用', '安装包内的 band-app.rpk 完整。')
      : {
          id: 'bundled-rpk',
          label: '内置手环应用',
          status: 'fail',
          summary: 'Pulse 安装目录缺少 band-app.rpk。',
          nextStep: '请从 GitHub Releases 重新下载并安装完整版本。',
        },
  );
  checks.push(
    input.usableQuotaCount > 0
      ? pass('quota', 'AI 额度数据', `已有 ${input.usableQuotaCount} 个额度来源可用。`)
      : {
          id: 'quota',
          label: 'AI 额度数据',
          status: 'warn',
          summary: '暂时没有可用的额度数据。',
          nextStep: '请登录至少一个受支持的 AI Agent，再重新运行诊断。',
        },
  );

  return { checkedAt: Date.now(), checks };
}
