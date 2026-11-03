import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { NativeHelpers, outcomeFromEvents } from '../helper-runtime.js';
import { HELPER_PRESET, FULL_HELPER_PRESET } from '../helper.js';

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aelios-helper-test-')));
  assert.match(path.basename(root), /^aelios-helper-test-/); assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let state = { otherData: 'preserved' };
  const agents = new Map(), persisted = new Map(), trace = [];
  const store = { read: async () => structuredClone(state), write: async next => { state = structuredClone(next); trace.push('store'); }, workspace: async () => options.unapproved ? null : { path: root, approved: true, access: options.access } };
  function session(id, header, events = []) {
    return { id, header, snapshotEvents: () => structuredClone(events), append(type, data) { const event = { seq: events.length, type, data }; events.push(event); return event; } };
  }
  async function build(config, isResume) {
    assert.equal(config.parentAgent, undefined); assert.equal(config.meta?.origin, undefined);
    const id = config.sessionId || config.resumeSessionId;
    const old = persisted.get(id);
    const value = isResume ? session(id, old.header, old.snapshotEvents()) : session(id, { ...config.meta });
    const agent = { id, session: value, options: config.agentOptions, status: 'idle', whenIdle: async () => {
      if (options.idleGate) await options.idleGate.promise;
      agent.status = 'idle';
    }, cancel(cause) { trace.push('cancel:' + cause.kind); agent.status = 'idle'; } };
    await config.setup({ tools: {} }, agent);
    agents.set(id, agent); persisted.set(id, value); trace.push(isResume ? 'resume' : 'create');
    return { agent, async dispose() { trace.push('dispose'); agents.delete(id); } };
  }
  const ctx = {
    agents: { get: id => agents.get(id), create: config => build(config, false), resume: config => build(config, true) },
    agentPresets: { mount: async (_ctx, id) => { assert.equal(id, options.access === 'full' ? FULL_HELPER_PRESET : HELPER_PRESET); trace.push('preset'); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'fake' }) },
    sessionPersistence: { flush: async () => { trace.push('flush'); } },
    sessionController: {
      inspect: async id => ({ meta: persisted.get(id).header, events: persisted.get(id).snapshotEvents() }),
      async prompt(request) {
        assert.equal(request.mode, 'queue');
        trace.push('prompt');
        const saved = Object.values(state.nativeHelpers.jobs).find(job => job.sessionId === request.sessionId && job.requestId === request.requestId);
        assert.ok(saved, 'mapping persisted before prompt');
        const agent = agents.get(request.sessionId), value = agent.session;
        assert.equal(value.header.agentPreset, options.access === 'full' ? FULL_HELPER_PRESET : HELPER_PRESET); assert.equal(value.header.cwd, root);
        const knobs = value.snapshotEvents();
        assert.equal(knobs.findLast(e => e.type === 'sandbox/mode').data.mode, options.access === 'full' ? 'danger-full-access' : 'read-only');
        assert.equal(knobs.findLast(e => e.type === 'approval/policy').data.policy, 'never');
        agent.status = 'running';
        const turn = value.snapshotEvents().filter(e => e.type === 'turn/start').length + 1;
        value.append('turn/start', { turn });
        value.append('user/message', { source: { kind: 'user', rpcId: request.requestId }, content: request.content });
        if (options.promptError) throw new Error('SIMULATED_PRIVATE_ERROR /private/secret synthetic-token');
        value.append('assistant/message', { turn, message: { content: [{ type: 'text', text: `Found report in ${root}.\napi_key=synthetic-value` }] } });
        if (!options.noEnd) value.append('turn/end', { turn, reason: { kind: options.reason || 'completed' } });
        return { accepted: true };
      }
    }
  };
  const input = { connectionId: 'connection-one', resident: 'default', deviceId: 'device-one', id: 'job-one', thread: 'thread-one', title: 'Inspect reports', instruction: 'List reports', workspace: root };
  return { root, ctx, store, input, trace, agents, persisted, state: () => structuredClone(state), replace: value => state = structuredClone(value), runtime: new NativeHelpers(ctx, store) };
}
test('explicit full grant selects a distinct full-access session; legacy grants retain read-only policy', async t => {
  const options = { access: undefined }, f = await fixture(t, options);
  const read = await f.runtime.run(f.input);
  assert.equal(Object.values(f.state().nativeHelpers.jobs)[0].access, 'read-only');
  options.access = 'full';
  const full = await f.runtime.run({ ...f.input, id: 'full-job' });
  assert.equal(full.status, 'completed'); assert.notEqual(full.sessionId, read.sessionId);
  assert.equal(f.agents.get(full.sessionId).session.header.agentPreset, FULL_HELPER_PRESET);
  assert.equal(Object.values(f.state().nativeHelpers.jobs).find(j => j.id === 'full-job').access, 'full');
  assert.equal((await f.runtime.run(f.input)).code, 'JOB_CONFLICT', 'old job IDs cannot be replayed at higher privilege');
});

