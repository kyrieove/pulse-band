/**
 * 「把日志拖进来，给我 authkey」——接受 .zip / 文件夹 / .log 三种输入。
 *
 * 边界：**只解析、只显示**。不写 OronBox 的配置文件、不代替配对。
 * 用户拿到 key 之后仍然在 OronBox 里输入并连接（那是唯一验证过的配对路径）。
 *
 * 解压走 PowerShell 的 Expand-Archive，不引第三方依赖，打包后照样能跑。
 * 日志里是 authkey 明文，临时解压目录用完必须删，不能留在用户的 %TEMP% 里。
 */
import { ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractKeys, type ExtractedKeys } from './band-key-parse';

/** 单个日志读取上限：日志目录里偶尔有几百 MB 的文件，整个读进内存会卡死主进程 */
const MAX_LOG_BYTES = 64 * 1024 * 1024;

/** PowerShell 单引号字符串不做插值，`$` 反引号 `"` 全是字面量；内部单引号翻倍转义 */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

function walkLogs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkLogs(p, out);
    else if (e.name.toLowerCase().endsWith('.log')) out.push(p);
  }
  return out;
}

/** 在一堆 .log 里挑出真正含 key 的那个：先按文件名，再按内容 */
function pickLog(files: string[]): { file: string; text: string } | null {
  const ordered = [
    ...files.filter((p) => /xiaomifit\.main\.log$/i.test(path.basename(p))),
    ...files.filter((p) => !/xiaomifit\.main\.log$/i.test(path.basename(p))),
  ];
  for (const file of ordered) {
    if (fs.statSync(file).size > MAX_LOG_BYTES) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/devicekey|encryptkey/i.test(text)) return { file, text };
  }
  return null;
}

export type ExtractResult =
  | ({ ok: true; logFile: string; agree: boolean } & ExtractedKeys)
  | { ok: false; error: string };

export function extractFromPath(input: string): ExtractResult {
  if (!fs.existsSync(input)) return { ok: false, error: `文件不存在：${input}` };

  let tempDir: string | null = null;
  try {
    const stat = fs.statSync(input);
    let picked: { file: string; text: string } | null;

    if (stat.isDirectory()) {
      picked = pickLog(walkLogs(input));
    } else if (input.toLowerCase().endsWith('.zip')) {
      tempDir = path.join(os.tmpdir(), `pulse-log-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(input)} -DestinationPath ${psQuote(tempDir)} -Force`,
      ]);
      picked = pickLog(walkLogs(tempDir));
    } else {
      if (stat.size > MAX_LOG_BYTES) return { ok: false, error: '日志文件过大（超过 64MB），请直接拖入 XiaomiFit.main.log' };
      picked = { file: input, text: fs.readFileSync(input, 'utf8') };
    }

    if (!picked) return { ok: false, error: '这份日志里没找到 deviceKey 或 encryptKey。确认拖入的是 XiaomiFit.main.log 或它所在的目录。' };

    const keys = extractKeys(picked.text);
    if (!keys.deviceKey && !keys.encryptKey) {
      return { ok: false, error: '日志里没有 deviceKey / encryptKey。手环可能还没在 Mi Fitness 里绑定过。' };
    }
    return {
      ok: true,
      logFile: picked.file,
      agree: !!keys.deviceKey && keys.deviceKey === keys.encryptKey,
      ...keys,
    };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    // 日志里是 authkey 明文，解压出来的副本不能留在用户磁盘上
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function registerBandKeyExtract() {
  ipcMain.handle('band:extract-key', (_e, payload: { path?: string }) =>
    extractFromPath(typeof payload?.path === 'string' ? payload.path : '')
  );
}
