import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Clock3, Download, KeyRound, Package, Settings2, Upload, Wrench } from 'lucide-react';
import type { PulseOronboxState } from '../../../main/services/oronbox-bridge';
import type { BandKeyResult, HookStatus } from '../../env';
import { Card, fmtSize } from './ui';

export const SettingsScreen: React.FC<{ state: PulseOronboxState | null }> = ({ state }) => {
  const [version, setVersion] = useState('');
  const [oronboxInstalled, setOronboxInstalled] = useState<boolean | null>(null);
  const [update, setUpdate] = useState<{ text: string; url?: string; ok: boolean } | null>(null);
  const [hook, setHook] = useState<HookStatus | null>(null);
  const [hookMessage, setHookMessage] = useState<string | null>(null);
  const [keyResult, setKeyResult] = useState<BandKeyResult | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [installMessage, setInstallMessage] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<number | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [modeMessage, setModeMessage] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [developerOpen, setDeveloperOpen] = useState(false);
  const [rpk, setRpk] = useState<{ name: string; size: number; path: string } | null>(null);
  const logInput = useRef<HTMLInputElement>(null);
  const rpkInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.pulse?.getAppVersion().then(setVersion);
    window.pulse?.isOronboxInstalled().then(setOronboxInstalled);
    window.pulse?.getHookStatus().then(setHook);
    return window.pulse?.onInstallProgress((progress) => {
      if (progress.done) {
        setInstallProgress(null);
        setInstallMessage(`安装完成：${progress.fileName}`);
      } else {
        setInstallProgress(progress.progress);
      }
    });
  }, []);

  const checkUpdate = async () => {
    setUpdate({ ok: true, text: '正在检查 GitHub Release…' });
    const result = await window.pulse?.checkUpdate();
    if (!result?.ok) {
      setUpdate({ ok: false, text: `检查失败：${result?.error ?? '未知错误'}` });
    } else if (result.updateAvailable) {
      setUpdate({ ok: true, text: `发现新版本 v${result.latestVersion}`, url: result.releaseUrl });
    } else {
      setUpdate({ ok: true, text: `当前 v${result.currentVersion} 已是最新版` });
    }
  };

  const acceptLog = async (file: File | null | undefined) => {
    if (!file) return;
    const filePath = window.pulse?.getPathForFile(file) ?? '';
    if (!filePath) return setKeyResult({ ok: false, error: '无法获取文件路径' });
    setKeyBusy(true);
    setKeyResult(await window.pulse?.extractBandKey(filePath) ?? { ok: false, error: '解析失败' });
    setKeyBusy(false);
  };

  const copyKey = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setHookMessage('authkey 已复制');
  };

  const runHook = async (action: 'install' | 'uninstall') => {
    const result = action === 'install' ? await window.pulse?.installHook() : await window.pulse?.uninstallHook();
    setHookMessage(result?.ok ? (action === 'install' ? 'Hook 已安装，请重开 Claude Code 会话' : 'Hook 已卸载') : `操作失败：${result?.error ?? '未知错误'}`);
    setHook(await window.pulse?.getHookStatus() ?? null);
  };

  const installBundled = async () => {
    setInstallProgress(0);
    setInstallMessage(null);
    const result = await window.pulse?.installBundledRpk();
    setInstallProgress(null);
    setInstallMessage(result?.ok ? 'Pulse 手环端安装成功' : `安装失败：${result?.error ?? '未知错误'}`);
  };

  const acceptRpk = (file: File | null | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.rpk')) return setInstallMessage('只支持 .rpk 文件');
    const filePath = window.pulse?.getPathForFile(file) ?? '';
    if (!filePath) return setInstallMessage('无法获取文件路径');
    setRpk({ name: file.name, size: file.size, path: filePath });
  };

  const installRpk = async () => {
    if (!rpk) return;
    setInstallProgress(0);
    setInstallMessage(null);
    const result = await window.pulse?.installRpk(rpk.path, rpk.name);
    setInstallProgress(null);
    setInstallMessage(result?.ok ? `${rpk.name} 安装成功` : `安装失败：${result?.error ?? '未知错误'}`);
  };

  const syncTime = async () => {
    setSyncMessage('正在同步…');
    const result = await window.pulse?.syncBandTime();
    setSyncMessage(result?.ok ? '校时请求已完成' : `校时失败：${result?.error ?? '未知错误'}`);
  };

  const setMode = async (mode: 'direct' | 'plugin') => {
    setModeMessage('正在切换…');
    const result = await window.pulse?.setBridgeMode(mode);
    setModeMessage(result?.ok ? (mode === 'direct' ? '已使用 Pulse 直连' : '已启用 FetchBridge 兼容模式') : `切换失败：${result?.error ?? '未知错误'}`);
  };

  const keys =
    keyResult?.ok
      ? [
          keyResult.encryptKey && { label: 'encryptKey（优先）', value: keyResult.encryptKey },
          keyResult.deviceKey && { label: 'deviceKey', value: keyResult.deviceKey },
        ].filter(Boolean) as Array<{ label: string; value: string }>
      : [];

  return (
    <main className="flex-1 bg-island-bg overflow-y-auto custom-scrollbar p-5 space-y-4 select-text">
      <Card className="p-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Pulse 桌面端</h2>
          <p className="text-xs text-zinc-500 mt-1">当前版本 {version ? `v${version}` : '读取中…'} · 更新由 GitHub Releases 发布</p>
        </div>
        <div className="flex items-center gap-2 select-none">
          {update && <span className={`text-xs ${update.ok ? 'text-emerald-400' : 'text-rose-300'}`}>{update.text}</span>}
          {update?.url && <button onClick={() => window.pulse?.openRelease(update.url!)} className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 text-xs">打开下载页</button>}
          <button onClick={checkUpdate} className="px-3 py-1.5 rounded-lg bg-island-accent text-zinc-950 text-xs font-semibold">检查更新</button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Settings2 className="w-4 h-4 text-island-accent" /><h2 className="text-sm font-semibold">首次设置</h2></div>
          <span className={`text-xs ${oronboxInstalled ? 'text-emerald-400' : 'text-amber-300'}`}>
            {oronboxInstalled == null ? '正在检查 OronBox…' : oronboxInstalled ? 'OronBox 已安装' : '未找到 OronBox'}
          </span>
        </div>
        <ol className="list-decimal pl-5 text-xs text-zinc-400 space-y-1.5">
          <li>安装并打开一次 OronBox。</li>
          <li>从手机导出小米运动健康或小米健康研究日志，在下方提取 authkey。</li>
          <li>在手环进入 设置 → 系统操作 → 连接新手机。</li>
          <li>在 OronBox 中扫描手环，连接类型选择 SPP，粘贴 authkey 完成配对。</li>
          <li>回到设备管理页手动连接，再安装 Pulse 手环端和 Claude Code Hook。</li>
        </ol>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2"><KeyRound className="w-4 h-4 text-amber-400" /><h2 className="text-sm font-semibold">从手机日志提取 authkey</h2></div>
        <input ref={logInput} type="file" className="hidden" onChange={(event) => void acceptLog(event.target.files?.[0])} />
        <button
          onClick={() => logInput.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => { event.preventDefault(); void acceptLog(event.dataTransfer.files?.[0]); }}
          className="w-full p-4 rounded-lg border border-dashed border-white/15 bg-black/10 text-xs text-zinc-400 select-none"
        >
          {keyBusy ? '正在本机解析…' : '点击选择或拖入日志文件 / ZIP'}
        </button>
        {keyResult && !keyResult.ok && <p className="text-xs text-rose-300">{keyResult.error}</p>}
        {keys.map((key) => (
          <div key={key.label} className="flex items-center justify-between gap-3 p-2 rounded-lg bg-black/20">
            <div className="min-w-0"><div className="text-[10px] text-zinc-500">{key.label}</div><code className="text-xs text-zinc-200 break-all">{key.value}</code></div>
            <button onClick={() => void copyKey(key.value)} className="px-3 py-1.5 rounded-lg bg-zinc-800 text-xs select-none">复制</button>
          </div>
        ))}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2"><Package className="w-4 h-4 text-emerald-400" /><h2 className="text-sm font-semibold">安装或更新 Pulse 手环端</h2></div>
        <p className="text-xs text-zinc-400">需要先在设备管理页连接手环。内置版本随桌面安装包发布。</p>
        <button onClick={installBundled} disabled={installProgress !== null} className="px-4 py-2 rounded-lg bg-emerald-500/20 text-emerald-300 text-xs font-semibold disabled:opacity-50 select-none">
          <Download className="inline w-3.5 h-3.5 mr-1.5" />安装／重新安装手环端
        </button>
        {installProgress !== null && <p className="text-xs text-island-accent">正在传输：{installProgress}%</p>}
        {installMessage && <p className="text-xs text-zinc-300">{installMessage}</p>}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2"><Wrench className="w-4 h-4 text-violet-400" /><h2 className="text-sm font-semibold">Claude Code 接入</h2></div>
        <p className="text-xs text-zinc-400">Hook 把 Claude Code 会话和工具状态发送给 Pulse；不需要另装 Node.js。</p>
        <div className="flex items-center gap-2 select-none">
          <span className={`text-xs ${hook?.installed ? 'text-emerald-400' : 'text-zinc-500'}`}>{hook?.installed ? '已安装' : '未安装'}</span>
          <button onClick={() => void runHook('install')} className="px-3 py-1.5 rounded-lg bg-island-accent/20 text-island-accent text-xs">{hook?.installed ? '重新安装' : '安装 Hook'}</button>
          {hook?.installed && <button onClick={() => void runHook('uninstall')} className="px-3 py-1.5 rounded-lg bg-zinc-800 text-zinc-300 text-xs">卸载</button>}
        </div>
        {hookMessage && <p className="text-xs text-zinc-300">{hookMessage}</p>}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-center gap-2"><Clock3 className="w-4 h-4 text-sky-400" /><h2 className="text-sm font-semibold">手环时间</h2></div>
        <p className="text-xs text-zinc-400">OronBox 可能导致时间显示异常。Pulse 会在连接后自动尝试校时，也可以在此手动重试。</p>
        <button onClick={syncTime} disabled={state?.connection.state !== 'connected'} className="px-3 py-1.5 rounded-lg bg-zinc-800 text-xs disabled:opacity-40 select-none">重新同步手环时间</button>
        {syncMessage && <p className="text-xs text-zinc-300">{syncMessage}</p>}
      </Card>

      <Card className="p-4">
        <button onClick={() => setAdvancedOpen(!advancedOpen)} className="w-full flex items-center justify-between text-sm font-semibold select-none">
          <span>高级兼容模式</span><ChevronDown className={`w-4 h-4 transition ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>
        {advancedOpen && (
          <div className="pt-3 mt-3 border-t border-white/[0.06] space-y-3">
            <p className="text-xs text-zinc-400">默认使用 Pulse 直连。只有诊断提示直连异常时，才尝试 FetchBridge 兼容模式。</p>
            <div className="flex gap-2 select-none">
              <button onClick={() => void setMode('direct')} className={`px-3 py-1.5 rounded-lg text-xs ${state?.bridge.mode === 'direct' ? 'bg-island-accent text-zinc-950' : 'bg-zinc-800'}`}>Pulse 直连</button>
              <button onClick={() => void setMode('plugin')} className={`px-3 py-1.5 rounded-lg text-xs ${state?.bridge.mode === 'plugin' ? 'bg-amber-500/25 text-amber-200' : 'bg-zinc-800'}`}>FetchBridge 兼容模式</button>
            </div>
            {modeMessage && <p className="text-xs text-zinc-300">{modeMessage}</p>}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <button onClick={() => setDeveloperOpen(!developerOpen)} className="w-full flex items-center justify-between text-sm font-semibold select-none">
          <span>开发者工具：推送其他 RPK</span><ChevronDown className={`w-4 h-4 transition ${developerOpen ? 'rotate-180' : ''}`} />
        </button>
        {developerOpen && (
          <div className="pt-3 mt-3 border-t border-white/[0.06] space-y-3">
            <p className="text-xs text-zinc-400">Pulse 不保证第三方 RPK 的兼容性；拖入文件不会自动安装。</p>
            <input ref={rpkInput} type="file" accept=".rpk" className="hidden" onChange={(event) => acceptRpk(event.target.files?.[0])} />
            <button
              onClick={() => rpkInput.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); acceptRpk(event.dataTransfer.files?.[0]); }}
              className="w-full p-4 rounded-lg border border-dashed border-white/15 bg-black/10 text-xs text-zinc-400 select-none"
            >
              <Upload className="inline w-3.5 h-3.5 mr-1.5" />选择或拖入 .rpk
            </button>
            {rpk && <div className="flex items-center justify-between text-xs"><span>{rpk.name} · {fmtSize(rpk.size)}</span><button onClick={installRpk} className="px-3 py-1.5 rounded-lg bg-island-accent text-zinc-950 font-semibold select-none">确认推送</button></div>}
          </div>
        )}
      </Card>
    </main>
  );
};
