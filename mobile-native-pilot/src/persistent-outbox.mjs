// Durable account-scoped owner over an injected encrypted journal. No storage
// fallback: failed commits never permit external emission or false confirmation.
export function createPersistentOutbox({ coordinator, realtime, createId, openJournal }) {
  let generation = 0, identity = null, journal = null, rows = [], flight = null, disposed = false;
  let opening = Promise.resolve();
  const listeners = new Set();
  const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch {} } };
  const current = mine => !disposed && mine === generation;
  const snapshot = () => rows.map(row => Object.freeze({ ...row }));
  function sync() {
    const session = coordinator.getSession(), state = coordinator.getState();
    const next = session && state.phase === 'authenticated' && state.userId ? `${session.epoch}:${state.userId}` : null;
    if (next === identity) return;
    identity = next; generation++; rows = []; flight = null;
    const mine = generation, previous = journal; journal = null;
    const previousOpening = opening;
    opening = (async () => {
      // Finish/close any superseded initialization before opening another
      // journal, including a fast A -> B -> A switch during SecureStore I/O.
      await previousOpening.catch(() => {});
      if (previous) await previous.close();
      if (!next || !current(mine)) return;
      const store = await openJournal(state.userId);
      if (!current(mine)) { await store.close(); return; }
      const restored = await store.list();
      if (!current(mine)) { await store.close(); return; }
      journal = store; rows = restored; emit();
    })();
    // Observers see failure through ready()/enqueue()/flush(), never an
    // unhandled rejection or a silent memory-only downgrade.
    opening.catch(() => {});
    emit();
  }
  const unsubscribe = coordinator.subscribe(sync);
  sync();
  async function context() {
    sync(); const mine = generation; await opening;
    if (!current(mine) || !journal) throw new Error('SESSION_OR_STORAGE_UNAVAILABLE');
    return { mine, store: journal };
  }
  function flush() {
    sync(); if (flight) return flight;
    const promise = (async () => {
      const { mine, store } = await context();
      for (const row of rows) {
        if (!current(mine) || realtime.getStatus() !== 'online') break;
        if (row.status === 'confirmed') continue;
        if (row.status !== 'queued') break;
        // Write-ahead boundary: never emit a message whose attempt identity
        // has not committed to the encrypted database.
        await store.mark(row.id, 'sending');
        if (!current(mine)) break;
        row.status = 'sending'; emit();
        realtime.joinChannel(row.channelId);
        let result;
        try { result = await realtime.send({ serverId: row.serverId, channelId: row.channelId, content: row.content, ackId: row.id }); }
        catch { result = { status: 'unconfirmed' }; }
        if (!current(mine)) break;
        const confirmed = result?.status === 'confirmed' && typeof result.messageId === 'string' && result.messageId;
        const status = confirmed ? 'confirmed' : result?.status === 'failed' ? 'failed' : 'unconfirmed';
        await store.mark(row.id, status, confirmed ? result.messageId : null);
        if (!current(mine)) break;
        row.status = status; if (confirmed) row.messageId = result.messageId; emit();
        if (!confirmed) break;
      }
      return snapshot();
    })().finally(() => { if (flight === promise) flight = null; });
    flight = promise; return promise;
  }
  return Object.freeze({
    ready: () => context().then(() => undefined),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    snapshot,
    async enqueue(input) {
      const { mine, store } = await context();
      const row = await store.append({ ...input, id: createId() });
      if (!current(mine)) throw new Error('SESSION_CHANGED');
      if (!rows.some(existing => existing.id === row.id)) rows.push({ ...row }); emit(); return row.id;
    },
    flush,
    async retry(id) {
      const { mine, store } = await context();
      const row = rows.find(row => row.id === id);
      if (!row || !['unconfirmed', 'failed'].includes(row.status)) throw new Error('NOT_RETRYABLE');
      await store.mark(id, 'queued');
      if (!current(mine)) throw new Error('SESSION_CHANGED');
      row.status = 'queued'; emit(); return flush();
    },
    async remove(id) {
      const { mine, store } = await context(); await store.remove(id);
      if (current(mine)) { rows = rows.filter(row => row.id !== id); emit(); }
    },
    dispose() { if (disposed) return; disposed = true; generation++; unsubscribe(); rows = []; listeners.clear(); if (journal) void journal.close().catch(() => {}); journal = null; },
  });
}
