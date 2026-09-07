#!/usr/bin/env node
const http = require('node:http');

let input = '';
const eventArg = process.argv[2];

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

  req.on('error', () => {
    // Non-blocking: quietly exit if CodeIsland is not running
    process.exit(0);
  });

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
  if (!payload.cwd) {
    payload.cwd = process.cwd();
  }

  sendEvent(payload);
});

// Safety timer: if stdin hangs or doesn'\''t close in 800ms, exit
setTimeout(() => {
  process.exit(0);
}, 800);
