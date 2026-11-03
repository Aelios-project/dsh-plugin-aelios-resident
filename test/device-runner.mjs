import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRunner, scopeKey, initialDeviceState } from '../device-runner.js';
function memory(initial = initialDeviceState()) {
  let value = structuredClone(initial), tail = Promise.resolve();
  return { async read() { await tail; return structuredClone(value); }, update(fn) { const next = tail.then(() => fn(value)); tail = next.catch(() => {}); return next; } };
}
const connection = { url: 'https://resident.example', key: 'synthetic-web', connectionId: 'connection-1' };
const binding = { connectionId: connection.connectionId, resident: 'default', deviceId: 'device-1', token: 'synthetic-device', workspace: process.cwd(), enabled: true };
const job = { id: 't_1234567890', thread: 't_1234567890', title: 'Read sample', instruction: 'List filenames only', leaseId: 'lease-1', attempt: 1, protocol: 'resident-dsh/1' };
const key = scopeKey(connection.connectionId, 'default', binding.deviceId), bindingKey = scopeKey(connection.connectionId, 'default');
function bridge() { return { async connection() { return connection; }, async status() { return { connected: true, url: connection.url, connectionId: connection.connectionId }; } }; }
test('old grants stay read-only, explicit full access persists and disable removes authority', async () => {
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding } });
  const upstream = bridge(); upstream.upstream = async (_connection, route) => route.endsWith('/register') ? { deviceId: 'device-full', token: 'synthetic-full', protocol: 'resident-dsh/1' } : { ok: true };
  const runner = new DeviceRunner(upstream, { async stopBinding() {} }, state);
  assert.equal((await runner.workspace(binding)).access, 'read-only');
  await runner.disable({ connectionId: connection.connectionId, resident: 'default' });
  await runner.enable({ connectionId: connection.connectionId, resident: 'default', workspace: process.cwd(), access: 'full' });
  const grant = await runner.workspace({ connectionId: connection.connectionId, resident: 'default', deviceId: 'device-full' });
  assert.equal(grant.access, 'full'); assert.equal((await runner.snapshot()).bindings[0].access, 'full');
  assert.equal((await state.read()).bindings[bindingKey].access, 'full');
  await runner.disable({ connectionId: connection.connectionId, resident: 'default' });
  assert.equal(await runner.workspace({ connectionId: connection.connectionId, resident: 'default' }), null);
  await assert.rejects(runner.enable({ connectionId: connection.connectionId, resident: 'default', workspace: process.cwd(), access: 'everything' }), { code: 'ACCESS' });
});

