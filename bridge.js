// Cloud Resident is authoritative. This adapter keeps only the connection credential.
export const CONNECTION_KEY = 'aelios-resident/connection';
export const API_PATH = '/api/aelios-resident';
const ID = /^(?:default|[a-z][a-z0-9-]{0,23})$/;
export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function normalizeOrigin(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new BridgeError('INVALID_URL', '请输入住民网页的完整 HTTPS 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new BridgeError('INVALID_URL', '地址只填网站根地址；使用 HTTPS，不带钥匙、路径或查询参数。');
  }
  return url.origin;
}
export function residentPath(id = 'default') {
  if (typeof id !== 'string' || !ID.test(id)) throw new BridgeError('INVALID_RESIDENT', '住民代号无效。');
  return id === 'default' ? '' : `/r/${id}`;
}
export class ResidentBridge {
  constructor(credentials, request = fetch) { this.credentials = credentials; this.request = request; this.generation = 0; this.connecting = false; this.mutations = Promise.resolve(); }
  mutate(operation) {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }
  async connection() {
    const record = await this.credentials.readRecord(CONNECTION_KEY);
    const data = record?.kind === 'grant' ? record.payload : null;
    if (!data || typeof data.url !== 'string' || typeof data.key !== 'string') return null;
    return { url: normalizeOrigin(data.url), key: data.key, connectionId: typeof data.connectionId === 'string' ? data.connectionId : '' };
  }
  async status() {
    const data = await this.connection();
    return { connected: Boolean(data), url: data?.url ?? '', connectionId: data?.connectionId ?? '', generation: this.generation };
  }
  async upstream(connection, path, { body, signal } = {}) {
    const timeout = AbortSignal.timeout(body ? 180000 : 20000);
    let response;
    try {
      response = await this.request(connection.url + path, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'x-web-key': connection.key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch {
      if (signal?.aborted) throw new BridgeError('CANCELLED', '请求已取消；发出的消息请先刷新确认，避免重复发送。', 499);
      throw new BridgeError('NETWORK', body ? '连接中断或超时，发送结果尚不确定。请先刷新聊天确认，勿直接重发。' : '无法连接住民，请检查地址与网络；服务需要能从 DSH 所在电脑访问。', 502);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BridgeError(response.status === 401 ? 'UNAUTHORIZED' : 'UPSTREAM', response.status === 401 ? '网页钥匙无效，请重新连接。' : `住民服务返回 ${response.status}，请在完整网页检查服务状态。`, response.status === 401 ? 401 : 502);
    }
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
      await response.body?.cancel();
      throw new BridgeError('NOT_JSON', '地址返回了网页而非住民接口，请检查是否被登录页或代理拦截。', 502);
    }
    // Limit bytes while streaming, rather than trusting Content-Length.
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new BridgeError('TOO_LARGE', '聊天内容过大，请在完整网页中查看。', 502);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('NETWORK', '读取中断，请刷新确认最新状态。', 502);
    } finally { reader.releaseLock(); }
    let data;
    try {
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new BridgeError('BAD_RESPONSE', '住民返回的内容无法读取。', 502); }
    if (data?.error) throw new BridgeError('RESIDENT_ERROR', '住民未完成请求，请打开完整网页检查。', 502);
    return data;
  }
  async connect(input, signal) {
    if (this.connecting) throw new BridgeError('BUSY', '正在连接，请稍后再试。', 409);
    const url = normalizeOrigin(input.url);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new BridgeError('INVALID_KEY', '请输入有效的网页钥匙。');
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const check = await this.upstream({ url, key }, '/web/check', { signal });
      if (check?.ok !== true) throw new BridgeError('BAD_RESPONSE', '这个地址没有返回有效的住民身份。', 502);
      if (generation !== this.generation) throw new BridgeError('CANCELLED', '连接已取消。', 409);
      const connectionId = crypto.randomUUID();
      await this.mutate(async () => {
        if (generation !== this.generation) throw new BridgeError('CANCELLED', '连接已取消。', 409);
        await this.credentials.modifyRecord(CONNECTION_KEY, async () => ({ kind: 'grant', payload: { url, key, connectionId } }));
      });
      if (generation !== this.generation) throw new BridgeError('CANCELLED', '连接已取消。', 409);
      return { connected: true, url, connectionId, generation, identity: check };
    } finally { this.connecting = false; }
  }
  async disconnect() {
    ++this.generation;
    await this.mutate(() => this.credentials.deleteRecord(CONNECTION_KEY));
    return { connected: false, url: '' };
  }
  async run(input, signal) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('INVALID_INPUT', '请求格式无效。');
    if (input.action === 'status') return this.status();
    const allowed = ['residents', 'messages', 'say', 'search'];
    if (!allowed.includes(input.action)) throw new BridgeError('INVALID_ACTION', '不支持的操作。');
    const connection = await this.connection();
    if (!connection) throw new BridgeError('NOT_CONNECTED', '先在 Aelios 住民面板连接你的网页门。', 409);
    if (input.connectionId !== undefined && input.connectionId !== connection.connectionId) throw new BridgeError('CONNECTION_CHANGED', '连接已在另一台设备上更改，请刷新后再操作。', 409);
    if (input.action === 'residents') return this.upstream(connection, '/web/residents', { signal });
    const prefix = residentPath(input.resident ?? 'default');
    if (input.action === 'messages') {
      const limit = input.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BridgeError('INVALID_LIMIT', '消息数量须为 1 到 200。');
      const since = typeof input.since === 'string' && input.since.length <= 200 ? input.since : '';
      const data = await this.upstream(connection, prefix + '/web/messages' + (since ? `?since=${encodeURIComponent(since)}` : ''), { signal });
      if (data.same === true) return data;
      if (!Array.isArray(data.data) || typeof data.rev !== 'string') throw new BridgeError('BAD_RESPONSE', '住民聊天格式不兼容。', 502);
      return { ...data, data: data.data.slice(-limit), omitted: Math.max(0, data.data.length - limit) };
    }
    if (input.action === 'search') {
      const q = typeof input.query === 'string' ? input.query.trim() : '';
      if (!q || q.length > 50) throw new BridgeError('INVALID_QUERY', '搜索词为 1 到 50 个字。');
      return this.upstream(connection, prefix + '/web/search?q=' + encodeURIComponent(q), { signal });
    }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.trim().length > 4000) throw new BridgeError('INVALID_TEXT', '消息为 1 到 4000 个字。');
    const result = await this.upstream(connection, prefix + '/web/say', { body: { text: input.text.trim() }, signal });
    if (!['completed', 'empty'].includes(result.status)) throw new BridgeError('UNCERTAIN', '住民尚未确认完成。请刷新聊天检查，不要自动重发。', 502);
    return result;
  }
}
