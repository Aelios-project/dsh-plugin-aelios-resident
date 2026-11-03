import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, HELPER_PRESET } from '../helper.js';

function mounted(authority) {
  let listener, tool;
  const ctx = { get: () => authority, tools: { presentAs() {}, restrict() {}, guard() {}, register(value) { tool = value; } }, systemPrompt: { section() {} }, on(_name, value) { listener = value; } };
  apply(ctx);
  return { listener, tool };
}
const agent = { id: 'session-bound', session: { header: { cwd: '/authorized', agentPreset: HELPER_PRESET }, append() {} } };
test('cold resume and each tool call fail closed without authority or after revocation', async () => {
  const missing = mounted(undefined);
  await assert.rejects(missing.listener({ agent }), { code: 'WORKSPACE_REVOKED' });
  const denied = await missing.tool.execute({ action: 'list' }, { agent });
  assert.equal(denied.error, 'WORKSPACE_REVOKED');
  let allowed = true, checks = 0;
  const scoped = mounted({ async authorizeSession(value) {
    checks++; assert.deepEqual(value, { sessionId: agent.id, workspace: '/authorized' }); return allowed;
  } });
  await scoped.listener({ agent });
  assert.equal(checks, 1);
  allowed = false;
  await assert.rejects(scoped.listener({ agent, source: 'resume' }), { code: 'WORKSPACE_REVOKED' });
  const result = await scoped.tool.execute({ action: 'read', path: 'report.txt' }, { agent });
  assert.equal(result.error, 'WORKSPACE_REVOKED'); assert.equal(checks, 3);
});
