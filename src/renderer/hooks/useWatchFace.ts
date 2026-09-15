import { useCallback, useEffect, useRef, useState } from 'react';
import type { WatchfaceItem } from '../../main/services/watchface-service';
import type { WatchfacePreviewView } from '../../main/services/watchface-preview-service';

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
  /** 本地预览图，按表盘 id 索引；来源可能是用户手动指定或自动提取 */
  previews: Record<string, WatchfacePreviewView>;
  /** 正在写/清预览图的表盘 id；null 表示没有进行中 */
  previewBusyId: string | null;
  previewError: string | null;
  setPreview: (id: string, filePath: string) => Promise<WatchfaceOpResult>;
  clearPreview: (id: string) => Promise<WatchfaceOpResult>;
  dismissPreviewError: () => void;
}

/**
 * 表盘列表 / 切换 / 本地安装 / 本地预览图的前端状态。
 *
 * 数据唯一来源是 window.pulse.watchface（device.watchface.* RPC + 本机预览缓存），
 * 不引入任何本地模拟数据；切换与安装共用同一互斥位，同一时刻只允许一个操作。
 * 安装是阻塞式长操作且无进度事件，这里不产生任何进度数值。
 * 预览图读写是本地文件操作，与切换/安装互不阻塞。
 */
export function useWatchFace(connected: boolean): UseWatchFaceResult {
  const [items, setItems] = useState<WatchfaceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settingId, setSettingId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installOutcome, setInstallOutcome] = useState<WatchfaceInstallOutcome | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, WatchfacePreviewView>>({});
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  const busyRef = useRef(false);
  const lastInstallRef = useRef<{ filePath: string; fileName: string } | null>(null);
  /** 最新的 items。异步回调里要同步判断「这个表盘在不在列表里」，不能用 state */
  const itemsRef = useRef<WatchfaceItem[]>([]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadPreviews = useCallback(() => {
    window.pulse
      ?.watchface?.preview?.list?.()
      .then((res) => {
        if (aliveRef.current && res?.ok) setPreviews(res.data?.previews ?? {});
      })
      .catch(() => {
        // 读不到本地预览图只表现为"卡片没有图"，不阻断列表本身
      });
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
          loadPreviews();
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
  }, [loadPreviews]);

  // 手环连上（或重连）后自动加载一次列表与本地预览
  useEffect(() => {
    if (connected) {
      loadPreviews();
      refresh();
    }
  }, [connected, loadPreviews, refresh]);

  const setPreview = useCallback(async (id: string, filePath: string): Promise<WatchfaceOpResult> => {
    if (!id) return { ok: false, message: '缺少表盘 id' };
    if (!filePath) return { ok: false, message: '无法获取所选图片的本地路径' };
    setPreviewBusyId(id);
    setPreviewError(null);
    try {
      const res = await window.pulse?.watchface?.preview?.set?.(id, filePath);
      if (!aliveRef.current) return { ok: false, message: '页面已关闭' };
      if (res && res.ok) {
        const preview = res.data.preview;
        setPreviews((prev) => ({ ...prev, [preview.id]: preview }));
        return { ok: true };
      }
      const message = (res && !res.ok ? res.message : null) ?? '设置本地预览图失败';
      setPreviewError(message);
      return { ok: false, message };
    } catch {
      setPreviewError('设置本地预览图失败');
      return { ok: false, message: '设置本地预览图失败' };
    } finally {
      if (aliveRef.current) setPreviewBusyId(null);
    }
  }, []);

  const clearPreview = useCallback(async (id: string): Promise<WatchfaceOpResult> => {
    if (!id) return { ok: false, message: '缺少表盘 id' };
    setPreviewBusyId(id);
    setPreviewError(null);
    try {
      const res = await window.pulse?.watchface?.preview?.clear?.(id);
      if (!aliveRef.current) return { ok: false, message: '页面已关闭' };
      if (res && res.ok) {
        setPreviews((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        return { ok: true };
      }
      const message = (res && !res.ok ? res.message : null) ?? '清除本地预览图失败';
      setPreviewError(message);
      return { ok: false, message };
    } catch {
      setPreviewError('清除本地预览图失败');
      return { ok: false, message: '清除本地预览图失败' };
    } finally {
      if (aliveRef.current) setPreviewBusyId(null);
    }
  }, []);

  const dismissPreviewError = useCallback(() => setPreviewError(null), []);

  const setWatchface = useCallback(async (id: string): Promise<WatchfaceOpResult> => {
    if (busyRef.current) return { ok: false, message: '有操作正在进行中，请稍候' };
    if (!id) return { ok: false, message: '缺少表盘 id' };
    busyRef.current = true;
    setSettingId(id);
    let needsRefresh = false;
    try {
      const res = await window.pulse?.watchface?.set?.(id);
      if (!aliveRef.current) return { ok: false, message: '页面已关闭' };
      if (res?.ok) {
        const current = res.data?.watchface;
        // 同步判断，不能用 setItems 的 updater 里赋值：updater 不是同步执行的，
        // 判断时那个标志还是 false。列表里没有这个表盘 = 列表已过期。
        needsRefresh = !current || !itemsRef.current.some((it) => it.id === current.id);
        setItems((prev) =>
          prev.map((it) => {
            if (current && it.id === current.id) return current;
            return { ...it, is_current: false };
          }),
        );
        return { ok: true };
      }
      return { ok: false, message: res?.message ?? '切换表盘失败' };
    } catch {
      return { ok: false, message: '切换表盘失败' };
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setSettingId(null);
      // 必须等 busyRef 释放之后再拉：refresh() 第一行就是 if (busyRef.current) return，
      // 在这里之前调用等于什么都没做。
      if (needsRefresh && aliveRef.current) refresh();
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
        loadPreviews();
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
  }, [loadPreviews]);

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
    previews,
    previewBusyId,
    previewError,
    setPreview,
    clearPreview,
    dismissPreviewError,
  };
}
