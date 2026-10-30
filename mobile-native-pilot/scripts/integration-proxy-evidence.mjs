// Disposable fixture diagnostics only. Never retain paths, queries, headers,
// bodies, TLS messages or request IDs. All emitted strings are fixed enums.
const KINDS = new Set(['document', 'script', 'style', 'native-login', 'native-authorize',
  'native-code', 'native-refresh', 'csrf', 'other']);
const PHASES = new Set(['request', 'response', 'complete', 'aborted', 'upstream-error']);
const TLS_CODES = new Set(['ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN', 'ECONNRESET', 'ETIMEDOUT']);
const POST_ROUTES = new Map([['/api/login', 'native-login'],
  ['/api/refresh/native-authorize', 'native-authorize'], ['/api/native-auth/token', 'native-code'],
  ['/api/native-auth/refresh', 'native-refresh']]);
export const TRANSPORT_PREFIX = 'NATIVE_TRANSPORT ';

export function requestKind(method, rawUrl) {
  const route = String(rawUrl ?? '').split('?')[0];
  if (method === 'GET') {
    if (route === '/' || route === '/native-auth') return 'document';
    if (route.startsWith('/assets/') && /\.m?js$/.test(route)) return 'script';
    if (route.startsWith('/assets/') && /\.css$/.test(route)) return 'style';
    if (route === '/api/csrf-token') return 'csrf';
  }
  if (method === 'POST') return POST_ROUTES.get(route) ?? 'other';
  return 'other';
}

function httpEvent(kind, phase, status) {
  return { kind, phase, ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
}

export function observeRequest(req, res, emit) {
  const kind = requestKind(req.method, req.url);
  emit(httpEvent(kind, 'request'));
  res.once('finish', () => emit(httpEvent(kind, 'complete', res.statusCode)));
  res.once('close', () => { if (!res.writableFinished) emit(httpEvent(kind, 'aborted')); });
  return {
    response: status => emit(httpEvent(kind, 'response', status)),
    upstreamError: () => emit(httpEvent(kind, 'upstream-error')),
  };
}

export function tlsEvent(error) {
  return error === undefined ? { kind: 'tls', phase: 'secure' }
    : { kind: 'tls', phase: 'client-error', code: TLS_CODES.has(error?.code) ? error.code : 'OTHER' };
}

// Aggregate only validated enum rows. Unknown/free-form input is discarded.
// Missing evidence is handled by the caller; an empty log means zero observed
// events, never a claim that the browser was able to connect.
export function transportProgress(text) {
  const counts = new Map();
  for (const line of String(text).split('\n')) {
    if (!line.startsWith(TRANSPORT_PREFIX)) continue;
    let row; try { row = JSON.parse(line.slice(TRANSPORT_PREFIX.length)); } catch { continue; }
    let event;
    if (KINDS.has(row?.kind) && PHASES.has(row?.phase)) event = httpEvent(row.kind, row.phase, row.status);
    else if (row?.kind === 'tls' && row.phase === 'secure') event = tlsEvent();
    else if (row?.kind === 'tls' && row.phase === 'client-error') event = tlsEvent({ code: row.code });
    else continue;
    const key = JSON.stringify(event);
    const entry = counts.get(key) ?? { ...event, count: 0 };
    entry.count++; counts.set(key, entry);
  }
  return [...counts.values()];
}
