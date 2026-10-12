// Persisted ActivityPub rows may carry a null/blank published timestamp.
// Number(null), Number('') and Number(false) are all zero in JavaScript;
// accepting them would hide a later valid createdAt and reorder lifecycle
// or direct-message history. Ignore absent/malformed values, preserve zero
// when it was actually persisted, and never accept negative/nonfinite time.
export function firstUsableRowTime(
  row: Record<string, unknown>,
  fields: readonly string[],
): number {
  for (const field of fields) {
    const raw = row[field];
    if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) continue;
    const time = Number(raw);
    if (Number.isSafeInteger(time) && time >= 0) return time;
  }
  return 0;
}
