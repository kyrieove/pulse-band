import React from 'react';
import type { AgentKind, MinibarState } from '../../../common/types';
import { SUPPORTED_AGENTS } from './AgentSection';
import { toRemainingPercent } from './agent-quota-utils';
import bandProduct from '../../assets/band-product.webp';

/** 手环端 applyCards 定义的配色（band-app/src/pages/index/index.ux） */
const AGENT_FILL: Record<AgentKind, string> = {
  claude: '#ff9f0a',
  codex: '#30d158',
  antigravity: '#9d4edd',
};
const SEVEN_BAR = '#0a84ff';
const NO_DATA_FILL = '#48484a'; // 手环端缺数条色
const EST_TEXT = '#8e8e93'; // 手环端估算数字色
const AGENT_NAME: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export type BandIllustrationMode = 'live' | 'connecting' | 'off';

export interface BandIllustrationProps {
  mode: BandIllustrationMode;
  /** 未配置时整图置灰降透明（熄屏 + 灰阶） */
  dimmed?: boolean;
  /** App 层唯一一份 useQuotaState 数据，不在本组件新开订阅 */
  quota: MinibarState | null;
}

/** band-product.json 标定的屏幕区（占图片宽高百分比）与椭圆圆角 */
const SCREEN = {
  left: '3.27%',
  top: '16.64%',
  width: '27.12%',
  height: '65.51%',
  borderRadius: '50% / 23.1%',
};

/**
 * 设备卡左侧插画：小米官方产品图 + 屏幕区叠加层。
 * 官方图屏幕里是小米自家表盘，叠加层必须常驻盖住它。
 * 数据取 5h 剩余最低的 agent；全部无数据时显示第一个（与手环端轮播的第一屏一致）。
 */
export const BandIllustration: React.FC<BandIllustrationProps> = ({ mode, dimmed = false, quota }) => {
  const quotas = quota?.quotas;
  const perAgent = SUPPORTED_AGENTS.map((key) => ({
    key,
    five: toRemainingPercent(quotas?.[key]?.pct5h),
    seven: toRemainingPercent(quotas?.[key]?.pct7d),
    estimated: quotas?.[key]?.authoritative === false,
  }));
  const withData = perAgent.filter((x) => x.five != null);
  const chosen = withData.length
    ? withData.reduce((a, b) => ((b.five as number) < (a.five as number) ? b : a))
    : perAgent[0];
  // 顶部状态点：该 agent 有活跃会话（思考/执行）时亮绿，与手环端 Thinking 圆点同义
  const busy = quota?.sessions?.some(
    (s) => s.agent === chosen.key && (s.status === 'thinking' || s.status === 'running_tool')
  );

  const fiveLabel = chosen.five != null ? `${chosen.estimated ? '~' : ''}${chosen.five}%` : '--';
  const sevenLabel = chosen.seven != null ? `${chosen.estimated ? '~' : ''}${chosen.seven}%` : '--';

  return (
    <div
      className={`relative inline-block select-none ${
        dimmed ? 'grayscale opacity-40' : ''
      } dark:drop-shadow-[0_0_1px_rgba(255,255,255,0.18)]`}
      aria-hidden
    >
      <img src={bandProduct} alt="" className="block h-[160px] w-auto object-contain" />
      {/* 屏幕区：官方图里是小米表盘，这层常驻黑底盖住它 */}
      <div
        className="absolute overflow-hidden"
        style={{ ...SCREEN, background: '#060807' }}
      >
        {mode === 'live' ? (
          <div className="w-full h-full flex flex-col justify-between" style={{ padding: '7px 6px' }}>
            {/* 顶部：agent 名 + 状态点（这个尺寸下工具名等小字全部省略） */}
            <div className="flex items-center justify-between gap-0.5 min-w-0">
              <span
                className="text-white font-semibold truncate"
                style={{ fontSize: 6.5, lineHeight: 1 }}
              >
                {AGENT_NAME[chosen.key]}
              </span>
              <span
                className="rounded-full shrink-0"
                style={{
                  width: 3.5,
                  height: 3.5,
                  background: busy ? '#30d158' : '#8e8e93',
                }}
              />
            </div>

            {/* 5h 剩余 */}
            <div>
              <div className="flex items-baseline justify-between">
                <span style={{ fontSize: 5.5, lineHeight: 1.2, color: 'rgba(255,255,255,0.55)' }}>
                  5h 剩余
                </span>
                <span
                  className="font-bold text-white tabular-nums"
                  style={{ fontSize: 10, lineHeight: 1, color: chosen.estimated ? EST_TEXT : '#ffffff' }}
                >
                  {fiveLabel}
                </span>
              </div>
              <div
                className="mt-[2px] rounded-full overflow-hidden"
                style={{ height: 2.5, background: 'rgba(255,255,255,0.12)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${chosen.five ?? 0}%`,
                    background: chosen.five != null ? AGENT_FILL[chosen.key] : NO_DATA_FILL,
                  }}
                />
              </div>
            </div>

            {/* 7d 剩余 */}
            <div>
              <div className="flex items-baseline justify-between">
                <span style={{ fontSize: 5.5, lineHeight: 1.2, color: 'rgba(255,255,255,0.55)' }}>
                  7d 剩余
                </span>
                <span
                  className="font-bold tabular-nums"
                  style={{ fontSize: 10, lineHeight: 1, color: chosen.estimated ? EST_TEXT : '#ffffff' }}
                >
                  {sevenLabel}
                </span>
              </div>
              <div
                className="mt-[2px] rounded-full overflow-hidden"
                style={{ height: 2.5, background: 'rgba(255,255,255,0.12)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${chosen.seven ?? 0}%`,
                    background: chosen.seven != null ? SEVEN_BAR : NO_DATA_FILL,
                  }}
                />
              </div>
            </div>

            {/* 底部占位：让布局贴近手环端三段式，不放读不出的小字 */}
            <div />
          </div>
        ) : mode === 'connecting' ? (
          /* 连接中：黑底 + 简单呼吸点（动画已被全局 prefers-reduced-motion 规则压掉） */
          <div className="w-full h-full flex items-center justify-center">
            <span
              className="rounded-full animate-pulse"
              style={{ width: 4, height: 4, background: 'rgba(255,255,255,0.45)' }}
            />
          </div>
        ) : (
          /* 未连接 / 连接失败 / 未配置：纯黑熄屏 */
          <div className="w-full h-full" />
        )}
      </div>
    </div>
  );
};
