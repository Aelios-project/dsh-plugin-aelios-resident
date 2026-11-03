import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, fullHelperPlugins } from '../helper-full.js';
import { FULL_HELPER_PRESET } from '../helper.js';

test('full helper rechecks every native call and cannot bypass other decisions or monotonic guard', async () => {
  const events = new Map(), policy = []; let guard, allowed = true, checks = 0;
  apply({
    aeliosDesktop: { async authorizeSession(input) { checks++; assert.equal(input.access, 'full'); return allowed; } },
    tools: { presentAs() {}, guard(value) { guard = value; } },
    systemPrompt: { section() {} }, on(name, value) { events.set(name, value); }
  });
  const agent = { id: 'full-root', session: { header: { cwd: '/work', agentPreset: FULL_HELPER_PRESET }, append(type, value) { policy.push([type, value]); } } };
  await events.get('agent/created')({ agent, source: 'startup' });
  assert.deepEqual(policy, [['sandbox/mode', { mode: 'danger-full-access' }], ['approval/policy', { policy: 'never' }]]);
  const call = { name: 'bash', agent, signal: new AbortController().signal };
  assert.match(guard(call), /not verified/);
  const otherDecision = { kind: 'deny', reason: 'another policy denied' };
  assert.equal(await events.get('tools/pre-execute')(call, async () => otherDecision), otherDecision);
  assert.equal(guard(call), undefined); assert.match(guard(call), /not verified/, 'receipt cannot be reused');
  const write = { ...call, name: 'write' };
  assert.deepEqual(await events.get('tools/pre-execute')(write, async () => ({ kind: 'allow' })), { kind: 'allow' });
  assert.equal(guard(write), undefined);
  allowed = false;
  const revoked = { ...call, name: 'subagent' };
  assert.equal((await events.get('tools/pre-execute')(revoked, async () => { throw new Error('must not dispatch'); })).kind, 'deny');
  assert.match(guard(revoked), /not verified/);
  await assert.rejects(events.get('agent/created')({ agent, source: 'resume' }), /revoked/);
  assert.equal(checks, 5);
});

test('full composition provides ordinary programming, skills, network, jobs and delegation packages', () => {
  const plugins = fullHelperPlugins();
  const names = new Set(plugins.map(p => p.name));
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tool-web']) assert.ok(names.has(name), name);
  const delegation = plugins.find(p => p.id === 'delegation');
  assert.ok(delegation.config.some(p => p.config?.toolName === 'subagent'));
  assert.ok(delegation.config.some(p => p.config?.toolName === 'subagent_fork'));
});
