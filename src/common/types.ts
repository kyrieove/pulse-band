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

