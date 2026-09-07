/**
 * 主屏「设备管理」（照 pulse-ui-mockup/main.html 搬入 React，数据来自 oronbox-bridge 快照）。
 *
 * 硬约束 2：.rpk 装包只做界面，选中后必须由人点「推送至手环」才会触发传输。
 * authkey 红线：渲染进程只拿 oronbox-bridge 消毒后的字段，不接触原始设备对象。
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Check, Info, Radio, RefreshCw, Repeat, Wifi, Download, Upload, X } from 'lucide-react';
import type { PulseOronboxState } from '../../../main/services/oronbox-bridge';
import { Card, StatusBadge, Toggle, fmtSize, fmtTime, maskMac } from './ui';

type ConnTone = 'success' | 'warning' | 'danger';

const STATUS_TEXT: Record<string, string> = {
  connected: '已连接 (Connected)',
  connecting: '正在连接... (Connecting)',
  disconnected: '未连接 (Disconnected)',
  error: '连接异常 (Error)',
};

const STATUS_NOTICE: Record<string, string> = {
  connected: 'SPP 蓝牙链路通畅，手环已就绪。',
  connecting: '正在与手环建立 SPP 蓝牙串口通道...',
  // 最常见的原因不是「离线」，是手环正被手机占着 —— 手环同一时间只认一个宿主。
  // 让人去查蓝牙和距离，永远查不出问题（2026-09-05 踩过）。
  disconnected: '手环多半正被手机占着。在手环上进 设置 → 系统操作 → 连接新手机，再点下面的「立即连接」。',
  error: '',
};

/**
 * 把 daemon 抛的原始报错翻译成「该干什么」。
 * 这两条的含义出处：HANDOFF_XIAOMI_BAND10.md §9.5。
 */
function explainError(raw?: string): string {
  if (!raw) return '连接出现异常。';
  if (raw.includes('No RFCOMM channel available')) {
    return '手环没进「连接新手机」模式，或正被手机占着。在手环上进 设置 → 系统操作 → 连接新手机 再试。';
  }
  if (raw.includes('Auth HMAC mismatch')) {
    return 'authkey 不对。手环被重新绑定过，需要从 Mi Fitness 日志重新取 key（见 HANDOFF §9.2）。';
  }
  return raw;
}

