// Use an unambiguous, versioned representation at the native string boundary.
export function outboxNamespaceMaterial(origin, accountId) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('ACCOUNT_REQUIRED');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('INVALID_ORIGIN');
  // JSON escapes embedded NULs; a C/JNI string boundary cannot discard the
  // account suffix as it can with an origin + literal-NUL + account string.
  return JSON.stringify(['bridge-native-outbox-v1', origin, accountId]);
}
