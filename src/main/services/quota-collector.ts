import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pushError } from './error-log';

const execFileAsync = promisify(execFile);

export interface AgentQuota {
  name: string;
  resetText: string;
  /** 7d 窗口的重置倒计时；只有 fromLive 拿得到真值，三条兜底路径一律 null（不许编） */
  reset7dText: string | null;
  pct5h: number | null;
  pct7d: number | null;
  level5h: 'normal' | 'warn' | 'danger';
  level7d: 'normal' | 'warn' | 'danger';
  used5h: number;
  limit5h: number;
  used7d: number;
  limit7d: number;
  unit: 'tokens' | 'steps' | 'percent';
  /** true = 服务端回传的真实额度；false = 本地估算，仅供参考 */
  authoritative: boolean;
  needsAuth?: boolean;
}

/** Codex 每次 token_count 事件回传的单个额度窗口 */
interface CodexWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number;
}

export interface ClusterQuotas {
  claude: AgentQuota;
  codex: AgentQuota;
  antigravity: AgentQuota;
  updatedAt: number;
}

function getLevel(pct: number | null): 'normal' | 'warn' | 'danger' {
  if (pct === null) return 'normal';
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return 'normal';
}

/**
 * 「还剩多久 · 几点重置」，例：`4h22min · 4:24`。
 * atMs 是重置的绝对时刻，不给就只出时长。
 * 本进程跑在用户本地时区，getHours() 直接就是墙上时间。
 */
