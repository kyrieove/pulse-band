import pkg from '../../package.json';

/**
 * 应用产品名与版本号的单一来源（源自 package.json）。
 * TopBar / Sidebar 等处显示用值应从这里取值，不再写死。
 */
export const APP_NAME: string = pkg.build?.productName ?? 'Pulse';
export const APP_VERSION: string = pkg.version;