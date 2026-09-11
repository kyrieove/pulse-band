import type { SetupStepId, SetupStepStatus } from '../../../common/types';

export type {
  SetupStatus,
  SetupStepId,
  SetupStepStatus,
  SetupStepState,
  SetupError,
  SetupState,
  SetupAction,
  LogImportStatus,
  LogImportState,
  InstallAppStatus,
  InstallAppState,
  VerifyQuotaStatus,
  VerifyQuotaState,
} from '../../../common/types';

/** 向后兼容现有 SetupWizard 内部引用的别名 */
export type StepStatus = SetupStepStatus;

export interface SetupStep {
  id: SetupStepId;
  index: number;
  title: string;
  shortLabel: string;
  description: string;
  status: SetupStepStatus;
  error?: string;
}

export const INITIAL_SETUP_STEPS: SetupStep[] = [
  {
    id: 'import_log',
    index: 1,
    title: '导入手机日志',
    shortLabel: '日志与设备绑定',
    description: '自动解析手机日志提取 AuthKey，匹配已配对手环并保存配置。',
    status: 'active',
  },
  {
    id: 'connect_band',
    index: 2,
    title: '连接手环',
    shortLabel: '连接蓝牙手环',
    description: '通过蓝牙 RFCOMM 建立安全连接并验证鉴权握手。',
    status: 'pending',
  },
  {
    id: 'install_app',
    index: 3,
    title: '安装手环应用',
    shortLabel: '安装快应用',
    description: '一键将配套的 Pulse 手环端快应用推送到手环。',
    status: 'pending',
  },
  {
    id: 'verify_quota',
    index: 4,
    title: '验证额度',
    shortLabel: '验证额度与显示',
    description: '检查电脑端额度数据获取，并在手环端确认卡片展示正常。',
    status: 'pending',
  },
];
