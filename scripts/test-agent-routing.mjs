import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentKind, resolveSessionId } from '../src/main/services/claude-hook-server.ts';

test('routes supported hook agents to independent cards', () => {
  assert.equal(resolveAgentKind({ agent: 'opencode' }), 'opencode');
  assert.equal(resolveAgentKind({ agent: 'zcode' }), 'zcode');
  assert.equal(resolveAgentKind({ agent: 'claude' }), 'claude');
  assert.equal(resolveAgentKind({}), 'claude');
  assert.equal(resolveAgentKind({ agent: 'unknown' }), 'claude');
});

test('uses the explicit session id instead of sharing a fallback card', () => {
  assert.equal(resolveSessionId({ session_id: 'ses_opencode_1' }, 'opencode'), 'ses_opencode_1');
  assert.equal(resolveSessionId({}, 'opencode'), 'opencode-session');
  assert.equal(resolveSessionId({}, 'zcode'), 'zcode-session');
  assert.equal(resolveSessionId({}, 'claude'), 'claude-session');
});
