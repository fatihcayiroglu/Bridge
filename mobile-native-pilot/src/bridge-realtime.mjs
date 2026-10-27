// Realtime channel messaging for the RN pilot over Bridge's EXISTING Socket.IO
// contract (server/socket/contracts.ts, handlers/messages-send.ts, members.ts).
// No event, field or acknowledgement is invented here.
//
// Server contract, as it is:
// - Handshake auth `{ token }` (access token). Refusals arrive as connect_error
//   messages: 'Unauthorized' / 'Token revoked' mean the token; anything else is not.
// - `channel:join` (channelId): no acknowledgement; the server joins only a member
//   who may view the channel.
// - `message:send` accepts { channelId, serverId, content, ackId? }. With ackId,
//   message:ack echoes { ackId, channelId, messageId }. The server deduplicates
//   by user + ackId in its repository and unique database index. Outbox callers
//   retain this id across retries; a broadcast alone cannot confirm these sends.
// - Legacy callers without ackId still use their own message:new echo. Those
//   sends are never automatically retried because their outcome is ambiguous.
//
// Consequences enforced here:
// - A send is CONFIRMED by the correlated ACK (or legacy own echo), FAILED by error:message,
//   and otherwise UNCONFIRMED after a timeout. It is never resent automatically:
//   the outbox must explicitly retry an uncertain send with its original ackId.
// - The socket belongs to one session epoch. An account switch or sign-out tears it
//   down; nothing from the old socket reaches the new session.
// - An auth refusal causes at most one shared refresh (coordinator single flight),
//   then a reconnect with the rotated token. invalid_grant ends the session.
export class RealtimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RealtimeError';
    this.code = code;
  }
}

const AUTH_REFUSALS = new Set(['Unauthorized', 'Token revoked']);
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_CONTENT = 4000;

/**
 * @param origin       https origin
 * @param coordinator  session coordinator (getSession, subscribe, refreshAfterUnauthorized)
 * @param connect      (origin, options) => socket   (socket.io-client `io`)
 * @param confirmTimeoutMs time after which an unechoed send is UNCONFIRMED
 */
