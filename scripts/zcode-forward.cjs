#!/usr/bin/env node
// ZCode hook -> Pulse 转发脚本
// 用法: node zcode-forward.cjs <事件名>，hook 的 stdin JSON 原样透传给 Pulse。
// Pulse 未运行时静默退出，绝不阻塞 ZCode。
const http = require('node:http');
const fs = require('node:fs');

// 调试追踪：记录每次被调用的时机与事件（排查 Stop 是否触发用，查完可删）
function trace(args) {
  try {
    fs.appendFileSync('/tmp/zcode-forward.log', `${new Date().toISOString()} ARGS=${JSON.stringify(args)} CWD=${process.cwd()} CLAUDE_SESSION_ID=${process.env.CLAUDE_SESSION_ID || ''}\n`);
  } catch {}
}

let input = '';
const eventArg = process.argv[2];
trace(process.argv.slice(2));

const sendEvent = (payload) => {
  const data = JSON.stringify(payload);
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: 41789,
      path: '/events',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 500,
    },
    (res) => {
      res.resume();
      process.exit(0);
    }
  );

  req.on('error', () => process.exit(0));
  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });

  req.write(data);
  req.end();
};

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  let payload = {};
  if (input.trim()) {
    try {
      payload = JSON.parse(input);
    } catch {
      payload = { raw: input };
    }
  }

  if (eventArg && !payload.hook_event_name) {
    payload.hook_event_name = eventArg;
  }
  // ZCode 必须拥有独立 agent 身份，不能再覆盖 Claude 卡片的完成态。
  payload.agent = 'zcode';
  if (!payload.cwd) {
    payload.cwd = process.cwd();
  }
  if (!payload.session_id && process.env.CLAUDE_SESSION_ID) {
    payload.session_id = process.env.CLAUDE_SESSION_ID;
  }

  sendEvent(payload);
});

// stdin 卡住时兜底退出
setTimeout(() => {
  process.exit(0);
}, 800);
