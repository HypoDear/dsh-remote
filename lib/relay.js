import { RELAY_ENDPOINT, WEB_CLIENT_ENDPOINT } from './upstream-protocol.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const RELAY = RELAY_ENDPOINT;
const WEB = WEB_CLIENT_ENDPOINT;
const VERSION = '0.1.0';
const DEVICE_NAME = 'HypoDear-DSH';

/**
 * Relay timing contract.
 *
 * Mirrors `packages/shared/src/web-remote-control-heartbeat.ts` from the pinned
 * upstream commit, so this client stays on the schedule the relay expects.
 */
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_JITTER_MS = 2_000;
const HEARTBEAT_ACK_TIMEOUT_MS = 30_000;

/**
 * Reconnect backoff, mirroring the upstream client's "reconnect in place"
 * behaviour. The official terminal transport retries a dropped *paired* socket
 * indefinitely (`scheduleReconnect` has no attempt cap), because a transient
 * relay blip must never cost the user their link.
 */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Query cadence while `waiting` (authenticated but the phone is not matched).
 *
 * The relay settles a pairing when the desktop asks, and the phone only waits
 * ~30 s for that to happen after it wakes and reconnects. A 10 s desktop
 * cadence can miss that window; 2 s means the phone is matched within one or
 * two rounds. Once matched, the normal 10 s heartbeat resumes.
 */
const WAITING_QUERY_MS = 2_000;

/**
 * Floor for the retry that follows a KICKED, and the supervisor cadence.
 *
 * KICKED means the relay still believes an older socket owns this routing slot.
 * Retrying within a second or two — which is what the plain backoff does on a
 * fresh counter — re-collides while the stale entry is still there, so the
 * client kicks itself in a loop instead of waiting the entry out. A floor well
 * above the jittered 1–2 s first step lets the relay's own timeout clear the
 * slot first.
 */
const KICKED_BACKOFF_MS = 30_000;
const SUPERVISOR_INTERVAL_MS = 10_000;
/**
 * How long an unreachable-looking socket may stay quiet before the supervisor
 * replaces it. Must exceed the heartbeat ACK deadline, so a merely slow relay is
 * never mistaken for a stalled one.
 */
const SUPERVISOR_STALL_MS = 45_000;

/** Exponential backoff with full jitter: 1s, 2s, 4s … capped at 30s. */
function reconnectDelayMs(attempt, random = Math.random, baseMs = RECONNECT_BASE_MS, maxMs = RECONNECT_MAX_MS) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : RECONNECT_BASE_MS;
  const cap = Number.isFinite(maxMs) && maxMs >= base ? Math.floor(maxMs) : RECONNECT_MAX_MS;
  const step = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(cap, base * 2 ** Math.min(step, 20));
  const sample = random();
  const value = Number.isFinite(sample) ? Math.min(0.999999999, Math.max(0, sample)) : 0;
  // Full jitter over [ceiling/2, ceiling] keeps a fleet of devices from
  // reconnecting in lockstep after a relay-side restart.
  return Math.floor(ceiling / 2) + Math.floor(value * (ceiling / 2 + 1));
}

/**
 * Close codes that mean "this pairing is finished" rather than "try again".
 *
 * From the official `WebRemoteControlCloseCodes` table. Retrying these is
 * pointless — the relay has already revoked the session, so the only cure is a
 * fresh pairing. Everything else (1006 abnormal closure, 1001 going away, a
 * socket error, a heartbeat timeout) is treated as transient.
 */
const FATAL_CLOSE_CODES = new Set([4004, 4009, 4011, 4012, 4013]);

function isFatalCloseCode(code) { return FATAL_CLOSE_CODES.has(code); }

/** A heartbeat jitter must stay strictly below the base interval. */
function heartbeatJitterMs(baseMs = HEARTBEAT_INTERVAL_MS, configuredMs = HEARTBEAT_JITTER_MS) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : HEARTBEAT_INTERVAL_MS;
  const fallback = Math.min(HEARTBEAT_JITTER_MS, Math.floor(base * 0.2));
  const requested = configuredMs ?? fallback;
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  // Jitter must be smaller than the base interval, or a legal heartbeat
  // degenerates into a 0 ms storm.
  return Math.min(Math.floor(requested), Math.max(0, base - 1));
}