export const DeviceScreen: React.FC<{ state: PulseOronboxState | null }> = ({ state }) => {
  const device = state?.device ?? null;
  const connection = state?.connection ?? { state: 'disconnected' as const };
  const bridge = state?.bridge;

  // 点击「立即连接」后的乐观状态：快照轮询（5s）跟上后以快照为准
  const [pendingConnect, setPendingConnect] = useState(false);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'bridge' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanCountdown, setScanCountdown] = useState(0);
  const [scanResults, setScanResults] = useState<Array<{ name: string; address: string; connectType: string }>>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; size: number; path: string } | null>(null);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [installProgress, setInstallProgress] = useState<{ progress: number } | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeMsg, setModeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [importForm, setImportForm] = useState<{
    name: string;
    addr: string;
    connectType: string;
    authkey: string;
    codename: string;
  } | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const logInputRef = useRef<HTMLInputElement>(null);
  const [keyDrop, setKeyDrop] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyResult, setKeyResult] = useState<import('../../env').BandKeyResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showMac, setShowMac] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const connState =
    pendingConnect && connection.state === 'disconnected' ? 'connecting' : connection.state;
  const tone: ConnTone = connState === 'connected' ? 'success' : connState === 'connecting' ? 'warning' : 'danger';

  useEffect(() => {
    if (!window.pulse) return;
    const unsub = window.pulse.onInstallProgress((p) => {
      if (p.done) {
        setInstallProgress(null);
        setInstallMsg({ ok: true, text: `安装完成：${p.fileName} 已推送至手环` });
      } else {
        setInstallProgress({ progress: p.progress });
      }
    });
    return unsub;
  }, []);

  // 快照显示已连接/已断开时清掉乐观状态
  useEffect(() => {
    if (connection.state !== 'disconnected') setPendingConnect(false);
  }, [connection.state]);

  const handleConnect = async () => {
    setBusy('connect');
    setPendingConnect(true);
    const res = await window.pulse?.connectBand();
    if (res && !res.ok) {
      setPendingConnect(false);
      setInstallMsg({ ok: false, text: `连接失败：${res.error ?? '未知错误'}` });
    }
    setBusy(null);
  };

  const handleDisconnect = async () => {
    setBusy('disconnect');
    await window.pulse?.disconnectBand();
    setBusy(null);
  };

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    setScanCountdown(10);
    setScanResults([]);
    setScanError(null);
    const timer = setInterval(() => setScanCountdown((c) => Math.max(0, c - 1)), 1000);
    const res = await window.pulse?.scanDevices();
    clearInterval(timer);
    setScanCountdown(0);
    setScanning(false);
    if (res?.ok) setScanResults(res.devices);
    else setScanError(res?.error ?? '扫描失败');
  };

  const handleAutoReconnect = async (v: boolean) => {
    await window.pulse?.setAutoReconnect(v);
  };

  const handleBridgeToggle = async () => {
    if (!bridge) return;
    setBusy('bridge');
    await window.pulse?.toggleBridge(!bridge.running);
    setBusy(null);
  };

  // 阶段 7 第三步：互斥开关在主进程验证式保证（直连 = 插件已确认关闭）
  const handleBridgeMode = async (mode: 'plugin' | 'direct') => {
    if (!bridge || mode === bridge.mode || modeBusy) return;
    setModeBusy(true);
    setModeMsg(null);
    const res = await window.pulse?.setBridgeMode(mode);
    setModeBusy(false);
    if (res && !res.ok) setModeMsg({ ok: false, text: res.error ?? '切换失败' });
    else setModeMsg({ ok: true, text: mode === 'direct' ? '已切换到直连模式（插件已关闭）' : '已切换回插件模式' });
  };

  const handleImport = async () => {
    if (!importForm) return;
    setImportBusy(true);
    setImportMsg(null);
    const res = await window.pulse?.importDevice({
      name: importForm.name,
      addr: importForm.addr,
      connectType: importForm.connectType,
      authkey: importForm.authkey,
      codename: importForm.codename || undefined,
    });
    setImportBusy(false);
    if (res && !res.ok) setImportMsg({ ok: false, text: res.error ?? '导入失败' });
    else {
      setImportMsg({ ok: true, text: `已导入 ${importForm.name}，可点击「立即连接」` });
      setImportForm(null); // authkey 输入用完即清
    }
  };

  const acceptFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.rpk')) {
      setInstallMsg({ ok: false, text: '只支持 .rpk 快应用格式，其他类型不做安装（避免未验证的失败路径）' });
      return;
    }
    const path = window.pulse?.getPathForFile(f) ?? '';
    if (!path) {
      setInstallMsg({ ok: false, text: '无法获取文件本地路径' });
      return;
    }
    setFile({ name: f.name, size: f.size, path });
    setInstallMsg(null);
  };

  const acceptLog = async (f: File | null | undefined) => {
    if (!f) return;
    const p = window.pulse?.getPathForFile(f) ?? '';
    if (!p) {
      setKeyResult({ ok: false, error: '无法获取文件本地路径' });
      return;
    }
    setKeyBusy(true);
    setKeyResult(null);
    const res = await window.pulse?.extractBandKey(p);
    setKeyBusy(false);
    setKeyResult(res ?? { ok: false, error: '解析失败' });
  };

  const copyKey = (k: string) => {
    navigator.clipboard
      .writeText(k)
      .then(() => {
        setCopied(k);
        setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => setCopied('__fail__'));
  };

  const handlePushBundled = async () => {
    if (connState !== 'connected') {
      setInstallMsg({ ok: false, text: '⚠️ 手环当前未连接！装包前手环必须已连接，请先点击「立即连接」。' });
      return;
    }
    setInstallMsg(null);
    setInstallProgress({ progress: 0 });
    const res = await window.pulse?.installBundledRpk();
    setInstallProgress(null);
    if (res && !res.ok) setInstallMsg({ ok: false, text: `推送失败：${res.error ?? '未知错误'}` });
    else if (res?.ok) setInstallMsg({ ok: true, text: '安装成功：内置版本已推送至手环' });
  };

  const handlePush = async () => {
    if (!file) return;
    if (connState !== 'connected') {
      setInstallMsg({ ok: false, text: '⚠️ 手环当前未连接！装包前手环必须已连接，请先点击「立即连接」。' });
      return;
    }
    setInstallMsg(null);
    setInstallProgress({ progress: 0 });
    const res = await window.pulse?.installRpk(file.path, file.name);
    setInstallProgress(null);
    if (res && !res.ok) setInstallMsg({ ok: false, text: `推送失败：${res.error ?? '未知错误'}` });
    else if (res?.ok) setInstallMsg({ ok: true, text: `安装成功：${file.name} 已推送至手环` });
  };

  const heroTone =
    connState === 'connected'
      ? 'border-emerald-500/30 shadow-[0_4px_20px_rgba(16,185,129,0.08)]'
      : 'border-white/[0.1] shadow-[0_4px_20px_rgba(0,0,0,0.3)]';

  return (
    <main className="flex-1 bg-island-bg overflow-y-auto custom-scrollbar p-5 space-y-4">
      {/* 模块 1：连接状态 Hero */}
      {device ? (
        <section className={`p-4 rounded-xl bg-island-surface border transition-all ${heroTone}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-xl bg-zinc-800/80 border border-zinc-700 flex items-center justify-center text-zinc-400 shadow-inner">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="7" y="4" width="10" height="16" rx="3" />
                  <path d="M11 2h2" />
                  <path d="M11 22h2" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-zinc-100">{device.name}</h2>
                  {device.codename && (
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                      {device.codename}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                  <span className="flex items-center gap-1 font-mono tabular-nums">
                    <span className="text-zinc-500">MAC:</span>
                    <span
                      className="cursor-pointer select-none"
                      title={showMac ? '点击隐藏' : '已打码，点击显示完整 MAC'}
                      onClick={() => setShowMac(!showMac)}
                    >
                      {showMac ? device.address : maskMac(device.address)}
                    </span>
                  </span>
                  <span className="text-zinc-600">|</span>
                  <span className="flex items-center gap-1">
                    <span className="text-zinc-500">通道:</span>
                    <span className="text-zinc-300 font-mono uppercase">{device.connectType} (蓝牙串口)</span>
                  </span>
                </div>
              </div>
            </div>
            <StatusBadge tone={tone} text={STATUS_TEXT[connState] ?? STATUS_TEXT.disconnected} />
          </div>

          <div className="mt-3.5 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs text-zinc-400">
            <div className="flex items-center gap-1.5">
              <AlertCircle className={`w-3.5 h-3.5 ${tone === 'success' ? 'text-emerald-400' : tone === 'warning' ? 'text-amber-400' : 'text-rose-400'}`} />
              <span>{connState === 'error' ? explainError(connection.error) : STATUS_NOTICE[connState] ?? STATUS_NOTICE.disconnected}</span>
            </div>
            <span className="text-[11px] text-zinc-500 font-mono">
              协议状态: <span className="text-zinc-300">{connState}</span>
            </span>
          </div>
        </section>
      ) : (
        <section className="p-8 rounded-xl bg-island-surface border border-dashed border-white/[0.15] text-center space-y-3">
          <div className="w-12 h-12 mx-auto rounded-full bg-zinc-800/80 flex items-center justify-center text-zinc-400">
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-medium text-zinc-200">未绑定任何小米手环</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
              当前系统中暂无配对的手环记录。请点击下方「扫描设备」进行搜索与首次绑定。
            </p>
          </div>
          <button
            onClick={handleScan}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-island-accent hover:bg-sky-400 text-zinc-950 font-medium text-xs transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            开始扫描发现设备
          </button>
        </section>
      )}

      {/* 模块 2：设备操作 */}
      <section className="grid grid-cols-3 gap-3.5">
        <Card className="p-3.5 flex flex-col justify-between">
          <div className="space-y-1">
            <div className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
              <Wifi className="w-3.5 h-3.5 text-island-accent" />
              蓝牙连接控制
            </div>
            <p className="text-[11px] text-zinc-400">发起 SPP 握手或主动切断当前连接</p>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleConnect}
              disabled={connState !== 'disconnected' || busy !== null}
              className="flex-1 py-1.5 rounded-lg bg-island-accent hover:bg-sky-400 active:bg-sky-600 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold text-xs transition shadow-[0_0_12px_rgba(56,189,248,0.3)] disabled:shadow-none flex items-center justify-center gap-1.5"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              <span>{pendingConnect || connState === 'connecting' ? '连接中...' : '立即连接'}</span>
            </button>
            <button
              onClick={handleDisconnect}
              disabled={connState !== 'connected' || busy !== null}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 disabled:opacity-40 disabled:pointer-events-none font-medium text-xs transition"
            >
              断开
            </button>
          </div>
        </Card>

        <Card className="p-3.5 flex flex-col justify-between">
          <div className="space-y-1">
            <div className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              周围设备扫描
            </div>
            <p className="text-[11px] text-zinc-400">通过 BLE/SPP 检索可连接的佩戴设备</p>
          </div>
          <div className="mt-3">
            <button
              onClick={handleScan}
              disabled={scanning}
              className="w-full py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 active:bg-zinc-600 text-zinc-200 font-medium text-xs transition flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-zinc-400 ${scanning ? 'animate-spin' : ''}`} />
              <span className="tabular-nums">{scanning ? `正在扫描周围手环 (${scanCountdown}s)` : '扫描可用手环 (10s)'}</span>
            </button>
          </div>
        </Card>

        <Card className="p-3.5 flex flex-col justify-between">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
                <Repeat className="w-3.5 h-3.5 text-indigo-400" />
                自动重连
              </span>
              <Toggle
                checked={state?.autoReconnect ?? false}
                onChange={handleAutoReconnect}
              />
            </div>
            <p className="text-[11px] text-zinc-400">daemon 启动时自动回连已配对手环</p>
          </div>
          <div className="mt-3 text-[11px] text-zinc-500 flex items-center justify-between">
            <span>
              状态: <strong className={`font-medium ${(state?.autoReconnect ?? false) ? 'text-island-accent' : 'text-zinc-500'}`}>
                {(state?.autoReconnect ?? false) ? '已启用' : '已停用'}
              </strong>
            </span>
          </div>
        </Card>
      </section>

      {/* 扫描结果 + 设备导入（阶段 7 顺手①：device.import，手输 authkey） */}
      {(scanResults.length > 0 || scanError || importForm) && (
        <section className="p-3.5 rounded-xl bg-island-surface border border-white/[0.08] space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              扫描结果 <span className="text-[10px] text-zinc-500 font-mono tabular-nums">({scanResults.length} 台)</span>
            </div>
            {!importForm && (
              <button
                onClick={() =>
                  setImportForm({ name: '', addr: '', connectType: 'spp', authkey: '', codename: '' })
                }
                className="text-[11px] text-island-accent hover:text-sky-300 font-medium transition"
              >
                + 手动添加设备
              </button>
            )}
          </div>
          {scanError && <div className="text-xs text-rose-400">{scanError}</div>}
          <div className="space-y-1.5">
            {scanResults.map((d) => (
              <div key={d.address} className="flex items-center justify-between p-2 rounded-lg bg-[#0e1017] border border-white/[0.04] text-xs">
                <span className="text-zinc-200 font-medium">{d.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-zinc-500 font-mono tabular-nums">
                    {maskMac(d.address)} · {d.connectType.toUpperCase()}
                  </span>
                  {!importForm && (
                    <button
                      onClick={() =>
                        setImportForm({
                          name: d.name,
                          addr: d.address,
                          connectType: d.connectType === 'ble' ? 'ble' : 'spp',
                          authkey: '',
                          codename: '',
                        })
                      }
                      className="text-island-accent hover:text-sky-300 font-medium"
                    >
                      导入
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>

          {importForm && (
            <div className="p-3 rounded-lg bg-[#0e1017] border border-white/[0.08] space-y-2">
              <div className="text-xs font-medium text-zinc-200">导入新设备（authkey 由你手工输入）</div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="px-2.5 py-1.5 rounded-lg bg-island-input border border-white/[0.08] text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-sky-500/50"
                  placeholder="设备名称，如 Xiaomi Smart Band 10"
                  value={importForm.name}
                  onChange={(e) => setImportForm({ ...importForm, name: e.target.value })}
                />
                <input
                  className="px-2.5 py-1.5 rounded-lg bg-island-input border border-white/[0.08] text-xs text-zinc-200 placeholder-zinc-600 font-mono focus:outline-none focus:border-sky-500/50"
                  placeholder="MAC 地址 AA:BB:CC:DD:EE:FF"
                  value={importForm.addr}
                  onChange={(e) => setImportForm({ ...importForm, addr: e.target.value })}
                />
                <select
                  className="px-2.5 py-1.5 rounded-lg bg-island-input border border-white/[0.08] text-xs text-zinc-200 focus:outline-none focus:border-sky-500/50"
                  value={importForm.connectType}
                  onChange={(e) => setImportForm({ ...importForm, connectType: e.target.value })}
                >
                  <option value="spp">SPP (蓝牙串口)</option>
                  <option value="ble">BLE</option>
                </select>
                <input
                  className="px-2.5 py-1.5 rounded-lg bg-island-input border border-white/[0.08] text-xs text-zinc-200 placeholder-zinc-600 font-mono focus:outline-none focus:border-sky-500/50"
                  placeholder="硬件代号 (可选，如 o66)"
                  value={importForm.codename}
                  onChange={(e) => setImportForm({ ...importForm, codename: e.target.value })}
                />
                <input
                  type="password"
                  className="col-span-2 px-2.5 py-1.5 rounded-lg bg-island-input border border-white/[0.08] text-xs text-zinc-200 placeholder-zinc-600 font-mono focus:outline-none focus:border-sky-500/50"
                  placeholder="authkey（配对密钥，导入后立即从输入框清除，不会落盘到界面）"
                  value={importForm.authkey}
                  onChange={(e) => setImportForm({ ...importForm, authkey: e.target.value })}
                />
              </div>
              {importMsg && (
                <div className={`text-xs ${importMsg.ok ? 'text-emerald-400' : 'text-rose-400'}`}>{importMsg.text}</div>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => {
                    setImportForm(null);
                    setImportMsg(null);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition"
                >
                  取消
                </button>
                <button
                  onClick={handleImport}
                  disabled={importBusy || !importForm.name || !importForm.addr || !importForm.authkey}
                  className="px-4 py-1.5 rounded-lg bg-island-accent hover:bg-sky-400 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold text-xs transition"
                >
                  {importBusy ? '导入中...' : '导入到手环管理'}
                </button>
              </div>
              <p className="text-[10px] text-zinc-500">
                导入调用 device.import 写入 OronBox 配对库；不会触碰已有设备的配对，device.remove 仍然禁用。
              </p>
            </div>
          )}

          <p className="text-[10px] text-zinc-500">配对关系由 OronBox 管理；扫描仅用于确认设备是否在信号范围内。</p>
        </section>
      )}

      {/* 模块 3：联网桥接 */}
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/25 flex items-center justify-center text-indigo-400">
              <Wifi className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-zinc-200">米环互联 FetchBridge</h3>
                {bridge?.version && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">
                    v{bridge.version}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">为手环端应用提供电脑端回环代理联网能力</p>
            </div>
          </div>

          {/* 模式开关（互斥，主进程验证式保证）+ 插件启停（仅插件模式） */}
          <div className="flex items-center gap-3">
            <div className="flex rounded-lg border border-white/[0.12] overflow-hidden text-xs">
              <button
                onClick={() => handleBridgeMode('plugin')}
                disabled={modeBusy || bridge?.mode === 'plugin'}
                className={`px-2.5 py-1 transition ${
                  bridge?.mode === 'plugin'
                    ? 'bg-sky-500/20 text-island-accent font-medium'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 disabled:opacity-50'
                }`}
                title="走 FetchBridge 插件 + 8765 HTTP 跳（阶段 3 链路，默认）"
              >
                插件模式
              </button>
              <button
                onClick={() => handleBridgeMode('direct')}
                disabled={modeBusy || bridge?.mode === 'direct'}
                className={`px-2.5 py-1 transition ${
                  bridge?.mode === 'direct'
                    ? 'bg-emerald-500/20 text-emerald-300 font-medium'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 disabled:opacity-50'
                }`}
                title="Pulse 订阅 interconnect 直接应答（阶段 7；切换时插件会被验证式关闭）"
              >
                直连模式
              </button>
            </div>
            {bridge?.mode === 'plugin' ? (
              <>
                <div
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border ${
                    bridge?.running
                      ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${bridge?.running ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-500'}`} />
                  <span>{bridge?.running ? '正在代理网络请求' : '已停止代理'}</span>
                </div>
                <button
                  onClick={handleBridgeToggle}
                  disabled={busy === 'bridge' || !bridge?.installed}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition border disabled:opacity-40 disabled:pointer-events-none ${
                    bridge?.running
                      ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border-rose-500/30'
                      : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-white/[0.08]'
                  }`}
                >
                  {bridge?.running ? '停止代理' : '启动代理'}
                </button>
              </>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border bg-emerald-500/15 border-emerald-500/30 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>Pulse 直连应答中</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-white/[0.06] text-xs">
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">监听快应用包名</div>
            <div className="text-zinc-200 font-mono mt-0.5 flex items-center justify-between">
              <span>{bridge?.packageName ?? 'com.codeisland.band'}</span>
              <span className={`text-[10px] ${bridge?.installed ? 'text-emerald-400' : 'text-zinc-600'}`}>
                {bridge?.installed ? '已安装' : '未安装'}
              </span>
            </div>
          </div>
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">累计代理请求</div>
            <div className="text-zinc-200 font-mono tabular-nums text-sm font-semibold mt-0.5">
              {bridge?.requestCount ?? 0} <span className="text-xs font-normal text-zinc-500">次</span>
              <span className="text-[10px] font-normal text-zinc-500 ml-1.5">最近 {fmtTime(bridge?.lastRequestAt)}</span>
            </div>
          </div>
          <div className="bg-[#0e1017] p-2.5 rounded-lg border border-white/[0.04]">
            <div className="text-[10px] text-zinc-500 uppercase font-medium">最近请求时延</div>
            <div
              className={`font-mono tabular-nums text-sm font-semibold mt-0.5 ${
                bridge?.mode === 'direct' ? 'text-emerald-400' : 'text-zinc-400'
              }`}
              title={
                bridge?.mode === 'direct'
                  ? '直连模式下 Pulse 进程内取数的耗时'
                  : '插件模式下请求由插件直连、不经过 Pulse，无法测得；切直连后可测'
              }
            >
              {bridge?.mode === 'direct' && bridge?.lastLatencyMs != null ? (
                <>
                  {bridge.lastLatencyMs} <span className="text-xs font-normal text-zinc-500">ms</span>
                </>
              ) : (
                <>
                  — <span className="text-xs font-normal text-zinc-500">ms</span>
                </>
              )}
            </div>
          </div>
        </div>

        {modeMsg && (
          <div
            className={`text-xs p-2.5 rounded-lg border ${
              modeMsg.ok
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}
          >
            {modeMsg.text}
          </div>
        )}
      </section>

      {/* 模块 3.5：从日志里取 authkey（拖入即解析，只显示不写盘） */}
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-island-accent" />
            <h3 className="text-sm font-semibold text-zinc-200">从手机日志里取 authkey</h3>
          </div>
          <span className="text-[11px] text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded border border-zinc-700">
            .zip / .log / 日志文件夹
          </span>
        </div>

        <p className="text-[11px] text-zinc-500 leading-relaxed">
          手机装「小米健康研究」后，日志在 <code className="text-zinc-400">Download/ResearchLog/research-数字/XiaomiFit.main.log</code>。
          把它（或整个文件夹、或 Mi Fitness 导出的 zip）拖进来即可。
          <span className="text-zinc-400">解析只在本机进行，临时解压的副本用完立即删除，不会写入任何配置。</span>
        </p>

        <div
          className={`p-5 rounded-xl text-center cursor-pointer select-none drop-zone ${keyDrop ? 'active' : ''}`}
          onClick={() => !keyBusy && logInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setKeyDrop(true);
          }}
          onDragLeave={() => setKeyDrop(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setKeyDrop(false);
            void acceptLog(e.dataTransfer.files?.[0]);
          }}
        >
          <p className="text-xs text-zinc-300">{keyBusy ? '正在解析日志…' : '把日志文件拖到这里，或点击选择'}</p>
        </div>
        <input
          ref={logInputRef}
          type="file"
          accept=".log,.zip"
          className="hidden"
          onChange={(e) => void acceptLog(e.target.files?.[0])}
        />

        {keyResult && !keyResult.ok && (
          <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-2.5 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{keyResult.error}</span>
          </div>
        )}

        {keyResult && keyResult.ok && (
          <div className="space-y-2">
            {[
              { label: 'deviceKey（已去掉开头的 did）', value: keyResult.deviceKey },
              { label: 'encryptKey', value: keyResult.encryptKey },
            ]
              .filter((k) => k.value)
              .map((k) => (
                <div key={k.label} className="p-2.5 rounded-lg bg-[#0e1017] border border-white/[0.06] space-y-1.5">
                  <div className="text-[10px] text-zinc-500">{k.label}</div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-island-accent break-all select-all flex-1">{k.value}</code>
                    <button
                      onClick={() => copyKey(k.value as string)}
                      className="shrink-0 px-2 py-1 rounded text-[11px] bg-island-accent/15 border border-island-accent/30 text-island-accent hover:bg-island-accent/25 transition"
                    >
                      {copied === k.value ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>
              ))}

            {keyResult.deviceKey && keyResult.encryptKey && (
              <div
                className={`text-[11px] flex items-start gap-1.5 ${keyResult.agree ? 'text-emerald-400' : 'text-amber-300'}`}
              >
                {keyResult.agree ? <Check className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                <span>
                  {keyResult.agree
                    ? '两个字段一致，用哪个都行。'
                    : '两个字段不一致 —— OronBox 用的是 encryptKey，先试它；不行再试 deviceKey。'}
                </span>
              </div>
            )}

            {copied === '__fail__' && <div className="text-[11px] text-amber-300">复制失败，请手动选中上面的字符串复制。</div>}

            <div className="text-[11px] text-zinc-500 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                下一步：手环上进 设置 → 系统操作 → 连接新手机，然后在 <span className="text-zinc-300">OronBox</span> 里扫描（connectType 选 spp）并粘贴这串 key 连接。
                连上之后 Pulse 才能推数据。
              </span>
            </div>
          </div>
        )}
      </section>

      {/* 模块 4：安装推送 */}
      <section className="p-4 rounded-xl bg-island-surface border border-white/[0.08] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-island-accent" />
            <h3 className="text-sm font-semibold text-zinc-200">手环安装包推送</h3>
          </div>
          <span className="text-[11px] text-zinc-400 bg-zinc-800/80 px-2 py-0.5 rounded border border-zinc-700">
            仅支持 <code className="text-island-accent font-bold">.rpk</code> 快应用格式
          </span>
        </div>

        <div
          className={`p-5 rounded-xl text-center cursor-pointer select-none drop-zone ${dropActive ? 'active' : ''}`}
          onClick={() => !file && !installProgress && fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDropActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDropActive(false);
            if (!installProgress) acceptFile(e.dataTransfer.files?.[0]);
          }}
        >
          {!file && !installProgress && (
            <div className="space-y-1.5">
              <div className="w-10 h-10 mx-auto rounded-full bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-island-accent">
                <Upload className="w-5 h-5" />
              </div>
              <div className="text-xs font-medium text-zinc-300">
                将 <span className="text-island-accent font-mono font-bold">.rpk</span> 文件拖入此处，或点击浏览文件
              </div>
              <p className="text-[11px] text-zinc-500">拖入后需手动确认才会推送至手环，不会自动触发传输</p>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void handlePushBundled();
                }}
                disabled={!!installProgress}
                className="mt-3 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-island-accent/15 border border-island-accent/30 text-island-accent hover:bg-island-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                或直接安装 Pulse 内置的版本（推荐，不用自己找 .rpk）
              </button>
            </div>
          )}

          {file && !installProgress && (
            <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0e1017] border border-white/[0.08] text-left">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded bg-sky-500/20 text-sky-400 flex items-center justify-center font-bold text-xs font-mono">RPK</div>
                  <div>
                    <div className="text-xs font-medium text-zinc-200">{file.name}</div>
                    <div className="text-[10px] text-zinc-500 font-mono tabular-nums">大小: {fmtSize(file.size)}</div>
                  </div>
                </div>
                <button
                  className="text-zinc-500 hover:text-zinc-300 p-1"
                  onClick={() => setFile(null)}
                  title="移除"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* 硬约束 2：必须人点这个按钮才推送 */}
              <div className="flex items-center justify-end gap-2">
                <button className="px-3 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 transition" onClick={() => setFile(null)}>
                  取消
                </button>
                <button
                  onClick={handlePush}
                  disabled={connState !== 'connected'}
                  className="px-4 py-1.5 rounded-lg bg-island-accent hover:bg-sky-400 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed text-zinc-950 font-semibold text-xs transition shadow-[0_0_15px_rgba(56,189,248,0.3)] disabled:shadow-none flex items-center gap-1.5"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                  <span>推送至手环</span>
                </button>
              </div>
            </div>
          )}

          {installProgress && (
            <div className="space-y-2 text-left p-2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-300 font-medium flex items-center gap-1.5">
                  <RefreshCw className="w-3.5 h-3.5 text-island-accent animate-spin" />
                  正在传输并安装至手环...
                </span>
                <span className="font-mono tabular-nums text-island-accent font-bold">{installProgress.progress}%</span>
              </div>
              <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-island-accent rounded-full transition-all duration-200"
                  style={{ width: `${installProgress.progress}%` }}
                />
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">通过 SPP 串口分包传输中 · 请勿切断手环连接</div>
            </div>
          )}
        </div>

        {installMsg && (
          <div
            className={`flex items-start gap-1.5 text-xs p-2.5 rounded-lg border ${
              installMsg.ok
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
            }`}
          >
            {installMsg.ok ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span className="break-all">{installMsg.text}</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".rpk"
          className="hidden"
          onChange={(e) => {
            acceptFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </section>
    </main>
  );
};