function formatCountdown(ms: number, atMs?: number): string {
  const totalMin = Math.max(0, Math.ceil(ms / (60 * 1000)));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const dur = h > 0 ? (m > 0 ? `${h}h ${m}min` : `${h}h`) : `${m}min`;
  if (!atMs) return dur;
  const d = new Date(atMs);
  return `${dur} · ${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** ≥24h 的窗口用「天+小时」，绝对时刻在 6 天外没有意义，不带 */
function formatLongCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  if (totalMin >= 24 * 60) {
    const d = Math.floor(totalMin / (24 * 60));
    const h = Math.floor((totalMin % (24 * 60)) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  return formatCountdown(ms); // 24h 以内退回老格式（不带绝对时刻）
}

/** 一个额度窗口的当前状态 */
interface WindowState {
  pct: number;
  resetMs: number;
}

type LiveQuota = { primary: WindowState; secondary: WindowState; at: number };

/** 外推锚点：某次成功读数的百分比 ↔ 当时本地 block 里已有多少 token */
interface ClaudeAnchor {
  pct: number;
  blockStart: number;
  tokens: number;
}

interface ClaudePersistedState {
  live: LiveQuota;
  anchor: ClaudeAnchor;
  tokensPerPct?: number;
}

/**
 * Claude 的读数落盘。/api/oauth/usage 被限流时可以持续 429 半小时以上，
 * 这期间重启就彻底没数了 —— 存一份，起来先用旧的 + 本地外推顶着。
 * 存放在项目内的 .cache/claude-quota.json，避免系统临时目录重启被清理。
 */
/**
 * 寻找应用根目录（包含 package.json 的目录），支持源码运行与打包后运行
 */
function findAppRootDir(): string {
  let cur = import.meta.dirname;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'package.json'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return process.cwd();
}

const CLAUDE_STATE_DIR = path.resolve(findAppRootDir(), '.cache');
const CLAUDE_STATE_FILE = path.join(CLAUDE_STATE_DIR, 'claude-quota.json');

function loadClaudeState(): ClaudePersistedState | null {
  try {
    const d = JSON.parse(fs.readFileSync(CLAUDE_STATE_FILE, 'utf-8'));
    if (
      (typeof d?.live?.at === 'number' && typeof d?.anchor?.tokens === 'number') ||
      (typeof d?.tokensPerPct === 'number' && d.tokensPerPct > 0)
    ) {
      return d;
    }
  } catch {}
  return null;
}

function saveClaudeState(live: LiveQuota, anchor: ClaudeAnchor, tokensPerPct?: number): void {
  try {
    if (!fs.existsSync(CLAUDE_STATE_DIR)) {
      fs.mkdirSync(CLAUDE_STATE_DIR, { recursive: true });
    }
    fs.writeFileSync(CLAUDE_STATE_FILE, JSON.stringify({ live, anchor, tokensPerPct }));
  } catch {}
}

/**
 * 统计当前 5 小时 block 内的 input+output token（不含 cache）。
 *
 * 三条规则照 ccusage 来，旧实现三条全踩反：
 *   1. 按 block 窗口取，不是「最近 5 小时」
 *   2. 按 requestId+message.id 去重，只留最后一条 —— 流式写入会先追加中间
 *      快照再写最终用量，全加起来就是重复计数（实测重复比唯一还多）
 *   3. 不算 cache token —— 实测 Anthropic 的 5h utilization 线性跟随
 *      in+out，含 cache 反而偏（58.5% vs 真值 60%）
 */
function claudeBlockTokens(blockStartMs: number, nowMs: number): number {
  const pDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(pDir)) return 0;

  const last = new Map<string, { ts: number; io: number }>();
  let projects: string[];
  try {
    projects = fs.readdirSync(pDir);
  } catch {
    return 0;
  }

  for (const p of projects) {
    const fp = path.join(pDir, p);
    let files: string[];
    try {
      if (!fs.statSync(fp).isDirectory()) continue;
      files = fs.readdirSync(fp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const q = path.join(fp, f);
      try {
        // block 开始之后没动过的文件不可能有本 block 的条目
        if (fs.statSync(q).mtimeMs < blockStartMs) continue;
        for (const line of fs.readFileSync(q, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          const u = e.message?.usage;
          if (!u) continue;
          const ts = new Date(e.timestamp).getTime();
          if (isNaN(ts) || ts < blockStartMs || ts > nowMs) continue;
          const key = `${e.requestId ?? ''}:${e.message?.id ?? ''}`;
          const prev = last.get(key);
          if (!prev || ts >= prev.ts) {
            last.set(key, { ts, io: (u.input_tokens || 0) + (u.output_tokens || 0) });
          }
        }
      } catch {}
    }
  }

  let total = 0;
  for (const v of last.values()) total += v.io;
  return total;
}

/**
 * 兜底路径用的 ccusage 式 block token 统计。
 * 当 API 拿不到且没有 live 状态时，照 ccusage 的规则划分 5h block：
 * 1. 扫描 ~/.claude/projects/ 下所有 jsonl，按 requestId:message.id 去重保留最新条目
 * 2. 按时间排序，遇到 ≥5 小时间隔开新 block，起点向下取整到整点
 * 3. 统计当前最新活跃 block 的 in+out token 总数及重置倒计时
 */
function claudeFallbackBlockTokens(nowMs: number): {
  tokens5h: number;
  tokens7d: number;
  blockEndMs: number;
} {
  const pDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(pDir)) {
    return { tokens5h: 0, tokens7d: 0, blockEndMs: 0 };
  }

  const sevenDaysAgo = nowMs - 7 * 86400 * 1000;
  let projects: string[];
  try {
    projects = fs.readdirSync(pDir);
  } catch {
    return { tokens5h: 0, tokens7d: 0, blockEndMs: 0 };
  }

  const entries: { ts: number; key: string; io: number }[] = [];

  for (const p of projects) {
    const fp = path.join(pDir, p);
    let files: string[];
    try {
      if (!fs.statSync(fp).isDirectory()) continue;
      files = fs.readdirSync(fp);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const q = path.join(fp, f);
      try {
        if (fs.statSync(q).mtimeMs < sevenDaysAgo) continue;
        for (const line of fs.readFileSync(q, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          const u = e.message?.usage;
          if (!u) continue;
          const ts = new Date(e.timestamp).getTime();
          if (isNaN(ts) || ts < sevenDaysAgo || ts > nowMs) continue;
          const key = `${e.requestId ?? ''}:${e.message?.id ?? ''}`;
          entries.push({ ts, key, io: (u.input_tokens || 0) + (u.output_tokens || 0) });
        }
      } catch {}
    }
  }

  if (entries.length === 0) {
    return { tokens5h: 0, tokens7d: 0, blockEndMs: 0 };
  }

  // 去重：同一条消息只算最后一次记录
  const dedup = new Map<string, { ts: number; io: number }>();
  for (const e of entries) {
    const prev = dedup.get(e.key);
    if (!prev || e.ts >= prev.ts) {
      dedup.set(e.key, { ts: e.ts, io: e.io });
    }
  }

  const sorted = Array.from(dedup.values()).sort((a, b) => a.ts - b.ts);
  let tokens7d = 0;
  for (const item of sorted) {
    tokens7d += item.io;
  }

  const FIVE_HOURS = 5 * 3600 * 1000;
  let curBlock: { startMs: number; endMs: number; lastTs: number; tokens: number } | null = null;

  for (const item of sorted) {
    if (!curBlock || item.ts - curBlock.lastTs >= FIVE_HOURS || item.ts >= curBlock.startMs + FIVE_HOURS) {
      const d = new Date(item.ts);
      d.setMinutes(0, 0, 0);
      const startMs = d.getTime();
      curBlock = {
        startMs,
        endMs: startMs + FIVE_HOURS,
        lastTs: item.ts,
        tokens: 0,
      };
    }
    curBlock.lastTs = item.ts;
    curBlock.tokens += item.io;
  }

  if (!curBlock || nowMs >= curBlock.endMs) {
    return { tokens5h: 0, tokens7d, blockEndMs: 0 };
  }

  return {
    tokens5h: curBlock.tokens,
    tokens7d,
    blockEndMs: curBlock.endMs,
  };
}

/**
 * 直接问 ChatGPT 后端要当前额度 —— 这是 Codex 桌面端自己用的接口
 * （app.asar 里 `AO.safeGet('/wham/usage', {OAI-App-Brand: codex})`）。
 * 凭据取 ~/.codex/auth.json 的 ChatGPT OAuth token。
 */
async function fetchCodexUsage(): Promise<{ primary: WindowState; secondary: WindowState } | null> {
  let auth: any;
  try {
    auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf-8'));
  } catch {
    return null;
  }
  const token = auth?.tokens?.access_token;
  if (!token) return null;

  const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'OAI-App-Brand': 'codex',
      'chatgpt-account-id': auth?.tokens?.account_id ?? '',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;

  const rl = ((await res.json()) as any)?.rate_limit;
  if (!rl) return null;

  const read = (w: any): WindowState => ({
    pct: w ? Math.min(100, Math.max(0, Math.round(w.used_percent))) : 0,
    resetMs: w ? w.reset_at * 1000 : 0,
  });
  return { primary: read(rl.primary_window), secondary: read(rl.secondary_window) };
}

/**
 * 直接问 Anthropic 要当前额度 —— 这是 Claude Code 自己用的接口
 * （claude.exe 里 `Mi.get("/api/oauth/usage", {refreshOAuth:true})`），
 * 响应含 five_hour / seven_day 两个窗口，各带 utilization 和 resets_at。
 *
 * 凭据来源二选一：
 *   - ~/.claude/.credentials.json（终端里 `claude` 登录后生成）
 *   - 环境变量 CLAUDE_CODE_OAUTH_TOKEN（`claude setup-token` 的输出）
 * 两个都没有就返回 null，走本地估算兜底。
 */
/**
 * Claude 凭据的自动续期。
 *
 * accessToken 只活 ~8 小时，过期后 /api/oauth/usage 返 401，面板掉进 est ——
 * 以前只能等用户开一次 Claude Code、由它去刷新这个文件。这里自己刷。
 * 端点、client_id、报文形状取自 claude.exe 里的 TOKEN_URL / CLIENT_ID 常量。
 *
 * 必须回写文件：服务端可能轮换 refreshToken，我们换走却不回写会把 Claude Code
 * 顶下线。写法是先留一份 .pulse-bak，再写临时文件 + rename 原子替换。
 *
 * 注意 setup-token 签出的长效 token 走不通这条路 —— 它没有 user:profile scope，
 * /api/oauth/usage 会返 403。只有 Claude Code 登录写下的这份凭据够权限。
 */
const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const CRED_BAK = CRED_FILE + '.pulse-bak';
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** 提前这么久续期。正常情况 Claude Code 自己会先刷，我们只是捡现成的。 */
const REFRESH_MARGIN_MS = 10 * 60_000;

interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  [k: string]: unknown;
}

function readClaudeCred(): { claudeAiOauth?: ClaudeOauth; accessToken?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

let refreshInFlight: Promise<string | null> | null = null;

/** 同一时刻只允许一次续期在飞，避免两轮轮询各换一次把 refreshToken 换废 */
function refreshClaudeToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = doRefreshClaudeToken().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function doRefreshClaudeToken(): Promise<string | null> {
  // 动手前再读一次盘：Claude Code 可能刚刚刷过，那就直接用它的，别白换一次
  const cur = readClaudeCred();
  const c = cur?.claudeAiOauth;
  if (!c || !c.refreshToken) return null;
  if (typeof c.expiresAt === 'number' && c.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return c.accessToken ?? null;
  }
  if (typeof c.refreshTokenExpiresAt === 'number' && c.refreshTokenExpiresAt <= Date.now()) {
    pushError('quota', 'claude：refreshToken 也过期了，在终端跑一次 claude 重新登录即可');
    return null;
  }

  let body: any;
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: c.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: (c.scopes ?? []).join(' '),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      pushError('quota', `claude：续期失败 HTTP ${res.status}，本轮走本地估算`);
      return null;
    }
    body = await res.json();
  } catch {
    pushError('quota', 'claude：续期请求没打通，本轮走本地估算', 'warn');
    return null;
  }

  const access = body?.access_token;
  if (typeof access !== 'string' || !access) {
    return null;
  }

  // 回写：只覆盖这五个字段，subscriptionType / rateLimitTier 之类原样留着
  const next: any = { ...(cur as object) };
  next.claudeAiOauth = {
    ...c,
    accessToken: access,
    refreshToken: body.refresh_token ?? c.refreshToken,
    expiresAt: Date.now() + (Number(body.expires_in) || 0) * 1000,
    refreshTokenExpiresAt:
      typeof body.refresh_token_expires_in === 'number'
        ? Date.now() + body.refresh_token_expires_in * 1000
        : c.refreshTokenExpiresAt,
    scopes: typeof body.scope === 'string' ? body.scope.split(' ') : c.scopes,
  };
  try {
    if (!fs.existsSync(CRED_BAK)) fs.copyFileSync(CRED_FILE, CRED_BAK);
    const tmp = CRED_FILE + '.pulse-tmp';
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, CRED_FILE);
  } catch (e) {
    // 写不进去也别把 token 丢了：这一轮内存里照用，下轮再试回写
    pushError('quota', `claude：新 token 回写失败（${String(e)}），Claude Code 那边可能要重登`);
  }
  return access;
}

export type ClaudeUsageResult =
  | { ok: true; data: { primary: WindowState; secondary: WindowState } }
  | { ok: false; reason: 'auth' | 'ratelimit' | 'other'; retryAfterMs?: number };

async function fetchClaudeUsage(): Promise<ClaudeUsageResult> {
  let token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    const raw = readClaudeCred();
    if (!raw) return { ok: false, reason: 'auth' };
    const c = raw.claudeAiOauth;
    // 快过期就先续一次，别等 401
    if (c && typeof c.expiresAt === 'number' && c.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      token = (await refreshClaudeToken()) ?? undefined;
    }
    if (!token) token = c?.accessToken ?? raw.accessToken;
  }
  if (!token) return { ok: false, reason: 'auth' };

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, reason: 'other' };
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'auth' };
    }
    if (res.status === 429) {
      let retryAfterMs: number | undefined;
      const headerVal = res.headers.get('retry-after');
      if (headerVal) {
        const secs = parseInt(headerVal, 10);
        if (!isNaN(secs) && secs > 0) {
          retryAfterMs = secs * 1000;
        }
      }
      return { ok: false, reason: 'ratelimit', retryAfterMs };
    }
    return { ok: false, reason: 'other' };
  }

  let d: any;
  try {
    d = (await res.json()) as any;
  } catch {
    return { ok: false, reason: 'other' };
  }

  const read = (w: any): WindowState => {
    const pct = w?.utilization ?? w?.percent;
    if (typeof pct !== 'number') return { pct: 0, resetMs: 0 };
    // resets_at 是 ISO 字符串，例如 "2026-09-04T04:19:59.887875+00:00"
    return {
      pct: Math.min(100, Math.max(0, Math.round(pct))),
      resetMs: w.resets_at ? new Date(w.resets_at).getTime() : 0,
    };
  };
  if (!d?.five_hour && !d?.seven_day) return { ok: false, reason: 'other' };
  return { ok: true, data: { primary: read(d.five_hour), secondary: read(d.seven_day) } };
}

/**
 * Antigravity 的额度问它本地的 language_server 就行，不用云端凭据：
 *   POST http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary
 *   header: x-codeium-csrf-token: <进程命令行里的 --csrf_token>
 * 端口是动态分配的（--https_server_port 0），所以从进程的监听端口里挨个试。
 *
 * 响应按模型组分桶（Gemini Models / Claude and GPT models），每组各有
 * 5h 和 weekly 两个 bucket，给的是 remainingFraction（剩余，不是已用）。
 * 面板只显示 Gemini 那组。
 */
const AG_GROUP = 'Gemini';
let agEndpoint: { port: number; token: string } | null = null;

/** 发一个 language_server 的 Connect RPC；网络错/非 2xx 一律返回 null 不抛 */
async function agCall(port: number, token: string, method: string, body: object): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    return res.ok ? ((await res.json()) as any) : null;
  } catch {
    return null;
  }
}

/**
 * 从 language_server 进程动态发现端口 + CSRF token（--https_server_port 0，
 * 端口每次重启都会变），再用 method 本身验证端点可用。Antigravity 没运行返回 null。
 */
async function discoverAgEndpoint(method: string, body: object): Promise<{ port: number; token: string } | null> {
  const ps = `
$p = Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | Select-Object -First 1
$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $p.ProcessId } | Select-Object -ExpandProperty LocalPort
[pscustomobject]@{ cmd = $p.CommandLine; ports = @($ports) } | ConvertTo-Json -Compress`;
  let info: any;
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 10000 });
    info = JSON.parse(stdout);
  } catch {
    return null; // Antigravity 没运行
  }
  const token = /--csrf_token[= ]([^\s"]+)/.exec(info?.cmd ?? '')?.[1];
  if (!token) return null;

  for (const port of [].concat(info.ports ?? [])) {
    if (await agCall(port, token, method, body)) return { port, token };
  }
  return null;
}

/**
 * 带缓存与自愈的 RPC：先试缓存的端点，失效就重新发现一轮。
 * 额度（RetrieveUserQuotaSummary）与会话状态（GetAllCascadeTrajectories）共用，
 * 任何一边发现的新端点另一边直接受益。
 */
export async function agRpc(method: string, body: object): Promise<any | null> {
  if (agEndpoint) {
    const data = await agCall(agEndpoint.port, agEndpoint.token, method, body);
    if (data) return data;
    agEndpoint = null; // 端口/token 变了，重新发现
  }
  agEndpoint = await discoverAgEndpoint(method, body);
  if (!agEndpoint) return null;
  return agCall(agEndpoint.port, agEndpoint.token, method, body);
}

async function fetchAntigravityUsage(): Promise<{ primary: WindowState; secondary: WindowState } | null> {
  const data = await agRpc('RetrieveUserQuotaSummary', {});
  if (!data) return null;

  // remainingFraction 是剩余比例，转成已用百分比
  const out: Record<string, WindowState> = {};
  const group = (data.response?.groups ?? []).find((g: any) =>
    String(g.displayName ?? '').includes(AG_GROUP)
  );
  for (const b of group?.buckets ?? []) {
    if (typeof b.remainingFraction !== 'number') continue;
    out[b.window] = {
      pct: Math.min(100, Math.max(0, Math.round((1 - b.remainingFraction) * 100))),
      resetMs: b.resetTime ? new Date(b.resetTime).getTime() : 0,
    };
  }
  if (!out['5h'] && !out.weekly) return null;
  const zero = { pct: 0, resetMs: 0 };
  return { primary: out['5h'] ?? zero, secondary: out.weekly ?? zero };
}

/**
 * 离线兜底：Codex 每个 token_count 事件也会把当时的额度写进 rollout 日志。
 * 只在本地跑过 Codex 之后才更新，网页版/云端/别的机器的用量看不到，所以偏低。
 */
function findLatestCodexRateLimits(): { primary?: CodexWindow; secondary?: CodexWindow } | null {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  if (!fs.existsSync(root)) return null;

  const files: { p: string; m: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          files.push({ p, m: fs.statSync(p).mtimeMs });
        } catch {}
      }
    }
  };
  walk(root);

  // 最近改动的文件里，事件时间戳最新的那条 rate_limits 才是当前额度
  files.sort((a, b) => b.m - a.m);
  let best: { ts: number; primary?: CodexWindow; secondary?: CodexWindow } | null = null;

  for (const { p } of files.slice(0, 10)) {
    let lines: string[];
    try {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      try {
        const entry = JSON.parse(lines[i]);
        const rl = entry.payload?.rate_limits;
        if (!rl?.primary) continue;
        const ts = new Date(entry.timestamp).getTime();
        if (!best || ts > best.ts) {
          best = { ts, primary: rl.primary, secondary: rl.secondary };
        }
        break;
      } catch {}
    }
  }

  return best;
}

type LiveKey = 'claude' | 'codex' | 'antigravity';

export class QuotaCollector {
  private cache: ClusterQuotas | null = null;
  private lastFetchTime = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache

  // 服务端真实额度：后台异步刷新，getQuotas() 保持同步不阻塞 HTTP 处理
  private live: Record<LiveKey, LiveQuota | null> = { claude: null, codex: null, antigravity: null };
  private fetching: Record<LiveKey, boolean> = { claude: false, codex: false, antigravity: false };
  private nextTry: Record<LiveKey, number> = { claude: 0, codex: 0, antigravity: 0 };
  private backoff: Record<LiveKey, number> = { claude: 0, codex: 0, antigravity: 0 };
  private authError: Record<LiveKey, boolean> = { claude: false, codex: false, antigravity: false };
  /** 每个源最后一次成功拉到服务端真实值的时间（阶段 5 诊断屏用），0 = 从未成功 */
  private lastSuccessAt: Record<LiveKey, number> = { claude: 0, codex: 0, antigravity: 0 };

  /**
   * 三个接口的脾气完全不同，间隔必须分开定：
   *
   * - Claude  `/api/oauth/usage` 限流极凶。社区实测 30s/60s/120s/240s/300s
   *           全部触发 429，且卡死 30 分钟以上不恢复（anthropics/claude-code#31637）。
   *           只能拉得很稀，中间靠本地 token 外推补。
   * - Codex   `/wham/usage` 不限流。Codex 桌面端自己是 30 秒起步、用得越满拉
   *           得越勤（`Math.max(FIVE_SECONDS, 30s * (1 - used%/100))`）。
   *           这里照抄，只是下限放宽到 10 秒。实测 10 秒间隔连打 4 次全 200。
   * - Antigravity  本机 language_server，没有配额成本，30 秒足够。
   */
  private intervalFor(key: LiveKey, cur: LiveQuota | null): number {
    if (key === 'claude') return 10 * 60_000;
    if (key === 'antigravity') return 30_000;
    // Codex：额度越紧盯得越勤
    const used = cur ? Math.max(cur.primary.pct, cur.secondary.pct) : 0;
    return Math.max(10_000, Math.round(30_000 * (1 - used / 100)));
  }
  /** 连续失败时退避的上限 */
  private readonly BACKOFF_MAX_MS = 60 * 60_000;
  /**
   * 超过这么久没成功拉到，就不再声称是服务端真值。
   * 按各自的拉取间隔推导 —— Codex/Antigravity 30 秒一拉，凭什么容忍 45 分钟的旧数据。
   */
  private staleAfter(key: LiveKey): number {
    return Math.max(5 * 60_000, 4 * this.intervalFor(key, this.live[key]));
  }

  /** Claude 的外推锚点，起来时先从盘上恢复 */
  private claudeAnchor: ClaudeAnchor | null = null;
  /** 上次成功读数（用于兜底 7d，即使过期或重置前也是有效下界） */
  private lastLiveClaude: LiveQuota | null = null;
  /** 标定系数：blockTokens / pct5h，稳定在 ~3598，每次成功读取 API 时自动更新并持久化 */
  private tokensPerPct: number | null = null;
  /** 本地 token 统计的短缓存，别每 5 秒扫一遍所有 jsonl */
  private tokenCache: { blockStart: number; at: number; value: number } | null = null;
  private readonly TOKEN_TTL_MS = 15_000;

  constructor() {
    const saved = loadClaudeState();
    if (saved) {
      if (saved.live) {
        this.live.claude = saved.live;
        this.lastLiveClaude = saved.live;
        // 跨重启恢复的读数也算「成功拉取过」，否则诊断屏会同时显示权威真值和「尚未成功」
        this.lastSuccessAt.claude = saved.live.at;
      }
      if (saved.anchor) {
        this.claudeAnchor = saved.anchor;
      }
      if (typeof saved.tokensPerPct === 'number' && saved.tokensPerPct > 0) {
        this.tokensPerPct = saved.tokensPerPct;
      }
    }
  }

  private blockTokensCached(blockStart: number, now: number): number {
    const c = this.tokenCache;
    if (c && c.blockStart === blockStart && now - c.at < this.TOKEN_TTL_MS) return c.value;
    const value = claudeBlockTokens(blockStart, now);
    this.tokenCache = { blockStart, at: now, value };
    return value;
  }

  // 猜的上限，没有官方依据；只在拿不到服务端真实值时兜底
  private limits = {
    antigravity: { limit5h: 2_000, limit7d: 6_000 },
  };

  public getQuotas(): ClusterQuotas {
    const now = Date.now();
    if (this.cache && now - this.lastFetchTime < this.CACHE_TTL_MS) {
      return this.cache;
    }

    this.refreshLive('codex', now, fetchCodexUsage);
    this.refreshLive('claude', now, fetchClaudeUsage);
    this.refreshLive('antigravity', now, fetchAntigravityUsage);

    const claude = this.collectClaudeQuota(now);
    const codex = this.collectCodexQuota(now);
    const antigravity = this.collectAntigravityQuota(now);

    this.cache = {
      claude,
      codex,
      antigravity,
      updatedAt: now,
    };
    this.lastFetchTime = now;
    return this.cache;
  }

  /** 诊断屏元数据：每源最后成功拉取时间 + 429/auth 退避到期时间（0 = 无退避） */
  public getQuotaMeta(): {
    lastSuccessAt: Record<LiveKey, number>;
    nextTry: Record<LiveKey, number>;
  } {
    return {
      lastSuccessAt: { ...this.lastSuccessAt },
      nextTry: { ...this.nextTry },
    };
  }

  private collectClaudeQuota(now: number): AgentQuota {
    let quota: AgentQuota;
    const live = this.live.claude;
    if (live) {
      quota = this.fromLive('claude', 'Claude', live, now, this.extrapolateClaude5h(live, now));
    } else {
      // 兜底：使用 ccusage 式本地真实 token 计数（按 requestId:message.id 去重，不含 cache）
      // 配合标定系数 tokensPerPct（稳定在 ~3598）折算百分比。
      // 如果从未成功调用过 API（无 tokensPerPct），则 5h 为 null，手环显示 --。
      // 7d：有上次成功读数则沿用 live.secondary.pct；从没成功读过则为 null。
      const fallback = claudeFallbackBlockTokens(now);
      const ratio = this.tokensPerPct;

      let pct5h: number | null = null;
      if (typeof ratio === 'number' && ratio > 0 && fallback.tokens5h > 0) {
        pct5h = Math.min(100, Math.max(0, Math.round(fallback.tokens5h / ratio)));
      }

      let pct7d: number | null = null;
      const lastKnown = this.lastLiveClaude;
      if (lastKnown && typeof lastKnown.secondary?.pct === 'number') {
        const expired7d = this.expire(lastKnown.secondary, now);
        pct7d = expired7d.pct;
      }

      let resetText = 'ready';
      if (fallback.blockEndMs > now) {
        resetText = formatCountdown(fallback.blockEndMs - now, fallback.blockEndMs);
      }

      quota = {
        name: 'Claude',
        resetText,
        reset7dText: null,
        pct5h,
        pct7d,
        level5h: getLevel(pct5h),
        level7d: getLevel(pct7d),
        used5h: pct5h ?? 0,
        limit5h: 100,
        used7d: pct7d ?? 0,
        limit7d: 100,
        unit: 'percent',
        authoritative: false,
      };
    }

    if (this.authError.claude) {
      quota.needsAuth = true;
      quota.authoritative = false;
    }

    return quota;
  }

  /** 后台刷新服务端真实额度，失败就沿用上一次的值 */
  private refreshLive(
    key: LiveKey,
    now: number,
    fetcher: () => Promise<{ primary: WindowState; secondary: WindowState } | null | ClaudeUsageResult>
  ): void {
    if (this.fetching[key]) return;
    if (now < this.nextTry[key]) return;
    const cur = this.live[key];
    if (cur && now - cur.at < this.intervalFor(key, cur)) return;

    this.fetching[key] = true;
    fetcher()
      .then((res) => {
        if (!res) {
          pushError('quota', `${key}：上游未返回数据，按失败退避重试`, 'warn');
          return this.penalise(key);
        }

        if ('ok' in res) {
          if (!res.ok) {
            if (res.reason === 'auth') {
              this.authError[key] = true;
              this.backoff[key] = 0;
              this.nextTry[key] = Date.now() + 5 * 60_000;
              this.cache = null;
              pushError('quota', `${key}：凭据失效（auth），5 分钟后重试`);
            } else if (res.reason === 'ratelimit' && typeof res.retryAfterMs === 'number' && res.retryAfterMs > 0) {
              this.backoff[key] = 0;
              this.nextTry[key] = Date.now() + res.retryAfterMs;
              this.cache = null;
              pushError(
                'quota',
                `${key}：被限流（429），退避 ${Math.round(res.retryAfterMs / 1000)}s 后重试`,
                'warn',
              );
            } else {
              pushError('quota', `${key}：拉取失败（${res.reason ?? 'unknown'}）`, 'warn');
              this.penalise(key);
            }
            return;
          }
          this.authError[key] = false;
          this.cache = null;
          const v = res.data;
          const at = Date.now();
          this.live[key] = { ...v, at };
          this.lastSuccessAt[key] = at;
          this.backoff[key] = 0;
          if (key === 'claude' && v.primary.resetMs > 0) {
            this.lastLiveClaude = this.live.claude;
            // 记下锚点：这次的百分比 ↔ 当时 block 里已有多少 token
            const blockStart = v.primary.resetMs - 5 * 3600 * 1000;
            const currentBlockTokens = this.blockTokensCached(blockStart, at);
            this.claudeAnchor = {
              pct: v.primary.pct,
              blockStart,
              tokens: currentBlockTokens,
            };
            if (v.primary.pct > 0 && currentBlockTokens > 0) {
              this.tokensPerPct = currentBlockTokens / v.primary.pct;
            }
            saveClaudeState(this.live.claude!, this.claudeAnchor, this.tokensPerPct ?? undefined);
          }
        } else {
          this.authError[key] = false;
          this.cache = null;
          const v = res;
          const at = Date.now();
          this.live[key] = { ...v, at };
          this.lastSuccessAt[key] = at;
          this.backoff[key] = 0;
        }
      })
      .catch((err) => {
        pushError('quota', `${key}：拉取异常 ${err?.message ?? err}`);
        this.penalise(key);
      })
      .finally(() => {
        this.fetching[key] = false;
      });
  }

  /** 拉失败（多半是被限流）→ 指数退避，别继续砸接口 */
  private penalise(key: LiveKey): void {
    const base = this.intervalFor(key, this.live[key]);
    this.backoff[key] = Math.min(this.backoff[key] ? this.backoff[key] * 2 : base, this.BACKOFF_MAX_MS);
    this.nextTry[key] = Date.now() + this.backoff[key];
  }

  /** 窗口的 reset 时间已经过去 → 额度已重置，不管这条读数多旧 */
  private expire(w: WindowState, now: number): WindowState {
    return w.resetMs > 0 && w.resetMs <= now ? { pct: 0, resetMs: 0 } : w;
  }

  private fromLive(key: LiveKey, name: string, live: LiveQuota, now: number, pct5hOverride?: number): AgentQuota {
    const w5h = this.expire(live.primary, now);
    const w7d = this.expire(live.secondary, now);
    const pct5h = pct5hOverride ?? w5h.pct;
    return {
      name,
      resetText: w5h.resetMs > 0 ? formatCountdown(w5h.resetMs - now, w5h.resetMs) : 'ready',
      // w7d 就在上面，三家共用这一条 fromLive 路径，加一行全覆盖
      reset7dText: w7d.resetMs > 0 ? formatLongCountdown(w7d.resetMs - now) : 'ready',
      pct5h,
      pct7d: w7d.pct,
      level5h: getLevel(pct5h),
      level7d: getLevel(w7d.pct),
      used5h: pct5h,
      limit5h: 100,
      used7d: w7d.pct,
      limit7d: 100,
      unit: 'percent',
      // 拉不到新数据太久就别再声称是真值 —— 外推能补 5h，补不了 7d
      authoritative: now - live.at < this.staleAfter(key),
    };
  }

  /**
   * 用本地 token 增量把锚点的百分比外推到现在。
   * P(t) = P_anchor × blockTokens(t) / blockTokens(t_anchor)
   * 实测：锚点 51%，外推 60.0%，服务端真值 60%。
   */
  private extrapolateClaude5h(live: LiveQuota, now: number): number | undefined {
    const a = this.claudeAnchor;
    if (!a || a.tokens <= 0) return undefined;
    // block 滚过去了，锚点作废，等下一次成功读数
    if (live.primary.resetMs <= now || a.blockStart !== live.primary.resetMs - 5 * 3600 * 1000) {
      return undefined;
    }
    const nowTokens = this.blockTokensCached(a.blockStart, now);
    if (nowTokens < a.tokens) return undefined; // 日志被清过之类，别乱推
    return Math.min(100, Math.max(0, Math.round((a.pct * nowTokens) / a.tokens)));
  }

  private collectCodexQuota(now: number): AgentQuota {
    const live = this.live.codex;
    if (live) return this.fromLive('codex', 'Codex', live, now);

    // 兜底：读本地 rollout 日志（可能过期好几小时，且看不到网页版/别的机器的用量）
    const rl = findLatestCodexRateLimits();
    const fromLog = (w?: CodexWindow): WindowState =>
      w
        ? this.expire(
            { pct: Math.min(100, Math.max(0, Math.round(w.used_percent))), resetMs: w.resets_at * 1000 },
            now
          )
        : { pct: 0, resetMs: 0 };
    const w5h = fromLog(rl?.primary);
    const w7d = fromLog(rl?.secondary);

    return {
      name: 'Codex',
      resetText: w5h.resetMs > 0 ? formatCountdown(w5h.resetMs - now, w5h.resetMs) : 'ready',
      reset7dText: null,
      pct5h: w5h.pct,
      pct7d: w7d.pct,
      level5h: getLevel(w5h.pct),
      level7d: getLevel(w7d.pct),
      used5h: w5h.pct,
      limit5h: 100,
      used7d: w7d.pct,
      limit7d: 100,
      unit: 'percent',
      authoritative: false,
    };
  }

  private collectAntigravityQuota(now: number): AgentQuota {
    const live = this.live.antigravity;
    if (live) return this.fromLive('antigravity', 'Antigravity', live, now);

    // 兜底：数 transcript 行数除以猜的上限，数字不可信
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const fiveHoursAgo = now - 5 * 3600 * 1000;
    const sevenDaysAgo = now - 7 * 86400 * 1000;

    let steps5h = 0;
    let steps7d = 0;
    let earliest5hTs: number | null = null;

    if (fs.existsSync(brainDir)) {
      try {
        const cids = fs.readdirSync(brainDir);
        for (const cid of cids) {
          const transPath = path.join(brainDir, cid, '.system_generated', 'logs', 'transcript.jsonl');
          if (!fs.existsSync(transPath)) continue;

          try {
            const stat = fs.statSync(transPath);
            if (stat.mtimeMs < sevenDaysAgo) continue;

            const content = fs.readFileSync(transPath, 'utf-8');
            const lines = content.split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                const ts = new Date(entry.created_at).getTime();
                if (isNaN(ts) || ts < sevenDaysAgo) continue;

                steps7d++;
                if (ts >= fiveHoursAgo) {
                  steps5h++;
                  if (earliest5hTs === null || ts < earliest5hTs) {
                    earliest5hTs = ts;
                  }
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }

    const { limit5h, limit7d } = this.limits.antigravity;
    const pct5h = Math.min(100, Math.max(0, Math.round((steps5h / limit5h) * 100)));
    const pct7d = Math.min(100, Math.max(0, Math.round((steps7d / limit7d) * 100)));

    let resetText = '5h';
    if (earliest5hTs !== null && steps5h > 0) {
      const resetAt = earliest5hTs + 5 * 3600 * 1000;
      resetText = formatCountdown(resetAt - now, resetAt);
    } else {
      resetText = 'ready';
    }

    return {
      name: 'Antigravity',
      resetText,
      reset7dText: null,
      pct5h,
      pct7d,
      level5h: getLevel(pct5h),
      level7d: getLevel(pct7d),
      used5h: steps5h,
      limit5h,
      used7d: steps7d,
      limit7d,
      unit: 'steps',
      authoritative: false,
    };
  }
}
