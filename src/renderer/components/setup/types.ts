export type SetupStepId =
  | 'prepare'
  | 'import_log'
  | 'save_credentials'
  | 'windows_pairing'
  | 'rfcomm_auth'
  | 'install_app'
  | 'verify_quota';

export type StepStatus = 'pending' | 'active' | 'completed' | 'error';

export interface SetupStep {
  id: SetupStepId;
  index: number;
  title: string;
  shortLabel: string;
  description: string;
  status: StepStatus;
  error?: string;
}

export const INITIAL_SETUP_STEPS: SetupStep[] = [
  {
    id: 'prepare',
    index: 1,
    title: '准备手环',
    shortLabel: '准备手环',
    description: '确认手环处于正常开机且蓝牙可被搜索状态。',
    status: 'active',
  },
  {
    id: 'import_log',
    index: 2,
    title: '导入手机日志',
    shortLabel: '导入手机日志',
    description: '从手机健康应用导出的运行日志中提取设备认证信息。',
    status: 'pending',
  },
  {
    id: 'save_credentials',
    index: 3,
    title: '保存凭据',
    shortLabel: '保存凭据',
    description: '使用 Windows DPAPI 本地用户安全体系加密存储设备认证凭据。',
    status: 'pending',
  },
  {
    id: 'windows_pairing',
    index: 4,
    title: 'Windows 配对',
    shortLabel: 'Windows 配对',
    description: '在 Windows 蓝牙设备管理中与手环建立经典蓝牙配对。',
    status: 'pending',
  },
  {
    id: 'rfcomm_auth',
    index: 5,
    title: 'RFCOMM连接认证',
    shortLabel: 'RFCOMM连接认证',
    description: '建立底层 RFCOMM 串口通信链路，完成双向协议握手与安全校验。',
    status: 'pending',
  },
  {
    id: 'install_app',
    index: 6,
    title: '安装Pulse快应用',
    shortLabel: '安装Pulse快应用',
    description: '推送配套的 Pulse 手环端快应用，用于在手环屏幕实时渲染状态。',
    status: 'pending',
  },
  {
    id: 'verify_quota',
    index: 7,
    title: '验证额度',
    shortLabel: '验证额度',
    description: '验证 PC 端 Agent 状态与额度数据向手环端的全链路推送与刷新。',
    status: 'pending',
  },
];
