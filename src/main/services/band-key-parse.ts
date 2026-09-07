/**
 * 从小米运动健康 / 小米健康研究的日志文本里提取手环 authkey。纯函数，无依赖，
 * 由 scripts/test-band-key-extract.mjs 自检。
 *
 * 两个关键词都要抓，因为两条导出路径给的字段不一样：
 *   - 小米健康研究（Download/ResearchLog/…/XiaomiFit.main.log）里更容易搜到 `deviceKey`
 *   - Mi Fitness「意见反馈 → 上传日志」导出的 zip 里是 `encryptKey`
 *
 * ⚠️ `deviceKey` 的值是 `did(十进制) + 32 位密钥`，整串约 42 位。
 * 用 `([0-9a-fA-F]{32})` 去匹配会从**开头**截 32 位，得到一个长度合法、看起来像密钥、
 * 但完全错误的字符串 —— 静默失败，最难查的那种。所以统一「贪婪抓整段十六进制，再取末尾 32 位」。
 * 对本来就是 32 位的 `encryptKey`，取尾 32 位就是它自己。
 */

export type ExtractedKeys = {
  /** deviceKey 去掉 did 后的 32 位 */
  deviceKey: string | null;
  /** deviceKey 原始整串，用于在界面上说明「去掉了开头这段」 */
  deviceKeyRaw: string | null;
  encryptKey: string | null;
};

/** 每次重新绑定手环都会换 key，日志里会有多组 —— 取最后一次出现的那组 */
function lastHexRun(text: string, keyword: string): string | null {
  const all = [...text.matchAll(new RegExp(`${keyword}[^0-9a-fA-F]{0,20}?([0-9a-fA-F]{32,})`, 'gi'))];
  return all.length ? all[all.length - 1][1] : null;
}

export function extractKeys(text: string): ExtractedKeys {
  const deviceKeyRaw = lastHexRun(text, 'devicekey');
  const encryptRaw = lastHexRun(text, 'encryptkey');
  return {
    deviceKey: deviceKeyRaw ? deviceKeyRaw.slice(-32) : null,
    deviceKeyRaw,
    encryptKey: encryptRaw ? encryptRaw.slice(-32) : null,
  };
}
