// User-scoped saved search shortcuts. Only canonical query text is persisted;
// results/snippets are always re-fetched so current permissions are authoritative.
export const MAX_SAVED_SEARCHES = 12;
const MAX_QUERY_LENGTH = 180;
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function key(userId: string): string {
  const safe = userId.trim().slice(0, 128) || 'anonymous';
  return `bridge:saved-searches:${safe}`;
}
export function normalizeSaved(list: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const value = raw.trim().slice(0, MAX_QUERY_LENGTH);
    const folded = value.toLocaleLowerCase();
    if (!value || seen.has(folded)) continue;
    seen.add(folded); out.push(value);
    if (out.length >= MAX_SAVED_SEARCHES) break;
  }
  return out;
}
export function loadSaved(userId: string, store: StorageLike | null = storage()): string[] {
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(key(userId)) ?? '[]') as unknown;
    return Array.isArray(parsed) ? normalizeSaved(parsed.filter((v): v is string => typeof v === 'string')) : [];
  } catch { return []; }
}
export function saveSaved(userId: string, list: readonly string[], store: StorageLike | null = storage()): void {
  if (!store) return;
  try { store.setItem(key(userId), JSON.stringify(normalizeSaved(list))); } catch { /* optional shortcut */ }
}
export function addSaved(list: readonly string[], query: string): string[] {
  return normalizeSaved([query, ...list]);
}
export function removeSaved(list: readonly string[], query: string): string[] {
  const folded = query.trim().toLocaleLowerCase();
  return list.filter(item => item.toLocaleLowerCase() !== folded);
}
