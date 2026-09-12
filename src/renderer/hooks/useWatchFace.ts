import { useCallback, useEffect, useRef, useState } from 'react';
import type { WatchfaceItem } from '../../main/services/watchface-service';

export interface WatchfaceOpResult {
  ok: boolean;
  message?: string;
}

export interface WatchfaceInstallOutcome {
  /** INSTALL_SUCCESS = 新装成功；INSTALL_USED = 设备上已存在（同属成功路径） */
  meaning: 'INSTALL_SUCCESS' | 'INSTALL_USED';
  fileName: string;
  watchfaceId: string;
}

export interface UseWatchFaceResult {
  items: WatchfaceItem[];
  loading: boolean;
  loadError: string | null;
  refresh: () => void;
  /** 正在切换的表盘 id；null 表示没有切换进行中 */
  settingId: string | null;
  setWatchface: (id: string) => Promise<WatchfaceOpResult>;
  installing: boolean;
  installOutcome: WatchfaceInstallOutcome | null;
  installError: string | null;
  installWatchface: (filePath: string, fileName: string) => Promise<void>;
  retryInstall: () => Promise<void>;
  dismissInstallFeedback: () => void;
}

/**
 * 表盘列表 / 切换 / 本地安装的前端状态。
 *
 * 数据唯一来源是 window.pulse.watchface（device.watchface.* RPC），
 * 不引入任何本地模拟数据；切换与安装共用同一互斥位，同一时刻只允许一个操作。
 * 安装是阻塞式长操作且无进度事件，这里不产生任何进度数值。
 */
export function useWatchFace(connected: boolean): UseWatchFaceResult {
  const [items, setItems] = useState<WatchfaceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installOutcome, setInstallOutcome] = useState<WatchfaceInstallOutcome | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const lastInstallRef = useRef<{ filePath: string; fileName: string } | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setLoading(true);
    setLoadError(null);
    window.pulse
      ?.watchface?.list?.()
      .then((res) => {
        if (!aliveRef.current) return;
        if (res?.ok) {
          setItems(res.data?.watchfaces ?? []);
        } else {
          setLoadError(res?.message ?? '读取表盘列表失败');
        }
      })
      .catch(() => {
        if (aliveRef.current) setLoadError('读取表盘列表失败');
      })
      .finally(() => {
        busyRef.current = false;
        if (aliveRef.current) setLoading(false);
      });
  }, []);

  // 手环连上（或重连）后自动加载一次列表
  useEffect(() => {
    if (connected) refresh();
  }, [connected, refresh]);

  const setWatchface = useCallback(async (id: string): Promise<WatchfaceOpResult> => {
    if (busyRef.current) return { ok: false, message: '有操作正在进行中，请稍候' };
    if (!id) return { ok: false, message: '缺少表盘 id' };
    busyRef.current = true;
    setSettingId(id);
    try {
      const res = await window.pulse?.watchface?.set?.(id);
      if (!aliveRef.current) return { ok: false, message: '页面已关闭' };
      if (res?.ok) {
        const current = res.data?.watchface;
        let merged = false;
        setItems((prev) =>
          prev.map((it) => {
            if (current && it.id === current.id) {
              merged = true;
              return current;
            }
            return { ...it, is_current: false };
          }),
        );
        // 返回的表盘不在本地列表里（列表已过期）时，重新拉一次
        if (!merged) refresh();
        return { ok: true };
      }
      return { ok: false, message: res?.message ?? '切换表盘失败' };
    } catch {
      return { ok: false, message: '切换表盘失败' };
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setSettingId(null);
    }
  }, [refresh]);

  const installWatchface = useCallback(async (filePath: string, fileName: string) => {
    if (busyRef.current || !filePath) return;
    busyRef.current = true;
    lastInstallRef.current = { filePath, fileName };
    setInstalling(true);
    setInstallOutcome(null);
    setInstallError(null);
    try {
      const res = await window.pulse?.watchface?.install?.(filePath);
      if (!aliveRef.current) return;
      if (res?.ok) {
        setInstallOutcome({
          meaning: res.data?.result_code === 2 ? 'INSTALL_SUCCESS' : 'INSTALL_USED',
          fileName,
          watchfaceId: res.data?.watchface_id ?? '',
        });
        // 安装结论已经落地，列表刷新失败不打断成功提示
        void window.pulse
          ?.watchface?.list?.()
          .then((lr) => {
            if (aliveRef.current && lr?.ok) setItems(lr.data?.watchfaces ?? []);
          })
          .catch(() => {});
      } else {
        setInstallError(res?.message ?? '表盘安装失败');
      }
    } catch {
      if (aliveRef.current) setInstallError('表盘安装失败');
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setInstalling(false);
    }
  }, []);

  const retryInstall = useCallback(async () => {
    const last = lastInstallRef.current;
    if (last) await installWatchface(last.filePath, last.fileName);
  }, [installWatchface]);

  const dismissInstallFeedback = useCallback(() => {
    setInstallOutcome(null);
    setInstallError(null);
  }, []);

  return {
    items,
    loading,
    loadError,
    refresh,
    settingId,
    setWatchface,
    installing,
    installOutcome,
    installError,
    installWatchface,
    retryInstall,
    dismissInstallFeedback,
  };
}
