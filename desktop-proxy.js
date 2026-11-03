import { readFile } from 'node:fs/promises';
import { BridgeError } from './bridge.js';
import { requireConnection } from './state.js';

const MAX_BYTES = 32 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const PUBLIC = /^(?:\/(?:models\.json|icon-192\.png|icon-512\.png|manifest\.webmanifest)|(?:\/r\/[a-z][a-z0-9-]{0,23})?\/(?:avatar|stickers)\/[A-Za-z0-9_./-]+)$/;
export function proxyTarget(origin, path, method = 'GET') {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || path.startsWith('//') || /[\\#\x00-\x20]/.test(path)) throw new BridgeError('BAD_PATH', '不支持的住民地址。');
  if (/%(?:2f|5c|2e)/i.test(path.split('?')[0]) || path.split('?')[0].split('/').some(p => p === '.' || p === '..')) throw new BridgeError('BAD_PATH', '不支持的住民地址。');
  if (!METHODS.has(method)) throw new BridgeError('BAD_METHOD', '不支持的请求方式。');
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new BridgeError('BAD_PATH', '请求不能离开当前住民站点。');
  const api = /^(?:\/r\/[a-z][a-z0-9-]{0,23})?\/web\/[A-Za-z0-9_/-]+$/.test(url.pathname);
  if (!api && !(method === 'GET' && PUBLIC.test(url.pathname))) throw new BridgeError('BAD_PATH', '这个地址不属于住民界面。');
  if (/\/web\/desktop(?:\/|$)/.test(url.pathname) && !(method === 'GET' && url.pathname.endsWith('/web/desktop'))) throw new BridgeError('USER_ONLY', '本机设备授权请在 DSH 的连接设置中操作。', 403);
  return { url, authenticated: api };
}
export async function boundedBytes(response, max = MAX_BYTES) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) throw new BridgeError('TOO_LARGE', '内容过大，请在完整网页中打开。', 413);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
export class DesktopProxy {
  constructor(bridge, request = fetch) { this.bridge = bridge; this.request = request; }
  async fetch(input, signal) {
    const connection = requireConnection(await this.bridge.connection(), input.connectionId);
    const method = input.method || 'GET', { url, authenticated } = proxyTarget(connection.url, input.path, method);
    let body;
    if (input.bodyBase64 !== undefined) {
      if (method === 'GET' || typeof input.bodyBase64 !== 'string' || input.bodyBase64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bodyBase64)) throw new BridgeError('BAD_BODY', '请求内容格式不正确。');
      body = Buffer.from(input.bodyBase64, 'base64');
    }
    const headers = authenticated ? { 'x-web-key': connection.key } : {};
    if (body) headers['content-type'] = typeof input.contentType === 'string' && input.contentType.length < 128 && !/[\r\n]/.test(input.contentType) ? input.contentType : 'application/octet-stream';
    let response;
    try {
      const timeout = AbortSignal.timeout(method === 'GET' ? 30000 : 180000);
      response = await this.request(url, { method, headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch { throw new BridgeError('NETWORK', method === 'GET' ? '连接住民失败，请稍后刷新。' : '连接中断，操作结果尚不确定，请先刷新确认。', 502); }
    const bytes = await boundedBytes(response);
    return { status: response.status, contentType: response.headers.get('content-type') || 'application/octet-stream', bodyBase64: bytes.toString('base64') };
  }
  async document(input) {
    const connection = requireConnection(await this.bridge.connection(), input.connectionId);
    if (typeof input.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.nonce)) throw new BridgeError('BAD_NONCE', '界面握手无效。');
    let html = await readFile(new URL('./ui/index.html', import.meta.url), 'utf8');
    const bootstrap = await readFile(new URL('./frame-bootstrap.js', import.meta.url), 'utf8');
    const config = JSON.stringify({ nonce: input.nonce, origin: connection.url }).replace(/</g, '\\u003c');
    const csp = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data:; style-src 'unsafe-inline' data:; img-src data: blob: ${connection.url}; media-src data: blob: ${connection.url}; font-src data:; frame-src about: blob:; connect-src 'none'; base-uri ${connection.url}; form-action 'none'`;
    html = html.replace('<head>', `<head><base href="${connection.url}/"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>window.__RESIDENT_FRAME__=${config};\n${bootstrap.replace(/<\/script/gi, '<\\/script')}</script>`);
    for (const file of ['markdown.js', 'group.js', 'app.js', 'desktop.js', 'vendor/alpine-3.14.9.min.js']) {
      const asset = await readFile(new URL('./ui/' + file, import.meta.url));
      html = html.replaceAll(`src="/${file}"`, `src="data:text/javascript;base64,${asset.toString('base64')}"`);
    }
    const css = await readFile(new URL('./ui/app.css', import.meta.url));
    html = html.replace('href="/app.css"', `href="data:text/css;base64,${css.toString('base64')}"`);
    return { html, protocol: 'resident-dsh/1' };
  }
}
