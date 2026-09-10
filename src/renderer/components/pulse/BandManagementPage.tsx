import React, { useEffect, useState } from 'react';
import { Watch, Package, Upload } from 'lucide-react';
import { useBandConnection } from '../../hooks/useBandConnection';
import { OtherAppInstall } from './OtherAppInstall';

export interface BandManagementPageProps {
  onStartSetup?: () => void;
}

const CONN_STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
  error: '连接失败',
};

interface BundledInfo {
  exists: boolean;
  packageId?: string;
  versionName?: string;
  versionCode?: number;
  fileSize?: number;
  manifestValid?: boolean;
}

export const BandManagementPage: React.FC<BandManagementPageProps> = ({ onStartSetup }) => {
  const conn = useBandConnection();

  // 内置手环端快应用的版本信息来自真实 manifest（安装动作在设置向导第 6 步）
  const [bundled, setBundled] = useState<BundledInfo | null>(null);

  useEffect(() => {
    let alive = true;
    window.pulse?.appInstall
      ?.getBundledInfo?.()
      .then((info) => {
        if (alive && info) setBundled(info as BundledInfo);
      })
      .catch(() => {
        if (alive) setBundled({ exists: false });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="space-y-5">
      {/* 设备状态区域 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-4 transition-colors duration-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-[var(--radius-md)] bg-[var(--bg-app)] border border-[var(--border-default)] flex items-center justify-center text-[var(--text-secondary)]">
              <Watch className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                {conn.device?.name ?? 'Xiaomi Smart Band 10'}
              </h2>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {conn.device ? '已配置手环' : '尚未载入已配对手环'} · 状态：
                {CONN_STATE_TEXT[conn.state] ?? '未连接'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onStartSetup}
            className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)] transition-colors cursor-pointer"
            title="进入手环设置向导，重新配置设备"
          >
            配置手环
          </button>
        </div>

        {conn.state === 'error' && conn.error && (
          <p className="text-xs text-[var(--status-error)] leading-relaxed">{conn.error}</p>
        )}

        <div className="pt-3 border-t border-[var(--border-default)] flex items-center justify-between text-xs text-[var(--text-muted)]">
          <span>日常连接与同步管理</span>
          <div className="flex items-center gap-2 select-none">
            <button
              type="button"
              onClick={conn.connect}
              disabled={!conn.canConnect}
              className="px-4 py-1.5 rounded-[var(--radius-md)] bg-[var(--accent-primary)] text-white text-xs font-medium cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {conn.state === 'connecting' ? '连接中…' : '连接'}
            </button>
            <button
              type="button"
              onClick={conn.disconnect}
              disabled={conn.state !== 'connected' || conn.busy}
              className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-strong)] text-xs text-[var(--text-secondary)] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              断开
            </button>
          </div>
        </div>
      </section>

      {/* Pulse 快应用：显示内置包真实版本；安装动作在设置向导第 6 步 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Package className="w-4 h-4 text-[var(--text-muted)]" />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Pulse 手环快应用
            </h3>
          </div>
          <span className="text-xs font-mono text-[var(--text-muted)]">
            {bundled === null
              ? '读取中…'
              : !bundled.exists
              ? '内置包缺失'
              : `v${bundled.versionName ?? '?'} (versionCode ${bundled.versionCode ?? '?'})`}
          </span>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          配套手环端快应用负责在手环屏幕上实时渲染 Agent 运行状态与配额。安装包随桌面端发布，
          在「配置手环」向导的「安装Pulse快应用」步骤一键安装。
        </p>
      </section>

      {/* 推送其他快应用：常驻可用区域 */}
      <section className="p-5 rounded-[var(--radius-lg)] bg-[var(--bg-surface)] border border-[var(--border-default)] shadow-[var(--shadow-card)] space-y-3">
        <div className="flex items-center gap-2.5">
          <Upload className="w-4 h-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">推送其他快应用</h3>
        </div>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          安装第三方或自行构建的 .rpk 到手环。与内置安装共用同一条安装通道，同一时间只允许一个安装任务。
        </p>
        <OtherAppInstall connected={conn.state === 'connected'} />
      </section>
    </div>
  );
};
