import { homedir } from 'node:os';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';
import { Relay } from './relay.js';
import { DshBackend } from './dsh.js';
import { RemoteHost } from './bridge.js';

export const name = 'dsh-remote';
export const inject = ['connection', 'sessionController', 'workspaceController', 'commands', 'fileUploads', 'attachments', 'userQuestions'];
export const ROUTE = '/api/plugins/dsh-remote/remote';

/**
 * Durable pairing state.
 *
 * The upstream plugin kept every pairing secret in memory, so a DSH restart
 * invalidated the link and forced a re-scan. Persisting the relay identity lets
 * a restarted desktop resume the *same* `device_sid` + `pass_hash`, which keeps
 * the link already open on the phone working.
 *
 * Stored under `$DSH_HOME/dsh-remote/state.json` (mode 0600). It holds the
 * relay pass hash — a bearer-equivalent secret — so it never leaves this file.
 */
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DIR = join(HOME, 'dsh-remote');
const STATE_FILE = join(DIR, 'state.json');
const DIAG_FILE = join(DIR, 'diagnostics.jsonl');
/** Keep the diagnostics log small; it is a debugging aid, not an audit trail. */
const DIAG_MAX_BYTES = 256 * 1024;

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
}
async function saveState(state) {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* Persistence is best-effort; a failure must not break pairing. */ }
}

/**
 * Append one diagnostic record.
 *
 * This exists to answer a question the code alone cannot: when the phone loses
 * the desktop, was it a transient network blip (recoverable) or did the relay
 * revoke the session (close code 4011)? Without the close code both look
 * identical from the outside.
 */
