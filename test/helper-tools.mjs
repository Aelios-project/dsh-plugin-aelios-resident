import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { workspaceOperation, approvedRoot, redactText, workspaceTool } from '../helper-tools.js';
import { apply, HELPER_PRESET } from '../helper.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aelios-helper-test-')));
  assert.match(path.basename(root), /^aelios-helper-test-/);
  assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'report.txt'), 'report\n'.repeat(8000));
  await fs.mkdir(path.join(root, 'nested'));
  return root;
}
test('workspace listing and reads are bounded and return only relative paths', async t => {
  const root = await fixture(t);
  const listed = await workspaceOperation(root, { action: 'list' });
  assert.equal(listed.path, '.'); assert.ok(listed.entries.some(item => item.name === 'report.txt'));
  const read = await workspaceOperation(root, { action: 'read', path: 'report.txt', limit: 12, offset: 7 });
  assert.equal(read.text.length, 12); assert.equal(read.truncated, true); assert.equal(read.path, 'report.txt');
  assert.equal(JSON.stringify(read).includes(root), false);
  await assert.rejects(workspaceOperation(root, { action: 'read', path: 'report.txt', limit: 24001 }), { code: 'INVALID_RANGE' });
});
test('traversal, absolute paths, credential names, symlink escape and hardlinks are rejected', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_SECRET=not-real');
  await fs.symlink(outside, path.join(root, 'escape'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'innocent.txt'));
  await fs.link(path.join(root, 'report.txt'), path.join(root, 'duplicate.txt'));
  for (const name of ['../report.txt', '/etc/passwd', 'escape/report.txt', '.env', 'innocent.txt', 'duplicate.txt', '..\\report.txt']) {
    await assert.rejects(workspaceOperation(root, { action: 'read', path: name }), `must reject ${name}`);
  }
  const names = (await workspaceOperation(root, { action: 'list' })).entries.map(item => item.name);
  assert.equal(names.includes('.env'), false);
  await assert.rejects(approvedRoot('/'), { code: 'SENSITIVE_PATH' });
});
test('binary, oversized files, special files and invalid operations fail closed', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
  await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(workspaceOperation(root, { action: 'read', path: 'binary.bin' }), { code: 'BINARY_FILE' });
  await assert.rejects(workspaceOperation(root, { action: 'read', path: 'large.txt' }), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(workspaceOperation(root, { action: 'write', path: 'report.txt' }), { code: 'INVALID_ACTION' });
  const tool = workspaceTool(() => root);
  const failed = await tool.execute({ action: 'read', path: 'missing' }, { signal: new AbortController().signal });
  assert.equal(failed.error, 'READ_FAILED'); assert.equal(JSON.stringify(failed).includes(root), false);
});
test('directory listing caps at 200 entries and signals truncation', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(root, `item-${i}.txt`), 'x')));
  const result = await workspaceOperation(root, { action: 'list' });
  assert.equal(result.entries.length, 200); assert.equal(result.truncated, true);
});
test('common credential values and private key blocks are redacted before slicing', async t => {
  const root = await fixture(t);
  const text = 'api_key=synthetic-value\n-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----\nnormal';
  await fs.writeFile(path.join(root, 'notes.txt'), text);
  const result = await workspaceOperation(root, { action: 'read', path: 'notes.txt' });
  assert.equal(result.text.includes('synthetic-value'), false); assert.equal(result.text.includes('SYNTHETIC'), false);
  assert.ok(result.text.includes('normal')); assert.ok(redactText(text).includes('[redacted]'));
});
test('preset masks inherited tools, denies every other scoped tool, and pins on cold resume', async () => {
  let guard, tool, listener, section;
  const calls = [];
  apply({ tools: { presentAs: mode => calls.push(mode), restrict: mask => calls.push(mask), guard: value => guard = value, register: value => tool = value },
    systemPrompt: { section: value => section = value }, get: () => ({ authorizeSession: async () => true }), on: (name, value) => { assert.equal(name, 'agent/created'); listener = value; } });
  assert.deepEqual(calls, ['native', { allow: [] }]);
  for (const name of ['bash', 'read', 'subagent', 'run_code', 'say', 'unknown']) assert.equal(typeof guard({ name }), 'string');
  assert.equal(guard({ name: 'resident_workspace' }), undefined); assert.equal(tool.name, 'resident_workspace'); assert.equal(section.complete, true);
  const events = [];
  await listener({ agent: { session: { header: { agentPreset: HELPER_PRESET, cwd: '/authorized' }, append: (type, data) => events.push({ type, data }) } } });
  assert.deepEqual(events.map(item => item.data), [{ mode: 'read-only' }, { policy: 'never' }]);
  await assert.rejects(listener({ agent: { session: { header: { cwd: '/authorized' }, append() {} } } }));
  const removed = [];
  await listener({ source: 'resume', agent: { session: { header: { agentPreset: HELPER_PRESET, cwd: '/authorized' }, append() {} }, inbox: {
    nextTurn: [{ id: 'old-cloud', source: { rpcId: 'aelios-job-old' } }, { id: 'human', source: { rpcId: 'human-rpc' } }],
    nextStep: [{ id: 'cloud-steer', source: { rpcId: 'aelios-job-steer' } }], remove: id => removed.push(id)
  } } });
  assert.deepEqual(removed, ['old-cloud', 'cloud-steer']);
});
