/**
 * ~/.claude/settings.json 的读取 / 备份 / 原子写入。
 *
 * 单独拆出来和 claude-hook-merge.ts 是同一个理由：claude-hook-install.ts 依赖
 * electron，普通 node 进程 import 不了，而这段逻辑会动用户自己的配置文件，
 * 必须有 scripts/test-hook-install.mjs 能直接跑的检查。
 *
 * 这里最要命的失败模式是「把用户的 settings.json 清空」：用户手写的 JSON 里
 * 只要有一个逗号写错，旧实现会把解析错误一并吞掉返回 {}，随后无条件落盘覆盖，
 * 他原有的 hooks 和 permissions 全没了。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 备份文件名：只在不存在时写，保证留下的是「第一次安装前」的原始文件 */
export const backupPathFor = (p: string) => `${p}.pulse-backup`;

/**
 * 读取 settings.json。
 * 只有 ENOENT（文件本来就没有）返回 {}；坏 JSON、EACCES 等一律抛出，
 * 由 IPC 调用方把错误显示给用户，绝不用 {} 顶替后继续写。
 */
export function readSettings(p: string): Record<string, any> {
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`读取 ${p} 失败：${err?.message ?? err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`${p} 不是合法 JSON，请先修好再安装 hook：${err?.message ?? err}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${p} 不是合法 JSON，请先修好再安装 hook：顶层必须是 JSON 对象`);
  }
  return parsed as Record<string, any>;
}

/**
 * 备份 + 原子写入。
 * - 备份只在 .pulse-backup 不存在时写：第二次安装不会把第一次的原始配置冲掉；
 * - 先写 ${p}.tmp 再 rename：中途被杀 / 断电时旧文件保持完整，不会留下截断的 JSON。
 */
export function writeSettings(p: string, settings: Record<string, any>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const backup = backupPathFor(p);
  if (fs.existsSync(p) && !fs.existsSync(backup)) {
    fs.copyFileSync(p, backup);
  }

  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
