/**
 * 设备配置服务 (DeviceConfigService)
 *
 * 职责：
 * 1. 检查和验证本机 %LOCALAPPDATA%\PulseDev\run\device.json 的存在性与格式合法性（脱敏返回）；
 * 2. 通过系统 PnP 设备树（PowerShell Get-PnpDevice）枚举 Windows 已配对的蓝牙手环设备；
 * 3. 结合日志提取的 32 位 authkey 与选定手环的 MAC 地址，校验后原子写入 device.json；
 * 4. 遵守纪律：authkey 与完整物理 MAC 绝对不返回给 Renderer（通过 maskedAddr 脱敏）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractFromPath } from './band-key-extract.ts';
import { getDeviceConfigFile } from './pulse-core-client.ts';

/**
 * 异步执行 PowerShell 并取回 stdout。
 *
 * 纪律：主进程里**禁止**用 execFileSync —— Get-PnpDevice 需要拉起 PowerShell，
 * 同步调用会阻塞 Electron 主进程事件循环（窗口不刷新、IPC 与调试端口全部无响应），
 * 首开向导时会出现数秒级卡死。
 */
function execPowerShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      }
    );
  });
}

export interface DeviceConfigStatus {
  exists: boolean;
  valid: boolean;
  deviceName?: string;
  maskedAddr?: string;
  codename?: string;
  error?: string;
}

export interface PairedBandDevice {
  id: string;
  name: string;
  maskedMac: string;
  isXiaomiBand: boolean;
  rawMac?: string; // 仅主进程内部可用，不脱敏对外暴露
}

export interface SaveDeviceConfigPayload {
  logPath?: string;
  selectedDeviceId?: string;
  useExisting?: boolean;
}

export interface SaveDeviceConfigResult {
  ok: boolean;
  error?: string;
  deviceName?: string;
  maskedAddr?: string;
}

/** 格式化 12 位 hex 为标准 XX:XX:XX:XX:XX:XX */
export function formatMacAddress(hex12: string): string {
  const clean = hex12.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length !== 12) return hex12;
  return clean.match(/.{2}/g)?.join(':') ?? hex12;
}

/** 脱敏 MAC 地址：保留前缀和末尾，隐藏中间字节 */
export function maskMacAddress(formattedOrHex: string): string {
  const clean = formattedOrHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length !== 12) return '***';
  return `${clean.slice(0, 2)}:${clean.slice(2, 4)}:**:**:${clean.slice(8, 10)}:${clean.slice(10, 12)}`;
}

export class DeviceConfigService {
  private configPath: string;

  constructor(customPath?: string) {
    this.configPath = customPath || getDeviceConfigFile();
  }

