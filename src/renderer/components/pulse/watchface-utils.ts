/**
 * 表盘页纯函数工具（无 React / 无 DOM / 无 electron 依赖，可在 node 下直接单测）。
 */

/** 小米手环 10 竖长条画布（band-app/src/manifest.json 的 designWidth=192） */
export const WATCHFACE_CANVAS_WIDTH = 192;
export const WATCHFACE_CANVAS_HEIGHT = 490;

const HEX_COLOR = /^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * 归一化 device.watchface.list 返回的 background_color。
 *
 * 该字段形状由设备决定，不在我们控制范围内；这里只接受明确是 hex 颜色的输入，
 * 其余（空串、非法值、非字符串）一律返回 null，由调用方回退到中性底色。
 * 不把设备原始字符串直接写进样式，避免拿到一个"看起来有底色其实没渲染"的空块。
 */
export function normalizeWatchfaceColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (/^0x/i.test(value)) value = value.slice(2);
  if (value.startsWith('#')) value = value.slice(1);
  const matched = HEX_COLOR.exec(value);
  if (!matched) return null;
  return `#${matched[1].toLowerCase()}`;
}

/**
 * 本地预览图后缀白名单。
 *
 * 只收 PNG / JPEG：主进程用 Electron nativeImage.createFromBuffer 解码，
 * 它只可靠支持这两种（webp / gif / bmp 会解出空图）。这里不承诺解不开的格式，
 * 避免用户选完才在下一层报错。
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

/** 供文件选择框 accept 使用，与 IMAGE_EXTENSIONS 同源，避免两处漂移 */
export const WATCHFACE_IMAGE_ACCEPT = '.png,.jpg,.jpeg';

export function isSupportedImageFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

/**
 * 卡片上展示的表盘名。设备可能返回空名字，此时回退到 id，
 * 避免出现一张只有底色、认不出是哪个表盘的卡片。
 */
export function watchfaceDisplayName(name: unknown, id: string): string {
  if (typeof name === 'string' && name.trim()) return name.trim();
  return id;
}
