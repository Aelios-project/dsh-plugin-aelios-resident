import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { HELPER_PRESET } from '../helper.js';

test('Host owns portable helper preset registration after authorization service publication', async () => {
  const effects = [], services = new Map();
  let registered, disposed = false;
  const exactDisposer = async () => { disposed = true; };
  apply({
    credentials: {},
    provide(name, value) { services.set(name, value); },
    effect(callback) { effects.push(callback); },
    agentPresets: { async register(definition) {
      assert.equal(typeof services.get('aeliosDesktop')?.authorizeSession, 'function');
      registered = definition;
      return exactDisposer;
    } }
  });
  // The first owned effect registers the preset; background polling does not run in this test.
  const cleanup = await effects[0]();
  assert.equal(cleanup, exactDisposer);
  assert.equal(registered.id, HELPER_PRESET);
  assert.equal(registered.plugins.length, 1);
  assert.equal(registered.plugins[0].name, new URL('../helper.js', import.meta.url).href);
  assert.equal(new URL(registered.plugins[0].name).protocol, 'file:');
  await cleanup(); assert.equal(disposed, true);
});