test('claim is persisted before native work; events remain durable until ACK and never reach foreground', async () => {
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding } });
  const received = [], calls = []; let claimed = false, executions = 0;
  const helpers = { async run(input, options) {
    executions++;
    assert.equal((await state.read()).jobs[`${key}/${job.id}`].phase, 'running');
    assert.equal(input.resident, 'default');
    await options.onStarted('native-session-1');
    return { sessionId: 'native-session-1', status: 'completed', summary: 'Two sample files' };
  } };
  const request = async (url, options) => {
    const action = url.split('/').at(-1), body = JSON.parse(options.body); calls.push(action);
    assert.equal(options.headers.authorization, 'Bearer ' + binding.token);
    assert.equal(options.redirect, 'error');
    if (action === 'events') received.push(body);
    const value = action === 'claim' ? { job: claimed ? null : (claimed = true, job) } : { ok: true };
    return Response.json(value);
  };
  const runner = new DeviceRunner(bridge(), helpers, state, request);
  await runner.tick(); await Promise.all([...runner.active.values()]);
  assert.equal(executions, 1);
  assert.deepEqual((await state.read()).outbox.map(item => item.event.type), ['started', 'completed']);
  await runner.tick(); await runner.tick();
  assert.deepEqual(received.map(event => event.type), ['started', 'completed']);
  assert.equal((await state.read()).outbox.length, 0);
  assert.equal(Object.keys((await state.read()).jobs).length, 0);
  assert.equal(executions, 1);
  assert.ok(!JSON.stringify(await runner.snapshot()).includes(binding.token));
});
test('network loss retains exact event and job; next tick retries report, never task', async () => {
  const event = { eventId: `dsh:${job.id}:completed`, jobId: job.id, leaseId: job.leaseId, type: 'completed', summary: 'Done' };
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding }, jobs: { [`${key}/${job.id}`]: { scope: key, job, phase: 'reporting' } }, outbox: [{ scope: key, event }] });
  let fail = true, executions = 0; const eventIds = [];
  const runner = new DeviceRunner(bridge(), { async run() { executions++; } }, state, async (url, options) => {
    if (url.endsWith('/events')) { eventIds.push(JSON.parse(options.body).eventId); if (fail) throw new Error('offline'); }
    return Response.json(url.endsWith('/claim') ? { job: null } : { ok: true });
  });
  await runner.tick();
  assert.equal((await state.read()).outbox.length, 1);
  fail = false; await runner.tick();
  assert.deepEqual(eventIds, [event.eventId, event.eventId]);
  assert.equal((await state.read()).outbox.length, 0); assert.equal(executions, 0);
});
test('restart preserves a queued terminal result instead of manufacturing a conflicting result', async () => {
  const record = { scope: key, connectionId: connection.connectionId, resident: 'default', job, phase: 'running' };
  const event = { eventId: 'completed-event', jobId: job.id, leaseId: job.leaseId, type: 'completed', summary: 'Done' };
  const state = memory({ ...initialDeviceState(), jobs: { [`${key}/${job.id}`]: record }, outbox: [{ scope: key, event }] });
  const runner = new DeviceRunner(bridge(), { async run() { throw new Error('must not replay'); } }, state);
  await runner.recover();
  assert.deepEqual((await state.read()).outbox, [{ scope: key, event }]);
  assert.equal((await state.read()).jobs[`${key}/${job.id}`].phase, 'reporting');
});
test('restart with unknown execution queues needs_you without running the native task', async () => {
  const record = { scope: key, connectionId: connection.connectionId, resident: 'default', job, phase: 'running' };
  const state = memory({ ...initialDeviceState(), jobs: { [`${key}/${job.id}`]: record } });
  let runs = 0;
  const runner = new DeviceRunner(bridge(), { async run() { runs++; } }, state);
  await runner.recover(); await runner.recover();
  assert.equal((await state.read()).outbox.length, 1);
  assert.equal((await state.read()).outbox[0].event.type, 'needs_you'); assert.equal(runs, 0);
});
test('workspace is bound to current connection, resident and device and revocation fails closed', async () => {
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding } });
  const runner = new DeviceRunner(bridge(), {}, state);
  assert.equal((await runner.workspace({ connectionId: connection.connectionId, resident: 'default', deviceId: binding.deviceId })).approved, true);
  assert.equal(await runner.workspace({ connectionId: 'old', resident: 'default' }), null);
  assert.equal(await runner.workspace({ connectionId: connection.connectionId, resident: 'other' }), null);
  assert.equal(await runner.workspace({ connectionId: connection.connectionId, resident: 'default', deviceId: 'other' }), null);
  await state.update(value => { value.bindings[bindingKey].enabled = false; });
  assert.equal(await runner.workspace({ connectionId: connection.connectionId, resident: 'default' }), null);
});
test('expired start cannot poison the matching terminal reconciliation', async () => {
  const start = { eventId: 'start', jobId: job.id, leaseId: job.leaseId, type: 'started', sessionId: 'native-session' };
  const end = { eventId: 'end', jobId: job.id, leaseId: job.leaseId, type: 'completed', summary: 'Done', sessionId: 'native-session' };
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding }, outbox: [{ scope: key, event: start }, { scope: key, event: end }], jobs: { [`${key}/${job.id}`]: { scope: key, job, phase: 'reporting' } } });
  const sent = [];
  const runner = new DeviceRunner(bridge(), {}, state, async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/events')) { sent.push(body.type); if (body.type === 'started') return Response.json({ error: 'stale', code: 'ALREADY_STARTED' }, { status: 409 }); }
    if (url.endsWith('/heartbeat')) assert.deepEqual(body, {});
    return Response.json(url.endsWith('/claim') ? { job: null } : { ok: true });
  });
  await runner.tick();
  assert.deepEqual(sent, ['started', 'completed']);
  assert.deepEqual((await state.read()).outbox, []);
});
test('re-paired device never transmits old-device events or blocks a new claim', async () => {
  const oldScope = scopeKey(connection.connectionId, 'default', 'old-device');
  const state = memory({ ...initialDeviceState(), bindings: { [bindingKey]: binding }, outbox: [{ scope: oldScope, event: { eventId: 'old', jobId: job.id, leaseId: 'old-lease', type: 'completed', summary: 'Old result' } }], jobs: { old: { scope: oldScope, job, phase: 'reporting' } } });
  const actions = [];
  const runner = new DeviceRunner(bridge(), {}, state, async url => { const action = url.split('/').at(-1); actions.push(action); return Response.json(action === 'claim' ? { job: null } : { ok: true }); });
  await runner.tick();
  assert.deepEqual(actions, ['heartbeat', 'claim']);
  assert.equal((await state.read()).outbox.length, 1);
});
test('terminal event fits encoded backend limit and cannot have an empty sanitized summary', async () => {
  const state = memory(), runner = new DeviceRunner(bridge(), {}, state);
  await runner.enqueue(key, job, 'completed', '\u0000'.repeat(4000), 'native-session');
  const event = (await state.read()).outbox[0].event;
  assert.ok(event.summary.trim());
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 16384);
});
