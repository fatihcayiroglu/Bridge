// The debug fixture must actually load through the configured reverse tunnel;
// reading a preference alone cannot establish which URL React Native used.
export function requireMetroLoopbackSource(source) {
  if (typeof source !== 'string') throw new Error('NATIVE_METRO_ROUTE_MISMATCH');
  let url;
  try { url = new URL(source); } catch { throw new Error('NATIVE_METRO_ROUTE_MISMATCH'); }
  if (url.origin !== 'http://127.0.0.1:8081' || url.username || url.password) throw new Error('NATIVE_METRO_ROUTE_MISMATCH');
}