export function createBridgeRealtime({ origin, coordinator, connect, confirmTimeoutMs = 10_000 }) {
  let root;
  try { root = new URL(origin); } catch { throw new RealtimeError('INVALID_ORIGIN'); }
  if (root.protocol !== 'https:' || !coordinator || typeof coordinator.getSession !== 'function' ||
      typeof coordinator.subscribe !== 'function' || typeof coordinator.refreshAfterUnauthorized !== 'function' ||
      typeof connect !== 'function') {
    throw new RealtimeError('INVALID_ADAPTER');
  }

  let socket = null;
  let socketEpoch = null;
  let userId = null;
  let tokenUsed = null;
  let status = 'offline'; // offline | connecting | online | auth-failed
  let lifecycle = 0;
  const joined = new Set();
  const pending = new Map(); // key → { resolve, timer }
  const messageListeners = new Set();
  const statusListeners = new Set();

  function setStatus(next) {
    if (status === next) return;
    status = next;
    for (const l of [...statusListeners]) { try { l(next); } catch { /* isolated */ } }
  }

  function settleAll(result) {
    for (const [key, p] of pending) { clearTimeout(p.timer); pending.delete(key); p.resolve(result); }
  }

  function teardown(next = 'offline') {
    lifecycle += 1;
    const s = socket;
    socket = null;
    socketEpoch = null;
    tokenUsed = null;
    joined.clear();
    settleAll({ status: 'unconfirmed', reason: 'SESSION_ENDED' });
    if (s) { try { s.removeAllListeners?.(); s.disconnect(); } catch { /* already gone */ } }
    setStatus(next);
  }

  function open() {
    const session = coordinator.getSession();
    const state = coordinator.getState?.();
    if (!session) { teardown('offline'); return; }
    if (socket && socketEpoch === session.epoch) return;
    teardown('connecting');
    socketEpoch = session.epoch;
    userId = state?.userId ?? null;
    const mine = session.epoch;
    const s = connect(root.origin, {
      transports: ['websocket'],
      // Evaluated on every (re)connection attempt: always the current token of
      // THIS epoch, or none (which the server refuses) after a transition.
      auth: (cb) => {
        const now = coordinator.getSession();
        tokenUsed = now && now.epoch === mine ? now.token : null;
        cb({ token: tokenUsed ?? '' });
      },
      reconnection: true,
    });
    socket = s;
    const current = () => socket === s && socketEpoch === mine;

    s.on('connect', () => {
      if (!current()) return;
      setStatus('online');
      for (const channelId of joined) s.emit('channel:join', channelId);
    });
    s.on('disconnect', () => { if (current()) setStatus('connecting'); });
    s.on('connect_error', async (error) => {
      if (!current()) return;
      if (!AUTH_REFUSALS.has(String(error?.message))) return; // transport trouble: socket.io retries
      const failedToken = tokenUsed;
      s.io?.opts && (s.io.opts.reconnection = false);
      s.disconnect();
      const fresh = failedToken ? await coordinator.refreshAfterUnauthorized({ token: failedToken, epoch: mine }) : null;
      if (!current()) return;
      if (!fresh) { teardown('auth-failed'); return; }
      s.io?.opts && (s.io.opts.reconnection = true);
      s.connect();
    });
    s.on('message:new', (msg) => {
      if (!current() || !msg || typeof msg !== 'object' || !joined.has(msg.channelId)) return;
      const key = `${msg.channelId}\u0000${msg.content}`;
      if (msg.userId === userId && pending.has(key) && !pending.get(key).ackId) {
        const p = pending.get(key);
        clearTimeout(p.timer);
        pending.delete(key);
        p.resolve({ status: 'confirmed', messageId: String(msg._id) });
      }
      for (const l of [...messageListeners]) { try { l(msg); } catch { /* isolated */ } }
    });
    s.on('message:ack', (ack) => {
      if (!current() || !ack || typeof ack.ackId !== 'string' ||
          typeof ack.messageId !== 'string' || !ack.messageId) return;
      const key = `ack:${ack.ackId}`;
      const p = pending.get(key);
      if (!p || ack.channelId !== p.channelId) return;
      clearTimeout(p.timer);
      pending.delete(key);
      p.resolve({ status: 'confirmed', messageId: ack.messageId });
    });
    s.on('error:message', (err) => {
      if (!current() || !err || err.event !== 'message:send') return;
      // The server names no message, so sends are serialised (at most one in flight):
      // the refusal belongs to the single pending send.
      const first = pending.entries().next();
      if (first.done) return;
      const [key, p] = first.value;
      if (p.ackId && err.ackId !== p.ackId) return;
      clearTimeout(p.timer);
      pending.delete(key);
      p.resolve({ status: 'failed', code: typeof err.code === 'string' ? err.code : 'REJECTED' });
    });
  }

  // At most one send in flight per socket, so an un-correlated error:message
  // cannot be attributed to the wrong message.
  let sendChain = Promise.resolve();

  const unsubscribe = coordinator.subscribe((state) => {
    if (state.phase === 'authenticated') {
      if (socketEpoch !== state.epoch) open();
    } else if (socket) {
      teardown('offline');
    }
  });

  return Object.freeze({
    start() { open(); },
    stop() { teardown('offline'); },
    dispose() { unsubscribe(); teardown('offline'); },
    getStatus: () => status,
    onStatus(listener) { statusListeners.add(listener); return () => statusListeners.delete(listener); },
    onMessage(listener) { messageListeners.add(listener); return () => messageListeners.delete(listener); },
    joinChannel(channelId) {
      if (!ID_RE.test(String(channelId))) throw new RealtimeError('INVALID_ID');
      joined.add(channelId);
      if (socket && status === 'online') socket.emit('channel:join', channelId);
    },
    /**
     * Resolves to {status:'confirmed', messageId} | {status:'failed', code} |
     * {status:'unconfirmed', reason}. Never resends.
     */
    send({ serverId, channelId, content, ackId }) {
      if (!ID_RE.test(String(serverId)) || !ID_RE.test(String(channelId))) return Promise.reject(new RealtimeError('INVALID_ID'));
      if (typeof content !== 'string' || !content.trim() || content.length > MAX_CONTENT) return Promise.reject(new RealtimeError('INVALID_CONTENT'));
      if (!joined.has(channelId)) return Promise.reject(new RealtimeError('NOT_JOINED'));
      if (ackId !== undefined && (typeof ackId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(ackId))) return Promise.reject(new RealtimeError('INVALID_ID'));
      const admittedEpoch = coordinator.getSession()?.epoch;
      const admittedLifecycle = lifecycle;
      const run = () => {
        if (admittedEpoch === undefined || coordinator.getSession()?.epoch !== admittedEpoch || lifecycle !== admittedLifecycle) return { status: 'unconfirmed', reason: 'SESSION_ENDED' };
        if (!socket || status !== 'online') return { status: 'unconfirmed', reason: 'OFFLINE' };
        const key = ackId ? `ack:${ackId}` : `${channelId}\u0000${content}`;
        return new Promise((resolve) => {
          // Bounded and NOT unref'd: an unconfirmed send must always settle.
          const timer = setTimeout(() => { pending.delete(key); resolve({ status: 'unconfirmed', reason: 'NO_ECHO' }); }, confirmTimeoutMs);
          pending.set(key, { resolve, timer, ackId, channelId });
          socket.emit('message:send', { serverId, channelId, content, ...(ackId ? { ackId } : {}) });
        });
      };
      const result = sendChain.then(run, run);
      sendChain = result.then(() => undefined, () => undefined);
      return result;
    },
  });
}
