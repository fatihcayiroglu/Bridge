// Bounded, memory-only intermediate outbox. App restart loses queued drafts.
// Every retry reuses the ORIGINAL ackId; the Bridge server deduplicates by
// (userId, ackId), including a durable unique index. This is not exactly-once
// delivery. Unknown outcomes stop ordering until explicitly retried with retry().
export function createOutbox({ coordinator, realtime, createId, capacity = 100 }) {
  if (!coordinator?.getSession || !coordinator?.subscribe || !realtime?.send ||
      !realtime?.getStatus || typeof createId !== 'function' ||
      !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('INVALID_OUTBOX');
  const rows = new Map();
  let epoch = coordinator.getSession()?.epoch;
  let flight = null;
  let disposed = false;
  function sync() {
    const next = coordinator.getSession()?.epoch;
    if (next !== epoch) { epoch = next; rows.clear(); }
  }
  const unsubscribe = coordinator.subscribe(sync);
  const snapshot = () => [...rows.values()].map(row => Object.freeze({ ...row }));
  function flush() {
    sync();
    if (flight) return flight;
    if (disposed || epoch === undefined || realtime.getStatus() !== 'online') return Promise.resolve(snapshot());
    const mine = epoch;
    const work = async () => {
      for (const row of rows.values()) {
        sync();
        if (disposed || epoch !== mine || realtime.getStatus() !== 'online') break;
        if (row.status === 'confirmed') continue;
        if (row.status !== 'queued') break;
        row.status = 'sending';
        let result;
        try { result = await realtime.send({ serverId: row.serverId, channelId: row.channelId, content: row.content, ackId: row.id }); }
        catch { result = { status: 'unconfirmed', reason: 'SEND_ERROR' }; }
        sync();
        if (disposed || epoch !== mine || rows.get(row.id) !== row) break;
        if (result?.status === 'confirmed' && typeof result.messageId === 'string' && result.messageId) {
          row.status = 'confirmed'; row.messageId = result.messageId;
        } else {
          // Do not send a younger entry past an uncertain or rejected operation.
          row.status = result?.status === 'failed' ? 'failed' : 'unconfirmed';
          break;
        }
      }
      return snapshot();
    };
    // Schedule after flight is assigned, so concurrent callers share one owner.
    const promise = Promise.resolve().then(work).finally(() => { if (flight === promise) flight = null; });
    flight = promise;
    return promise;
  }
  return Object.freeze({
    enqueue({ serverId, channelId, content }) {
      sync();
      if (disposed || epoch === undefined) throw new Error('SESSION_REQUIRED');
      if (![serverId, channelId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v)) ||
          typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('INVALID_MESSAGE');
      if (rows.size >= capacity) throw new Error('OUTBOX_FULL');
      const id = createId(); // Inject a cryptographically random UUID in the native app.
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || rows.has(id)) throw new Error('INVALID_ID');
      rows.set(id, { id, serverId, channelId, content, status: 'queued' });
      return id;
    },
    flush,
    retry(id) {
      sync();
      const row = rows.get(id);
      if (disposed || !row || !['unconfirmed', 'failed'].includes(row.status)) throw new Error('NOT_RETRYABLE');
      row.status = 'queued';
      return flush();
    },
    remove(id) {
      sync();
      const row = rows.get(id);
      if (row && !['confirmed', 'queued'].includes(row.status)) throw new Error('OUTCOME_UNRESOLVED');
      rows.delete(id);
    },
    snapshot() { sync(); return snapshot(); },
    dispose() { disposed = true; unsubscribe(); rows.clear(); },
  });
}
