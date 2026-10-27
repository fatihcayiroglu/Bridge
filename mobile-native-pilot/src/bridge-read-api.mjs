// Experimental, read-only Bridge API adapter for RN. NOT a login flow or product parity proof.
// Routes and response envelopes were checked against server/routes/{auth,servers,channels,messages}.
// No token persistence, refresh, logging, retries, or silent fallback is allowed here.
export class BridgeReadError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeReadError';
    this.code = code;
  }
}

function verifiedOrigin(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new BridgeReadError('INVALID_ORIGIN'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new BridgeReadError('INVALID_ORIGIN');
  }
  return u.origin;
}

function verifiedId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new BridgeReadError('INVALID_ID');
  }
  return encodeURIComponent(value);
}

function requiredList(value) {
  if (!Array.isArray(value)) throw new BridgeReadError('BAD_RESPONSE');
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item._id !== 'string' || !item._id || typeof item.name !== 'string') {
      throw new BridgeReadError('BAD_RESPONSE');
    }
    list.push({ id: item._id, name: item.name });
  }
  return list;
}

function classifyStatus(status) {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 409) return 'SESSION_CHANGED';
  if (status >= 500) return 'SERVER_UNAVAILABLE';
  return 'REQUEST_REJECTED';
}

/**
 * getSession() MUST be an injected, memory-only snapshot provider returning
 * { token, epoch }, where epoch changes on login/logout/account switch.
 * An actual secure native key store and token refresh are separate work.
 */
export function createBridgeReadApi({ origin, getSession, fetchImpl = fetch }) {
  const root = verifiedOrigin(origin);
  if (typeof getSession !== 'function' || typeof fetchImpl !== 'function') {
    throw new BridgeReadError('INVALID_ADAPTER');
  }

  async function request(path, { signal } = {}) {
    let before;
    try { before = await getSession(); } catch { throw new BridgeReadError('AUTH_REQUIRED'); }
    if (!before || typeof before.token !== 'string' || !before.token ||
        !['string', 'number'].includes(typeof before.epoch)) {
      throw new BridgeReadError('AUTH_REQUIRED');
    }
    let response;
    try {
      response = await fetchImpl(root + path, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + before.token, Accept: 'application/json' },
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw new BridgeReadError('ABORTED');
      throw new BridgeReadError('NETWORK_FAILURE');
    }
    // Run before interpreting status or body: stale responses must not reach an account switch.
    async function assertSameSession() {
      let after;
      try { after = await getSession(); } catch { throw new BridgeReadError('SESSION_CHANGED'); }
      if (!after || after.epoch !== before.epoch || after.token !== before.token) {
        throw new BridgeReadError('SESSION_CHANGED');
      }
    }
    await assertSameSession();
    if (!response || typeof response.status !== 'number' || typeof response.ok !== 'boolean') {
      throw new BridgeReadError('BAD_RESPONSE');
    }
    if (!response.ok) throw new BridgeReadError(classifyStatus(response.status));
    let data;
    try { data = await response.json(); } catch { throw new BridgeReadError('BAD_RESPONSE'); }
    // JSON parsing can itself await; fence it too.
    await assertSameSession();
    return data;
  }

  return Object.freeze({
    async getMe(options = {}) {
      const data = await request('/api/me', options);
      const id = data && typeof data === 'object' && (data._id || data.id);
      if (typeof id !== 'string' || !id) throw new BridgeReadError('BAD_RESPONSE');
      return { id, displayName: typeof data.displayName === 'string' ? data.displayName : '' };
    },
    async listServers(options = {}) {
      return requiredList(await request('/api/servers', options));
    },
    async listChannels(serverId, options = {}) {
      return requiredList(await request('/api/servers/' + verifiedId(serverId) + '/channels', options));
    },
    async listMessages(channelId, options = {}) {
      const id = verifiedId(channelId);
      const limit = options.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new BridgeReadError('INVALID_LIMIT');
      }
      const data = await request('/api/channels/' + id + '/messages?limit=' + limit, options);
      if (!data || typeof data !== 'object' || !Array.isArray(data.messages) ||
          typeof data.hasMore !== 'boolean' ||
          (data.nextCursor !== null && typeof data.nextCursor !== 'string')) {
        throw new BridgeReadError('BAD_RESPONSE');
      }
      for (const item of data.messages) {
        if (!item || typeof item !== 'object' || typeof item._id !== 'string' || !item._id) {
          throw new BridgeReadError('BAD_RESPONSE');
        }
      }
      return { messages: data.messages, hasMore: data.hasMore, nextCursor: data.nextCursor };
    },
  });
}
