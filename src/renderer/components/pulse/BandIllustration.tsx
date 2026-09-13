import React from 'react';
import bandProduct from '../../assets/band-static.png';

export interface BandIllustrationProps {
  /** 未配置时整图置灰降透明 */
  dimmed?: boolean;
}

/** 静态产品图只负责设备识别；连接状态与设备信息统一放在右侧。 */
export const BandIllustration: React.FC<BandIllustrationProps> = ({ dimmed = false }) => (
  <div
    className={`h-[250px] w-full overflow-hidden flex items-center justify-center select-none transition-opacity duration-200 ${
      dimmed ? 'grayscale opacity-40' : ''
    }`}
    aria-hidden
  >
    <img
      src={bandProduct}
      alt=""
      className="block h-[304px] w-[304px] max-w-none shrink-0 object-contain drop-shadow-[0_12px_14px_rgba(20,28,24,0.18)] dark:drop-shadow-[0_12px_14px_rgba(0,0,0,0.38)]"
    />
  </div>
);
