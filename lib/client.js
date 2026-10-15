window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    // Both of these make the rail button look native, but neither may be fatal:
    // a client bundle that throws while loading takes the whole UI down (the
    // "failed to import" failure mode), so each one degrades instead.
    let IconGlobe = null;
    let createPortal = null;
    try { IconGlobe = require('@deepseek-ai/dsh-client-ui-primitives').IconGlobeOutlineRegular; } catch { /* fallback below */ }
    try { ({ createPortal } = require('react-dom')); } catch { /* falls back to in-place */ }
    /** Stand-in for the host globe icon: same box and 1px currentColor stroke. */
    const FallbackIcon = ({ size = 20 }) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
      'aria-hidden': true, stroke: 'currentColor', strokeWidth: 1 },
      h('circle', { cx: 8, cy: 8, r: 5.25 }),
      h('ellipse', { cx: 8, cy: 8, rx: 2.25, ry: 5.25 }),
      h('path', { d: 'M2.9 6.2h10.2M2.9 9.8h10.2' }));
    const GlobeIcon = IconGlobe ?? FallbackIcon;

    // Typography and control metrics follow the sidebar's own values, so the
    // rail row reads as one more panel row: the sidebar root is 14px and its
    // panel rows inherit that at a 22px line height with an 8px icon gap.
    const css = `
.dsh-remote-rail{display:flex;align-items:center;width:100%}
.dsh-remote-rail-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:flex-start;gap:8px;width:100%;height:36px;padding:0 8px;margin:0;border:0;border-radius:var(--dsw-radius-md,6px);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:14px;font-weight:400;line-height:22px;text-align:left}
.dsh-remote-rail-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-remote-rail-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsh-remote-rail-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}
.dsh-remote-rail-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-remote-rail-btn[data-state='connected'] .dsh-remote-rail-icon{color:var(--dsw-alias-state-success-primary)}
.dsh-remote-rail-btn[data-state='waiting'] .dsh-remote-rail-icon,.dsh-remote-rail-btn[data-state='connecting'] .dsh-remote-rail-icon,.dsh-remote-rail-btn[data-state='reconnecting'] .dsh-remote-rail-icon{color:var(--dsw-alias-state-warn-primary)}
.dsh-remote-rail-btn[data-state='error'] .dsh-remote-rail-icon{color:var(--dsw-alias-state-error-primary)}

.dsh-remote-cv{position:fixed;z-index:80;width:360px;max-width:calc(100vw - 16px);max-height:calc(100vh - 96px);overflow:auto;box-sizing:border-box;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);letter-spacing:0}
.dsh-remote-cv h2{font-size:16px;font-weight:500;line-height:24px;margin:0 0 2px;color:var(--dsw-alias-label-primary)}
.dsh-remote-cv .field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-remote-cv .field + .field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-remote-cv .field-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dsh-remote-cv .hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-remote-cv .row{display:flex;align-items:center;gap:8px}
.dsh-remote-cv .row .field-label{flex:1;min-width:0}
.dsh-remote-cv .check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-remote-cv .check input{flex:0 0 auto;width:16px;height:16px;margin:1px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:inherit}
.dsh-remote-cv .check input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-remote-cv .check:has(input:disabled){cursor:default;opacity:.5}
.dsh-remote-cv .check small{display:block;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-remote-cv .switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}
.dsh-remote-cv .switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}
.dsh-remote-cv .switch:disabled{cursor:default;opacity:.5}
.dsh-remote-cv .switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-remote-cv .thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}
.dsh-remote-cv .switch[aria-checked='false'] .thumb{background:var(--dsw-alias-switch-thumb)}
.dsh-remote-cv .switch[aria-checked='true'] .thumb{transform:translateX(16px)}
.dsh-remote-cv .status{display:flex;align-items:center;gap:8px;padding:10px 0 0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-remote-cv .dot{position:relative;display:inline-block;flex:none;width:10px;height:10px}
.dsh-remote-cv .dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}
.dsh-remote-cv .dot.idle{color:var(--dsw-alias-state-idle-primary)}
.dsh-remote-cv .dot.busy{color:var(--dsw-alias-state-warn-primary)}
.dsh-remote-cv .dot.on{color:var(--dsw-alias-state-success-primary)}
.dsh-remote-cv .dot.err{color:var(--dsw-alias-state-error-primary)}
.dsh-remote-cv .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsh-remote-cv .btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font:inherit;font-size:13px;line-height:1.5;height:32px;padding:0 12px;color:var(--dsw-alias-label-primary);background:transparent}
.dsh-remote-cv .btn:disabled{cursor:not-allowed;opacity:.4}
.dsh-remote-cv .btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dsh-remote-cv .btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsh-remote-cv .btn.outline{border:.5px solid var(--dsw-alias-border-l3)}
.dsh-remote-cv .btn.outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-remote-cv .error{margin:8px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-remote-cv .qr{display:block;width:240px;max-width:100%;height:auto;aspect-ratio:1;margin:12px auto 0;padding:10px;background:#fff;border-radius:var(--dsw-radius-lg,10px)}
.dsh-remote-cv .foot{margin:10px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
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

    /** Host-shaped switch: aria-checked drives the appearance. */
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

    /**
     * One poll shared by the rail button and its panel.
     *
     * Polling starts with the first subscriber and stops with the last, so a
     * closed panel costs nothing and the two surfaces never disagree.
     */
    const watch = (() => {
      let snapshot = null;
      let failure = '';
      const listeners = new Set();
      let timer = null;
      let started = false;
      const emit = () => { for (const fn of listeners) fn(snapshot, failure); };
      const tick = async () => {
        try { snapshot = await api(null); failure = ''; }
        catch (error) { failure = error.message; }
        emit();
        timer = setTimeout(tick, 2500);
      };
      return {
        get: () => snapshot,
        subscribe(fn) {
          listeners.add(fn);
          fn(snapshot, failure);
          if (!started) { started = true; tick(); }
          return () => {
            listeners.delete(fn);
            if (!listeners.size) { clearTimeout(timer); started = false; }
          };
        },
      };
    })();

    /**
     * The whole remote-control surface, anchored to the sidebar rail row that
     * sits directly above the account avatar (`sidebar.footer.action` renders
     * before `sidebar.settings`).
     *
     * This is the only entry point on purpose: the sidebar's own toggle stays
     * reachable while collapsed (it is `position: fixed` in the title bar), so
     * a panel here is never unreachable.
     */
    function RailEntry({ wide }) {
      const [state, setState] = React.useState(watch.get());
      const [pollError, setPollError] = React.useState('');
      const [open, setOpen] = React.useState(false);
      const [anchor, setAnchor] = React.useState(null);
      const [selected, setSelected] = React.useState([]);
      const [consent, setConsent] = React.useState(false);
      const [allowPermissions, setAllowPermissions] = React.useState(false);
      const [allowInteractions, setAllowInteractions] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const [showQr, setShowQr] = React.useState(false);
      const initialized = React.useRef(false);
      const button = React.useRef(null);
      const panel = React.useRef(null);

      React.useEffect(() => watch.subscribe((value, failure) => {
        setState(value);
        setPollError(failure ?? '');
        if (!value) return;
        if (!initialized.current) {
          initialized.current = true;
          setSelected(value.selected ?? []);
          setConsent(!['stopped', 'error'].includes(value.state));
          setAllowPermissions(value.allowPermissionChanges === true);
          setAllowInteractions(value.allowInteractions === true);
        }
        if (!value.qr) setShowQr(false);
      }), []);

      // Close on outside click and on Escape; never leave a floating panel
      // behind a sidebar the user has just collapsed.
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = event => {
          if (button.current?.contains(event.target)) return;
          if (panel.current?.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onDown, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);
      React.useEffect(() => { if (open && wide === false) setOpen(false); }, [open, wide]);

      async function act(action) {
        setBusy(true); setError(''); setCopied(false);
        try {
          setState(await api({ action, consent, allowPermissionChanges: allowPermissions, allowInteractions,
            workspaces: selected.length ? selected : state?.selected }));
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
      }

      const active = state && !['stopped', 'error'].includes(state.state);
      const waiting = state?.state === 'waiting';
      const qrVisible = Boolean(state?.qr) && (showQr || (waiting && !active));
      const label = labels[state?.state] || '正在读取状态';
      const locked = '远程已开启；先停止再修改';
      const isWide = wide !== false;

      // Anchor the panel above the row, flipping below when the window is short,
      // and clamp horizontally so it never leaves the viewport.
      const openPanel = () => {
        const rect = button.current?.getBoundingClientRect();
        if (rect) {
          const width = 360;
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
          const below = rect.top < 380;
          setAnchor({ left, ...(below ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }) });
        }
        setOpen(v => !v);
      };

      return h('div', { className: 'dsh-remote-rail' },
        h('button', { ref: button, type: 'button', className: 'dsh-remote-rail-btn',
          'data-state': state?.state ?? 'stopped', 'aria-label': `远程控制：${label}`, title: `远程控制：${label}`,
          'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: openPanel },
          h('span', { className: 'dsh-remote-rail-icon' }, h(GlobeIcon, { size: 20 })),
          h('span', { className: 'dsh-remote-rail-label' }, '远程控制')),
        open && anchor ? (createPortal ?? ((node) => node))(
          h('div', { ref: panel, className: 'dsh-remote-cv', role: 'dialog', 'aria-label': '远程控制',
            style: { left: anchor.left + 'px', ...(anchor.top !== undefined ? { top: anchor.top + 'px' } : { bottom: anchor.bottom + 'px' }) } },
            h('h2', null, '远程控制'),
            h('div', { className: 'status', role: 'status' },
              h('span', { className: `dot ${dots[state?.state] ?? 'idle'}`, 'aria-hidden': true }), label,
              waiting ? h('span', { className: 'hint' }, '· 在手机上打开链接即可连接') : null,
              state?.state === 'reconnecting' && state?.reconnectAttempt
                ? h('span', { className: 'hint' }, `· 第 ${state.reconnectAttempt + 1} 次重连`) : null),
            h('div', { className: 'field' },
              h('span', { className: 'field-label' }, '共享工作区'),
              ...(state?.workspaces ?? []).map(w => h('label', { className: 'check', key: w.id },
                h('input', { type: 'checkbox', checked: (active ? state.selected : selected).includes(w.id),
                  disabled: busy || active,
                  onChange: e => setSelected(list => e.target.checked ? [...list, w.id] : list.filter(id => id !== w.id)) }),
                h('span', null, w.title || w.path, h('small', null, `${w.sessions} 个会话 · ${w.path}`))))),
            h(SwitchField, { label: '允许手机切换权限档位（含完全访问）', checked: allowPermissions,
              onChange: setAllowPermissions, disabled: busy || active, title: active ? locked : undefined }),
            h(SwitchField, { label: '允许手机处理审批与问答（超时或断开后交回桌面）', checked: allowInteractions,
              onChange: setAllowInteractions, disabled: busy || active, title: active ? locked : undefined }),
            h(SwitchField, { label: '允许远程访问所选工作区', checked: consent,
              onChange: value => { setConsent(value); if (!value && active) void act('stop'); }, disabled: busy }),
            h('div', { className: 'actions' },
              h('button', { className: 'btn primary', disabled: busy || (!active && (!consent || !selected.length)),
                onClick: () => act(active ? 'stop' : 'start') }, active ? '停止' : '开启远程'),
              h('button', { className: 'btn outline', disabled: busy || !active || !consent, onClick: () => act('refresh') }, '刷新链接'),
              h('button', { className: 'btn outline', disabled: busy || !state?.link, onClick: async () => {
                try { await navigator.clipboard.writeText(state.link); setCopied(true); } catch { setError('复制失败，请改用二维码'); }
              } }, copied ? '已复制链接' : '复制链接'),
              h('button', { className: 'btn outline', disabled: busy || !state?.qr, onClick: () => setShowQr(v => !v) },
                qrVisible ? '隐藏二维码' : '显示二维码')),
            qrVisible ? h('img', { className: 'qr', src: state.qr, alt: '远程配对二维码', width: 240, height: 240 }) : null,
            error || pollError || state?.error ? h('p', { className: 'error', role: 'alert' }, error || pollError || state.error) : null,
            !active && consent && selected.length ? h('p', { className: 'foot' }, '链接即凭据，请勿分享。') : null),
          document.body) : null);
    }

    return { inject: ['slots'], apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); }, '远程控制: 样式');
      // `sidebar.footer.action` is a list slot rendered directly above the
      // account row; negative order keeps this row on top of that group.
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action',
        id: 'dsh-remote-status', order: -10, label: () => '远程控制', inject: () => ({}) }, RailEntry));
    } };
  },
});
