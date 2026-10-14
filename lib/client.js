window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const css = `.dsh-remote{max-width:760px;letter-spacing:0;color:var(--dsw-alias-label-primary)}.dsh-remote h2{font-size:20px;margin:0 0 20px;color:var(--dsw-alias-label-primary)}.dsh-remote fieldset{border:0;padding:0;margin:0 0 20px}.dsh-remote legend{font-size:13px;color:var(--dsw-alias-label-tertiary);margin-bottom:8px}.dsh-remote label{display:flex;gap:10px;align-items:flex-start;margin:12px 0;font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary)}.dsh-remote small{display:block;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px}.dsh-remote-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:16px 0}.dsh-remote button{font:inherit;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .15s,border-color .15s}.dsh-remote button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-remote button:disabled{opacity:.45;cursor:not-allowed}.dsh-remote-qr{display:block;width:280px;max-width:100%;height:auto;aspect-ratio:1;margin:16px 0;padding:12px;background:#fff;border-radius:var(--dsw-radius-lg,10px)}.dsh-remote-status{display:flex;align-items:center;gap:8px;font-size:14px;padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}.dsh-remote-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}.dsh-remote-dot.on{background:var(--dsw-alias-state-success-primary)}.dsh-remote-dot.busy{background:var(--dsw-alias-state-warn-primary)}.dsh-remote-dot.err{background:var(--dsw-alias-state-error-primary)}.dsh-remote-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;font-size:13px;line-height:1.6}.dsh-remote-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}`;
    const labels = { stopped: '未开启', connecting: '正在连接', waiting: '等待手机连接', connected: '手机已连接', error: '连接失败', reconnecting: '正在重连' };
    const dots = { stopped: '', connecting: 'busy', waiting: 'busy', connected: 'on', error: 'err', reconnecting: 'busy' };
    async function api(body, signal) {
      const response = await fetch(new URL('api/plugins/dsh-remote/remote', new URL('.', window.location.href)), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }
    function Settings() {
      const [state, setState] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [consent, setConsent] = React.useState(false);
      const [allowPermissions, setAllowPermissions] = React.useState(false);
      const [allowInteractions, setAllowInteractions] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [pollError, setPollError] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [showQr, setShowQr] = React.useState(false);
      const initialized = React.useRef(false);
      React.useEffect(() => {
        const abort = new AbortController();
        let timer;
        const poll = async () => {
          try {
            const value = await api(null, abort.signal);
            if (!abort.signal.aborted) {
              setState(value);
              setPollError('');
              if (!initialized.current) {
                initialized.current = true;
                setSelected(value.selected ?? []);
                setConsent(!['stopped', 'error'].includes(value.state));
                setAllowPermissions(value.allowPermissionChanges === true);
                setAllowInteractions(value.allowInteractions === true);
              }
              // 扫码等待期自动亮出二维码，连上后自动收起；手动切换可覆盖。
              if (!value.qr) setShowQr(false);
            }
          } catch (e) { if (!abort.signal.aborted) setPollError(e.message); }
          if (!abort.signal.aborted) timer = setTimeout(poll, 2500);
        };
        void poll();
        return () => { abort.abort(); clearTimeout(timer); };
      }, []);
      async function act(action) {
        setBusy(true); setError(''); setCopied(false);
        try { setState(await api({ action, consent, allowPermissionChanges: allowPermissions, allowInteractions, workspaces: selected.length ? selected : state?.selected })); }
        catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }
      const active = state && !['stopped', 'error'].includes(state.state);
      const waiting = state?.state === 'waiting';
      // 二维码仅在两种情况下出现：等待扫码时自动亮出；用户手动点了「显示二维码」。
      // 连接成功后自动收起，链接仍在，但不再占屏。
      const qrVisible = Boolean(state?.qr) && (showQr || (waiting && !active));
      return h('section', { className: 'dsh-remote' },
        h('h2', null, '远程控制'),
        h('fieldset', { disabled: busy || active }, h('legend', null, '共享工作区'),
          ...(state?.workspaces ?? []).map(w => h('label', { key: w.id },
            h('input', { type: 'checkbox', checked: (active ? state.selected : selected).includes(w.id),
              onChange: e => setSelected(list => e.target.checked ? [...list, w.id] : list.filter(id => id !== w.id)) }),
            h('span', null, w.title || w.path, h('small', null, `${w.sessions} 个会话 · ${w.path}`))))),
        h('label', null, h('input', { type: 'checkbox', checked: allowPermissions, disabled: busy || active,
          onChange: e => setAllowPermissions(e.target.checked) }), '允许手机切换权限档位（含完全访问）'),
        h('label', null, h('input', { type: 'checkbox', checked: allowInteractions, disabled: busy || active,
          onChange: e => setAllowInteractions(e.target.checked) }), '允许手机处理审批与问答（超时或断开后交回桌面）'),
        h('label', null, h('input', { type: 'checkbox', checked: consent, disabled: busy,
          onChange: e => { setConsent(e.target.checked); if (!e.target.checked && active) void act('stop'); } }), '允许远程访问所选工作区'),
        h('div', { className: 'dsh-remote-status', role: 'status' },
          h('span', { className: `dsh-remote-dot ${dots[state?.state] ?? ''}`, 'aria-hidden': true }),
          labels[state?.state] || '正在读取状态',
          waiting ? h('span', { className: 'dsh-remote-hint' }, '· 在手机上打开链接即可连接') : null,
          state?.state === 'reconnecting' && state?.reconnectAttempt ? h('span', { className: 'dsh-remote-hint' }, `· 第 ${state.reconnectAttempt + 1} 次重连`) : null),
        h('div', { className: 'dsh-remote-actions' },
          h('button', { disabled: busy || (!active && (!consent || !selected.length)), onClick: () => act(active ? 'stop' : 'start') }, active ? '停止' : '开启远程'),
          h('button', { disabled: busy || !active || !consent, onClick: () => act('refresh') }, '刷新链接'),
          h('button', { disabled: busy || !state?.link, onClick: async () => {
            try { await navigator.clipboard.writeText(state.link); setCopied(true); } catch { setError('复制失败，请直接扫二维码'); }
          } }, copied ? '已复制链接' : '复制链接'),
          h('button', { disabled: busy || !state?.qr, onClick: () => setShowQr(v => !v) },
            qrVisible ? '隐藏二维码' : '显示二维码')),
        qrVisible ? h('img', { className: 'dsh-remote-qr', src: state.qr, alt: '远程配对二维码', width: 280, height: 280 }) : null,
        error || pollError || state?.error ? h('p', { className: 'dsh-remote-error', role: 'alert' }, error || pollError || state.error) : null,
        !active && consent && selected.length ? h('p', { className: 'dsh-remote-hint' }, '链接即凭据，请勿分享。') : null);
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); }, '远程控制: 样式');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-remote', order: 13,
        label: () => '远程控制', inject: () => ({}) }, Settings));
    } };
  },
});
