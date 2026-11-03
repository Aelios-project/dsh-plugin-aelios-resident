import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DesktopProxy, proxyTarget, boundedBytes } from '../desktop-proxy.js';
const connection = { url: 'https://resident.example', key: 'synthetic-web-key', connectionId: 'connection-1' };

test('proxy constrains origin, path, method, and desktop authority', () => {
  assert.equal(proxyTarget(connection.url, '/r/alice/web/messages?since=a', 'GET').url.origin, connection.url);
  assert.equal(proxyTarget(connection.url, '/web/say', 'POST').authenticated, true);
  assert.equal(proxyTarget(connection.url, '/r/alice/avatar/avatar-a').authenticated, false);
  for (const path of ['//evil.example/web/messages', '/web/../tasks/id/hands', '/web/%2e%2e/tasks', '/web%2fconfig', '/tasks/id/hands', '/desktop/v1/claim', '/sw.js', '/web/messages#x', '/\\evil/web/messages']) assert.throws(() => proxyTarget(connection.url, path));
  assert.throws(() => proxyTarget(connection.url, '/web/config', 'TRACE'));
  assert.throws(() => proxyTarget(connection.url, '/web/desktop/register', 'POST'));
  assert.throws(() => proxyTarget(connection.url, '/r/alice/web/desktop/revoke', 'POST'));
  assert.ok(proxyTarget(connection.url, '/r/alice/web/desktop', 'GET'));
});
test('fixed Host key replaces browser headers; binary bodies and responses survive', async () => {
  const calls = [];
  const proxy = new DesktopProxy({ async connection() { return connection; } }, async (url, options) => {
    calls.push({ url, options }); return new Response(new Uint8Array([0, 1, 128, 255]), { headers: { 'content-type': 'image/png' } });
  });
  const input = { connectionId: connection.connectionId, path: '/web/avatar', method: 'POST', bodyBase64: Buffer.from([0, 255]).toString('base64'), contentType: 'image/png', headers: { 'x-web-key': 'forged' } };
  const value = await proxy.fetch(input);
  assert.equal(calls[0].options.headers['x-web-key'], connection.key);
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual([...calls[0].options.body], [0, 255]);
  assert.deepEqual([...Buffer.from(value.bodyBase64, 'base64')], [0, 1, 128, 255]);
  assert.equal(value.contentType, 'image/png');
  assert.ok(!JSON.stringify(value).includes(connection.key));
  await assert.rejects(proxy.fetch({ ...input, connectionId: 'old' }), { code: 'STALE_CONNECTION' });
  await assert.rejects(proxy.fetch({ ...input, bodyBase64: 'invalid-base64!' }), { code: 'BAD_BODY' });
});
test('redirect attempts never forward web key to another origin', async () => {
  let targetCalls = 0;
  const target = http.createServer((req, res) => { targetCalls++; res.end('no'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const origin = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/steal` }); res.end(); });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  try {
    const local = { ...connection, url: `http://127.0.0.1:${origin.address().port}` };
    const proxy = new DesktopProxy({ async connection() { return local; } });
    await assert.rejects(proxy.fetch({ connectionId: local.connectionId, path: '/web/messages' }), { code: 'NETWORK' });
    assert.equal(targetCalls, 0);
  } finally { await Promise.all([new Promise(r => origin.close(r)), new Promise(r => target.close(r))]); }
});
test('streamed response cap applies without trusting content length', async () => {
  await assert.rejects(boundedBytes(new Response(new Uint8Array(100)), 10), { code: 'TOO_LARGE' });
});
test('real original UI document is isolated and has no real credential or Service Worker script', async () => {
  const proxy = new DesktopProxy({ async connection() { return connection; } });
  const { html } = await proxy.document({ connectionId: connection.connectionId, nonce: '11111111-1111-4111-8111-111111111111' });
  assert.ok(html.includes('x-data="resident()"'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(html.includes('data:text/javascript;base64,'));
  assert.ok(!html.includes('src="/app.js"'));
  assert.ok(!html.includes(connection.key));
  assert.ok(!html.includes('src="/sw.js"'));
  assert.ok(html.includes('window.ResidentDesktop'));
});
