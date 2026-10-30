// P7: accounts whose local-first data was erased on this device.
//
// Leaf module (no imports) so the store composition root, the record store and
// the key provider can all consult it without an import cycle.
//
// An account is marked BEFORE any record or key is deleted, and the mark is
// persisted. From then on no local store for that account opens durable
// storage, no key is created for it and no encrypted record is written for it,
// so a delayed draft, outbox or history write cannot re-create data after an
// erasure. A wipe interrupted by a crash or reload is completed by the startup
// sweep, which re-runs for every marked account (idempotent). Account ids are
// server-issued and never reused, so a mark never blocks a different account.

const STORAGE_KEY = 'bridge:local-first:erased-accounts:v1';
/** Bounded: one entry per account deleted on this device. */
const MAX_TRACKED = 64;
const MAX_ID_LENGTH = 256;

const marked = new Set<string>();

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function persisted(): string[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(validId).slice(-MAX_TRACKED) : [];
  } catch {
    return [];
  }
}

/**
 * Mark first, delete second. Returns false when the mark could not be
 * persisted: the in-memory mark still blocks this session, and the caller
 * reports that a reload could re-open the data before the wipe completes.
 */
export function markLocalAccountErased(userId: string): boolean {
  if (!validId(userId)) throw new Error('A valid account id is required');
  marked.add(userId);
  const ids = persisted().filter(id => id !== userId);
  ids.push(userId);
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_TRACKED)));
    return true;
  } catch {
    return false;
  }
}

export function isLocalAccountErased(userId: string): boolean {
  return marked.has(userId) || persisted().includes(userId);
}

/** Every account this device must keep erased (for the startup sweep). */
export function erasedLocalAccounts(): string[] {
  return [...new Set([...persisted(), ...marked])];
}

/** Test-only reset of the in-memory marks; never used by production code. */
export function resetErasedLocalAccountsForTests(): void {
  marked.clear();
}
