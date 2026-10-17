import { homedir } from 'node:os';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { Relay } from './relay.js';
import { DshBackend } from './dsh.js';
import { RemoteHost } from './bridge.js';
import { QueueControl } from './queue-control.js';

export const name = 'dsh-remote';
export const inject = ['connection', 'sessionController', 'workspaceController', 'commands', 'fileUploads', 'attachments', 'userQuestions'];
export const ROUTE = '/api/plugins/dsh-remote/remote';

/**
 * Durable pairing state.
 *
 * The upstream plugin kept every pairing secret in memory, so a DSH restart
 * invalidated the link and forced a re-scan. Persisting the relay identity lets
 * a restarted desktop resume the *same* `device_sid` + `pass_hash` + `device_mid`,
 * which keeps the link already open on the phone working.
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
/**
 * How long a handed-out phone link stays as-is.
 *
 * The remote page wants a recent `t` in the URL, but the link also has to be
 * stable enough to copy once and keep. Re-minting at most this often keeps a
 * freshly copied link fresh while the identity it points at (sid + hash + mid)
 * never rotates on its own.
 */
const LINK_FRESH_MS = 60_000;

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

/** True when `pid` names a live process (its own, or one we may not signal). */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

export function createControl(ctx) {
  // The admission gate for the durable Inbox lives here; queue contents stay in DSH.
  const queues = typeof ctx.on === 'function' ? new QueueControl(ctx) : null;
  let host, link = null, qr = null, linkAt = 0, selected = [];
  let starting = false, disposed = false, intent = 0, allowPermissionChanges = false, allowInteractions = false;
  let blocked = null;
  // Loaded once; every later write merges into this object.
  let saved = null;
  let restored = false;
  let ownsPairing = false;
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
    // `deviceMid` is part of the phone link, so losing it would invalidate the
    // link on every restart — it is persisted alongside the sid and pass hash.
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
   * Take ownership of this machine's pairing, or report who holds it.
   *
   * Two DSH processes sharing one `state.json` both register the same
   * `device_sid` on the relay, and the relay answers the newer socket with
   * KICKED — a fight that only ends when one process dies, and that rotated the
   * routing id out from under the phone's link on every round. Only one process
   * may drive the relay; the others stay local and say so.
   *
   * The claim is written and read back, so two processes starting together
   * cannot both believe they won.
   */
  async function ensureOwnership() {
    const owner = saved?.owner;
    if (owner?.pid !== process.pid && processAlive(owner?.pid)) {
      blocked = 'owned-elsewhere';
      return false;
    }
    saved = { ...(saved ?? {}), owner: { pid: process.pid, startedAt: Date.now() } };
    await saveState(saved);
    const readBack = await loadState();
    if (readBack?.owner?.pid !== process.pid) {
      blocked = 'owned-elsewhere';
      return false;
    }
    ownsPairing = true;
    blocked = null;
    return true;
  }
  function releaseOwnership() {
    if (!ownsPairing) return;
    ownsPairing = false;
    if (saved?.owner?.pid === process.pid) {
      saved = { ...saved, owner: undefined };
      void saveState(saved);
    }
  }

  /**
   * Tear the pairing down.
   *
   * `forget` drops the persisted identity. It defaults to **false** on purpose:
   * a transient network failure, a failed resume or a subscription fault must
   * never destroy the user's link. Only a deliberate user action (`action:
   * 'stop'`) or a leaked-link refresh passes `forget: true`.
   */
  const stop = ({ forget = false } = {}) => {
    intent++; host?.dispose(); host = null; relay.stop(); link = qr = null; linkAt = 0;
    if (forget) {
      saved = { ...(saved ?? {}), enabled: false, deviceSid: undefined, passHash: undefined };
      void saveState(saved);
      void logDiagnostic({ event: 'forget', reason: 'explicit user action' });
    }
  };

  const all = new DshBackend(ctx, null);

  /**
   * The phone link, re-minted at most once per {@link LINK_FRESH_MS}.
   *
   * Deriving it here rather than caching it at pairing time is what keeps a
   * copied link usable: `t` is refreshed while sid/hash/mid stay put, so the
   * phone's page keeps matching this desktop instead of being told the link is
   * stale.
   */
  async function currentLink() {
    if (['stopped', 'error'].includes(relay.state)) { link = null; qr = null; linkAt = 0; return null; }
    const next = relay.link();
    // Mid-handshake the relay has no sid to build a link from yet: keep the one
    // the panel is already showing rather than flickering it away.
    if (!next) return link;
    if (link && Date.now() - linkAt < LINK_FRESH_MS) return link;
    link = next;
    linkAt = Date.now();
    qr = await QRCode.toDataURL(next, { width: 320, margin: 3, errorCorrectionLevel: 'M' }).catch(() => null);
    return link;
  }

  async function status() {
    const workspaces = (await all.workspaces()).map(w => ({ id: w.workspaceId, title: w.title, path: w.path, sessions: w.sessionIds.length }));
    return { ...relay.status(), link: await currentLink(), qr, selected, blocked,
      allowPermissionChanges, allowInteractions, workspaces, resumed: restored, lastDiagnostic };
  }

  /** Shared by the HTTP handler and the boot-time resume path. */
  async function begin({ workspaces, permissionChanges, interactions, resume }) {
    // Ownership is claimed here, not at boot: a process with remote access *off*
    // must not block another one from turning it on. Only the process that is
    // actually about to drive the relay needs the slot.
    if (!await ensureOwnership()) throw new Error('Another DSH process already controls remote access');
    stop({ forget: false });
    selected = [...new Set(workspaces)];
    allowPermissionChanges = permissionChanges === true;
    allowInteractions = interactions === true;
    saved = { ...saved, enabled: true, selected, allowPermissionChanges, allowInteractions };
    await saveState(saved);
    const backend = new DshBackend(ctx, selected, allowPermissionChanges, queues);
    // Relay.start calls stop internally; create the host after that reset.
    const start = relay.start({
      deviceMid: saved?.deviceMid,
      resume: resume && saved?.deviceSid && saved?.passHash
        ? { deviceSid: saved.deviceSid, passHash: saved.passHash }
        : undefined,
    });
    const remote = new RemoteHost(backend, p => relay.payload(p), undefined, error => {
      if (host !== remote) return;
      // A DSH-side subscription fault is not a relay failure: keep the stored
      // identity so the next start (or the next boot) can resume the same link.
      stop({ forget: false });
      relay.setState('error', 'DSH subscription failed; refresh pairing');
      // Record what actually threw. The user-facing string above is deliberately
      // generic, so the message and name are the only way to tell a revoked
      // scope ("Session is no longer shared") from a real internal error.
      void logDiagnostic({ event: 'subscription-fault',
        error: String(error?.message ?? error ?? 'unknown'),
        errorName: error?.name ?? null,
        stack: error?.stack ? String(error.stack).split('\n').slice(0, 4).join('\n') : null });
    });
    host = remote;
    // A first-attempt failure rejects here (so the caller can report it) while
    // the relay keeps retrying in the background — the link is published by
    // status() as soon as the socket authenticates, not only on this path.
    await start;
  }

  /**
   * Restore a previously enabled pairing on boot.
   *
   * This is what makes a restart invisible to the phone: the stored identity is
   * resumed, so the link already open on the phone reconnects on its own.
   */
  async function resumeSaved() {
    await ready;
    if (disposed || restored || !saved?.enabled || saved.consent !== true) return;
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
      // the background retry (or the next boot) can still revive this same link.
      restored = false;
      void logDiagnostic(blocked === 'owned-elsewhere'
        ? { event: 'owner-conflict', pid: saved?.owner?.pid ?? null }
        : { event: 'resume-failed', error: String(error?.message ?? error) });
    } finally { starting = false; }
  }

  return {
    interact(kind, request, next) {
      return allowInteractions && relay.state === 'connected' && host && !host.closed
        ? host.backend.interactions.ask(kind, request, next) : next();
    },
    dispose() { disposed = true; stop({ forget: false }); releaseOwnership(); all.dispose(); queues?.dispose(); },
    resumeSaved,
    async fetch(request) {
      const reply = (code, body) => Response.json(body, { status: code, headers: { 'cache-control': 'no-store' } });
      try {
        await ready;
        if (request.method === 'GET') return reply(200, await status());
        if (request.method !== 'POST') return reply(405, { error: 'GET/POST only' });
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 8192) return reply(413, { error: 'Request too large' });
        let body;
        try { body = JSON.parse(raw); } catch { return reply(400, { error: 'Invalid JSON' }); }
        // The only path that discards the pairing is an explicit user stop.
        if (body?.action === 'stop') { stop({ forget: true }); return reply(200, await status()); }
        if (!['start', 'refresh'].includes(body?.action)) return reply(400, { error: 'Unknown action' });
        if (body.consent !== true) return reply(400, { error: 'Remote access consent required' });
        if (!Array.isArray(body.workspaces) || body.workspaces.length === 0 || body.workspaces.length > 20
          || body.workspaces.some(id => typeof id !== 'string')) return reply(400, { error: 'Select 1-20 workspaces' });
        if (starting) return reply(409, { error: 'Pairing is already starting' });
        if (!await ensureOwnership()) {
          return reply(409, { error: 'Another DSH process on this machine already controls remote access. Enable it there, or close that process.' });
        }
        const requestIntent = intent;
        const known = await all.workspaces();
        if (body.workspaces.some(id => !known.some(w => w.workspaceId === id))) return reply(400, { error: 'Workspace not found' });
        // A stop (or a competing start) that landed while the list was loading wins.
        if (disposed) return reply(503, { error: 'Plugin stopped' });
        if (requestIntent !== intent) return reply(409, { error: 'Pairing request was superseded' });
        starting = true;
        try {
          saved = { ...saved, consent: true };
          // A refresh rotates the identity, which is what invalidates a leaked link.
          if (body.action === 'refresh') saved = { ...saved, deviceSid: undefined, passHash: undefined, deviceMid: undefined };
          await begin({ workspaces: body.workspaces, permissionChanges: body.allowPermissionChanges,
            interactions: body.allowInteractions, resume: body.action !== 'refresh' });
        } finally { starting = false; }
        return reply(200, await status());
      } catch (error) {
        const detail = error?.message ? ` (${error.message})` : '';
        return reply(503, { error: `Remote pairing unavailable${detail}. Check DSH desktop and network, then retry.` });
      }
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
