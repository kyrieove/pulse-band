/**
 * Claude Code Hook 一键安装 / 卸载。
 *
 * 为什么要绕一圈：hook 命令是 Claude Code 直接拉起的外部进程，原来的写法是
 * `node "<仓库>/scripts/claude-hook.cjs" <事件>`，等于要求用户机器上装了 Node。
 * Pulse 自带 Electron，Electron 加 ELECTRON_RUN_AS_NODE=1 就是一个 Node，
 * 但 settings.json 的 command 字段没法带环境变量 —— 所以安装时在 userData 下
 * 生成一个 .cmd 包装器，由它设环境变量再转调。
 *
 * 脚本也一并复制到 userData：打包后 scripts/ 在 app.asar 里，asar 内的路径能被
 * 主进程的 fs 读到，但不保证能被当作外部进程的入口，复制出来最省事。
 */
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS, isOurs, mergeHooks, removeHooks } from './claude-hook-merge';
import { readSettings, writeSettings } from './claude-hook-settings';

const settingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');
const hookDir = () => path.join(app.getPath('userData'), 'hook');
const wrapperPath = () => path.join(hookDir(), 'pulse-hook.cmd');

/** 把转发脚本和 .cmd 包装器落到 userData，返回包装器绝对路径 */
function writeWrapper(): string {
  const dir = hookDir();
  fs.mkdirSync(dir, { recursive: true });

  const src = path.join(import.meta.dirname, '../../scripts/claude-hook.cjs');
  const dest = path.join(dir, 'claude-hook.cjs');
  fs.writeFileSync(dest, fs.readFileSync(src, 'utf8'), 'utf8');

  const cmd = wrapperPath();
  fs.writeFileSync(
    cmd,
    ['@echo off', 'set "ELECTRON_RUN_AS_NODE=1"', `"${process.execPath}" "${dest}" %1`, ''].join('\r\n'),
    'utf8'
  );
  return cmd;
}

export type HookStatus = { installed: boolean; settingsPath: string; command: string | null };

export function getHookStatus(): HookStatus {
  const hooks = readSettings(settingsPath()).hooks ?? {};
  const ours = HOOK_EVENTS.map((e) => (hooks[e] ?? []).find(isOurs)).filter(Boolean);
  const script = path.join(hookDir(), 'claude-hook.cjs');
  return {
    installed:
      ours.length === HOOK_EVENTS.length &&
      fs.existsSync(wrapperPath()) &&
      fs.existsSync(script),
    settingsPath: settingsPath(),
    command: ours[0]?.hooks?.[0]?.command ?? null,
  };
}

export function registerClaudeHookInstall() {
  ipcMain.handle('hook:status', () => getHookStatus());

  ipcMain.handle('hook:install', () => {
    try {
      // 先读后写：settings.json 坏掉时在这里就抛出来，绝不进入覆盖流程
      const settings = readSettings(settingsPath());
      const cmd = writeWrapper();
      settings.hooks = mergeHooks(settings.hooks ?? {}, (event) => `"${cmd}" ${event}`);
      writeSettings(settingsPath(), settings);
      return { ok: true, ...getHookStatus() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('hook:uninstall', () => {
    try {
      const settings = readSettings(settingsPath());
      settings.hooks = removeHooks(settings.hooks ?? {});
      writeSettings(settingsPath(), settings);
      return { ok: true, ...getHookStatus() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
}
