import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, HELPER_PRESET } from '../helper.js';

function mounted(authority) {
  let listener, tool, registrations = 0;
  const effects = [];
  const ctx = {
    get: () => authority,
    tools: { presentAs() {}, restrict() {}, guard() {}, register() { throw new Error('must not register on ancestor preset'); } },
    systemPrompt: { section() {} }, on(_name, value) { listener = value; },
    effect(callback) { const cleanup = callback(); effects.push(cleanup); return cleanup; }
  };
  apply(ctx);
  const agent = { id: 'session-bound', ctx: { tools: { register(value) { tool = value; registrations++; return () => {}; } } }, session: { header: { cwd: '/authorized', agentPreset: HELPER_PRESET }, append() {} } };
  return { listener, agent, get tool() { return tool; }, get registrations() { return registrations; } };
}
test('cold resume and each tool call fail closed without authority or after revocation', async () => {
  const missing = mounted(undefined);
  await assert.rejects(missing.listener({ agent: missing.agent }), { code: 'WORKSPACE_REVOKED' });
  assert.equal(missing.tool, undefined); assert.equal(missing.registrations, 0);
  let allowed = true, checks = 0;
  const scoped = mounted({ async authorizeSession(value) {
    checks++; assert.deepEqual(value, { sessionId: 'session-bound', workspace: '/authorized' }); return allowed;
  } });
  await scoped.listener({ agent: scoped.agent });
  assert.equal(checks, 1); assert.equal(scoped.registrations, 1);
  await scoped.listener({ agent: scoped.agent, source: 'clear' });
  assert.equal(scoped.registrations, 1, 'reannouncing same live Agent must not duplicate tool registration');
  allowed = false;
  await assert.rejects(scoped.listener({ agent: scoped.agent, source: 'resume' }), { code: 'WORKSPACE_REVOKED' });
  const result = await scoped.tool.execute({ action: 'read', path: 'report.txt' }, { agent: scoped.agent });
  assert.equal(result.error, 'WORKSPACE_REVOKED'); assert.equal(checks, 4);
});
