import path from 'node:path';
import { BridgeError, residentPath } from './bridge.js';
import { boundedBytes } from './desktop-proxy.js';
import { approvedRoot } from './helper-tools.js';
import { requireConnection } from './state.js';

// Each tick is a heartbeat and a claim on the user's Worker: every 3 s it was about 58k requests a day, most of the
// Cloudflare free plan's 100k. 15 s keeps a job's pickup quick and well inside the cloud's 5-minute lease.
const TICK_MS = 15000;
const scopeKey = (connectionId, resident, deviceId) => `${connectionId}/${resident}${deviceId ? '/' + deviceId : ''}`;
const empty = () => ({ version: 1, bindings: {}, jobs: {}, outbox: [] });
export class DeviceRunner {
  constructor(bridge, helpers, state, request = fetch) { this.bridge = bridge; this.helpers = helpers; this.state = state; this.request = request; this.active = new Map(); this.error = ''; }
  async current(id) { return requireConnection(await this.bridge.connection(), id); }
  async workspace({ connectionId, resident, deviceId }) {
    const connection = await this.bridge.connection();
    if (!connection || connection.connectionId !== connectionId) return null;
    const binding = (await this.state.read()).bindings?.[scopeKey(connectionId, resident)];
    return binding?.enabled && (!deviceId || binding.deviceId === deviceId) ? { path: binding.workspace, approved: true } : null;
  }
  async enable(input, signal) {
    const connection = await this.current(input.connectionId), prefix = residentPath(input.resident);
    if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new BridgeError('WORKSPACE', '请在 DSH 中选择一个本机工作区。');
    let workspace;
    try { workspace = await approvedRoot(input.workspace); }
    catch { throw new BridgeError('WORKSPACE', '请选择现有的普通工作目录，不使用系统根目录或私密配置目录。'); }
    const key = scopeKey(connection.connectionId, input.resident);
    if ((await this.state.read()).bindings?.[key]?.enabled) throw new BridgeError('ALREADY_ENABLED', '请先停用当前本机帮手，再修改工作区。', 409);
    const paired = await this.bridge.upstream(connection, prefix + '/web/desktop/register', { body: { label: 'DSH Desktop' }, signal });
    if (typeof paired.deviceId !== 'string' || typeof paired.token !== 'string' || paired.protocol !== 'resident-dsh/1') throw new BridgeError('PAIRING', '住民尚不支持这个桌面协议。', 502);
    // If another tab changed the cloud connection during pairing, never grant its workspace.
    try { await this.current(input.connectionId); }
    catch (error) { await this.bridge.upstream(connection, prefix + '/web/desktop/revoke', { body: { deviceId: paired.deviceId } }).catch(() => {}); throw error; }
    try {
      await this.state.update(state => {
        Object.assign(state, { version: 1 }); state.bindings ||= {}; state.jobs ||= {}; state.outbox ||= [];
        state.bindings[key] = { resident: input.resident, connectionId: connection.connectionId, deviceId: paired.deviceId, token: paired.token, workspace, enabled: true };
      });
    } catch (error) {
      await this.bridge.upstream(connection, prefix + '/web/desktop/revoke', { body: { deviceId: paired.deviceId }, signal: AbortSignal.timeout(10000) }).catch(() => {});
      throw error;
    }
    return { enabled: true, resident: input.resident, workspaceName: path.basename(workspace), deviceId: paired.deviceId };
  }
  async disable(input) {
    const connection = await this.current(input.connectionId), key = scopeKey(connection.connectionId, input.resident);
    const binding = (await this.state.read()).bindings?.[key];
    const deviceId = input.deviceId || binding?.deviceId;
    if (!deviceId || typeof deviceId !== 'string' || deviceId.length > 200) return { enabled: false };
    if (binding && binding.deviceId === deviceId) {
      // Stop claiming locally first, even when the cloud is unreachable.
      await this.state.update(state => { state.bindings[key].enabled = false; });
      if (this.helpers.stopBinding) await this.helpers.stopBinding({ connectionId: connection.connectionId, resident: input.resident, deviceId }).catch(() => {});
      else for (const record of Object.values((await this.state.read()).jobs || {})) {
        if (record.scope === key && record.phase === 'running') await this.helpers.stop({ connectionId: connection.connectionId, resident: input.resident, jobId: record.job.id }).catch(() => {});
      }
    }
    await this.bridge.upstream(connection, residentPath(input.resident) + '/web/desktop/revoke', { body: { deviceId } });
    return { enabled: false };
  }
  async snapshot() {
    const status = await this.bridge.status(), state = await this.state.read();
    return { ...status, desktopProtocol: 'resident-dsh/1', helperMode: 'read-only', error: this.error,
      bindings: Object.values(state.bindings || {}).filter(b => b.connectionId === status.connectionId).map(b => ({ resident: b.resident, enabled: b.enabled, workspaceName: path.basename(b.workspace), deviceId: b.deviceId })),
      jobs: Object.values(state.jobs || {}).filter(j => j.connectionId === status.connectionId).map(j => ({ id: j.job.id, resident: j.resident, title: j.job.title, phase: j.phase })) };
  }
  async device(connection, binding, action, body, signal) {
    const timeout = AbortSignal.timeout(20000);
    let response;
    try {
      response = await this.request(connection.url + residentPath(binding.resident) + '/desktop/v1/' + action, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    } catch { throw new BridgeError('DEVICE_NETWORK', '本机帮手暂时连不上住民；未确认的操作不会自动重做。', 502); }
    if (!response.ok) {
      let deviceCode = '';
      try { const value = JSON.parse((await boundedBytes(response, 16384)).toString('utf8')); if (typeof value.code === 'string' && /^[A-Z_]{1,64}$/.test(value.code)) deviceCode = value.code; } catch {}
      const error = new BridgeError(response.status === 401 || response.status === 403 ? 'DEVICE_REVOKED' : 'DEVICE_PROTOCOL', response.status === 401 || response.status === 403 ? '设备授权已失效，请在 DSH 重新连接。' : `设备接口返回 ${response.status}。`, response.status === 401 || response.status === 403 ? 403 : response.status);
      error.deviceCode = deviceCode;
      throw error;
    }
    try {
      const value = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8'));
      if (value?.error) throw new Error();
      return value;
    } catch { throw new BridgeError('DEVICE_PROTOCOL', '设备接口没有返回有效数据。', 502); }
  }
  async enqueue(key, job, type, summary, sessionId) {
    await this.state.update(state => {
      state.outbox ||= [];
      const eventId = `dsh:${job.id}:${type}`;
      const event = { eventId, jobId: job.id, leaseId: job.leaseId, type, ...(summary ? { summary: summary.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, 4000) } : {}), ...(sessionId ? { sessionId } : {}) };
      if (type !== 'started' && !event.summary?.trim()) event.summary = '请打开原 DSH 会话确认执行结果。';
      while (Buffer.byteLength(JSON.stringify(event)) > 15000 && event.summary?.length) event.summary = event.summary.slice(0, -128);
      if (!state.outbox.some(item => item.scope === key && item.event.eventId === eventId)) state.outbox.push({ scope: key, event });
    });
  }
  async flush(connection, binding, key, signal) {
    for (const item of (await this.state.read()).outbox || []) {
      if (item.scope !== key) continue;
      try { await this.device(connection, binding, 'events', item.event, signal); }
      catch (error) {
        const terminal = (await this.state.read()).outbox?.some(next => next.scope === key && next.event.jobId === item.event.jobId && next.event.leaseId === item.event.leaseId && next.event.type !== 'started');
        if (!(item.event.type === 'started' && error.status === 409 && error.deviceCode === 'ALREADY_STARTED' && terminal)) throw error;
        // A stale start cannot block the matching durable terminal reconciliation.
      }
      await this.state.update(state => {
        state.outbox = state.outbox.filter(next => !(next.scope === key && next.event.eventId === item.event.eventId));
        if (item.event.type !== 'started') delete state.jobs[`${key}/${item.event.jobId}`];
      });
    }
  }
  async execute(connection, binding, key, job) {
    const jobKey = `${key}/${job.id}`;
    try {
      const result = await this.helpers.run({ ...job, connectionId: connection.connectionId, resident: binding.resident, deviceId: binding.deviceId, workspace: binding.workspace }, {
        onStarted: sessionId => this.enqueue(key, job, 'started', undefined, sessionId)
      });
      const type = ['completed', 'failed', 'needs_you'].includes(result.status) ? result.status : 'needs_you';
      await this.enqueue(key, job, type, result.summary || '请打开 DSH 会话确认执行结果。', result.sessionId);
    } catch {
      await this.enqueue(key, job, 'needs_you', 'DSH 未确认任务完成。请打开执行过程检查，任务不会自动重做。');
    } finally {
      await this.state.update(state => { if (state.jobs[jobKey]) state.jobs[jobKey].phase = 'reporting'; });
      this.active.delete(jobKey);
    }
  }
  async recover() {
    const state = await this.state.read();
    for (const [jobKey, record] of Object.entries(state.jobs || {})) {
      if (record.phase !== 'running') continue;
      if (!(state.outbox || []).some(item => item.scope === record.scope && item.event.jobId === record.job.id && item.event.type !== 'started')) await this.enqueue(record.scope, record.job, 'needs_you', 'DSH 已重启，执行状态尚未确认。请查看原会话；不会自动重做。');
      await this.state.update(next => { if (next.jobs[jobKey]) next.jobs[jobKey].phase = 'reporting'; });
    }
  }
  async tick(signal) {
    const connection = await this.bridge.connection(); if (!connection) return;
    const state = await this.state.read();
    for (const [key, binding] of Object.entries(state.bindings || {})) {
      if (!binding.enabled || binding.connectionId !== connection.connectionId || signal?.aborted) continue;
      try {
        const dispatchScope = scopeKey(connection.connectionId, binding.resident, binding.deviceId);
        await this.device(connection, binding, 'heartbeat', {}, signal);
        await this.flush(connection, binding, dispatchScope, signal);
        const fresh = await this.state.read();
        if (Object.values(fresh.jobs || {}).some(j => j.scope === dispatchScope)) continue;
        const { job } = await this.device(connection, binding, 'claim', {}, signal);
        if (!job) continue;
        if (job.protocol !== 'resident-dsh/1' || typeof job.id !== 'string' || !/^t_[a-f0-9]{10}$/.test(job.id) || typeof job.thread !== 'string' || typeof job.instruction !== 'string' || job.instruction.length > 16000 || typeof job.leaseId !== 'string') throw new BridgeError('DEVICE_PROTOCOL', '本机任务格式不兼容。');
        await this.current(connection.connectionId);
        const jobKey = `${dispatchScope}/${job.id}`;
        await this.state.update(next => { next.jobs ||= {}; next.jobs[jobKey] = { scope: dispatchScope, connectionId: connection.connectionId, resident: binding.resident, deviceId: binding.deviceId, job, phase: 'running' }; });
        const running = this.execute(connection, binding, dispatchScope, job).catch(() => { this.error = '任务结果尚未同步，请查看原 DSH 会话。'; });
        this.active.set(jobKey, running);
        this.error = '';
      } catch (error) {
        if (signal?.aborted) return;
        this.error = error instanceof BridgeError ? error.message : '本机帮手暂时不可用。';
        if (error?.code === 'DEVICE_REVOKED') await this.state.update(next => { if (next.bindings[key]) next.bindings[key].enabled = false; });
      }
    }
  }
  async start(signal) {
    await this.recover();
    while (!signal.aborted) {
      await this.tick(signal).catch(() => { this.error = '本机帮手暂时不可用。'; });
      if (signal.aborted) break;
      await new Promise(resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, TICK_MS); signal.addEventListener('abort', finish, { once: true }); });
    }
  }
}
export { scopeKey, empty as initialDeviceState };
