// Durable client outbox for the existing message ackId protocol.
// Pure persistence only: socket replay/timers remain owned by MessageInputPanel.

export const OUTBOX_KEY_PREFIX = 'bridge:outbox:v1';
export const MAX_OUTBOX_ENTRIES = 100;
const memoryFallback = new Map<string, OutboxEntry[]>();
const fallbackOnly = new Set<string>();

export type OutboxState = 'queued' | 'sending' | 'failed';
export type OutboxMessageType = 'normal' | 'file' | 'sticker';

export interface OutboxEntry {
  ackId: string;
  userId: string;
  channelId: string;
  serverId: string;
  draftKind: 'channel' | 'dm' | 'gdm';
  messageType: OutboxMessageType;
  content: string;
  replyToId?: string;
  replyPreview?: { _id: string; displayName?: string; content?: string };
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  stickerPackId?: string;
  stickerId?: string;
  stickerSnapshot?: { id: string; packId: string; name: string; url: string; width: number; height: number };
  createdAt: number;
  state: OutboxState;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export function outboxKey(userId: string): string | null {
  return userId ? `${OUTBOX_KEY_PREFIX}:${userId}` : null;
}

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; }
  catch { return null; }
}

function validEntry(value: unknown, expectedUserId: string): value is OutboxEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<OutboxEntry>;
  if (entry.userId !== expectedUserId) return false;
  if (!entry.ackId || entry.ackId.length > 64 || !entry.channelId || !entry.serverId) return false;
  if (!['queued', 'sending', 'failed'].includes(String(entry.state))) return false;
  if (!['normal', 'file', 'sticker'].includes(String(entry.messageType))) return false;
  if (!['channel', 'dm', 'gdm'].includes(String(entry.draftKind))) return false;
  if (typeof entry.content !== 'string' || entry.content.length > 2000) return false;
  if (entry.messageType === 'file' && (!entry.fileUrl || !entry.fileName)) return false;
  if (entry.messageType === 'sticker' && (!entry.stickerPackId || !entry.stickerId || !entry.stickerSnapshot)) return false;
  return typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt);
}

function writeAll(userId: string, entries: OutboxEntry[]): boolean {
  const key = outboxKey(userId);
  if (!key) return false;
  if (entries.length === 0) {
    try { storage()?.removeItem(key); } catch { /* storage unavailable */ }
    memoryFallback.delete(key);
    fallbackOnly.delete(key);
    return true;
  }
  const bounded = entries.slice(0, MAX_OUTBOX_ENTRIES);
  try {
    const store = storage();
    // ── DEPOLAMANIN YOKLUĞU DA BİR ARIZADIR ────────────────────────────────
    // Burada eskiden `storage()?.setItem(...)` vardı. İsteğe bağlı zincir,
    // depolama HİÇ YOKKEN (gömülü görünüm, katı gizlilik ayarı, `about:blank`
    // gibi bir kaynak) çağrıyı sessizce yutuyor ve kod BAŞARI yoluna
    // giriyordu: bellek yedeği SİLİNİYOR ve `true` dönülüyordu.
    //
    // Sonuç, modülün var olma sebebinin tam tersiydi — kullanıcının
    // gönderilmemiş mesajı, kuyruğa alındığı anda kayboluyordu; üstelik
    // "kaydedildi" denerek.
    //
    // Yokluk artık atma ile AYNI şekilde ele alınır: oturum bellekte
    // güvenilir kalır, yeniden yükleme dayanıklılığı ise iddia EDİLMEZ.
    if (!store) throw new Error('storage unavailable');
    store.setItem(key, JSON.stringify(bounded));
    memoryFallback.delete(key);
    fallbackOnly.delete(key);
    return true;
  } catch {
    // Storage may be blocked/quota-limited. Keep the active session reliable
    // in memory and continue honestly; reload durability is unavailable.
    memoryFallback.set(key, bounded);
    fallbackOnly.add(key);
    return true;
  }
}

export function readOutbox(userId: string): OutboxEntry[] {
  const key = outboxKey(userId);
  if (!key) return [];
  // A failed write means the in-memory copy is newer than whatever may still
  // be present on disk.  Prefer it until a later mutation successfully writes
  // the complete queue and `writeAll` clears `fallbackOnly`.  Reading a valid
  // but stale localStorage value here used to make a freshly queued message
  // disappear immediately after a quota/security failure.
  if (fallbackOnly.has(key)) return [...(memoryFallback.get(key) ?? [])];
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('invalid outbox');
    const entries = parsed.filter((entry): entry is OutboxEntry => validEntry(entry, userId));
    if (entries.length !== parsed.length) writeAll(userId, entries);
    return entries.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    try { storage()?.removeItem(key); } catch { /* storage unavailable */ }
    return [];
  }
}

/** @internal test/session cleanup for storage-less environments. */
export function resetOutboxMemory(): void {
  memoryFallback.clear();
  fallbackOnly.clear();
}

/** Browser/process restart: an in-flight item becomes reconnect-waiting. */
export function restoreOutbox(userId: string): OutboxEntry[] {
  const entries = readOutbox(userId).map((entry) =>
    entry.state === 'sending' ? { ...entry, state: 'queued' as const } : entry,
  );
  writeAll(userId, entries);
  return entries;
}

export function putOutboxEntry(entry: OutboxEntry): boolean {
  const entries = readOutbox(entry.userId);
  const index = entries.findIndex((item) => item.ackId === entry.ackId);
  if (index >= 0) entries[index] = entry;
  else {
    if (entries.length >= MAX_OUTBOX_ENTRIES) return false;
    entries.push(entry);
  }
  return writeAll(entry.userId, entries.sort((a, b) => a.createdAt - b.createdAt));
}

export function patchOutboxEntry(
  userId: string,
  ackId: string,
  patch: Partial<Pick<OutboxEntry, 'state' | 'attempts' | 'lastAttemptAt' | 'lastError'>>,
): OutboxEntry | null {
  const entries = readOutbox(userId);
  const index = entries.findIndex((entry) => entry.ackId === ackId);
  if (index < 0) return null;
  entries[index] = { ...entries[index], ...patch };
  return writeAll(userId, entries) ? entries[index] : null;
}

export function removeOutboxEntry(userId: string, ackId: string): void {
  writeAll(userId, readOutbox(userId).filter((entry) => entry.ackId !== ackId));
}

export function outboxForChannel(userId: string, channelId: string): OutboxEntry[] {
  return readOutbox(userId).filter((entry) => entry.channelId === channelId);
}
