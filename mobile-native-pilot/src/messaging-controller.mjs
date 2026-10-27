// UI state owner. Tokens never enter snapshots. Unknown sends require explicit
// stable-ID retry; reconnect only flushes drafts that have not been attempted.
import { createOutbox } from './outbox.mjs';

export function createMessagingController({ coordinator, read, realtime, createId }) {
  const box = createOutbox({ coordinator, realtime, createId });
  const listeners = new Set();
  let disposed = false, sequence = 0;
  let state = { session: coordinator.getState(), connection: realtime.getStatus(), servers: [], channels: [],
    serverId: null, channelId: null, messages: [], error: null, loading: false };
  const snapshot = () => ({ ...state, servers: [...state.servers], channels: [...state.channels],
    messages: [...state.messages], drafts: box.snapshot().filter(row => row.channelId === state.channelId) });
  const emit = () => { if (!disposed) for (const listener of [...listeners]) { try { listener(snapshot()); } catch {} } };
  const current = (seq, epoch) => !disposed && seq === sequence && coordinator.getSession()?.epoch === epoch;
  const error = () => { state.error = 'REQUEST_FAILED'; emit(); };
  async function loadServers() {
    const seq = sequence, epoch = coordinator.getSession()?.epoch;
    if (disposed || epoch === undefined) return;
    try { const servers = await read.listServers(); if (current(seq, epoch)) { state.servers = servers; emit(); } }
    catch { if (current(seq, epoch)) error(); }
  }
  async function history() {
    const seq = sequence, epoch = coordinator.getSession()?.epoch, channel = state.channelId;
    if (disposed || !channel || epoch === undefined) return;
    try {
      const response = await read.listMessages(channel, { limit: 50 });
      if (!current(seq, epoch) || channel !== state.channelId) return;
      // Keep events received during the request. Server identity is the only
      // deduplication key; equal message content does not establish identity.
      const merged = new Map(response.messages.map(row => [row._id, row]));
      for (const row of state.messages) merged.set(row._id, row);
      state.messages = [...merged.values()].sort((a, b) => Number(a.createdAt) - Number(b.createdAt)); emit();
    } catch { if (current(seq, epoch)) error(); }
  }
  async function flush() {
    if (disposed) return;
    const seq = sequence, epoch = coordinator.getSession()?.epoch;
    for (const row of box.snapshot()) if (row.status === 'queued') realtime.joinChannel(row.channelId);
    const work = box.flush(); await Promise.resolve(); emit(); await work;
    if (!current(seq, epoch)) return;
    emit(); if (realtime.getStatus() === 'online') await history();
  }
  const unsubscribeSession = coordinator.subscribe(session => {
    if (disposed) return;
    if (session.epoch !== state.session.epoch || session.phase !== 'authenticated') {
      sequence++;
      state = { ...state, servers: [], channels: [], serverId: null, channelId: null, messages: [], error: null, loading: false };
    }
    state.session = session; emit();
    if (session.phase === 'authenticated' && !state.serverId) void loadServers();
  });
  const unsubscribeStatus = realtime.onStatus(connection => {
    state.connection = connection; emit();
    if (connection === 'online') {
      if (state.channelId) realtime.joinChannel(state.channelId);
      void flush();
    }
  });
  const unsubscribeMessage = realtime.onMessage(message => {
    if (disposed || !coordinator.getSession() || message.channelId !== state.channelId) return;
    state.messages = [...state.messages.filter(row => row._id !== message._id), message]; emit();
  });
  return Object.freeze({
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() { if (disposed) return; realtime.start(); await loadServers(); },
    async selectServer(serverId) {
      const seq = ++sequence, epoch = coordinator.getSession()?.epoch;
      state = { ...state, serverId, channelId: null, channels: [], messages: [], error: null }; emit();
      if (epoch === undefined || disposed) return;
      try { const channels = await read.listChannels(serverId); if (current(seq, epoch)) { state.channels = channels; emit(); } }
      catch { if (current(seq, epoch)) error(); }
    },
    async selectChannel(channelId) {
      if (!state.channels.some(row => row.id === channelId)) throw new Error('CHANNEL_NOT_SELECTED');
      sequence++; state.channelId = channelId; state.messages = []; state.error = null;
      realtime.joinChannel(channelId); emit(); await history();
    },
    async send(content) {
      if (!state.serverId || !state.channelId) throw new Error('CHANNEL_REQUIRED');
      box.enqueue({ serverId: state.serverId, channelId: state.channelId, content }); emit(); await flush();
    },
    async retry(id) {
      const row = box.snapshot().find(row => row.id === id);
      if (!row || row.channelId !== state.channelId) throw new Error('DRAFT_NOT_SELECTED');
      realtime.joinChannel(row.channelId);
      const seq = sequence, epoch = coordinator.getSession()?.epoch;
      const work = box.retry(id); emit(); await work;
      if (current(seq, epoch)) { emit(); await history(); }
    },
    refresh: history,
    dispose() { disposed = true; sequence++; unsubscribeSession(); unsubscribeStatus(); unsubscribeMessage(); box.dispose(); realtime.dispose(); listeners.clear(); },
  });
}