/** One jittered heartbeat delay. Re-sampled every round, never cached. */
function heartbeatDelayMs(
  baseMs = HEARTBEAT_INTERVAL_MS,
  configuredMs = HEARTBEAT_JITTER_MS,
  random = Math.random,
) {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.floor(baseMs) : HEARTBEAT_INTERVAL_MS;
  const jitter = heartbeatJitterMs(base, configuredMs);
  const min = Math.max(1, base - jitter);
  const max = base + jitter;
  const sample = random();
  const value = Number.isFinite(sample) ? Math.min(0.999999999, Math.max(0, sample)) : 0;
  return min + Math.floor(value * (max - min + 1));
}

/**
 * Relay connection for one desktop pairing.
 *
 * The identity (`device_sid` + `pass_hash`) lives in `this.identity` so it
 * survives a transient drop and can be reused to reconnect *in place* — the
 * phone keeps the very same link. Only `stop()` (an explicit user action, or a
 * leaked-link refresh) discards it.
 */
export class Relay {
  constructor({
    onPayload,
    onStatus = () => {},
    onCredentials = () => {},
    onDiagnostic = () => {},
    WebSocketCtor = WebSocket,
    deviceMid,
    resume,
    heartbeatIntervalMs,
    heartbeatJitterMs,
    heartbeatAckTimeoutMs,
    autoReconnect = true,
    reconnectBaseMs,
    reconnectMaxMs,
    waitingQueryMs,
    kickedBackoffMs,
    supervisorIntervalMs,
    supervisorStallMs,
  } = {}) {
    Object.assign(this, { onPayload, onStatus, onCredentials, onDiagnostic, WebSocketCtor });
    this.options = { deviceMid, resume, heartbeatIntervalMs, heartbeatJitterMs, heartbeatAckTimeoutMs, autoReconnect,
      reconnectBaseMs, reconnectMaxMs, waitingQueryMs, kickedBackoffMs, supervisorIntervalMs, supervisorStallMs };
    this.state = 'stopped';
    this.stateChangedAt = Date.now();
    this.generation = 0;
    this.identity = null;
    this.established = false;
    this.reconnectAttempt = 0;
    this.kickedFloorMs = 0;
    this.connectedAt = 0;
  }
  status() {
    return { state: this.state, error: this.error ?? null,
      reconnectAttempt: this.state === 'reconnecting' ? this.reconnectAttempt : 0 };
  }
  setState(state, error) {
    this.state = state;
    this.error = error;
    this.stateChangedAt = Date.now();
    this.onStatus(this.status());
  }
  /**
   * @param override - per-start identity, for a caller that loads persisted
   *   credentials after the Relay was constructed (e.g. resume on boot).
   */
  async start(override = {}) {
    this.stop();
    const deviceMid = override.deviceMid ?? this.options.deviceMid;
    const resume = override.resume ?? this.options.resume;
    // A minted mid must be persisted immediately, not only on the fresh-pairing
    // path: a resumed pairing never sees `device_register_ack`, so a mid picked
    // here would otherwise be forgotten on every restart and the phone's link
    // would rotate out from under the user each time.
    const mid = deviceMid ?? `dsh-remote-${randomUUID()}`;
    if (mid !== deviceMid) this.onCredentials({ deviceMid: mid });
    this.identity = {
      // A stable device identity keeps the relay routing this machine
      // consistently, and keeps the published link unchanged across restarts.
      mid,
      // Resuming reuses the stored pass hash; a fresh pairing mints one.
      hash: resume?.passHash ?? createHash('sha256').update(randomBytes(32)).digest('base64'),
      sid: resume?.deviceSid ?? null,
    };
    this.startSupervisor();
    // Route the first attempt through the same classifier as every retry: a
    // socket constructor that throws synchronously must not end the chain.
    return this.attemptConnect();
  }
  /**
   * One connection attempt. Resolves once authenticated; rejects if this
   * attempt fails. A failure *before* authentication is terminal (the caller
   * asked to connect and we could not), while a failure *after* a successful
   * authentication is handed to the reconnect scheduler instead.
   */
  open() {
    const generation = this.generation;
    const identity = this.identity;
    if (!identity) return Promise.reject(new Error('Relay identity missing'));
    this.setState('connecting');
    const ws = this.socket = new this.WebSocketCtor(`${RELAY}?mid=${encodeURIComponent(identity.mid)}`);
    const active = () => generation === this.generation && this.socket === ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(this.connectTimer);
        if (error) reject(new Error(error)); else resolve(this.status());
      };
      this.cancelStart = () => finish('Pairing stopped');
      const fail = (error, detail) => {
        // Always settle this attempt's promise so no caller is left waiting; the
        // classification below is skipped for a superseded attempt, which must
        // not drive the reconnect chain.
        finish(error);
        if (!active()) return;
        this.handleFailure(error, detail);
      };
      this.connectTimer = setTimeout(() => fail('Relay authentication timed out'), 20000);
      ws.addEventListener('open', () => {
        if (!active()) return;
        // Count the handshake as progress: the supervisor must not treat a
        // freshly opened socket as quiet just because no frame has arrived yet.
        this.lastReceived = Date.now();
        // Resuming skips registration: the stored device_sid is still the identity
        // the relay knows, so the previously issued link keeps working.
        if (identity.sid) this.sendAuthInit();
        else this.send({ type: 'device_register_init', device_mid: identity.mid, pass_hash: identity.hash,
          meta: { platform: process.platform, version: VERSION, name: DEVICE_NAME } });
      });
      ws.addEventListener('message', async event => {
        if (!active()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024) throw new Error();
          const message = JSON.parse(event.data);
          this.lastReceived = Date.now();
          if (message.type === 'device_register_ack') {
            if (typeof message.device_sid !== 'string' || !message.device_sid) throw new Error();
            identity.sid = message.device_sid;
            // Hand the new identity to the caller so a later start() can resume it.
            // `mid` rides along: it is a component of the phone link, so dropping
            // it would change the link on every restart. See `start()`.
            this.onCredentials({ deviceSid: identity.sid, passHash: identity.hash, deviceMid: identity.mid });
            this.sendAuthInit();
          } else if (message.type === 'auth_challenge') {
            if (!identity.sid || typeof message.nonce !== 'string') throw new Error();
            this.send({ type: 'auth_response', device_sid: identity.sid,
              proof: createHmac('sha256', identity.hash).update(`${message.nonce}|device|${identity.sid}`).digest('base64url') });
          } else if (message.type === 'auth_ack' || message.type === 'pair_status_ack') {
            // A pair-status frame is the ACK the watchdog waits for, so it is
            // re-armed here — exactly where the upstream client arms it.
            this.armAckWatchdog();
            this.setState(message.pair_status === 'matched' ? 'connected' : 'waiting');
            if (message.type === 'auth_ack') {
              // Authenticated: from here on a drop is recoverable in place.
              this.established = true;
              this.connectedAt = Date.now();
              this.startHeartbeat();
              // If the phone is already sitting in its waiting window (a screen
              // waking from Safari backgrounding), one extra query right now can
              // match it immediately instead of making it wait a full cadence.
              this.send({ type: 'pair_status_query', device_sid: identity.sid });
              finish();
            }
          } else if (message.type === 'data') {
            if (this.state !== 'connected') return;
            // A frame whose *content* fails to process is not a protocol error:
            // keep the pairing and let the next frame or a resync recover.
            try { await this.onPayload(message.payload); }
            catch (error) {
              this.onDiagnostic({ at: Date.now(), kind: 'payload-error',
                error: String(error?.message ?? error), code: null, reason: 'payload',
                wasEstablished: this.established, attempt: this.reconnectAttempt });
            }
          } else if (message.type === 'error') {
            // The official relay can report INTERNAL while the phone reloads.
            // Retain device pairing, suspend business frames and recheck status.
            if (message.code === 'INTERNAL' && ['connected', 'waiting'].includes(this.state)) {
              this.setState('waiting');
              this.send({ type: 'pair_status_query', device_sid: identity.sid });
            } else {
              // The official client maps KICKED to session-conflict, not
              // session-expired: the relay still knows the device_sid, it just
              // believes another connection owns it. That happens when a stale
              // socket (a killed process, a reboot) lingers on the relay side —
              // confirmed by a live diagnostic: one KICKED, then a manual re-scan
              // worked. Conflict clears once the old socket times out, so back off
              // and retry rather than discarding a perfectly good pairing.
              // Only AUTH_FAILED / WRONG_PARAM prove the stored credentials are
              // no longer accepted; those stay terminal.
              const fatal = ['AUTH_FAILED', 'WRONG_PARAM'].includes(message.code);
              fail(`Relay rejected the connection (${message.code})`, { fatal, reason: message.code });
            }
          }
        } catch { fail('Remote protocol error; refresh pairing'); }
      });
      ws.addEventListener('error', () => fail('Relay connection failed'));
      ws.addEventListener('close', event => {
        const code = event?.code ?? 1006;
        const reason = typeof event?.reason === 'string' ? event.reason : '';
        fail(
          isFatalCloseCode(code)
            ? `Relay closed the session (${code}${reason ? ` ${reason}` : ''}); refresh pairing`
            : `Relay connection closed (${code}); reconnecting`,
          { code, reason },
        );
      });
    });
  }
  /**
   * Classify a failure and either go terminal or schedule a reconnect.
   *
   * Retry is gated on holding an identity and on the relay *not* having revoked
   * us (close codes / AUTH_FAILED / WRONG_PARAM) — the same rule the official
   * client applies when it checks `hadPairedSession`. `wasEstablished` is
   * reported for diagnostics only; it must not gate recovery, or the first
   * failed attempt after a restart would discard a perfectly good pairing.
   */
  handleFailure(error, detail = {}) {
    const fatal = detail.fatal === true || isFatalCloseCode(detail.code);
    // Retry whenever the relay did not explicitly revoke us and we still hold an
    // identity to retry *with*. Requiring `established` here was the bug behind
    // "only a restart fixes it": `begin()` resets `established` via `stop()`, so
    // the first post-boot attempt that failed tore down the identity outright
    // and left the plugin in `error` with nothing left to reconnect.
    const recoverable = !fatal && this.options.autoReconnect && !!this.identity;
    // KICKED means the relay believes another socket already owns this
    // device_sid. The routing id is deliberately NOT rotated here: `mid` is a
    // component of the phone link (`link()`), so rotating it silently orphans
    // the link the user is holding — that was the "it broke again" loop, and it
    // also turned the stale-socket race into an endless re-collide. A stale
    // socket from a killed process clears on the relay's own timeout, so back
    // off and retry with the identity that already works. The single-instance
    // claim in index.js is what prevents a *live* second process from fighting
    // over this slot in the first place.
    // A connection that survived a while is a genuinely fresh start: reset the
    // backoff. One that was kicked seconds after auth_ack is part of the same
    // outage — resetting there would restart the backoff at 1 s on every cycle,
    // which is exactly the KICKED hammering the first live diagnostic showed
    // (five KICKEDs, attempt=0 each, 20 s apart).
    const lived = Date.now() - (this.connectedAt ?? 0);
    if (lived > 60_000) this.reconnectAttempt = 0;
    this.onDiagnostic({
      at: Date.now(),
      kind: fatal ? 'fatal' : recoverable ? 'transient' : 'terminal',
      error,
      code: detail.code ?? null,
      reason: detail.reason ?? null,
      wasEstablished: this.established,
      attempt: this.reconnectAttempt,
      livedMs: this.connectedAt ? Date.now() - this.connectedAt : null,
    });
    this.teardown();
    if (!recoverable) {
      this.identity = null;
      this.setState('error', error);
      return;
    }
    this.setState('reconnecting', error);
    // A KICKED slot is occupied by a socket the relay has not reaped yet, so the
    // ordinary 1–2 s first step re-collides instead of recovering. Wait well
    // past the relay's own reap window before re-registering this identity.
    this.kickedFloorMs = detail.reason === 'KICKED'
      ? (this.options.kickedBackoffMs ?? KICKED_BACKOFF_MS) : 0;
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.max(this.kickedFloorMs ?? 0, reconnectDelayMs(this.reconnectAttempt++,
      Math.random, this.options.reconnectBaseMs, this.options.reconnectMaxMs));
    this.kickedFloorMs = 0;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'reconnecting') return;
      this.attemptConnect();
    }, delay);
  }
  /**
   * Run one connection attempt and make sure its outcome is always classified.
   *
   * `open()` can reject without ever reaching `handleFailure` — a missing
   * identity, or a socket constructor that throws before any listener is
   * attached. Swallowing that rejection ended the retry chain for good, which is
   * why a wedged plugin needed a manual DSH restart. Both exits now either
   * reconnect or record why they stopped.
   */
  attemptConnect() {
    try {
      return this.open().catch(error => {
        try { this.handleFailure(`Relay connection failed (${error?.message ?? error})`); }
        catch { /* classification must never escape into an unhandled rejection */ }
      });
    } catch (error) {
      try { this.handleFailure(`Relay connection failed (${error?.message ?? error})`); }
      catch { /* as above */ }
      return Promise.resolve();
    }
  }
  /**
   * Liveness watchdog, independent of every other timer and event.
   *
   * The reconnect chain is a sequence of self-scheduling timers, and any single
   * broken link in it silently parks the client in `reconnecting` forever —
   * observed live: `attempt=1`, no socket, no new diagnostics for 90 s, while the
   * process stayed healthy. This asserts the invariant directly instead of
   * trusting the chain: if we hold an identity, are supposed to be recovering,
   * and have no live socket, reconnect now.
   */
  startSupervisor() {
    if (this.supervisorTimer) return;
    const interval = this.options.supervisorIntervalMs ?? SUPERVISOR_INTERVAL_MS;
    const stall = this.options.supervisorStallMs ?? SUPERVISOR_STALL_MS;
    this.supervisorTimer = setInterval(() => {
      // Any state that should be reachable to the relay is supervised — not just
      // `reconnecting`. A half-open socket (the relay or an intermediary drops the
      // connection without a close frame, which is the ~86 s signature in
      // diagnostics.jsonl) leaves us parked in `connecting` holding a dead socket
      // object forever, and the original check let the supervisor skip exactly
      // that case. This asserts the invariant instead: an identity we are trying
      // to use must have had *some* sign of life recently.
      if (!this.identity) return;
      if (['stopped', 'error'].includes(this.state)) return;
      const alive = this.socket && this.socket.readyState === 1;
      // A pending attempt is expected to produce traffic shortly; give it a full
      // period past its last observed progress before declaring it stalled.
      const quietFor = Date.now() - Math.max(this.stateChangedAt ?? 0, this.lastReceived ?? 0);
      if (alive && quietFor < stall) return;
      if (!alive && this.reconnectTimer && quietFor < interval) return;
      if (quietFor < stall) return;
      this.onDiagnostic({ at: Date.now(), kind: 'transient', error: 'Reconnect stalled; retrying',
        code: null, reason: 'supervisor', wasEstablished: this.established,
        attempt: this.reconnectAttempt, livedMs: quietFor });
      // Drop whatever dead socket we are holding so the next attempt starts clean.
      this.teardown();
      this.setState('reconnecting', 'Reconnect stalled; retrying');
      this.kickedFloorMs = 0;
      this.scheduleReconnect();
    }, interval);
    // Never hold the process open on this alone.
    this.supervisorTimer.unref?.();
  }
  stopSupervisor() {
    clearInterval(this.supervisorTimer);
    this.supervisorTimer = null;
  }
  sendAuthInit() {
    this.send({ type: 'auth_init', role: 'device', device_sid: this.identity.sid,
      meta: { platform: process.platform, version: VERSION, name: DEVICE_NAME } });
  }
  /**
   * Heartbeat runs on a recursive timer, re-sampling its delay every round.
   *
   * The upstream client is explicit about why a fixed `setInterval` is wrong: it
   * phase-locks every device paired at the same moment, and it replays the
   * callbacks missed while the machine slept in one burst. The ACK deadline is
   * armed separately, because folding it into the heartbeat would let the
   * jittered interval drift the 30 s loss detection.
   *
   * The one deliberate departure from the upstream interval: while `waiting`,
   * queries are sent every ~2 s instead of 10 s. The relay settles a pairing
   * when the *desktop* asks — so when the phone wakes its browser and tries to
   * reconnect, it only has a ~30 s waiting window, and a 10 s desktop cadence
   * risks missing it. Live evidence: the phone kept failing with
   * "Desktop did not match this mobile connection before the waiting timeout"
   * even though the desktop link was alive the whole time.
   */
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.lastReceived = Date.now();
    this.armAckWatchdog();
    this.scheduleHeartbeat();
  }
  heartbeatInterval() {
    // Two different cadences for two different jobs: while the phone is not
    // matched the desktop must poll fast enough to settle the pairing inside
    // the phone's ~30 s window; once matched, the official 10 s heartbeat
    // resumes. An explicit heartbeatIntervalMs pins both cadences (tests and
    // tuning); waitingQueryMs only overrides the waiting leg in production.
    if (this.state === 'waiting') {
      const base = this.options.waitingQueryMs ?? this.options.heartbeatIntervalMs ?? WAITING_QUERY_MS;
      const jitter = Math.min(1_000, Math.floor(base * 0.2));
      return base - jitter + Math.floor(Math.random() * (jitter * 2 + 1));
    }
    return heartbeatDelayMs(this.options.heartbeatIntervalMs, this.options.heartbeatJitterMs);
  }
  scheduleHeartbeat() {
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (!['waiting', 'connected'].includes(this.state)) return;
      this.send({ type: 'pair_status_query', device_sid: this.identity?.sid });
      this.scheduleHeartbeat();
    }, this.heartbeatInterval());
  }
  armAckWatchdog() {
    if (!['waiting', 'connected'].includes(this.state)) return;
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (!['waiting', 'connected'].includes(this.state)) return;
      this.failHeartbeat();
    }, this.options.heartbeatAckTimeoutMs ?? HEARTBEAT_ACK_TIMEOUT_MS);
  }
  failHeartbeat() {
    // A silent relay is indistinguishable from a dead socket, so treat it like
    // any other transient drop: reconnect in place rather than losing the link.
    this.handleFailure('Relay heartbeat timed out', { reason: 'heartbeat-timeout' });
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ ...message, client_ts: Date.now() }));
    return true;
  }
  payload(payload) { return this.state === 'connected' && this.send({ type: 'data', payload }); }
  link() {
    // `reconnecting` still has a valid identity, so the link stays usable.
    if (!this.identity?.sid || !['waiting', 'connected', 'reconnecting'].includes(this.state)) return null;
    // The timestamp is part of the pairing request, not merely cache-busting:
    // without it a freshly opened page is rejected as a stale link ("现在正常新
    // 连接也是显示失效"). Dropping it was tried and reverted — do not remove.
    // It is re-derived on demand by index.js instead of being frozen here, so a
    // link copied earlier keeps working rather than aging out.
    return `${WEB}?${new URLSearchParams({ sid: this.identity.sid, hash: this.identity.hash, mid: this.identity.mid,
      t: String(Date.now()), name: DEVICE_NAME })}`;
  }
  /** Drop the socket and every timer, but keep the identity for a retry. */
  teardown() {
    this.generation++;
    clearTimeout(this.connectTimer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.ackTimer);
    this.connectTimer = this.heartbeatTimer = this.ackTimer = null;
    this.cancelStart?.();
    this.cancelStart = null;
    const socket = this.socket;
    this.socket = null;
    // Guarded: teardown runs on the failure path, so it must never itself throw
    // (an unexpected socket implementation must not mask the original error).
    try {
      if (typeof socket?.close === 'function' && socket.readyState < 2) socket.close();
    } catch { /* closing a already-broken socket is not interesting */ }
  }
  /** Explicit stop: discard the identity so nothing is resumed implicitly. */
  stop() {
    this.teardown();
    this.stopSupervisor();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.identity = null;
    this.established = false;
    this.reconnectAttempt = 0;
    this.kickedFloorMs = 0;
    this.connectedAt = 0;
    this.setState('stopped');
  }
}