  /** 获取设备配置文件路径 */
  public getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 检查本机 device.json 状态
   * 校验规则：
   * - authkey 必须存在且为 32 位十六进制
   * - addr 过滤后必须为 12 位十六进制
   */
  public getDeviceConfigStatus(): DeviceConfigStatus {
    if (!fs.existsSync(this.configPath)) {
      return { exists: false, valid: false };
    }

    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const data = JSON.parse(raw);

      if (typeof data !== 'object' || data === null) {
        return { exists: true, valid: false, error: 'device.json 格式异常 (非有效对象)' };
      }

      const authkey = typeof data.authkey === 'string' ? data.authkey.trim() : '';
      if (!/^[0-9a-fA-F]{32}$/.test(authkey)) {
        return { exists: true, valid: false, error: 'authkey 格式不符合 32 位十六进制' };
      }

      const rawAddr = typeof data.addr === 'string' ? data.addr : '';
      const hexMac = rawAddr.replace(/[^0-9a-fA-F]/g, '');
      if (hexMac.length !== 12) {
        return { exists: true, valid: false, error: 'addr MAC 格式不符合 12 位十六进制' };
      }

      return {
        exists: true,
        valid: true,
        deviceName: typeof data.name === 'string' ? data.name : 'Xiaomi Smart Band',
        maskedAddr: maskMacAddress(hexMac),
        codename: typeof data.codename === 'string' ? data.codename : undefined,
      };
    } catch (err: any) {
      return {
        exists: true,
        valid: false,
        error: `读取 device.json 失败: ${err?.message ?? err}`,
      };
    }
  }

  /**
   * 枚举 Windows 系统中已配对的蓝牙设备列表，筛选匹配手环。
   *
   * 异步：底层走 `execPowerShell`，不阻塞主进程（详见该函数注释）。
   */
  public async getPairedBandDevices(): Promise<PairedBandDevice[]> {
    try {
      const psCommand =
        'Get-PnpDevice -Class Bluetooth | Select-Object FriendlyName, InstanceId, Status | ConvertTo-Json';
      const output = await execPowerShell(psCommand, 8000);

      if (!output || !output.trim()) return [];

      const parsed = JSON.parse(output);
      const items: Array<{ FriendlyName?: string; InstanceId?: string; Status?: string }> =
        Array.isArray(parsed) ? parsed : [parsed];

      const devices: PairedBandDevice[] = [];

      for (const item of items) {
        const instanceId = item.InstanceId ?? '';
        const match = instanceId.match(/DEV_([0-9A-Fa-f]{12})/i);
        if (!match) continue;

        const rawMac = match[1].toUpperCase();
        const name = (item.FriendlyName ?? '').trim() || 'Bluetooth Device';
        const isXiaomiBand = /band|手环|xiaomi/i.test(name);

        devices.push({
          id: `pnp_${rawMac.toLowerCase()}`,
          name,
          maskedMac: maskMacAddress(rawMac),
          isXiaomiBand,
          rawMac,
        });
      }

      // 排序：小米手环优先置顶
      devices.sort((a, b) => {
        if (a.isXiaomiBand && !b.isXiaomiBand) return -1;
        if (!a.isXiaomiBand && b.isXiaomiBand) return 1;
        return a.name.localeCompare(b.name);
      });

      return devices;
    } catch (err) {
      return [];
    }
  }

  /**
   * 保存设备配置至 device.json（异步：内部需枚举已配对设备）
   */
  public async saveDeviceConfig(
    payload: SaveDeviceConfigPayload
  ): Promise<SaveDeviceConfigResult> {
    // 1. 若声明直接使用已有配置
    if (payload.useExisting) {
      const status = this.getDeviceConfigStatus();
      if (!status.exists || !status.valid) {
        return { ok: false, error: status.error || '本机尚无可用的有效配置' };
      }
      return {
        ok: true,
        deviceName: status.deviceName,
        maskedAddr: status.maskedAddr,
      };
    }

    // 2. 从日志提取密钥
    if (!payload.logPath) {
      return { ok: false, error: '缺少日志文件路径' };
    }

    const extractResult = extractFromPath(payload.logPath);
    if (!extractResult.ok) {
      return { ok: false, error: extractResult.error };
    }

    const authkey = extractResult.encryptKey || extractResult.deviceKey;
    if (!authkey || !/^[0-9a-fA-F]{32}$/.test(authkey)) {
      return {
        ok: false,
        error: '未能从日志中提取出合法的 32 位 authkey',
      };
    }

    // 3. 匹配选定手环设备
    const pairedDevices = await this.getPairedBandDevices();
    let selectedDevice: PairedBandDevice | undefined;

    if (payload.selectedDeviceId) {
      selectedDevice = pairedDevices.find((d) => d.id === payload.selectedDeviceId);
    }

    // 若未显式传入 ID 或找不到，但列表中恰好有唯一小米手环，则智能自动选中
    if (!selectedDevice) {
      const xiaomiBands = pairedDevices.filter((d) => d.isXiaomiBand);
      if (xiaomiBands.length === 1) {
        selectedDevice = xiaomiBands[0];
      }
    }

    if (!selectedDevice || !selectedDevice.rawMac) {
      return {
        ok: false,
        error:
          '未匹配到已配对的小米手环。请先在 Windows 设置 -> 蓝牙与设备中完成手环配对。',
      };
    }

    const formattedAddr = formatMacAddress(selectedDevice.rawMac);

    // 4. 构建配置对象
    const configContent = {
      name: selectedDevice.name || 'Xiaomi Smart Band 10',
      addr: formattedAddr,
      connectType: 'spp',
      authkey: authkey.toLowerCase(),
      codename: 'o66',
    };

    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 原子写入：先写同目录临时文件，再 rename 覆盖。
      //
      // 直接 writeFileSync 覆盖目标文件时，若进程在写入中途被终止（被 kill / 断电），
      // 会留下截断的 JSON —— pulse-core 读它时解析失败，且报错信息很难定位到"配置写坏了"。
      // 同目录 rename 在 NTFS 上是原子替换，失败时旧配置保持完整。
      const tmpPath = `${this.configPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(configContent, null, 2), 'utf8');
      try {
        fs.renameSync(tmpPath, this.configPath);
      } catch (err) {
        fs.rmSync(tmpPath, { force: true });
        throw err;
      }

      return {
        ok: true,
        deviceName: configContent.name,
        maskedAddr: maskMacAddress(selectedDevice.rawMac),
      };
    } catch (err: any) {
      return {
        ok: false,
        error: `写入 device.json 失败: ${err?.message ?? err}`,
      };
    }
  }
}

export const deviceConfigService = new DeviceConfigService();
