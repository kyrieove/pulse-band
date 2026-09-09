export type AgentKind = 'claude' | 'codex' | 'antigravity';

export type SessionState = 'idle' | 'thinking' | 'running_tool' | 'completed' | 'error';

export interface ToolCallInfo {
  name: string;
  paramsSummary?: string;
  startedAt: number;
}

export interface AgentSession {
  id: string;
  agent: AgentKind;
  status: SessionState;
  title?: string;
  cwd?: string;
  currentTool?: ToolCallInfo | null;
  lastMessage?: string;
  startedAt: number;
  updatedAt: number;
  durationSeconds: number;
  error?: string;
}

export interface IslandState {
  sessions: AgentSession[];
  activeSessionId?: string;
  isExpanded: boolean;
  dockEdge: 'top' | 'bottom' | 'left' | 'right' | 'none';
  alwaysOnTop: boolean;
}

export interface ClaudeHookPayload {
  session_id?: string;
  event_type?: string;
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  tool_output?: any;
  message?: string;
  error?: string;
  [key: string]: any;
}

export interface MinibarState {
  sessions: AgentSession[];
  quotas: import('../main/services/quota-collector').ClusterQuotas;
  isExpanded: boolean;
}

// ============================================================================
// Pulse 2.0 首次设置向导数据契约 (Setup Data Contracts - Type-only)
// ============================================================================

export type SetupStatus =
  | 'idle'
  | 'running'
  | 'success'
  | 'error';

export type SetupStepId =
  | 'prepare'
  | 'import_log'
  | 'save_credentials'
  | 'windows_pairing'
  | 'rfcomm_auth'
  | 'install_app'
  | 'verify_quota';

export type SetupStepStatus =
  | 'pending'
  | 'active'
  | 'completed'
  | 'error';

export interface SetupStepState {
  id: SetupStepId;
  status: SetupStepStatus;
  message?: string;
}

export interface SetupError {
  code: string;
  userMessage: string;
}

export interface SetupState {
  status: SetupStatus;
  currentStep: SetupStepId | null;
  steps: SetupStepState[];
  error?: SetupError;
}

export type SetupAction =
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'select_log' }
  | { type: 'retry_step'; step: SetupStepId };

// ============================================================================
// 手机日志导入步骤数据契约 (Log Import Step Data Contract)
// ============================================================================

export type LogImportStatus =
  | 'idle'
  | 'selecting'
  | 'parsing'
  | 'success'
  | 'error';

export interface LogImportState {
  status: LogImportStatus;
  fileName?: string;
  error?: SetupError;
}

// ============================================================================
// 保存凭据步骤数据契约 (Credential Save Step Data Contract)
// ============================================================================

export type CredentialSaveStatus =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'error';

export interface CredentialSaveState {
  status: CredentialSaveStatus;
  error?: SetupError;
}

// ============================================================================
// Windows 配对步骤数据契约 (Windows Pairing Step Data Contract)
// ============================================================================

export type WindowsPairingStatus =
  | 'idle'
  | 'waiting'
  | 'checking'
  | 'paired'
  | 'error';

export interface WindowsPairingState {
  status: WindowsPairingStatus;
  error?: SetupError;
}

// ============================================================================
// RFCOMM 连接认证步骤数据契约 (RFCOMM Auth Step Data Contract)
// ============================================================================

export type RfcommAuthStatus =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'error';

export interface RfcommAuthState {
  status: RfcommAuthStatus;
  error?: SetupError;
}
