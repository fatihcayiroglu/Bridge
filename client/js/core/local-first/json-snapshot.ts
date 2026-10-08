// Local-first encrypted stores persist JSON, not arbitrary JavaScript objects.
// Svelte 5 reactive state uses Proxy objects, which structuredClone rejects in
// Chromium, Firefox and WebKit. Serializing the canonical JSON representation
// produces a detached snapshot without retaining reactive objects or functions.
export function cloneLocalFirstJson<T>(value: T): T {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Local-first payload must be JSON serializable');
  }
  return JSON.parse(encoded) as T;
}