async function logDiagnostic(record) {
  try {
    await mkdir(DIR, { recursive: true });
    const info = await stat(DIAG_FILE).catch(() => null);
    if (info && info.size > DIAG_MAX_BYTES) {
      await writeFile(DIAG_FILE, '', { mode: 0o600 });
    }
    // The canonical timestamp must win: records coming from the relay already
    // carry a raw `at: Date.now()`, which would otherwise shadow the ISO form.
    await appendFile(DIAG_FILE, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch { /* Diagnostics must never break the connection path. */ }
}

export function createControl(ctx) {
  let host, link = null, qr = null, selected = [], starting = false, disposed = false, intent = 0, allowPermissionChanges = false, allowInteractions = false;
  // Loaded once; every later write merges into this object.
  let saved = null;
  let restored = false;
  let lastDiagnostic = null;
  const ready = loadState()
    .then(state => { saved = state; });

  const relay = new Relay({
    onPayload: p => host?.accept(p),
    onStatus: status => {
      if (status.state !== 'connected') host?.backend.interactions.clear();
      if (status.state === 'reconnecting') {
        // A transient drop. Keep the host and the link: the relay identity is
        // still valid, so the phone reconnects to the very same link.
        void logDiagnostic({ event: 'reconnecting', attempt: status.reconnectAttempt, error: status.error });
        return;
      }
      if (['error', 'stopped'].includes(status.state)) { host?.dispose(); host = null; link = qr = null; }
    },
    // The relay hands back the identity it assigned; keep it for the next start.
    onCredentials: credentials => {
      saved = { ...saved, ...credentials };
      void saveState(saved);
    },
    onDiagnostic: record => {
      lastDiagnostic = record;
      void logDiagnostic({ event: 'relay-failure', ...record });
    },
  });

  /**
   * Tear the pairing down.
   *
   * `forget` drops the persisted identity. It defaults to **false** on purpose:
   * a transient network failure, a failed resume or a subscription fault must
   * never destroy the user's link. Only a deliberate user action (`action:
   * 'stop'`) or a leaked-link refresh passes `forget: true`.
   */
  const stop = ({ forget = false } = {}) => {
    intent++; host?.dispose(); host = null; relay.stop(); link = qr = null;
    if (forget) {
      saved = { ...(saved ?? {}), enabled: false, deviceSid: undefined, passHash: undefined };
      void saveState(saved);
      void logDiagnostic({ event: 'forget', reason: 'explicit user action' });
    }
  };

  const all = new DshBackend(ctx, null);

  async function status() {
    const workspaces = (await all.workspaces()).map(w => ({ id: w.workspaceId, title: w.title, path: w.path, sessions: w.sessionIds.length }));
    return { ...relay.status(), link, qr, selected, allowPermissionChanges, allowInteractions,
      workspaces, resumed: restored, lastDiagnostic };
  }

  /** Shared by the HTTP handler and the boot-time resume path. */
  async function begin({ workspaces, permissionChanges, interactions, resume }) {
    stop({ forget: false });
    selected = [...new Set(workspaces)];
    allowPermissionChanges = permissionChanges === true;
    allowInteractions = interactions === true;
    saved = { ...saved, enabled: true, selected, allowPermissionChanges, allowInteractions };
    await saveState(saved);
    const backend = new DshBackend(ctx, selected, allowPermissionChanges);
    // Relay.start calls stop internally; create the host after that reset.
    const start = relay.start({
      deviceMid: saved?.deviceMid,
      resume: resume && saved?.deviceSid && saved?.passHash
        ? { deviceSid: saved.deviceSid, passHash: saved.passHash }
        : undefined,
    });
    const remote = new RemoteHost(backend, p => relay.payload(p), undefined, () => {
      if (host !== remote) return;
      // A DSH-side subscription fault is not a relay failure: keep the stored
      // identity so the next start (or the next boot) can resume the same link.
      stop({ forget: false });
      relay.setState('error', 'DSH subscription failed; refresh pairing');
      void logDiagnostic({ event: 'subscription-fault', error: 'DSH subscription failed' });
    });
    host = remote;
    await start;
    if (disposed || relay.state === 'stopped') throw new Error('Pairing stopped');
    const generation = relay.generation;
    const nextLink = relay.link();
    const nextQr = await QRCode.toDataURL(nextLink, { width: 320, margin: 3, errorCorrectionLevel: 'M' });
    if (!disposed && relay.generation === generation) { link = nextLink; qr = nextQr; }
  }

  /**
   * Restore a previously enabled pairing on boot.
   *
   * This is what makes a restart invisible to the phone: the stored identity is
   * resumed, so the link already open on the phone reconnects on its own.
   */
  async function resumeSaved() {
    await ready;
    if (restored || disposed || !saved?.enabled || saved.consent !== true) return;
    if (!saved.deviceSid || !saved.passHash) return;
    if (!Array.isArray(saved.selected) || saved.selected.length === 0) return;
    const known = await all.workspaces();
    const wanted = saved.selected.filter(id => known.some(w => w.workspaceId === id));
    if (wanted.length === 0) return;
    restored = true;
    starting = true;
    try {
      await begin({ workspaces: wanted, permissionChanges: saved.allowPermissionChanges,
        interactions: saved.allowInteractions, resume: true });
      void logDiagnostic({ event: 'resumed', deviceSid: saved.deviceSid });
    } catch (error) {
      // Keep the credentials: the relay may simply be unreachable right now, and
      // the next boot (or a manual start) can resume the same link.
      restored = false;
      stop({ forget: false });
      void logDiagnostic({ event: 'resume-failed', error: String(error?.message ?? error) });
    } finally { starting = false; }
  }

  return {
    interact(kind, request, next) {
      return allowInteractions && relay.state === 'connected' && host && !host.closed
        ? host.backend.interactions.ask(kind, request, next) : next();
    },
    dispose() { disposed = true; stop({ forget: false }); all.dispose(); },
    resumeSaved,
    async fetch(request) {
      const reply = (code, body) => Response.json(body, { status: code, headers: { 'cache-control': 'no-store' } });
      try {
        await ready;
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (request.method === 'GET') return reply(200, await status());
        if (request.method !== 'POST') return reply(405, { error: 'GET/POST only' });
        if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 8192) return reply(413, { error: 'Request too large' });
        let body;
        try { body = JSON.parse(raw); } catch { return reply(400, { error: 'Invalid JSON' }); }
        // The only path that discards the pairing is an explicit user stop.
        if (body?.action === 'stop') { stop({ forget: true }); return reply(200, await status()); }
        if (!['start', 'refresh'].includes(body?.action)) return reply(400, { error: 'Unknown action' });
        if (starting) return reply(409, { error: 'Pairing is already starting' });
        if (body.consent !== true) return reply(400, { error: 'Remote access consent required' });
        if (!Array.isArray(body.workspaces) || body.workspaces.length === 0 || body.workspaces.length > 20
          || body.workspaces.some(id => typeof id !== 'string')) return reply(400, { error: 'Select 1-20 workspaces' });
        const requestIntent = intent;
        const known = await all.workspaces();
        if (body.workspaces.some(id => !known.some(w => w.workspaceId === id))) return reply(400, { error: 'Workspace not found' });
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (requestIntent !== intent) return reply(409, { error: 'Pairing request was superseded' });
        if (starting) return reply(409, { error: 'Pairing is already starting' });
        starting = true;
        try {
          saved = { ...saved, consent: true };
          // A refresh rotates the identity, which is what invalidates a leaked link.
          if (body.action === 'refresh') saved = { ...saved, deviceSid: undefined, passHash: undefined };
          await begin({ workspaces: body.workspaces, permissionChanges: body.allowPermissionChanges,
            interactions: body.allowInteractions, resume: body.action !== 'refresh' });
        } finally { starting = false; }
        return reply(200, await status());
      } catch { return reply(503, { error: 'Remote pairing unavailable. Check DSH desktop and network, then retry.' }); }
    },
  };
}

export function apply(ctx) {
  const control = createControl(ctx);
  ctx.on('approval/request', (request, next) => control.interact('permission', request, next), { prepend: true, global: true });
  ctx.on('user-questions/request', (request, next) => control.interact('userInput', request, next), { prepend: true, global: true });
  ctx.effect(() => () => control.dispose(), '远程控制: 关闭远程连接');
  ctx.effect(() => ctx.connection.fetch.register({ path: ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered',
    fetch: request => control.fetch(request) }), '远程控制: 注册远程控制接口');
  // Resume after the plugin is fully mounted, so a restart keeps the phone link alive.
  void control.resumeSaved();
}
