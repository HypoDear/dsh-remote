window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    // Styling follows the host's own design tokens and control metrics. The
    // switch, checkbox, button and status-dot shapes are reproduced from
    // @deepseek-ai/dsh-client-ui-primitives so this card matches the settings
    // pages around it, without depending on that package's internal paths.
    const css = `
.dsh-remote{max-width:760px;letter-spacing:0;color:var(--dsw-alias-label-primary)}
.dsh-remote h2{font-size:16px;font-weight:500;line-height:24px;margin:0 0 4px;color:var(--dsw-alias-label-primary)}
.dsh-remote .field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-remote .field + .field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-remote .field-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-remote .hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-remote .row{display:flex;align-items:center;gap:8px}
.dsh-remote .row .field-label{flex:1;min-width:0}
.dsh-remote .check{display:flex;align-items:flex-start;gap:8px;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-remote .check input{flex:0 0 auto;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dsh-remote .check input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-remote .check:has(input:disabled){cursor:default;opacity:.5}
.dsh-remote .check small{display:block;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-remote .switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-remote .switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}
.dsh-remote .switch:disabled{cursor:default;opacity:.5}
.dsh-remote .switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-remote .thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-remote .switch[aria-checked='false'] .thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-remote .switch[aria-checked='true'] .thumb{transform:translateX(16px)}
.dsh-remote .status{display:flex;align-items:center;gap:8px;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2);font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-remote .dot{position:relative;display:inline-block;flex:none;width:10px;height:10px}
.dsh-remote .dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.dsh-remote .dot.idle{color:var(--dsw-alias-state-idle-primary)}
.dsh-remote .dot.busy{color:var(--dsw-alias-state-warn-primary)}
.dsh-remote .dot.on{color:var(--dsw-alias-state-success-primary)}
.dsh-remote .dot.err{color:var(--dsw-alias-state-error-primary)}
.dsh-remote .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:16px}
.dsh-remote .btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:13px;line-height:1.5;height:36px;padding:0 14px;color:var(--dsw-alias-label-primary);background:transparent}
.dsh-remote .btn:disabled{cursor:not-allowed;opacity:.4}
.dsh-remote .btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-remote .btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-remote .btn.outline{height:28px;font-size:12px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l3)}
.dsh-remote .btn.outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-remote .error{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-remote .qr{display:block;width:280px;max-width:100%;height:auto;aspect-ratio:1;margin:12px 0;padding:12px;background:#fff;border-radius:var(--dsw-radius-lg,10px)}
`;
    const labels = { stopped: '未开启', connecting: '正在连接', waiting: '等待手机连接', connected: '手机已连接', error: '连接失败', reconnecting: '正在重连' };
    const dots = { stopped: 'idle', connecting: 'busy', waiting: 'busy', connected: 'on', error: 'err', reconnecting: 'busy' };
    async function api(body, signal) {
      const response = await fetch(new URL('api/plugins/dsh-remote/remote', new URL('.', window.location.href)), {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
      return value;
    }
    // Host-shaped switch: aria-checked drives the appearance, so the visual
    // state can never disagree with what assistive technology reads.
    function Switch({ checked, onChange, disabled, label, title }) {
      return h('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, title, disabled,
        className: 'switch', onClick: () => onChange(!checked) }, h('span', { className: 'thumb' }));
    }
    function SwitchField({ label, checked, onChange, disabled, title }) {
      return h('div', { className: 'field' },
        h('div', { className: 'row' },
          h('span', { className: 'field-label' }, label),
          h(Switch, { checked, onChange, disabled, label, title })));
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
      const lockedWhileActive = '远程已开启；先停止再修改';
      return h('section', { className: 'dsh-remote' },
        h('h2', null, '远程控制'),
        h('div', { className: 'field' },
          h('span', { className: 'field-label' }, '共享工作区'),
          ...(state?.workspaces ?? []).map(w => h('label', { className: 'check', key: w.id },
            h('input', { type: 'checkbox', checked: (active ? state.selected : selected).includes(w.id), disabled: busy || active,
              onChange: e => setSelected(list => e.target.checked ? [...list, w.id] : list.filter(id => id !== w.id)) }),
            h('span', null, w.title || w.path, h('small', null, `${w.sessions} 个会话 · ${w.path}`))))),
        h(SwitchField, { label: '允许手机切换权限档位（含完全访问）', checked: allowPermissions,
          onChange: setAllowPermissions, disabled: busy || active, title: active ? lockedWhileActive : undefined }),
        h(SwitchField, { label: '允许手机处理审批与问答（超时或断开后交回桌面）', checked: allowInteractions,
          onChange: setAllowInteractions, disabled: busy || active, title: active ? lockedWhileActive : undefined }),
        h(SwitchField, { label: '允许远程访问所选工作区', checked: consent,
          onChange: value => { setConsent(value); if (!value && active) void act('stop'); }, disabled: busy }),
        h('div', { className: 'status', role: 'status' },
          h('span', { className: `dot ${dots[state?.state] ?? 'idle'}`, 'aria-hidden': true }),
          labels[state?.state] || '正在读取状态',
          waiting ? h('span', { className: 'hint' }, '· 在手机上打开链接即可连接') : null,
          state?.state === 'reconnecting' && state?.reconnectAttempt ? h('span', { className: 'hint' }, `· 第 ${state.reconnectAttempt + 1} 次重连`) : null),
        h('div', { className: 'actions' },
          h('button', { className: 'btn primary', disabled: busy || (!active && (!consent || !selected.length)),
            onClick: () => act(active ? 'stop' : 'start') }, active ? '停止' : '开启远程'),
          h('button', { className: 'btn outline', disabled: busy || !active || !consent, onClick: () => act('refresh') }, '刷新链接'),
          h('button', { className: 'btn outline', disabled: busy || !state?.link, onClick: async () => {
            try { await navigator.clipboard.writeText(state.link); setCopied(true); } catch { setError('复制失败，请直接扫二维码'); }
          } }, copied ? '已复制链接' : '复制链接'),
          h('button', { className: 'btn outline', disabled: busy || !state?.qr, onClick: () => setShowQr(v => !v) },
            qrVisible ? '隐藏二维码' : '显示二维码')),
        qrVisible ? h('img', { className: 'qr', src: state.qr, alt: '远程配对二维码', width: 280, height: 280 }) : null,
        error || pollError || state?.error ? h('p', { className: 'error', role: 'alert' }, error || pollError || state.error) : null,
        !active && consent && selected.length ? h('p', { className: 'hint' }, '链接即凭据，请勿分享。') : null);
    }
    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); }, '远程控制: 样式');
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dsh-remote', order: 13,
        label: () => '远程控制', inject: () => ({}) }, Settings));
    } };
  },
});
