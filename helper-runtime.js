import { randomUUID } from 'node:crypto';
import { approvedRoot, redactText } from './helper-tools.js';
import { HELPER_PRESET, pinHelperPolicy } from './helper.js';

const FINAL = new Set(['completed', 'failed', 'needs_you']);
const keyOf = (...parts) => JSON.stringify(parts);
const bounded = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${label}`);
  return value;
};
function safeSummary(value, root) {
  const safe = redactText(value).split(root).join('[workspace]').trim();
  return safe.slice(0, 4000) || '任务结束，但没有可确认的结果，请打开 DSH 会话检查。';
}
function textOf(message) {
  return message?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') || '';
}
function requestPresent(events, requestId) {
  return events.some(event => event.type === 'user/message' && event.data.source?.rpcId === requestId || event.type === 'agent/inbox/spliced' && event.data.inserted?.some(message => message.source?.rpcId === requestId));
}
export function outcomeFromEvents(events, requestId, root) {
  // Only a turn containing our exact durable user RPC may complete this job.
  const message = events.find(event => event.type === 'user/message' && event.data.source?.rpcId === requestId);
  if (!message) return { status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '任务未确认执行，请打开 DSH 会话检查，避免重复运行。' };
  const turnStart = [...events].reverse().find(event => event.seq < message.seq && event.type === 'turn/start');
  if (!turnStart) return { status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '无法关联任务轮次，请打开 DSH 会话检查。' };
  const end = events.find(event => event.seq > message.seq && event.type === 'turn/end' && event.data.turn === turnStart.data.turn);
  if (!end) return { status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '执行结果尚不确定，请打开 DSH 会话检查。' };
  const reason = end.data.reason?.kind;
  if (reason === 'aborted') return { status: 'failed', code: 'CANCELLED', summary: '本机任务已停止。' };
  if (reason !== 'completed') return { status: reason === 'blocked' ? 'needs_you' : 'failed', code: 'TURN_' + String(reason || 'UNKNOWN').toUpperCase(), summary: '本机任务未完成，请打开 DSH 会话查看原因。' };
  const reply = events.filter(event => event.seq > message.seq && event.seq < end.seq && event.type === 'assistant/message').map(event => textOf(event.data.message)).filter(Boolean).at(-1);
  if (!reply) return { status: 'needs_you', code: 'NO_REPORT', summary: '执行轮次已结束，但没有结果摘要，请打开 DSH 会话查看。' };
  return { status: 'completed', code: 'COMPLETED', summary: safeSummary(reply, root) };
}
function pendingWork(events) {
  const inbox = { 'next-turn': [], 'next-step': [] };
  let open = false;
  for (const event of events) {
    if (event.type === 'turn/start') open = true;
    if (event.type === 'turn/end') open = false;
    if (event.type === 'agent/inbox/spliced') {
      const p = event.data;
      if (!(p.target in inbox) || !Number.isSafeInteger(p.start) || p.start < 0) return true;
      inbox[p.target].splice(p.start, p.removedCount || 0, ...(p.inserted || []));
    }
  }
  return open || inbox['next-turn'].length > 0 || inbox['next-step'].length > 0;
}
export class NativeHelpers {
  constructor(ctx, store) {
    this.ctx = ctx; this.store = store; this.mutations = Promise.resolve();
    this.running = new Map(); this.handles = new Map(); this.disposed = false;
  }
  mutate(operation) {
    const result = this.mutations.then(async () => {
      const state = structuredClone(await this.store.read() || {});
      state.nativeHelpers ||= { version: 1, jobs: {}, threads: {} };
      if (state.nativeHelpers.version !== 1) throw new Error('Unsupported helper state version');
      const answer = await operation(state.nativeHelpers);
      await this.store.write(state);
      return answer;
    });
    this.mutations = result.catch(() => {}); return result;
  }
  async lookup(input) {
    const state = await this.store.read() || {};
    const job = state.nativeHelpers?.jobs?.[keyOf(input.connectionId, input.resident, input.jobId ?? input.id)];
    if (!job || job.connectionId !== input.connectionId || job.resident !== input.resident || input.deviceId !== undefined && input.deviceId !== job.deviceId) throw new Error('Helper task is not bound to this resident.');
    return job;
  }
  async resolve(input) { return { sessionId: (await this.lookup(input)).sessionId }; }
  async status(input) { const job = await this.lookup(input); return { sessionId: job.sessionId, status: job.status, summary: job.summary || '', code: job.code || '' }; }
  async run(input, options = {}) {
    const onStarted = typeof options === 'function' ? options : options.onStarted;
    if (this.disposed) return { status: 'needs_you', code: 'PLUGIN_STOPPED', summary: '本机执行桥已停止。' };
    const connectionId = bounded(input.connectionId, 200, 'connection'), resident = bounded(input.resident, 24, 'resident');
    const deviceId = bounded(input.deviceId, 200, 'device'), id = bounded(input.id, 200, 'job');
    const thread = bounded(input.thread || id, 200, 'thread'), instruction = bounded(input.instruction, 12000, 'instruction');
    const jobKey = keyOf(connectionId, resident, id);
    if (this.running.has(jobKey)) return this.running.get(jobKey);
    const promise = this.perform({ ...input, connectionId, resident, deviceId, id, thread, instruction }, jobKey, onStarted);
    this.running.set(jobKey, promise);
    try { return await promise; } finally { if (this.running.get(jobKey) === promise) this.running.delete(jobKey); }
  }
  async perform(input, jobKey, onStarted) {
    let job;
    try {
      const grant = await this.store.workspace({ connectionId: input.connectionId, resident: input.resident, deviceId: input.deviceId });
      if (grant?.approved !== true) return { status: 'needs_you', code: 'WORKSPACE_REQUIRED', summary: '请先在可信 DSH 面板中选择并授权本机目录。' };
      const root = await approvedRoot(grant.path);
      if (input.workspace !== undefined && await approvedRoot(input.workspace) !== root) throw new Error('Workspace grant changed');
      const threadKey = keyOf(input.connectionId, input.resident, input.deviceId, input.thread, root);
      const reservation = await this.mutate(state => {
        const existing = state.jobs[jobKey];
        if (existing) {
          if (existing.deviceId !== input.deviceId || existing.thread !== input.thread || existing.workspace !== root || existing.instruction !== input.instruction) return { conflict: true };
          return { existing };
        }
        if (Object.values(state.jobs).some(value => value.threadKey === threadKey && (!FINAL.has(value.status) || value.code === 'OUTCOME_UNKNOWN'))) return { busy: true };
        const sessionId = state.threads[threadKey] || `session-aelios-${randomUUID()}`;
        const fresh = !state.threads[threadKey];
        job = { ...input, workspace: root, threadKey, sessionId, requestId: `aelios-job-${randomUUID()}`, status: 'preparing', createdAt: Date.now() };
        delete job.title;
        state.jobs[jobKey] = job; state.threads[threadKey] = sessionId;
        return { job, fresh };
      });
      if (reservation.conflict) return { status: 'needs_you', code: 'JOB_CONFLICT', summary: '任务标识与已有任务不一致，请检查后重新授权。' };
      if (reservation.busy) return { status: 'needs_you', code: 'THREAD_BUSY', summary: '同一线程仍有未确认任务，请先查看已有 DSH 会话。' };
      if (reservation.existing) {
        const existing = reservation.existing;
        return FINAL.has(existing.status) ? { sessionId: existing.sessionId, status: existing.status, code: existing.code, summary: existing.summary } : { sessionId: existing.sessionId, status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '此任务已经登记，结果尚不确定；请打开已有会话检查，不会自动重跑。' };
      }
      job = reservation.job;
      if (this.disposed) throw new Error('Bridge stopped');
      let agent = this.ctx.agents.get(job.sessionId);
      if (agent && (agent.session.header.cwd !== root || agent.session.header.agentPreset !== HELPER_PRESET)) throw new Error('Session binding changed');
      if (agent?.status === 'running') throw new Error('Session is busy');
      const setup = async (agentCtx, created) => {
        await this.ctx.agentPresets.mount(agentCtx, HELPER_PRESET);
        pinHelperPolicy(created.session);
      };
      if (!agent) {
        const options = { agentOptions: { ...this.ctx.agentDefaultModel.currentSelection() }, setup };
        let handle;
        if (reservation.fresh) {
          handle = await this.ctx.agents.create({ ...options, sessionId: job.sessionId, meta: { cwd: root, agentPreset: HELPER_PRESET } });
        } else {
          const old = await this.ctx.sessionController.inspect(job.sessionId);
          if (old.meta.cwd !== root || old.meta.agentPreset !== HELPER_PRESET || pendingWork(old.events)) throw new Error('Session requires reconciliation');
          handle = await this.ctx.agents.resume({ ...options, resumeSessionId: job.sessionId });
        }
        if (this.disposed) { await handle.dispose(); throw new Error('Bridge stopped'); }
        this.handles.set(job.sessionId, handle); agent = handle.agent;
      }
      if (!agent.options?.provider || !agent.options?.model) throw new Error('No selected model');
      // The mapping is already durable. Record the started event before waking a model.
      if (onStarted) await onStarted(job.sessionId);
      if (this.disposed) throw new Error('Bridge stopped');
      const before = agent.session.snapshotEvents();
      if (requestPresent(before, job.requestId)) throw new Error('Request is already present');
      await this.mutate(state => { state.jobs[jobKey].status = 'running'; });
      await this.ctx.sessionController.prompt({ sessionId: job.sessionId, requestId: job.requestId, mode: 'queue', content: [{ type: 'text', text: job.instruction }] }, new AbortController().signal);
      // No foreground navigation is performed here. UI opens this ordinary session only on user action.
      await agent.whenIdle();
      const result = outcomeFromEvents(agent.session.snapshotEvents(), job.requestId, root);
      await this.ctx.sessionPersistence.flush();
      await this.mutate(state => { Object.assign(state.jobs[jobKey], result, { finishedAt: Date.now() }); });
      return { sessionId: job.sessionId, ...result };
    } catch {
      const result = { status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '本机任务未能确认完成，请打开已有 DSH 会话检查；不会自动重跑。' };
      if (job) await this.mutate(state => { if (state.jobs[jobKey]) Object.assign(state.jobs[jobKey], result); }).catch(() => {});
      return { ...(job ? { sessionId: job.sessionId } : {}), ...result };
    }
  }
  async stop(input) {
    const job = await this.lookup(input);
    this.ctx.agents.get(job.sessionId)?.cancel({ kind: 'user' });
    return { sessionId: job.sessionId, requested: true };
  }
  async stopBinding({ connectionId, resident, deviceId }) {
    const sessionIds = await this.mutate(state => {
      const ids = new Set();
      for (const job of Object.values(state.jobs)) {
        if (job.connectionId !== connectionId || job.resident !== resident || deviceId !== undefined && job.deviceId !== deviceId) continue;
        ids.add(job.sessionId);
        if (!FINAL.has(job.status)) Object.assign(job, { status: 'needs_you', code: 'BINDING_DISABLED', summary: '本机目录授权已停用，请检查原会话后再继续。' });
      }
      return [...ids];
    });
    for (const sessionId of sessionIds) {
      this.ctx.agents.get(sessionId)?.cancel({ kind: 'user' });
      const handle = this.handles.get(sessionId);
      if (handle) {
        this.handles.delete(sessionId);
        void handle.dispose().catch(() => {});
      }
    }
    return { sessionIds };
  }
  async dispose() {
    this.disposed = true;
    for (const handle of this.handles.values()) handle.agent.cancel({ kind: 'disposed' });
    await this.mutate(state => { for (const job of Object.values(state.jobs)) if (!FINAL.has(job.status)) Object.assign(job, { status: 'needs_you', code: 'OUTCOME_UNKNOWN', summary: '本机执行桥已停止，请检查原会话后再继续。' }); });
    // Cordis owns exact handle teardown. Observe disposal without blocking plugin teardown on an uncooperative provider.
    for (const handle of this.handles.values()) void handle.dispose().catch(() => {});
    this.handles.clear();
  }
}
