/**
 * 悬浮窗几何与尺寸计算纯函数。
 * 纯粹数学与几何逻辑，完全不依赖 Electron 原生对象，确保可单元测试与跨环境复用。
 */

// 竖向侧栏：左/右吸附
export const COLLAPSED_WIDTH = 80;
export const COLLAPSED_HEIGHT = 340;
export const EXPANDED_WIDTH = 370;
export const EXPANDED_HEIGHT = 340;

// 横向侧栏：上/下吸附
export const H_COLLAPSED_WIDTH = 340;
export const H_COLLAPSED_HEIGHT = 56;
export const H_EXPANDED_WIDTH = 340;
export const H_EXPANDED_HEIGHT = 370;

// 边缘标签
export const EDGE_TAB_WIDTH = 18;
export const EDGE_TAB_HEIGHT = 48;
export const H_EDGE_TAB_WIDTH = 48;
export const H_EDGE_TAB_HEIGHT = 18;

export type DockSide = 'left' | 'right' | 'top' | 'bottom';

export interface DockTarget {
  dockSide: DockSide;
  x: number;
  y: number;
}

export function isHorizontalDock(dockSide: DockSide): boolean {
  return dockSide === 'top' || dockSide === 'bottom';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 判定鼠标最近的四条屏幕边缘，并返回对应收起态窗口的坐标。
 * 左右吸附时 Y 跟随鼠标，上下吸附时 X 跟随鼠标。
 */
export function resolveDockTarget(
  cursorPoint: { x: number; y: number },
  workArea: { x: number; y: number; width: number; height: number },
  _currentX?: number,
  _currentY?: number,
): DockTarget {
  const rightEdge = workArea.x + workArea.width;
  const bottomEdge = workArea.y + workArea.height;
  const distances = {
    left: Math.abs(cursorPoint.x - workArea.x),
    right: Math.abs(rightEdge - cursorPoint.x),
    top: Math.abs(cursorPoint.y - workArea.y),
    bottom: Math.abs(bottomEdge - cursorPoint.y),
  };
  const nearest = (Object.keys(distances) as DockSide[]).reduce((best, side) =>
    distances[side] < distances[best] ? side : best
  , 'right');

  if (nearest === 'top') {
    return {
      dockSide: 'top',
      x: Math.round(clamp(
        cursorPoint.x - H_COLLAPSED_WIDTH / 2,
        workArea.x,
        rightEdge - H_COLLAPSED_WIDTH,
      )),
      y: workArea.y,
    };
  }
  if (nearest === 'bottom') {
    return {
      dockSide: 'bottom',
      x: Math.round(clamp(
        cursorPoint.x - H_COLLAPSED_WIDTH / 2,
        workArea.x,
        rightEdge - H_COLLAPSED_WIDTH,
      )),
      y: bottomEdge - H_COLLAPSED_HEIGHT,
    };
  }
  if (nearest === 'left') {
    return {
      dockSide: 'left',
      x: workArea.x,
      y: Math.round(clamp(
        cursorPoint.y - COLLAPSED_HEIGHT / 2,
        workArea.y,
        bottomEdge - COLLAPSED_HEIGHT,
      )),
    };
  }
  return {
    dockSide: 'right',
    x: rightEdge - COLLAPSED_WIDTH,
    y: Math.round(clamp(
      cursorPoint.y - COLLAPSED_HEIGHT / 2,
      workArea.y,
      bottomEdge - COLLAPSED_HEIGHT,
    )),
  };
}

/**
 * 计算收起态稳定锚点。
 */
export function calculateCollapsedBounds(
  bounds: { x: number; y: number; width: number; height: number },
  expanded: boolean,
  dockSide: DockSide = 'right',
): { x: number; y: number } {
  if (!expanded) {
    return { x: bounds.x, y: bounds.y };
  }

  if (dockSide === 'left' || dockSide === 'top') {
    return { x: bounds.x, y: bounds.y };
  }
  if (dockSide === 'right') {
    return { x: bounds.x + bounds.width - COLLAPSED_WIDTH, y: bounds.y };
  }
  return {
    x: bounds.x,
    y: bounds.y + H_EXPANDED_HEIGHT - H_COLLAPSED_HEIGHT,
  };
}

/**
 * 根据收起态锚点计算目标状态的物理 bounds。
 */
export function calculateWindowBoundsForState(
  anchor: { x: number; y: number },
  targetExpanded: boolean,
  dockSide: DockSide = 'right',
): { x: number; y: number; width: number; height: number } {
  if (isHorizontalDock(dockSide)) {
    if (!targetExpanded) {
      return {
        x: anchor.x,
        y: anchor.y,
        width: H_COLLAPSED_WIDTH,
        height: H_COLLAPSED_HEIGHT,
      };
    }
    if (dockSide === 'top') {
      return {
        x: anchor.x,
        y: anchor.y,
        width: H_EXPANDED_WIDTH,
        height: H_EXPANDED_HEIGHT,
      };
    }
    return {
      x: anchor.x,
      y: anchor.y - (H_EXPANDED_HEIGHT - H_COLLAPSED_HEIGHT),
      width: H_EXPANDED_WIDTH,
      height: H_EXPANDED_HEIGHT,
    };
  }

  if (!targetExpanded) {
    return {
      x: anchor.x,
      y: anchor.y,
      width: COLLAPSED_WIDTH,
      height: COLLAPSED_HEIGHT,
    };
  }

  if (dockSide === 'left') {
    return {
      x: anchor.x,
      y: anchor.y,
      width: EXPANDED_WIDTH,
      height: EXPANDED_HEIGHT,
    };
  }

  const rightEdge = anchor.x + COLLAPSED_WIDTH;
  return {
    x: rightEdge - EXPANDED_WIDTH,
    y: anchor.y,
    width: EXPANDED_WIDTH,
    height: EXPANDED_HEIGHT,
  };
}

/**
 * 将窗口 bounds 夹回工作区，保持当前吸附边缘。
 */
export function clampBoundsToWorkArea(
  x: number,
  y: number,
  _w: number,
  _h: number,
  workArea: { x: number; y: number; width: number; height: number },
  expanded: boolean = false,
  dockSide: DockSide = 'right',
): { x: number; y: number } {
  const rightEdge = workArea.x + workArea.width;
  const bottomEdge = workArea.y + workArea.height;
  const horizontal = isHorizontalDock(dockSide);
  const width = horizontal
    ? (expanded ? H_EXPANDED_WIDTH : H_COLLAPSED_WIDTH)
    : (expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH);
  const height = horizontal
    ? (expanded ? H_EXPANDED_HEIGHT : H_COLLAPSED_HEIGHT)
    : (expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT);

  let clampedX = clamp(x, workArea.x, rightEdge - width);
  let clampedY = clamp(y, workArea.y, bottomEdge - height);

  if (dockSide === 'left') clampedX = workArea.x;
  if (dockSide === 'right') clampedX = rightEdge - width;
  if (dockSide === 'top') clampedY = workArea.y;
  if (dockSide === 'bottom') clampedY = bottomEdge - height;

  return { x: clampedX, y: clampedY };
}

/**
 * 计算进入边缘标签态的 bounds。
 */
export function calculateEdgeTabBounds(
  anchor: { x: number; y: number },
  dockSide: DockSide = 'right',
  fullHeight: number = COLLAPSED_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  if (dockSide === 'top') {
    return {
      x: anchor.x + Math.round((H_COLLAPSED_WIDTH - H_EDGE_TAB_WIDTH) / 2),
      y: anchor.y,
      width: H_EDGE_TAB_WIDTH,
      height: H_EDGE_TAB_HEIGHT,
    };
  }
  if (dockSide === 'bottom') {
    return {
      x: anchor.x + Math.round((H_COLLAPSED_WIDTH - H_EDGE_TAB_WIDTH) / 2),
      y: anchor.y + H_COLLAPSED_HEIGHT - H_EDGE_TAB_HEIGHT,
      width: H_EDGE_TAB_WIDTH,
      height: H_EDGE_TAB_HEIGHT,
    };
  }

  const centerY = anchor.y + Math.round((fullHeight - EDGE_TAB_HEIGHT) / 2);
  const x = dockSide === 'left'
    ? anchor.x
    : anchor.x + COLLAPSED_WIDTH - EDGE_TAB_WIDTH;
  return {
    x,
    y: centerY,
    width: EDGE_TAB_WIDTH,
    height: EDGE_TAB_HEIGHT,
  };
}

/**
 * 从边缘标签恢复为完整侧栏锚点。
 */
export function restoreAnchorFromEdgeTab(
  tabBounds: { x: number; y: number },
  dockSide: DockSide = 'right',
  fullHeight: number = COLLAPSED_HEIGHT,
): { x: number; y: number } {
  if (dockSide === 'top') {
    return {
      x: tabBounds.x - Math.round((H_COLLAPSED_WIDTH - H_EDGE_TAB_WIDTH) / 2),
      y: tabBounds.y,
    };
  }
  if (dockSide === 'bottom') {
    return {
      x: tabBounds.x - Math.round((H_COLLAPSED_WIDTH - H_EDGE_TAB_WIDTH) / 2),
      y: tabBounds.y + H_EDGE_TAB_HEIGHT - H_COLLAPSED_HEIGHT,
    };
  }

  const y = tabBounds.y - Math.round((fullHeight - EDGE_TAB_HEIGHT) / 2);
  const x = dockSide === 'left'
    ? tabBounds.x
    : tabBounds.x + EDGE_TAB_WIDTH - COLLAPSED_WIDTH;
  return { x, y };
}
