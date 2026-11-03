import { API_PATH, BridgeError, ResidentBridge, residentPath } from './bridge.js';
import { CredentialState, requireConnection } from './state.js';
import { DesktopProxy } from './desktop-proxy.js';
import { NativeHelpers } from './helper-runtime.js';
import { DeviceRunner, initialDeviceState } from './device-runner.js';

export const inject = ['connection', 'credentials', 'tools', 'agents', 'agentPresets', 'agentDefaultModel', 'sessionController', 'sessionPersistence'];
export function apply(ctx) {
  const bridge = new ResidentBridge(ctx.credentials), proxy = new DesktopProxy(bridge);
  const deviceState = new CredentialState(ctx.credentials, 'aelios-resident/desktop-state', initialDeviceState());
  const helperState = new CredentialState(ctx.credentials, 'aelios-resident/helper-state');
  let runner;
  const helpers = new NativeHelpers(ctx, {
    read: () => helperState.read(), write: next => helperState.write(next),
    workspace: input => runner.workspace(input)
  });
  runner = new DeviceRunner(bridge, helpers, deviceState);
  const facade = {
    async authorizeSession({ sessionId, workspace }) {
      const records = (await helperState.read()).nativeHelpers?.jobs || {};
      const connection = await bridge.connection();
      if (!connection) return false;
      for (const job of Object.values(records)) {
        if (job.sessionId !== sessionId || job.connectionId !== connection.connectionId || job.workspace !== workspace) continue;
        const grant = await runner.workspace(job);
        if (grant?.approved && grant.path === workspace) return true;
      }
      return false;
    },
    async stopConnection(connectionId) {
      const data = await helperState.read(), jobs = Object.values(data.nativeHelpers?.jobs || {});
      const seen = new Set();
      for (const job of jobs) {
        if (job.connectionId !== connectionId || seen.has(job.sessionId)) continue;
        seen.add(job.sessionId);
        await helpers.stop({ connectionId, resident: job.resident, jobId: job.id }).catch(() => {});
      }
    },
    async disconnect() {
      const connection = await bridge.connection(), data = await deviceState.read();
      await deviceState.update(state => { for (const binding of Object.values(state.bindings || {})) binding.enabled = false; });
      if (connection) {
        await facade.stopConnection(connection.connectionId);
        await Promise.allSettled(Object.values(data.bindings || {}).filter(b => b.connectionId === connection.connectionId).map(binding =>
          bridge.upstream(connection, residentPath(binding.resident) + '/web/desktop/revoke', { body: { deviceId: binding.deviceId }, signal: AbortSignal.timeout(10000) })));
      }
      return bridge.disconnect();
    },
    async run(input, signal) {
      if (input.action === 'connect') {
        // A successful replacement invalidates old workspace grants through connectionId.
        const old = await bridge.connection(), value = await bridge.connect(input, signal);
        if (old) await facade.stopConnection(old.connectionId);
        return value;
      }
      if (input.action === 'disconnect') return facade.disconnect();
      if (input.action === 'desktop.status') return runner.snapshot();
      if (input.action === 'desktop.document') return proxy.document(input);
      if (input.action === 'desktop.proxy') return proxy.fetch(input, signal);
      if (input.action === 'native.enable') return runner.enable(input, signal);
      if (input.action === 'native.disable') return runner.disable(input);
      if (input.action === 'native.devices') {
        const connection = requireConnection(await bridge.connection(), input.connectionId);
        return bridge.upstream(connection, residentPath(input.resident) + '/web/desktop', { signal });
      }
      if (input.action === 'helper.resolve') {
        requireConnection(await bridge.connection(), input.connectionId); residentPath(input.resident);
        return helpers.resolve(input);
      }
      if (input.action === 'helper.stop') {
        requireConnection(await bridge.connection(), input.connectionId); residentPath(input.resident);
        return helpers.stop(input);
      }
      return bridge.run(input, signal);
    }
  };
  ctx.provide('aeliosResident', bridge);
  ctx.provide('aeliosDesktop', facade);
  ctx.effect(() => {
    const abort = new AbortController();
    void runner.start(abort.signal).catch(() => {});
    return () => { abort.abort(); void helpers.dispose().catch(() => {}); };
  });
  ctx.effect(() => ctx.connection.fetch.register({
    path: API_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      try {
        if (!(request.headers.get('content-type') || '').startsWith('application/json')) return Response.json({ error: '需要 JSON 请求。' }, { status: 415, headers });
        const text = await request.text();
        if (Buffer.byteLength(text) > 45 * 1024 * 1024) throw new BridgeError('TOO_LARGE', '请求内容过大。', 413);
        let input;
        try { input = JSON.parse(text); } catch { throw new BridgeError('INVALID_JSON', '请求格式无效。'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('INVALID_INPUT', '请求格式无效。');
        const value = await facade.run(input, request.signal);
        return Response.json(value, { headers });
      } catch (error) {
        return Response.json({ error: error instanceof BridgeError ? error.message : '桌面连接暂时无法处理请求。', code: error instanceof BridgeError ? error.code : 'INTERNAL' }, { status: error instanceof BridgeError ? error.status : 500, headers });
      }
    }
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'aelios_resident',
    description: 'Read connected Aelios residents and their shared cloud conversations, search history, or send a message when the user asks to contact a resident. Returns at most 200 recent messages. Connect the service through the Aelios panel first.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'residents', 'messages', 'search', 'say'] },
        resident: { type: 'string', description: 'Resident ID from residents; defaults to default.' },
        text: { type: 'string', description: 'Message to send for say; 1–4000 characters.' },
        query: { type: 'string', description: 'Search text for search; 1–50 characters.' },
        limit: { type: 'integer', description: 'Recent messages for messages; 1–200, default 100.' }
      }, required: ['action']
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => args?.action !== 'say',
    execute: (args, execution) => bridge.run(args, execution.signal)
  }));
}
