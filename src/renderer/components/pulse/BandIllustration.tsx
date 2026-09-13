import React, { useEffect, useState } from 'react';
import { normalizeWatchfaceColor } from './watchface-utils';
import bandProduct from '../../assets/band-product.webp';

export type BandIllustrationMode = 'live' | 'connecting' | 'off';

export interface BandIllustrationProps {
  mode: BandIllustrationMode;
  /** 未配置时整图置灰降透明（熄屏 + 灰阶） */
  dimmed?: boolean;
  /** 手环图渲染高度（px）；屏幕叠加层按图片百分比定位，随高度自动缩放 */
  height?: number;
}

/** band-product.json 标定的屏幕区（占图片宽高百分比）与椭圆圆角 */
const SCREEN = {
  left: '3.27%',
  top: '16.64%',
  width: '27.12%',
  height: '65.51%',
  borderRadius: '50% / 23.1%',
};

interface CurrentWatchface {
  name: string;
  color: string | null;
}

/**
 * 设备卡左侧插画：小米官方产品图 + 屏幕区叠加层。
 * 官方图屏幕里是小米自家表盘，叠加层必须常驻盖住它。
 *
 * 屏幕内容是「当前表盘」：已连接时拉一次 device.watchface.list 取 is_current 项，
 * 不轮询；背景铺表盘 background_color（normalizeWatchfaceColor 校验），
 * 背景色为空或拉取失败保持黑底只显名字，连名字都没有就纯黑。
 */
export const BandIllustration: React.FC<BandIllustrationProps> = ({
  mode,
  dimmed = false,
  height = 160,
}) => {
  const [watchface, setWatchface] = useState<CurrentWatchface | null>(null);

  useEffect(() => {
    if (mode !== 'live') return;
    let alive = true;
    window.pulse
      ?.watchface?.list?.()
      .then((res) => {
        if (!alive) return;
        if (res?.ok) {
          const cur = res.data?.watchfaces?.find((w) => w.is_current);
          setWatchface(
            cur
              ? { name: cur.name ?? '', color: normalizeWatchfaceColor(cur.background_color) }
              : null
          );
        } else {
          setWatchface(null);
        }
      })
      .catch(() => {
        if (alive) setWatchface(null);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  // 非连接态强制熄屏，不留上一次的表盘底色
  const bg = mode === 'live' ? watchface?.color ?? '#060807' : '#060807';

  return (
    <div
      className={`relative inline-block select-none ${
        dimmed ? 'grayscale opacity-40' : ''
      } dark:drop-shadow-[0_0_1px_rgba(255,255,255,0.18)]`}
      aria-hidden
    >
      <img src={bandProduct} alt="" style={{ height }} className="block w-auto object-contain" />
      {/* 屏幕区：官方图里是小米表盘，这层常驻盖住它 */}
      <div className="absolute overflow-hidden" style={{ ...SCREEN, background: bg }}>
        {mode === 'live' && watchface?.name ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-[3px] px-[3px]">
            <span
              className="text-center"
              style={{
                fontSize: 5,
                lineHeight: 1,
                color: 'rgba(255,255,255,0.55)',
                textShadow: '0 0 3px rgba(0,0,0,0.6)',
              }}
            >
              当前表盘
            </span>
            <span
              className="text-white font-semibold text-center truncate w-full"
              style={{ fontSize: 7.5, lineHeight: 1.15, textShadow: '0 0 3px rgba(0,0,0,0.6)' }}
            >
              {watchface.name}
            </span>
            {/* 表盘预览图接在这里：workbuddy 的预览图缓存落地后，按表盘 id 取预览图铺满屏幕区 */}
          </div>
        ) : mode === 'connecting' ? (
          /* 连接中：黑底 + 简单呼吸点（动画已被全局 prefers-reduced-motion 规则压掉） */
          <div className="w-full h-full flex items-center justify-center">
            <span
              className="rounded-full animate-pulse"
              style={{ width: 4, height: 4, background: 'rgba(255,255,255,0.45)' }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
};
