/* Production adapter inside the opaque Resident document; never runs in the DSH parent. */
(function () {
  'use strict';
  const config = window.__RESIDENT_FRAME__;
  const protocol = 'resident-dsh/1';
  let port, sequence = 0, acceptReady;
  const pending = new Map();
  const ready = new Promise(resolve => { acceptReady = resolve; });
  function receive(event) {
    if (event.source !== parent || event.data?.protocol !== protocol || event.data?.nonce !== config.nonce || event.data?.type !== 'attach' || !event.ports[0] || port) return;
    port = event.ports[0];
    port.onmessage = function (message) {
      const data = message.data;
      if (!data || data.protocol !== protocol || !Number.isSafeInteger(data.id)) return;
      const request = pending.get(data.id); if (!request) return;
      pending.delete(data.id); clearTimeout(request.timer);
      data.ok ? request.resolve(data.value) : request.reject(new Error(typeof data.error === 'string' ? data.error : '桌面连接失败'));
    };
    port.start(); window.removeEventListener('message', receive); acceptReady();
  }
  window.addEventListener('message', receive);
  async function request(action, payload) {
    await ready;
    if (pending.size >= 64) throw new Error('桌面请求过多，请稍后重试');
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('桌面连接超时；请先刷新确认操作结果')); }, 190000);
      pending.set(id, { resolve, reject, timer });
      port.postMessage({ protocol, id, action, payload: payload || {} });
    });
  }
  async function encode(value) {
    if (value === undefined || value === null) return undefined;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value)
      : value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    if (!bytes || bytes.byteLength > 32 * 1024 * 1024) throw new Error('请求内容过大或格式不受支持');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  async function cloudFetch(input, options) {
    const opts = options || {};
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, config.origin);
    if (url.origin !== config.origin) throw new Error('桌面请求不能离开当前住民站点');
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const value = await request('fetch', { path: url.pathname + url.search, method: opts.method || 'GET', contentType: new Headers(opts.headers).get('content-type'), bodyBase64: await encode(opts.body) });
    const bytes = Uint8Array.from(atob(value.bodyBase64), c => c.charCodeAt(0));
    return new Response([101, 204, 205, 304].includes(value.status) ? null : bytes, { status: value.status, headers: { 'content-type': value.contentType } });
  }
  window.ResidentDesktop = Object.freeze({ protocol, origin: config.origin, ready, request, fetch: cloudFetch });
  function external(value) {
    const url = new URL(String(value), config.origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    request('external.open', { url: url.href }).catch(() => {});
  }
  // Preserve external links without giving the opaque document popup or top-navigation authority.
  window.open = function (url) { external(url); return null; };
  document.addEventListener('click', function (event) {
    const link = event.target?.closest?.('a[href]');
    if (!link || event.defaultPrevented) return;
    const url = new URL(link.getAttribute('href'), config.origin);
    if (['https:', 'http:'].includes(url.protocol) && (link.target === '_blank' || url.origin !== config.origin)) { event.preventDefault(); external(url.href); }
  });
  window.fetch = cloudFetch;
})();
