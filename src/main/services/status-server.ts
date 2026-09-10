import http from 'node:http';
import type { SessionManager } from './session-manager';
import { QuotaCollector } from './quota-collector';

export class StatusServer {
  private server: http.Server | null = null;
  private sessionManager: SessionManager;
  private quotaCollector: QuotaCollector;
  private port: number;

  constructor(sessionManager: SessionManager, port = 8765) {
    this.sessionManager = sessionManager;
    this.quotaCollector = new QuotaCollector();
    this.port = port;
  }

  /** 迷你悬浮窗等进程内消费者读额度快照（复用同一 QuotaCollector，带缓存） */
  public getQuotas() {
    return this.quotaCollector.getQuotas();
  }

  public start() {
    this.server = http.createServer((req, res) => {
      // Add CORS headers for QuickApp / local fetch
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (/^\/(api\/)?status\/compact(\?|$)/.test(req.url || '')) {
        const params = new URLSearchParams((req.url || '').split('?')[1] || '');

        // 多屏模式：?all=1 一次返回每个独立 agent 的 session + limits。
        // 砍掉 serverIp / session.agent / active（手环侧要么本来知道、要么一眼可见），
        // currentTool.name 拍平成 tool 并截 24 字符。旧的 ?agent= 路径一个字节不动，
        // 设备上还跑着 1.2.4，随时要能回退。
        if (params.get('all') === '1') {
          const allSessions = this.sessionManager.getAllSessions();
          const allQuotas = this.quotaCollector.getQuotas();
          const leanSession = (agent: string) => {
            const s = allSessions.find((x) => x.agent === agent);
            if (!s) return { status: null, tool: null };
            const toolName =
              s.currentTool && s.currentTool.name
                ? String(s.currentTool.name).slice(0, 24)
                : null;
            return { status: s.status || null, tool: toolName };
          };
          // 手环卡片右上角只有 80px 宽（V4 装机反馈：'1h 22min · 16:40' 会被屏幕裁掉
          // 「· 具体时间」部分），只保留时长段；网页仪表盘 /api/status 仍用完整格式
          const shortReset = (t: string | null) => (t ? String(t).split(' · ')[0] : null);
          const leanLimit = (q: any) =>
            q
              ? {
                  pct5h: q.pct5h,
                  pct7d: q.pct7d,
                  level5h: q.level5h,
                  level7d: q.level7d,
                  resetText: shortReset(q.resetText),
                  reset7dText: shortReset(q.reset7dText),
                  authoritative: q.authoritative,
                }
              : null;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              ts: Date.now(),
              sessions: {
                claude: leanSession('claude'),
                codex: leanSession('codex'),
                antigravity: leanSession('antigravity'),
                opencode: leanSession('opencode'),
                zcode: leanSession('zcode'),
              },
              limits: {
                claude: leanLimit(allQuotas.claude),
                codex: leanLimit(allQuotas.codex),
                antigravity: leanLimit(allQuotas.antigravity),
                opencode: null,
                zcode: null,
              },
            })
          );
          return;
        }

        // 手环点名要哪个 agent（?agent=claude）。不点名时沿用「谁在跑显示谁」。
        // 点名的好处：报文不用塞三份 session（会撑爆 768 字节单帧上限），
        // 而且 hero 不再随 running_tool 在 Claude/Codex 之间来回跳。
        const wantAgent = params.get('agent');
        const sessions = this.sessionManager.getAllSessions();
        const active = wantAgent
          ? sessions.find((s) => s.agent === wantAgent)
          : sessions.find((s) => s.status === 'running_tool') ||
            sessions.find((s) => s.status === 'thinking') ||
            sessions[0];
        const quotas = this.quotaCollector.getQuotas();

        const compactLimit = (q: any) => {
          if (!q) return null;
          const res: any = {
            pct5h: q.pct5h,
            pct7d: q.pct7d,
            level5h: q.level5h,
            level7d: q.level7d,
            resetText: q.resetText,
            authoritative: q.authoritative,
          };
          if (q.needsAuth) {
            res.needsAuth = true;
          }
          return res;
        };

        const compactSession = active
          ? {
              agent: active.agent,
              status: active.status,
              currentTool: active.currentTool ? { name: active.currentTool.name } : null,
              // lastMessage 不再下发：手环上显示的是「动词 · 对象」，
              // 由 status + currentTool 派生。lastMessage 是英文工具日志，
              // 给我自己看的，在 192px 屏上读不完也记不住。省 ~60 字节。
            }
          : null;

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            active: !!active,
            // 手环的 Date.now() 不是真 UTC（实测偏 +5h29m），墙上时间只能由这里给
            ts: Date.now(),
            session: compactSession,
            limits: {
              claude: compactLimit(quotas.claude),
              codex: compactLimit(quotas.codex),
              antigravity: compactLimit(quotas.antigravity),
            },
          })
        );
        return;
      }

      if (req.url === '/status' || req.url === '/api/status') {
        const sessions = this.sessionManager.getAllSessions();
        const active =
          sessions.find((s) => s.status === 'running_tool') ||
          sessions.find((s) => s.status === 'thinking') ||
          sessions[0];
        const quotas = this.quotaCollector.getQuotas();

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            active: !!active,
            serverIp: '127.0.0.1',
            serverPort: this.port,
            timestamp: Date.now(),
            session: active
              ? {
                  id: active.id,
                  agent: active.agent,
                  title: active.title,
                  cwd: active.cwd,
                  status: active.status,
                  durationSeconds: active.durationSeconds,
                  lastMessage: active.lastMessage,
                  currentTool: active.currentTool,
                  error: active.error,
                }
              : null,
            limits: quotas,
            // 阶段 5 诊断屏：每源最后成功拉取时间 + 429 退避到期时间（手环走的 /compact 不带，报文不加重）
            quotaMeta: this.quotaCollector.getQuotaMeta(),
          })
        );
        return;
      }

      if (req.url === '/preview' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.getPreviewHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[StatusServer] Local band API listening on http://127.0.0.1:${this.port}/status`);
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private getPreviewHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>小米手环 10 · AI 状态监控 (V3.2 旗舰视觉调优台)</title>
  <link rel="stylesheet" href="https://fonts.cdnfonts.com/css/sf-pro-display" />
  <style>
    :root {
      --screen-pad-top: 54px;
      --screen-pad-bottom: 27px;
      --screen-pad-x: 18px;

      --hero-margin-bottom: 30px;
      --hero-title-size: 16px;
      --hero-timer-size: 32px;
      --hero-status-size: 12px;

      --sep-margin-bottom: 14px;

      --limits-gap: 13px;
      --agent-name-size: 14px;
      --agent-reset-size: 10px;
      --limit-tag-size: 13px;
      --limit-pct-size: 12px;
      --bar-height: 3.5px;
      --row-gap: 5px;

      --bottom-date-size: 13px;
      --bottom-time-size: 30px;
      --bottom-float: 42px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body {
      background: #09090b;
      color: #f5f5f7;
      font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .studio-layout {
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      justify-content: center;
      gap: 40px;
      max-width: 1080px;
      width: 100%;
    }

    /* Left: Xiaomi Band Case */
    .band-preview-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      position: sticky;
      top: 24px;
    }

    .band-case {
      width: 252px;
      height: 610px;
      background: #000000;
      border: 6px solid #1c1c1f;
      border-radius: 126px;
      box-shadow: 0 40px 90px -15px rgba(0,0,0,0.95), 0 0 0 1px #27272a;
      padding: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .band-screen {
      width: 224px;
      height: 570px;
      background: #000000;
      border-radius: 112px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-top: var(--screen-pad-top);
      padding-bottom: var(--screen-pad-bottom);
      padding-left: var(--screen-pad-x);
      padding-right: var(--screen-pad-x);
      position: relative;
      transition: all 0.15s ease;
    }

    /* 1. Hero Widget */
    .hero-widget {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 100%;
      margin-bottom: var(--hero-margin-bottom);
      cursor: pointer;
      border-radius: 8px;
      transition: outline 0.15s ease;
    }
    .hero-widget:hover {
      outline: 1px dashed rgba(90, 200, 250, 0.4);
    }

    .hero-agent-line {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 5px;
    }

    .agent-title {
      font-size: var(--hero-title-size);
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.2px;
      line-height: 1.1;
    }

    .hero-badge-mini {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      background: #d97757;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .hero-timer-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 4px;
    }

    .metric-giant {
      font-size: var(--hero-timer-size);
      font-weight: 700;
      color: #5ac8fa;
      letter-spacing: -0.6px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      text-shadow: 0 0 12px rgba(90, 200, 250, 0.35);
    }

    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #30d158;
      box-shadow: 0 0 8px #30d158;
      animation: pulseDot 2s ease-in-out infinite;
    }
    @keyframes pulseDot {
      0%, 100% { opacity: 0.4; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.2); }
    }

    .status-subtext {
      font-size: var(--hero-status-size);
      font-weight: 500;
      color: #8e8e93;
      letter-spacing: -0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 184px;
      text-align: center;
    }

    /* 2. Hairline Divider */
    .hairline-sep {
      width: 100%;
      height: 1px;
      background: rgba(255, 255, 255, 0.08);
      margin-bottom: var(--sep-margin-bottom);
    }

    /* 3. Agent Limits Dashboard */
    .limits-dashboard {
      display: flex;
      flex-direction: column;
      width: 100%;
      gap: var(--limits-gap);
      cursor: pointer;
      border-radius: 8px;
      transition: outline 0.15s ease;
    }
    .limits-dashboard:hover {
      outline: 1px dashed rgba(90, 200, 250, 0.4);
    }

    .agent-limit-block {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .agent-limit-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      width: 100%;
      margin-bottom: 4px;
    }

    .agent-name {
      font-size: var(--agent-name-size);
      font-weight: 600;
      color: #ffffff;
      letter-spacing: -0.2px;
    }

    .agent-reset {
      font-size: var(--agent-reset-size);
      font-weight: 500;
      color: #8e8e93;
      letter-spacing: 0.2px;
    }

    .limit-bar-row {
      display: flex;
      flex-direction: column;
      width: 100%;
      margin-bottom: var(--row-gap);
    }

    .limit-meta-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      width: 100%;
      margin-bottom: 3px;
    }

    .limit-tag {
      font-size: var(--limit-tag-size);
      font-weight: 600;
      color: #8e8e93;
      text-transform: lowercase;
    }

    .limit-pct {
      font-size: var(--limit-pct-size);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }

    .bar-track {
      width: 100%;
      height: var(--bar-height);
      background: #1c1c1e;
      border-radius: 9999px;
      overflow: hidden;
      position: relative;
    }

    .bar-fill {
      height: 100%;
      border-radius: 9999px;
    }

    /* Resource Alert Colors */
    .theme-normal { color: #30d158; }
    .fill-normal {
      background: #30d158;
      box-shadow: 0 0 4px rgba(48, 209, 88, 0.4);
    }

    .theme-warn { color: #ffcc00; }
    .fill-warn {
      background: #ffcc00;
      box-shadow: 0 0 4px rgba(255, 204, 0, 0.4);
    }

    .theme-danger { color: #ff453a; }
    .fill-danger {
      background: #ff453a;
      box-shadow: 0 0 4px rgba(255, 69, 58, 0.4);
    }

    /* 4. Bottom Time Anchor (完全恢复V3.2经典极简高级排版，默认上浮42px填补留白) */
    .bottom-time-anchor {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-bottom: 2px;
      cursor: pointer;
      border-radius: 8px;
      transform: translateY(calc(-1 * var(--bottom-float, 42px)));
      transition: transform 0.15s ease, filter 0.15s ease;
    }
    .bottom-time-anchor:hover {
      filter: drop-shadow(0 0 8px rgba(90, 200, 250, 0.5));
    }
    .anchor-top {
      margin-top: 0 !important;
      margin-bottom: 14px !important;
      transform: translateY(0) !important;
    }

    .bottom-date {
      font-size: var(--bottom-date-size);
      font-weight: 600;
      color: #8e8e93;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      margin-bottom: 2px;
      line-height: 1.2;
    }

    .bottom-time {
      font-size: var(--bottom-time-size);
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.8px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }

    /* Right: Control Studio Panel */
    .editor-panel {
      flex: 1;
      max-width: 480px;
      background: #121215;
      border: 1px solid #27272a;
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 20px 40px -10px rgba(0,0,0,0.7);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .editor-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #27272a;
      padding-bottom: 14px;
    }

    .editor-title {
      font-size: 16px;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .editor-actions {
      display: flex;
      gap: 8px;
    }

    .btn-action {
      background: #27272a;
      color: #f5f5f7;
      border: none;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .btn-action:hover {
      background: #3f3f46;
      color: #ffffff;
    }
    .btn-primary {
      background: #5ac8fa;
      color: #000000;
    }
    .btn-primary:hover {
      background: #7ad5fc;
    }

    .control-group {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 700;
      color: #a1a1aa;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .reorder-btns {
      display: flex;
      gap: 4px;
    }
    .btn-mini {
      background: #27272a;
      border: none;
      color: #d4d4d8;
      border-radius: 4px;
      padding: 3px 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-mini:hover {
      background: #5ac8fa;
      color: #000000;
    }

    .control-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .control-label-line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #d4d4d8;
    }

    .control-val-tag {
      font-size: 12px;
      font-weight: 600;
      color: #5ac8fa;
      font-variant-numeric: tabular-nums;
    }

    .slider-input {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      border-radius: 2px;
      background: #27272a;
      outline: none;
      transition: background 0.2s;
    }
    .slider-input::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #5ac8fa;
      cursor: pointer;
      box-shadow: 0 0 6px rgba(90, 200, 250, 0.5);
      transition: transform 0.1s ease;
    }
    .slider-input::-webkit-slider-thumb:hover {
      transform: scale(1.2);
    }

    .toast-msg {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #30d158;
      color: #000000;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 9999px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.6);
      opacity: 0;
      pointer-events: none;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 1000;
    }
    .toast-msg.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  </style>
</head>
<body>
  <div class="studio-layout">
    <!-- Left: Xiaomi Band Case (原汁原味 V3.2 质感呈现) -->
    <div class="band-preview-col">
      <div class="band-case">
        <div id="bandScreen" class="band-screen">
          <!-- 1. Hero Widget -->
          <div id="heroBlock" class="hero-widget" onclick="selectGroup('group-hero')">
            <div class="hero-agent-line">
              <div id="heroSquircle" class="hero-badge-mini">
                <svg width="9" height="9" viewBox="0 0 24 24" fill="#ffffff">
                  <path d="M12 2.5a.75.75 0 0 1 .75.75v3.1a.75.75 0 0 1-1.5 0V3.25A.75.75 0 0 1 12 2.5zm-5.3 1.95a.75.75 0 0 1 1.06 0l2.2 2.2a.75.75 0 1 1-1.06 1.06l-2.2-2.2a.75.75 0 0 1 0-1.06zm10.6 0a.75.75 0 0 1 0 1.06l-2.2 2.2a.75.75 0 1 1-1.06-1.06l2.2-2.2a.75.75 0 0 1 1.06 0zM2.5 12a.75.75 0 0 1 .75-.75h3.1a.75.75 0 0 1 0 1.5h-3.1A.75.75 0 0 1 2.5 12zm15.15 0a.75.75 0 0 1 .75-.75h3.1a.75.75 0 0 1 0 1.5h-3.1a.75.75 0 0 1-.75-.75zm-11.9 5.3a.75.75 0 0 1 1.06 0l2.2 2.2a.75.75 0 0 1-1.06 1.06l-2.2-2.2a.75.75 0 0 1 0-1.06zm10.6 0a.75.75 0 0 1 0 1.06l-2.2 2.2a.75.75 0 0 1-1.06-1.06l2.2-2.2a.75.75 0 0 1 1.06 0zM12 17.65a.75.75 0 0 1 .75.75v3.1a.75.75 0 0 1-1.5 0v-3.1a.75.75 0 0 1 .75-.75zM12 7.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6z"/>
                </svg>
              </div>
              <span id="heroAgentName" class="agent-title">Claude</span>
            </div>

            <div class="hero-timer-row">
              <span id="heroMetricText" class="metric-giant">02:55</span>
              <div class="pulse-dot"></div>
            </div>

            <div id="heroSubText" class="status-subtext">Running</div>
          </div>

          <!-- 2. 发丝分割线 -->
          <div id="sepBlock" class="hairline-sep"></div>

          <!-- 3. Limits Dashboard (Claude, Codex, Antigravity 2行全宽大盘) -->
          <div id="limitsBlock" class="limits-dashboard" onclick="selectGroup('group-limits')">
            <!-- Claude Block -->
            <div class="agent-limit-block">
              <div class="agent-limit-header">
                <span class="agent-name">Claude</span>
                <span id="claudeReset" class="agent-reset">resets 2h</span>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">5h</span>
                  <span id="claude5hPct" class="limit-pct theme-normal">62%</span>
                </div>
                <div class="bar-track">
                  <div id="claude5hBar" class="bar-fill fill-normal" style="width: 62%;"></div>
                </div>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">7d</span>
                  <span id="claude7dPct" class="limit-pct theme-normal">38%</span>
                </div>
                <div class="bar-track">
                  <div id="claude7dBar" class="bar-fill fill-normal" style="width: 38%;"></div>
                </div>
              </div>
            </div>

            <!-- Codex Block -->
            <div class="agent-limit-block">
              <div class="agent-limit-header">
                <span class="agent-name">Codex</span>
                <span id="codexReset" class="agent-reset">resets 4h</span>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">5h</span>
                  <span id="codex5hPct" class="limit-pct theme-warn">85%</span>
                </div>
                <div class="bar-track">
                  <div id="codex5hBar" class="bar-fill fill-warn" style="width: 85%;"></div>
                </div>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">7d</span>
                  <span id="codex7dPct" class="limit-pct theme-normal">42%</span>
                </div>
                <div class="bar-track">
                  <div id="codex7dBar" class="bar-fill fill-normal" style="width: 42%;"></div>
                </div>
              </div>
            </div>

            <!-- Antigravity Block -->
            <div class="agent-limit-block">
              <div class="agent-limit-header">
                <span class="agent-name">Antigravity</span>
                <span id="antigravityReset" class="agent-reset">resets 35m</span>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">5h</span>
                  <span id="antigravity5hPct" class="limit-pct theme-normal">20%</span>
                </div>
                <div class="bar-track">
                  <div id="antigravity5hBar" class="bar-fill fill-normal" style="width: 20%;"></div>
                </div>
              </div>
              <div class="limit-bar-row">
                <div class="limit-meta-line">
                  <span class="limit-tag">7d</span>
                  <span id="antigravity7dPct" class="limit-pct theme-warn">80%</span>
                </div>
                <div class="bar-track">
                  <div id="antigravity7dBar" class="bar-fill fill-warn" style="width: 80%;"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 4. 底部日期与时间 (经典原版底置锚定，纯净无遮挡) -->
          <div id="bottomBlock" class="bottom-time-anchor" onclick="selectGroup('group-bottom')">
            <div id="digitalDate" class="bottom-date">THU, SEP 3</div>
            <div id="digitalClock" class="bottom-time">23:59</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Right: Studio Visual Controls Panel -->
    <div class="editor-panel">
      <div class="editor-header">
        <div class="editor-title">
          <span>🎛️ 手环视觉排版调优台</span>
        </div>
        <div class="editor-actions">
          <button class="btn-action" onclick="resetDefaults()">🔄 重置</button>
          <button class="btn-action btn-primary" onclick="copyConfig()">📋 复制给 AI</button>
        </div>
      </div>

      <!-- Group 1: 屏幕边距 (Padding) -->
      <div id="group-screen" class="control-group">
        <div class="group-header">
          <span>📱 屏幕留白边距 (Padding)</span>
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>顶部边距 (Padding Top)</span>
            <span id="val_screen-pad-top" class="control-val-tag">54px</span>
          </div>
          <input id="slider_screen-pad-top" type="range" class="slider-input" min="10" max="60" value="54" oninput="updateVar('screen-pad-top', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>底部边距 (Padding Bottom)</span>
            <span id="val_screen-pad-bottom" class="control-val-tag">27px</span>
          </div>
          <input id="slider_screen-pad-bottom" type="range" class="slider-input" min="8" max="60" value="27" oninput="updateVar('screen-pad-bottom', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>两侧安全边距 (Padding X)</span>
            <span id="val_screen-pad-x" class="control-val-tag">18px</span>
          </div>
          <input id="slider_screen-pad-x" type="range" class="slider-input" min="10" max="30" value="18" oninput="updateVar('screen-pad-x', this.value, 'px')">
        </div>
      </div>

      <!-- Group 2: Hero 当前任务 -->
      <div id="group-hero" class="control-group">
        <div class="group-header">
          <span>⚡ Hero 任务区</span>
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>计时数字大小 (02:55)</span>
            <span id="val_hero-timer-size" class="control-val-tag">32px</span>
          </div>
          <input id="slider_hero-timer-size" type="range" class="slider-input" min="20" max="44" value="32" oninput="updateVar('hero-timer-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>Agent 标题字号 (Claude)</span>
            <span id="val_hero-title-size" class="control-val-tag">16px</span>
          </div>
          <input id="slider_hero-title-size" type="range" class="slider-input" min="12" max="22" value="16" oninput="updateVar('hero-title-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>状态副标题字号 (Running)</span>
            <span id="val_hero-status-size" class="control-val-tag">12px</span>
          </div>
          <input id="slider_hero-status-size" type="range" class="slider-input" min="9" max="16" value="12" oninput="updateVar('hero-status-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>Hero 底部留白 (Margin Bottom)</span>
            <span id="val_hero-margin-bottom" class="control-val-tag">30px</span>
          </div>
          <input id="slider_hero-margin-bottom" type="range" class="slider-input" min="4" max="30" value="30" oninput="updateVar('hero-margin-bottom', this.value, 'px')">
        </div>
      </div>

      <!-- Group 3: Limits 配额大盘 -->
      <div id="group-limits" class="control-group">
        <div class="group-header">
          <span>📊 配额大盘 (Limits)</span>
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>三个 Agent 间距 (Gap)</span>
            <span id="val_limits-gap" class="control-val-tag">13px</span>
          </div>
          <input id="slider_limits-gap" type="range" class="slider-input" min="4" max="26" value="13" oninput="updateVar('limits-gap', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>发丝能量条厚度 (Bar Height)</span>
            <span id="val_bar-height" class="control-val-tag">3.5px</span>
          </div>
          <input id="slider_bar-height" type="range" class="slider-input" min="1.5" max="7" step="0.5" value="3.5" oninput="updateVar('bar-height', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>Agent 名称字号</span>
            <span id="val_agent-name-size" class="control-val-tag">14px</span>
          </div>
          <input id="slider_agent-name-size" type="range" class="slider-input" min="11" max="18" value="14" oninput="updateVar('agent-name-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>限额标签字号 (5h / 7d)</span>
            <span id="val_limit-tag-size" class="control-val-tag">13px</span>
          </div>
          <input id="slider_limit-tag-size" type="range" class="slider-input" min="9" max="15" value="13" oninput="updateVar('limit-tag-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>百分比字号 (62%)</span>
            <span id="val_limit-pct-size" class="control-val-tag">12px</span>
          </div>
          <input id="slider_limit-pct-size" type="range" class="slider-input" min="10" max="17" value="12" oninput="updateVar('limit-pct-size', this.value, 'px')">
        </div>
      </div>

      <!-- Group 4: 底部时间与日期 (可自由调节字号与上浮填充留白) -->
      <div id="group-bottom" class="control-group">
        <div class="group-header">
          <span>⏱️ 底部时间与日期</span>
          <div class="reorder-btns">
            <button class="btn-mini" onclick="setTimePosition('top')">🔝 置顶</button>
            <button class="btn-mini" onclick="setTimePosition('bottom')">⚓ 恢复置底</button>
          </div>
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>时间数字字号 (23:59)</span>
            <span id="val_bottom-time-size" class="control-val-tag">30px</span>
          </div>
          <input id="slider_bottom-time-size" type="range" class="slider-input" min="18" max="44" value="30" oninput="updateVar('bottom-time-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>日期字号 (THU, SEP 3)</span>
            <span id="val_bottom-date-size" class="control-val-tag">13px</span>
          </div>
          <input id="slider_bottom-date-size" type="range" class="slider-input" min="9" max="16" value="13" oninput="updateVar('bottom-date-size', this.value, 'px')">
        </div>
        <div class="control-row">
          <div class="control-label-line">
            <span>垂直上移微调 (往上提/填补留白)</span>
            <span id="val_bottom-float" class="control-val-tag">42px</span>
          </div>
          <input id="slider_bottom-float" type="range" class="slider-input" min="-10" max="80" value="42" oninput="updateVar('bottom-float', this.value, 'px')">
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast-msg">✅ 布局配置已复制！直接粘贴发送给我即可</div>

  <script>
    const currentVars = {
      'screen-pad-top': '54px',
      'screen-pad-bottom': '27px',
      'screen-pad-x': '18px',
      'hero-margin-bottom': '30px',
      'hero-title-size': '16px',
      'hero-timer-size': '32px',
      'hero-status-size': '12px',
      'limits-gap': '13px',
      'bar-height': '3.5px',
      'agent-name-size': '14px',
      'limit-tag-size': '13px',
      'limit-pct-size': '12px',
      'bottom-time-size': '30px',
      'bottom-date-size': '13px',
      'bottom-float': '42px'
    };

    function updateVar(key, val, unit = '') {
      const fullVal = val + unit;
      currentVars[key] = fullVal;
      document.documentElement.style.setProperty('--' + key, fullVal);
      const tag = document.getElementById('val_' + key);
      if (tag) tag.innerText = fullVal;
      const slider = document.getElementById('slider_' + key);
      if (slider && slider.value !== String(val)) slider.value = val;

      // Direct DOM mutation for 100% instant reliability
      if (key === 'bottom-time-size') {
        const el = document.getElementById('digitalClock');
        if (el) el.style.fontSize = fullVal;
      }
      if (key === 'bottom-date-size') {
        const el = document.getElementById('digitalDate');
        if (el) el.style.fontSize = fullVal;
      }
      if (key === 'bottom-float') {
        const el = document.getElementById('bottomBlock');
        if (el) el.style.transform = 'translateY(-' + fullVal + ')';
      }
      if (key === 'hero-timer-size') {
        const el = document.getElementById('heroMetricText');
        if (el) el.style.fontSize = fullVal;
      }
      if (key === 'hero-title-size') {
        const el = document.getElementById('heroAgentName');
        if (el) el.style.fontSize = fullVal;
      }
      if (key === 'hero-status-size') {
        const el = document.getElementById('heroSubText');
        if (el) el.style.fontSize = fullVal;
      }
      if (key === 'limits-gap') {
        const el = document.getElementById('limitsBlock');
        if (el) el.style.gap = fullVal;
      }
      if (key === 'bar-height') {
        document.querySelectorAll('.bar-track, .bar-fill').forEach(bar => bar.style.height = fullVal);
      }
    }

    function setTimePosition(pos) {
      const block = document.getElementById('bottomBlock');
      const screen = document.getElementById('bandScreen');
      if (pos === 'top') {
        block.classList.add('anchor-top');
        screen.insertBefore(block, screen.firstChild);
        showToast('🔝 时间已置顶');
      } else {
        block.classList.remove('anchor-top');
        screen.appendChild(block);
        showToast('⚓ 时间已恢复置底');
      }
    }

    function selectGroup(groupId) {
      document.querySelectorAll('.control-group').forEach(el => el.style.borderColor = '#27272a');
      const target = document.getElementById(groupId);
      if (target) {
        target.style.borderColor = '#5ac8fa';
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    function copyConfig() {
      const screen = document.getElementById('bandScreen');
      const order = Array.from(screen.children).map(c => c.id);
      const text = [
        '### 🎨 我的手环视觉排版定制参数：',
        '\`\`\`json',
        JSON.stringify(currentVars, null, 2),
        '\`\`\`',
        '**当前实际排布顺序**: ' + JSON.stringify(order)
      ].join('\\n');

      navigator.clipboard.writeText(text).then(() => {
        showToast('✅ 布局配置已复制！直接粘贴在对话框发送即可');
      });
    }

    function resetDefaults() {
      location.reload();
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function updateClock() {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      document.getElementById('digitalClock').innerText = h + ':' + m;

      const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const dateEl = document.getElementById('digitalDate');
      if (dateEl) {
        dateEl.innerText = days[now.getDay()] + ', ' + months[now.getMonth()] + ' ' + now.getDate();
      }
    }
    setInterval(updateClock, 1000);
    updateClock();

    function formatSecs(s) {
      const m = Math.floor(s / 60).toString().padStart(2, '0');
      const sec = (s % 60).toString().padStart(2, '0');
      return m + ':' + sec;
    }

    async function poll() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        render(data);
      } catch (err) {}
    }

    function render(data) {
      const heroAgentName = document.getElementById('heroAgentName');
      const heroMetric = document.getElementById('heroMetricText');
      const heroSubText = document.getElementById('heroSubText');

      if (!data.active || !data.session) {
        heroAgentName.innerText = 'Claude';
        heroMetric.innerText = '02:55';
        heroSubText.innerText = 'Standby';
      } else {
        const s = data.session;
        const status = s.status;
        const duration = s.durationSeconds || 0;

        if (s.agent === 'claude') {
          heroAgentName.innerText = 'Claude';
        } else {
          heroAgentName.innerText = 'Codex';
        }

        if (status === 'thinking') {
          heroMetric.innerText = formatSecs(duration);
          heroSubText.innerText = s.lastMessage ? s.lastMessage.substring(0, 16) : 'Thinking...';
        } else if (status === 'running_tool') {
          heroMetric.innerText = formatSecs(duration);
          const toolName = s.currentTool?.name || 'Process';
          heroSubText.innerText = '> ' + toolName;
        } else if (status === 'completed') {
          heroMetric.innerText = '00:00';
          heroSubText.innerText = 'Completed (' + formatSecs(duration) + ')';
        }
      }

      if (data.limits) {
        const updateAgent = (key, prefix) => {
          const q = data.limits[key];
          if (!q) return;
          const r = document.getElementById(prefix + 'Reset');
          if (r) r.innerText = q.resetText;

          const p5 = document.getElementById(prefix + '5hPct');
          const b5 = document.getElementById(prefix + '5hBar');
          if (p5) {
            p5.innerText = q.pct5h + '%';
            p5.className = 'limit-pct theme-' + q.level5h;
          }
          if (b5) {
            b5.style.width = q.pct5h + '%';
            b5.className = 'bar-fill fill-' + q.level5h;
          }

          const p7 = document.getElementById(prefix + '7dPct');
          const b7 = document.getElementById(prefix + '7dBar');
          if (p7) {
            p7.innerText = q.pct7d + '%';
            p7.className = 'limit-pct theme-' + q.level7d;
          }
          if (b7) {
            b7.style.width = q.pct7d + '%';
            b7.className = 'bar-fill fill-' + q.level7d;
          }
        };

        updateAgent('claude', 'claude');
        updateAgent('codex', 'codex');
        updateAgent('antigravity', 'antigravity');
      }
    }

    setInterval(poll, 1500);
    poll();
  </script>
</body>
</html>`;
  }
}
