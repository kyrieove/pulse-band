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
  CredentialSaveStatus,
  CredentialSaveState,
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
    id: 'prepare',
    index: 1,
    title: '准备手环',
    shortLabel: '准备手环',
    description: '真实能力将在后续阶段接入。',
    status: 'active',
  },
  {
    id: 'import_log',
    index: 2,
    title: '导入手机日志',
    shortLabel: '导入手机日志',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
  {
    id: 'save_credentials',
    index: 3,
    title: '保存凭据',
    shortLabel: '保存凭据',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
  {
    id: 'windows_pairing',
    index: 4,
    title: 'Windows配对',
    shortLabel: 'Windows配对',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
  {
    id: 'rfcomm_auth',
    index: 5,
    title: 'RFCOMM连接认证',
    shortLabel: 'RFCOMM连接认证',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
  {
    id: 'install_app',
    index: 6,
    title: '安装Pulse快应用',
    shortLabel: '安装Pulse快应用',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
  {
    id: 'verify_quota',
    index: 7,
    title: '验证额度',
    shortLabel: '验证额度',
    description: '真实能力将在后续阶段接入。',
    status: 'pending',
  },
];
