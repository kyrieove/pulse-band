/**
 * 设备配置服务 (DeviceConfigService)
 *
 * 职责：
 * 1. 检查和验证本机 %LOCALAPPDATA%\PulseDev\run\device.json 的存在性与格式合法性（脱敏返回）；
 * 2. 取手环 MAC：Windows 已配对列表（PowerShell Get-PnpDevice，有则作快捷方式）、
 *    pulse-core --scan 扫描附近手环、日志里的绑定二维码 URL、用户手动输入；
 *    **不要求**先在 Windows 设置里配对——手环每次连接都会主动发起配对，由 pulse-core 自动同意；
 * 3. 结合日志提取的 32 位 authkey 与选定手环的 MAC 地址，校验后原子写入 device.json；
 * 4. 遵守纪律：authkey 与完整物理 MAC 绝对不返回给 Renderer（通过 maskedAddr 脱敏）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { extractFromPath } from './band-key-extract.ts';
import { CORE_EXE, getDeviceConfigFile } from './pulse-core-client.ts';

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
  /** 用户手动输入的 MAC，优先级最高 */
  manualMac?: string;
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

const isXiaomiBandName = (name: string) => /band|手环|xiaomi/i.test(name);

/** 解析 `pulse-core --scan` 的 stdout，只留小米手环（扫描结果里常混着耳机、手柄） */
export function parseScanOutput(stdout: string): PairedBandDevice[] {
  const items: Array<{ name?: string; addr?: string }> = JSON.parse(stdout.trim() || '[]');
  const devices: PairedBandDevice[] = [];
  for (const item of items) {
    const rawMac = (item.addr ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    const name = (item.name ?? '').trim();
    if (rawMac.length !== 12 || !isXiaomiBandName(name)) continue;
    devices.push({ id: `scan_${rawMac.toLowerCase()}`, name, maskedMac: maskMacAddress(rawMac), isXiaomiBand: true, rawMac });
  }
  return devices;
}

export class DeviceConfigService {
  private configPath: string;
  /** 最近一次扫描结果；保存时按 selectedDeviceId 在这里找，避免再扫一遍 */
  private scannedDevices: PairedBandDevice[] = [];

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
        const isXiaomiBand = isXiaomiBandName(name);

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
   * 扫描附近的小米手环（pulse-core --scan，经典蓝牙 inquiry，约 8 秒）。
   * 不需要手环在 Windows 里配对过。失败时返回空列表，由界面提示手动输入。
   */
  public scanBandDevices(): Promise<PairedBandDevice[]> {
    return new Promise((resolve) => {
      execFile(CORE_EXE, ['--scan'], { encoding: 'utf8', timeout: 30000, windowsHide: true }, (err, stdout) => {
        try {
          this.scannedDevices = err ? [] : parseScanOutput(String(stdout ?? ''));
        } catch {
          this.scannedDevices = [];
        }
        resolve(this.scannedDevices);
      });
    });
  }

  /**
   * 保存设备配置至 device.json（异步：内部可能需枚举已配对设备）
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

    // 3. 确定手环 MAC：手动输入 > 选中的设备（已配对 / 扫描到）> 日志里的 MAC > 唯一已配对小米手环
    let selectedDevice: PairedBandDevice | undefined;
    let rawMac: string | undefined;
    let paired: PairedBandDevice[] | undefined;
    const getPaired = async () => (paired ??= await this.getPairedBandDevices());

    if (payload.manualMac) {
      rawMac = payload.manualMac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
      if (rawMac.length !== 12) {
        return { ok: false, error: 'MAC 地址格式不对：应为 12 位十六进制，例如 04:34:C3:97:9A:06' };
      }
    } else {
      if (payload.selectedDeviceId) {
        selectedDevice = this.scannedDevices.find((d) => d.id === payload.selectedDeviceId);
        if (!selectedDevice) {
          selectedDevice = (await getPaired()).find((d) => d.id === payload.selectedDeviceId);
        }
        // 用户明确选了设备却找不到（多半是扫描结果过期），不能悄悄换成日志里的 MAC 或别的手环
        if (!selectedDevice) {
          return { ok: false, error: '选中的手环已不在列表里，请重新扫描后再选择。' };
        }
      }
      if (!selectedDevice && extractResult.mac) {
        rawMac = extractResult.mac;
      }
      // 若未显式传入 ID 或找不到，但已配对列表中恰好有唯一小米手环，则智能自动选中
      if (!selectedDevice && !rawMac) {
        const xiaomiBands = (await getPaired()).filter((d) => d.isXiaomiBand);
        if (xiaomiBands.length === 1) {
          selectedDevice = xiaomiBands[0];
        }
      }
      rawMac = selectedDevice?.rawMac ?? rawMac;
    }

    if (!rawMac) {
      return {
        ok: false,
        error: '这份日志里没有手环的蓝牙地址。请点「扫描附近手环」，或手动输入 MAC 地址。',
      };
    }

    const formattedAddr = formatMacAddress(rawMac);

    // 4. 构建配置对象
    const configContent = {
      name: selectedDevice?.name || `Xiaomi Smart Band 10 ${rawMac.slice(-4)}`,
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
        maskedAddr: maskMacAddress(rawMac),
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
