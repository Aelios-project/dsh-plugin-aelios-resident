window.__ModuleLoader__.load({ id: '@aelios/dsh-resident', factory(require) {
  const exports = {};
  const React = require('react');
  const { createElement: h, useState, useEffect, useRef, useSyncExternalStore } = React;
  const protocol = 'resident-dsh/1', panel = 'aelios-resident';
  const dicts = {
    en: { title: 'Aelios Residents', connect: 'Connect', site: 'Resident website', key: 'Web door key', connecting: 'Connecting…', settings: 'Connection & helpers', close: 'Close', full: 'Full website', dsh: 'DSH conversations', back: 'Back to Resident', disconnect: 'Disconnect', choose: 'Choose workspace', enable: 'Enable full-access helper', disable: 'Disable helper', resident: 'Resident', helper: 'Local helper', readonly: 'Full access lets this helper read and change files, execute commands, install dependencies and use DSH tools on the computer running DSH. The workspace is its starting directory, not a filesystem sandbox.', browse: 'Browse the DSH computer', here: 'Use this folder', home: 'Home', parent: 'Parent folder', cancel: 'Cancel', truncated: 'Some folders are omitted; enter a path to browse further.', directoryPath: 'Directory path', openPath: 'Open path', legacyGrant: 'Existing read-only grant. Disable it, then choose a folder and enable full access.', first: 'Connect your existing Resident. Its original conversation, residents, threads and settings appear here.', none: 'Choose a local folder before enabling a helper.', enabled: 'Full-access helper enabled', loading: 'Opening Resident…', retry: 'Reload', limits: 'Use the full website for microphone recording and system notifications.', legacy: 'Your website needs the DSH desktop code PR before local helpers can connect.', revoked: 'Revoke device', devices: 'Registered devices', busy: 'Working…', external: 'Open external link' },
    zh: { title: 'Aelios 住民', connect: '连接', site: '住民网页地址', key: '网页钥匙', connecting: '正在连接…', settings: '连接与本机帮手', close: '收起', full: '完整网页', dsh: 'DSH 会话', back: '回到住民', disconnect: '断开连接', choose: '选择工作区', enable: '开启完整本机帮手', disable: '停用帮手', resident: '住民', helper: '本机帮手', readonly: '完整权限允许帮手在运行 DSH 的电脑上读写文件、执行命令、安装依赖和使用 DSH 工具。所选工作区是起始目录，不是文件系统隔离边界。', browse: '浏览 DSH 电脑的目录', here: '使用这个文件夹', home: '主目录', parent: '上级目录', cancel: '取消', truncated: '部分目录未列出，可以输入完整路径继续浏览。', directoryPath: '目录路径', openPath: '打开路径', legacyGrant: '当前是旧的只读授权。先停用，再选择目录并开启完整权限。', first: '连接已有的住民，在这里使用原来的对话、住户列表、线程和设置。', none: '先选择一个本机文件夹，再开启帮手。', enabled: '完整本机帮手已开启', loading: '正在打开住民…', retry: '重新加载', limits: '语音录制与系统通知请在完整网页使用。', legacy: '住民网站需要先应用 DSH 桌面代码 PR，才能连接本机帮手。', revoked: '撤销设备', devices: '已注册设备', busy: '正在处理…', external: '打开外部链接' }
  };
  exports.inject = ['slots', 'layout', 'locale', 'uiWorkspace'];
  exports.apply = function (ctx) {
    for (const [locale, words] of Object.entries(dicts)) ctx.effect(() => ctx.locale.register('aelios.desktop', locale, words));
    const translate = ctx.locale.bind('aelios.desktop');
    let selectedResident = 'default';
    function words() { useSyncExternalStore(fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot()); return translate; }
    async function api(input) {
      const response = await fetch('/api/aelios-resident', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Desktop request failed');
      return result;
    }
    function saveMode(value) { try { sessionStorage.setItem('aelios.desktop.mode', value); } catch {} }
    function openResident() { saveMode('resident'); ctx.layout.selectPanel(panel); }
    function Nav({ size = 18 }) { return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('path', { d: 'M3 11 12 3l9 8M6 10v11h12V10M10 21v-7h4v7' })); }
    function Back() { const t = words(); return h('button', { type: 'button', onClick: openResident, style: { color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' } }, t('back')); }
    function Panel() {
      const t = words();
      const [state, setState] = useState(null), [url, setUrl] = useState(''), [key, setKey] = useState('');
      const [settings, setSettings] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
      const [people, setPeople] = useState([]), [resident, setResident] = useState(selectedResident), [workspace, setWorkspace] = useState('');
      const [externalLink, setExternalLink] = useState('');
      const [directoryOpen, setDirectoryOpen] = useState(false), [directory, setDirectory] = useState(null), [directoryBusy, setDirectoryBusy] = useState(false), [directoryError, setDirectoryError] = useState(''), [directoryPath, setDirectoryPath] = useState('');
      const browseRequest = useRef(0);
      async function browse(path) {
        const request = ++browseRequest.current;
        setDirectoryBusy(true); setDirectoryError('');
        try {
          const listing = await ctx.uiWorkspace.listDirectory(path);
          if (live.current && request === browseRequest.current) { setDirectory(listing); setDirectoryPath(listing.path); }
        } catch (e) { if (live.current && request === browseRequest.current) setDirectoryError(e.message); }
        finally { if (live.current && request === browseRequest.current) setDirectoryBusy(false); }
      }
      function closeBrowser() { browseRequest.current++; setDirectoryOpen(false); setDirectory(null); setDirectoryBusy(false); setDirectoryError(''); }

      const [devices, setDevices] = useState([]), [document, setDocument] = useState(null), [revision, setRevision] = useState(0);
      const iframe = useRef(), channel = useRef(), live = useRef(false), nonce = useRef(crypto.randomUUID()), current = useRef();
      current.current = { state, resident };
      function draftKey(id, person) { return `aelios.desktop.draft:${id}:${person}`; }
      function recallDraft(id, person) { try { return sessionStorage.getItem(draftKey(id, person)) || ''; } catch { return ''; } }
      useEffect(() => {
        live.current = true;
        let timer;
        async function refresh() {
          try {
            const value = await api({ action: 'desktop.status' });
            if (!live.current) return;
            setState(value); if (value.connected) setUrl(value.url);
          } catch (e) { if (live.current) setError(e.message); }
          if (live.current) timer = setTimeout(refresh, 5000);
        }
        refresh();
        return () => { live.current = false; clearTimeout(timer); channel.current?.close(); };
      }, []);
      useEffect(() => {
        if (!state?.connected) { setDocument(null); return; }
        let cancelled = false;
        nonce.current = crypto.randomUUID();
        setDocument(null);
        api({ action: 'desktop.document', connectionId: state.connectionId, nonce: nonce.current }).then(value => { if (!cancelled) setDocument(value.html); }).catch(e => { if (!cancelled) setError(e.message); });
        api({ action: 'residents', connectionId: state.connectionId }).then(value => { if (!cancelled) setPeople(value.residents || []); }).catch(() => {});
        return () => { cancelled = true; channel.current?.close(); };
      }, [state?.connected, state?.connectionId, revision]);
      useEffect(() => {
        if (!settings || !state?.connected) return;
        let cancelled = false;
        api({ action: 'native.devices', resident, connectionId: state.connectionId }).then(value => { if (!cancelled) setDevices(value.devices || []); }).catch(() => { if (!cancelled) setDevices([]); });
        return () => { cancelled = true; };
      }, [settings, resident, state?.connectionId, state?.bindings?.length, busy]);
      async function act(operation) {
        if (busy) return;
        setBusy(true); setError('');
        try { await operation(); if (live.current) setState(await api({ action: 'desktop.status' })); }
        catch (e) { if (live.current) setError(e.message); }
        finally { if (live.current) setBusy(false); }
      }
      function attachFrame() {
        if (!iframe.current?.contentWindow || !state?.connected) return;
        channel.current?.close();
        const transport = new MessageChannel(), id = state.connectionId;
        const allowed = new Set(['fetch', 'state.get', 'resident.select', 'draft.save', 'helper.open', 'external.open']);
        const payloadKeys = { fetch: ['path', 'method', 'contentType', 'bodyBase64'], 'state.get': [], 'resident.select': ['resident'], 'draft.save': ['resident', 'text'], 'helper.open': ['resident', 'jobId'], 'external.open': ['url'] };
        let lastId = 0, inFlight = 0;
        channel.current = transport.port1;
        transport.port1.onmessage = async function (event) {
          const request = event.data;
          if (!request || request.protocol !== protocol || !Number.isSafeInteger(request.id) || request.id < 1 || typeof request.action !== 'string' || !allowed.has(request.action) || request.id <= lastId) return;
          lastId = request.id;
          const payload = request.payload;
          const reply = value => { try { transport.port1.postMessage({ protocol, id: request.id, ...value }); } catch {} };
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !payloadKeys[request.action].includes(key)) || inFlight >= 64 || current.current.state?.connectionId !== id) { reply({ ok: false, error: 'Desktop request refused' }); return; }
          inFlight++;
          try {
            let value;
            if (request.action === 'fetch') {
              value = await api({ ...payload, action: 'desktop.proxy', connectionId: id });
            } else if (request.action === 'external.open') {
              if (typeof payload.url !== 'string' || payload.url.length > 8192) throw new Error('Invalid link');
              const url = new URL(payload.url);
              if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid link');
              setExternalLink(url.href); value = { ready: true };
            } else if (request.action === 'state.get') {
              value = { resident: selectedResident, draft: recallDraft(id, selectedResident) };
            } else {
              if (typeof payload.resident !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(payload.resident)) throw new Error('Invalid resident');
              if (request.action === 'resident.select') { selectedResident = payload.resident; setResident(payload.resident); value = { okay: true }; }
              else if (payload.resident !== selectedResident) throw new Error('Resident selection changed');
              else if (request.action === 'draft.save') {
                if (typeof payload.text !== 'string' || payload.text.length > 16000) throw new Error('Draft too large');
                try { payload.text ? sessionStorage.setItem(draftKey(id, payload.resident), payload.text) : sessionStorage.removeItem(draftKey(id, payload.resident)); } catch {}
                value = { saved: true };
              } else if (request.action === 'helper.open') {
                if (typeof payload.jobId !== 'string' || !/^t_[a-f0-9]{10}$/.test(payload.jobId)) throw new Error('Invalid helper');
                const navigation = ctx.layout.beginNavigation();
                const target = await api({ action: 'helper.resolve', connectionId: id, resident: payload.resident, jobId: payload.jobId });
                if (!live.current || current.current.state?.connectionId !== id || payload.resident !== selectedResident || navigation.aborted) throw new Error('Selection changed');
                value = { opened: true };
                reply({ ok: true, value });
                setTimeout(() => {
                  if (live.current && !navigation.aborted && current.current.state?.connectionId === id && payload.resident === selectedResident) { saveMode('dsh'); ctx.uiWorkspace.openSession(target.sessionId); }
                }, 0);
                return; // This card click is the only operation that navigates to a helper.
              }
            }
            reply({ ok: true, value });
          } catch (e) { reply({ ok: false, error: e.message }); }
          finally { inFlight--; }
        };
        transport.port1.start();
        iframe.current.contentWindow.postMessage({ protocol, nonce: nonce.current, type: 'attach' }, '*', [transport.port2]);
      }
      const binding = state?.bindings?.find(value => value.resident === resident && value.enabled);
      const field = (label, props) => h('label', { className: 'ard-field' }, h('span', null, label), h('input', props));
      const connectForm = h('form', { onSubmit: e => { e.preventDefault(); act(async () => { const next = await api({ action: 'connect', url, key }); setKey(''); setState(next); saveMode('resident'); setSettings(false); }); } },
        field(t('site'), { value: url, type: 'url', placeholder: 'https://your-resident.workers.dev', required: true, onChange: e => setUrl(e.target.value) }),
        field(t('key'), { value: key, type: 'password', autoComplete: 'off', required: true, onChange: e => setKey(e.target.value) }),
        h('button', { disabled: busy, type: 'submit' }, busy ? t('connecting') : t('connect')));
      return h('section', { className: 'ard-panel' },
        h('style', null, '.ard-panel{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}.ard-toolbar{display:flex;align-items:center;gap:8px;padding:10px 14px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1)}.ard-toolbar strong{margin-right:auto}.ard-panel button,.ard-panel select,.ard-panel input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px}.ard-panel button{cursor:pointer}.ard-panel button:disabled{opacity:.5;cursor:default}.ard-panel a{color:var(--dsw-alias-label-primary)}.ard-settings{padding:18px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1)}.ard-settings p{font-size:13px;line-height:1.5}.ard-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-width:600px}.ard-start{padding:30px;overflow:auto;max-width:680px}.ard-frame{border:0;flex:1;width:100%;min-height:0}.ard-error{padding:10px 16px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}.ard-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ard-loading{padding:24px}.ard-device{display:flex;justify-content:space-between;gap:8px;margin-top:8px}.ard-browser{margin-top:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}.ard-browser input{flex:1;min-width:160px}.ard-directories{display:flex;flex-direction:column;align-items:stretch;gap:4px;max-height:240px;overflow:auto}.ard-directories button{text-align:left}'),
        h('header', { className: 'ard-toolbar' }, h(Nav, {}), h('strong', null, t('title')),
          state?.connected && h('button', { onClick: () => setSettings(!settings) }, settings ? t('close') : t('settings')),
          state?.connected && h('a', { href: state.url, target: '_blank', rel: 'noopener noreferrer' }, t('full')),
          h('button', { onClick: () => { saveMode('dsh'); ctx.layout.selectPanel(null); } }, t('dsh'))),
        externalLink && h('div', { className: 'ard-toolbar' }, h('a', { href: externalLink, target: '_blank', rel: 'noopener noreferrer', onClick: () => setExternalLink('') }, t('external') + ' · ' + new URL(externalLink).host), h('button', { onClick: () => setExternalLink('') }, t('close'))),
        error && h('div', { className: 'ard-error', role: 'alert' }, error),
        !state?.connected ? h('div', { className: 'ard-start' }, h('p', null, t('first')), connectForm)
        : h(React.Fragment, null,
          settings && h('div', { className: 'ard-settings' },
            h('label', { className: 'ard-field' }, h('span', null, t('resident')), h('select', { value: resident, onChange: e => { setResident(e.target.value); setWorkspace(''); closeBrowser(); }, disabled: busy }, people.map(person => h('option', { key: person.id, value: person.id }, person.name || person.id)))),
            h('p', null, t('readonly')),
            h('div', { className: 'ard-actions' },
              h('button', { disabled: busy || Boolean(binding), onClick: () => { setDirectoryOpen(true); void browse(workspace || undefined); } }, t('choose')),
              h('span', null, binding ? binding.workspaceName : workspace || t('none')),
              binding ? h('button', { disabled: busy, onClick: () => act(() => api({ action: 'native.disable', connectionId: state.connectionId, resident })) }, t('disable'))
                : h('button', { disabled: busy || !workspace, onClick: () => act(() => api({ action: 'native.enable', connectionId: state.connectionId, resident, workspace, access: 'full' })) }, t('enable'))),
            binding && h('p', { role: 'status' }, t(binding.access === 'full' ? 'enabled' : 'legacyGrant')),
            directoryOpen && h('section', { className: 'ard-browser', 'aria-label': t('browse') },
              h('strong', null, t('browse')),
              h('form', { className: 'ard-actions', onSubmit: e => { e.preventDefault(); void browse(directoryPath); } },
                h('input', { 'aria-label': t('directoryPath'), value: directoryPath, onChange: e => setDirectoryPath(e.target.value), placeholder: '/path/to/workspace', disabled: directoryBusy }),
                h('button', { type: 'submit', disabled: directoryBusy || !directoryPath }, t('openPath'))),
              directoryError && h('p', { role: 'alert' }, directoryError),
              directoryBusy && h('p', { role: 'status' }, t('busy')),
              directory && h(React.Fragment, null,
                h('div', { className: 'ard-actions' },
                  h('button', { type: 'button', disabled: directoryBusy, onClick: () => void browse(directory.home) }, t('home')),
                  h('button', { type: 'button', disabled: directoryBusy || directory.crumbs.length < 2, onClick: () => void browse(directory.crumbs[directory.crumbs.length - 2].path) }, t('parent'))),
                h('nav', { className: 'ard-actions', 'aria-label': t('directoryPath') }, directory.crumbs.map(crumb => h('button', { type: 'button', key: crumb.path, disabled: directoryBusy, onClick: () => void browse(crumb.path) }, crumb.name || '/'))),
                h('div', { className: 'ard-directories' }, directory.entries.map(entry => h('button', { type: 'button', key: entry.path, disabled: directoryBusy, onClick: () => void browse(entry.path) }, entry.name))),
                directory.truncated && h('p', null, t('truncated'))),
              h('div', { className: 'ard-actions' },
                h('button', { type: 'button', disabled: directoryBusy || !directory || Boolean(directoryError), onClick: () => { setWorkspace(directory.path); closeBrowser(); } }, t('here')),
                h('button', { type: 'button', onClick: closeBrowser }, t('cancel')))),
            state.error && h('p', { role: 'status' }, state.error),
            devices.filter(device => !device.revokedAt).map(device => h('div', { className: 'ard-device', key: device.deviceId }, h('span', null, device.label || 'DSH Desktop'), h('button', { disabled: busy, onClick: () => act(() => api({ action: 'native.disable', connectionId: state.connectionId, resident, deviceId: device.deviceId })) }, t('revoked')))),
            h('p', null, t('limits')),
            h('div', { className: 'ard-actions' }, h('button', { disabled: busy, onClick: () => { setError(''); setRevision(value => value + 1); } }, t('retry')), h('button', { disabled: busy, onClick: () => act(async () => { await api({ action: 'disconnect' }); setDocument(null); setSettings(false); saveMode('dsh'); }) }, t('disconnect')))),
          document ? h('iframe', { ref: iframe, className: 'ard-frame', title: t('title'), srcDoc: document, sandbox: 'allow-scripts allow-downloads', referrerPolicy: 'no-referrer', onLoad: attachFrame }) : h('div', { className: 'ard-loading', role: 'status' }, t('loading'))));
    }
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel }, Panel));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 5, label: () => translate('title') }, Nav));
    ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({ name: 'conversation.header.leading' }, Back));
    ctx.effect(() => {
      try { if (sessionStorage.getItem('aelios.desktop.mode') === 'resident') ctx.layout.selectPanel(panel); } catch {}
    });
  };
  return exports;
}});
