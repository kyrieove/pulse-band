/**
 * 检查更新 + 下载安装包（GitHub Releases）。
 *
 * 不用 electron-updater：release.yml 只上传 `Pulse-Setup-<版本>.exe` 和它的 `.sha256`，没有 latest.yml。
 * 下载后必须用 .sha256 校验，校验不过就删掉，绝不启动一个没对上哈希的 exe。
 * 下载地址只认 kyrieove/pulse-band 的 release 资源，由主进程自己查 GitHub 得到，不接受 Renderer 传来的 URL。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isVersionNewer } from './version-check.ts';

export const RELEASES_API = 'https://api.github.com/repos/kyrieove/pulse-band/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/kyrieove/pulse-band/releases/download/';

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  /** 安装包与校验文件都在 release 里时才有，缺一个就只能去网页手动下载 */
  installer?: { name: string; url: string; size: number; checksumUrl: string };
}

export interface DownloadProgress {
  received: number;
  total: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function parseRelease(release: any, currentVersion: string): UpdateInfo {
  const latestVersion = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  const releaseUrl = typeof release?.html_url === 'string' ? release.html_url : '';
  const assets: any[] = Array.isArray(release?.assets) ? release.assets : [];
  const name = `Pulse-Setup-${latestVersion}.exe`;
  const exe = assets.find((a) => a?.name === name);
  const sha = assets.find((a) => a?.name === `${name}.sha256`);
  const trusted = (a: any) => typeof a?.browser_download_url === 'string' && a.browser_download_url.startsWith(DOWNLOAD_PREFIX);

  return {
    currentVersion,
    latestVersion,
    updateAvailable: isVersionNewer(latestVersion, currentVersion),
    releaseUrl,
    installer:
      trusted(exe) && trusted(sha)
        ? { name, url: exe.browser_download_url, size: Number(exe.size) || 0, checksumUrl: sha.browser_download_url }
        : undefined,
  };
}

export async function fetchUpdateInfo(currentVersion: string, fetchImpl: FetchLike = fetch): Promise<UpdateInfo> {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);
  return parseRelease(await res.json(), currentVersion);
}

/** 下载安装包时的空闲超时：多久收不到一个字节就判定链路已死（不是总时长） */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/**
 * 下载到 destDir，边写边算 SHA256；对不上就删掉并抛错。返回安装包路径。
 *
 * idleTimeoutMs 可注入，便于测试用很小的值跑超时路径。
 */
export async function downloadInstaller(
  installer: NonNullable<UpdateInfo['installer']>,
  destDir: string,
  onProgress: (p: DownloadProgress) => void,
  fetchImpl: FetchLike = fetch,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS
): Promise<string> {
  const shaRes = await fetchImpl(installer.checksumUrl, { signal: AbortSignal.timeout(30_000) });
  if (!shaRes.ok) throw new Error(`下载校验文件失败：${shaRes.status}`);
  const expected = (await shaRes.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('校验文件格式不对');

  // 空闲超时：连接半开（对端消失但没发 FIN）时 await 会永远不返回，界面就一直停在
  // 「下载中」，而且这个 promise 被上层缓存，重试也没用。每收到一个 chunk 就重置计时器；
  // 不用总时长超时 —— 安装包大、网速慢时会误杀。
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | null = null;
  let idleTimedOut = false;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
  };

  fs.mkdirSync(destDir, { recursive: true });
  const finalPath = path.join(destDir, installer.name);
  const partPath = `${finalPath}.part`;
  const out = fs.createWriteStream(partPath);

  // 写盘出错（磁盘满、目标被占用）时流会 emit 'error'；没有监听者就是未捕获异常，
  // 直接把主进程带走。这里先挂上监听，再让下面每个 await 都能把它变成 reject。
  let writeError: Error | null = null;
  out.on('error', (err: Error) => {
    writeError = err;
  });
  /** 等 drain；写入流出错时立刻 reject，不能干等一个永远不会来的 drain */
  const waitDrain = () =>
    new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        out.off('error', onErr);
        resolve();
      };
      const onErr = (e: Error) => {
        out.off('drain', onDrain);
        reject(e);
      };
      out.once('drain', onDrain);
      out.once('error', onErr);
    });

  const hash = createHash('sha256');
  let received = 0;
  try {
    resetIdle();
    const res = await fetchImpl(installer.url, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`下载安装包失败：${res.status}`);
    const total = Number(res.headers.get('content-length')) || installer.size;

    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      resetIdle();
      if (writeError) throw writeError;
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await waitDrain();
      if (writeError) throw writeError;
      onProgress({ received, total });
    }

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => {
        out.off('error', onErr);
        reject(e);
      };
      out.once('error', onErr);
      out.end(() => {
        out.off('error', onErr);
        resolve();
      });
    });
    if (writeError) throw writeError;

    if (hash.digest('hex') !== expected) throw new Error('安装包校验失败（SHA256 不一致），已删除，请重试');
    fs.renameSync(partPath, finalPath);
    return finalPath;
  } catch (err: any) {
    const failure = idleTimedOut
      ? new Error(`下载超时：${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据，请重试`)
      : err;
    // Windows 上句柄没关就删会 EBUSY，先等流真正关闭
    if (!out.closed) await new Promise<void>((r) => out.destroy().once('close', () => r()));
    fs.rmSync(partPath, { force: true });
    throw failure;
  } finally {
    clearIdle();
  }
}
