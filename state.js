import { BridgeError } from './bridge.js';

export class CredentialState {
  constructor(credentials, key, initial = {}) { this.credentials = credentials; this.key = key; this.initial = initial; this.mutations = Promise.resolve(); }
  serialize(operation) {
    const result = this.mutations.then(operation);
    this.mutations = result.catch(() => {});
    return result;
  }
  async read() {
    await this.mutations;
    const record = await this.credentials.readRecord(this.key);
    return structuredClone(record?.kind === 'grant' ? record.payload : this.initial);
  }
  update(change) {
    return this.serialize(async () => {
      let value;
      await this.credentials.modifyRecord(this.key, async record => {
        const state = structuredClone(record?.kind === 'grant' ? record.payload : this.initial);
        value = await change(state);
        return { kind: 'grant', payload: state };
      });
      return value;
    });
  }
  write(value) { return this.serialize(() => this.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload: structuredClone(value) }))); }
}

export function requireConnection(connection, id) {
  if (!connection || !id || id !== connection.connectionId) throw new BridgeError('STALE_CONNECTION', '连接已改变，请重新打开住民面板。', 409);
  return connection;
}