test('creates ordinary independent helper, persists before started/prompt and reports matched completion', async t => {
  const f = await fixture(t);
  const result = await f.runtime.run(f.input, async id => { f.trace.push('started'); assert.ok(Object.values(f.state().nativeHelpers.jobs).some(job => job.sessionId === id)); });
  assert.equal(result.status, 'completed'); assert.ok(result.sessionId.startsWith('session-aelios-'));
  assert.ok(f.trace.indexOf('store') < f.trace.indexOf('started')); assert.ok(f.trace.indexOf('started') < f.trace.indexOf('prompt'));
  assert.equal(result.summary.includes(f.root), false); assert.equal(result.summary.includes('synthetic-value'), false);
  assert.equal(f.state().otherData, 'preserved'); assert.equal(f.trace.filter(v => v === 'prompt').length, 1);
  assert.deepEqual(await f.runtime.resolve({ connectionId: f.input.connectionId, resident: f.input.resident, jobId: f.input.id }), { sessionId: result.sessionId });
});
test('same job retries return stored result without replay; conflicting or cross-resident lookup is rejected', async t => {
  const f = await fixture(t);
  const first = await f.runtime.run(f.input);
  assert.deepEqual(await f.runtime.run(f.input), first);
  assert.equal((await f.runtime.run({ ...f.input, instruction: 'different' })).code, 'JOB_CONFLICT');
  assert.equal(f.trace.filter(v => v === 'prompt').length, 1);
  await assert.rejects(f.runtime.resolve({ connectionId: 'other', resident: 'default', jobId: f.input.id }));
  await assert.rejects(f.runtime.resolve({ connectionId: f.input.connectionId, resident: 'other', jobId: f.input.id }));
  await assert.rejects(f.runtime.resolve({ connectionId: f.input.connectionId, resident: 'default', deviceId: 'other', jobId: f.input.id }));
});
test('follow-up reuses same ordinary session; cold continuation resumes its persistent dedicated preset', async t => {
  const f = await fixture(t);
  const first = await f.runtime.run(f.input);
  const second = await f.runtime.run({ ...f.input, id: 'job-two', instruction: 'Summarize reports' });
  assert.equal(second.sessionId, first.sessionId);
  f.agents.clear();
  const third = await new NativeHelpers(f.ctx, f.store).run({ ...f.input, id: 'job-three', instruction: 'Compare reports' });
  assert.equal(third.status, 'completed'); assert.equal(third.sessionId, first.sessionId);
  assert.equal(f.trace.filter(v => v === 'create').length, 1); assert.equal(f.trace.filter(v => v === 'resume').length, 1);
});
test('in-flight retry joins one operation; same-thread second job does not run concurrently', async t => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await fixture(t, { idleGate: gate });
  const first = f.runtime.run(f.input, () => started.resolve());
  await started.promise;
  const retry = f.runtime.run(f.input);
  const busy = await f.runtime.run({ ...f.input, id: 'other-job' });
  assert.equal(busy.code, 'THREAD_BUSY');
  gate.resolve(); assert.deepEqual(await first, await retry);
  assert.equal(f.trace.filter(v => v === 'prompt').length, 1);
});
test('restart with an unconfirmed job never replays a prompt or resumes an Agent', async t => {
  const f = await fixture(t);
  await f.runtime.run(f.input);
  const state = f.state(), record = Object.values(state.nativeHelpers.jobs)[0]; record.status = 'running'; delete record.summary; delete record.code; f.replace(state);
  f.trace.length = 0; f.agents.clear();
  const result = await new NativeHelpers(f.ctx, f.store).run(f.input);
  assert.equal(result.code, 'OUTCOME_UNKNOWN'); assert.deepEqual(f.trace, ['store']);
});
test('unapproved workspace fails before creation; errors are bounded and do not expose provider details', async t => {
  const rejected = await fixture(t, { unapproved: true });
  assert.equal((await rejected.runtime.run(rejected.input)).code, 'WORKSPACE_REQUIRED'); assert.equal(rejected.trace.includes('create'), false);
  const failed = await fixture(t, { promptError: true });
  const result = await failed.runtime.run(failed.input);
  assert.equal(result.status, 'needs_you'); assert.equal(result.code, 'OUTCOME_UNKNOWN');
  assert.equal(JSON.stringify(result).includes('SIMULATED_PRIVATE_ERROR'), false);
  assert.equal((await failed.runtime.run({ ...failed.input, id: 'later-job' })).code, 'THREAD_BUSY');
});
test('whenIdle alone is not success; blocked, failed, cancelled and missing turn ends stay distinct', async t => {
  for (const [reason, expected] of [['blocked', 'needs_you'], ['error', 'failed'], ['aborted', 'failed']]) {
    const f = await fixture(t, { reason }); assert.equal((await f.runtime.run(f.input)).status, expected);
  }
  const f = await fixture(t, { noEnd: true }); assert.equal((await f.runtime.run(f.input)).code, 'OUTCOME_UNKNOWN');
  assert.equal(outcomeFromEvents([{ seq: 0, type: 'turn/end', data: { reason: { kind: 'completed' } } }], 'unrelated', '/authorized').status, 'needs_you');
});
test('binding disable cancels completed sessions and disposes only matching owned handles', async t => {
  const f = await fixture(t);
  const first = await f.runtime.run(f.input);
  const other = await f.runtime.run({ ...f.input, connectionId: 'other-connection', id: 'other-job' });
  const stopped = await f.runtime.stopBinding({ connectionId: f.input.connectionId, resident: f.input.resident, deviceId: f.input.deviceId });
  assert.deepEqual(stopped.sessionIds, [first.sessionId]);
  assert.equal(f.agents.has(first.sessionId), false);
  assert.equal(f.agents.has(other.sessionId), true);
  assert.equal(f.trace.filter(item => item === 'dispose').length, 1);
});
test('stop is explicit and scoped; dispose cancels owned handles without starting or replaying work', async t => {
  const f = await fixture(t); const result = await f.runtime.run(f.input);
  await f.runtime.stop({ connectionId: f.input.connectionId, resident: 'default', jobId: f.input.id });
  assert.ok(f.trace.includes('cancel:user'));
  await f.runtime.dispose(); assert.ok(f.trace.includes('dispose'));
  assert.equal((await f.runtime.run({ ...f.input, id: 'new' })).code, 'PLUGIN_STOPPED');
  assert.equal(f.trace.filter(v => v === 'prompt').length, 1); assert.ok(result.sessionId);
});
