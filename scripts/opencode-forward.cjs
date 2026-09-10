/**
 * Pulse 转发插件（OpenCode -> Pulse）。
 *
 * 安装：复制本文件到 ~/.config/opencode/plugins/pulse-forward.js，并确保该目录
 * 使用 CommonJS（package.json 包含 { "type": "commonjs" }）。修改后需重启 OpenCode。
 */
const http = require('node:http');

const PULSE_HOST = '127.0.0.1';
const PULSE_PORT = 41789;

let currentSessionId = null;
let currentCwd = null;

function sendEvent(payload) {
  try {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: PULSE_HOST,
        port: PULSE_PORT,
        path: '/events',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 500,
      },
      (res) => res.resume(),
    );
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch {
    // Pulse 未运行时静默失败，不阻塞 OpenCode。
  }
}

const pulseServer = async ({ directory } = {}) => {
  if (directory) currentCwd = directory;

  return {
    event: async ({ event }) => {
      const type = event.type;
      const eventSessionId =
        event.properties?.sessionID ||
        event.properties?.info?.id ||
        event.sessionID ||
        event.session_id ||
        currentSessionId;

      if (type === 'session.created') {
        const info = event.properties?.info;
        currentSessionId = eventSessionId || 'opencode';
        currentCwd = info?.directory || currentCwd;
        sendEvent({
          agent: 'opencode',
          hook_event_name: 'SessionStart',
          session_id: currentSessionId,
          cwd: currentCwd,
        });
      } else if (type === 'session.status' && event.properties?.status?.type === 'busy') {
        currentSessionId = eventSessionId || currentSessionId || 'opencode';
        sendEvent({
          agent: 'opencode',
          hook_event_name: 'UserPromptSubmit',
          session_id: currentSessionId,
          cwd: currentCwd,
        });
      } else if (type === 'session.idle') {
        if (eventSessionId) {
          sendEvent({
            agent: 'opencode',
            hook_event_name: 'Stop',
            session_id: eventSessionId,
            cwd: currentCwd,
          });
        }
      } else if (type === 'session.error') {
        if (eventSessionId) {
          sendEvent({
            agent: 'opencode',
            hook_event_name: 'error',
            session_id: eventSessionId,
            cwd: currentCwd,
            error: event.properties?.error?.message || event.properties?.message || 'opencode session error',
          });
        }
      }
    },

    'tool.execute.before': async (input, output) => {
      const sessionId = input.sessionID || currentSessionId || 'opencode';
      sendEvent({
        agent: 'opencode',
        hook_event_name: 'PreToolUse',
        session_id: sessionId,
        cwd: currentCwd,
        tool_name: input.tool || 'tool',
        tool_input: output.args || {},
      });
    },

    'tool.execute.after': async (input) => {
      const sessionId = input.sessionID || currentSessionId || 'opencode';
      sendEvent({
        agent: 'opencode',
        hook_event_name: 'PostToolUse',
        session_id: sessionId,
        cwd: currentCwd,
      });
    },
  };
};

// 非枚举 id 避免 CommonJS named-export 探测把它误判成插件入口。
const exportObj = { server: pulseServer };
Object.defineProperty(exportObj, 'id', {
  value: 'pulse-forward',
  enumerable: false,
  writable: false,
  configurable: false,
});
module.exports = exportObj;
