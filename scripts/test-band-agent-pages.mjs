import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ux = fs.readFileSync(new URL('../band-app/src/pages/index/index.ux', import.meta.url), 'utf8');
const agents = [
  ['claude', 0],
  ['codex', 1],
  ['antigravity', 2],
  ['opencode', 3],
  ['zcode', 4],
];

test('every agent has a complete, independently bound band page', () => {
  for (const [agent, index] of agents) {
    assert.match(ux, new RegExp(`agent-${agent}\\.png`), `${agent} icon is missing`);
    assert.match(ux, new RegExp(`light${index}Class`), `${agent} status light is missing`);
    assert.match(ux, new RegExp(`a${index}VerbColor`), `${agent} status text is missing`);
    assert.match(ux, new RegExp(`${agent}Val5h`), `${agent} 5h card binding is missing`);
    assert.match(ux, new RegExp(`${agent}Val7d`), `${agent} 7d card binding is missing`);
    assert.match(ux, new RegExp(`\\.card-a${index} \\{`), `${agent} card style is missing`);
    assert.match(ux, new RegExp(`\\.tt-a${index} \\{`), `${agent} card title style is missing`);
  }
});

test('status and vibration state arrays cover all five pages', () => {
  assert.match(ux, /const AGENTS = \['claude', 'codex', 'antigravity', 'opencode', 'zcode'\]/);
  assert.match(ux, /const prevStatus = \['idle', 'idle', 'idle', 'idle', 'idle'\]/);
});
