// scripts/multinode/lib/client.mjs
//
// Minimal Bridge API/Socket.IO client for multi-node scenarios. Every call
// names the base URL it talks to, so a scenario states explicitly which node
// (or the load balancer) served it.

import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from './cluster.mjs';

const require = createRequire(import.meta.url);
const { io } = require(path.join(REPO, 'node_modules/socket.io-client'));
export { io };

// The login/register bot filter scores header shape; a bare fetch() looks like
// a bot. These are the same browser-like headers the e2e probes use.
export const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

export const rnd = () => Math.random().toString(36).slice(2, 10);

function cookiesFrom(res) {
  const out = {};
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

// Nodes run with TRUSTED_PROXY_COUNT=1 (as behind a real load balancer), so a
// direct-to-node request may state its client IP. Scenarios give each
// simulated client its own address; a per-IP limit then behaves as it does in
// production instead of every request sharing 127.0.0.1.
export const fakeIp = () => `198.51.100.${1 + Math.floor(Math.random() * 250)}`;

/** Raw request; returns { status, body, headers, cookies, servedBy }. */
export async function request(base, method, urlPath, { token, body, cookies, headers = {}, csrf, raw, ip } = {}) {
  const h = { ...BROWSER, ...headers };
  if (ip) h['X-Forwarded-For'] = ip;
  if (token) h.Authorization = `Bearer ${token}`;
  if (csrf) h['X-CSRF-Token'] = csrf;
  if (cookies && Object.keys(cookies).length) h.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  let payload;
  if (raw !== undefined) payload = raw;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + urlPath, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, body: parsed, headers: res.headers, cookies: cookiesFrom(res), servedBy: res.headers.get('x-mn-served-by') };
}

export async function csrfToken(base, token, headers) {
  const r = await request(base, 'GET', '/api/csrf-token', { token, headers });
  if (r.status !== 200) throw new Error(`csrf-token ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** Authenticated mutating call with a fresh CSRF token from the same base. */
export async function mutate(base, method, urlPath, token, body, headers) {
  const csrf = await csrfToken(base, token, headers);
  return request(base, method, urlPath, { token, body, csrf, headers });
}

export async function register(base, prefix = 'mn') {
  const username = `${prefix}_${rnd()}`;
  const password = `Mn-${rnd()}-${rnd()}!`;
  const r = await request(base, 'POST', '/api/register', {
    body: { username, email: `${username}@bridge-mn.test`, password, displayName: username },
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${r.status} ${JSON.stringify(r.body)}`);
  return {
    username, password, id: r.body.user?._id || r.body.user?.id,
    token: r.body.token, refresh: r.cookies.bridge_refresh,
  };
}

export async function login(base, user, ip) {
  const r = await request(base, 'POST', '/api/login', { body: { username: user.username, password: user.password }, ip });
  if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(r.body)}`);
  return { token: r.body.token, refresh: r.cookies.bridge_refresh, servedBy: r.servedBy };
}

export async function refresh(base, refreshToken, ip) {
  return request(base, 'POST', '/api/refresh', { cookies: { bridge_refresh: refreshToken }, ip });
}

/** A server with one text channel; `members` are joined through an invite. */
export async function makeServer(base, owner, members = []) {
  const s = await mutate(base, 'POST', '/api/servers', owner.token, { name: `MN ${rnd()}` });
  if (s.status >= 300) throw new Error(`server create ${s.status} ${JSON.stringify(s.body)}`);
  const serverId = s.body._id || s.body.id;
  const c = await mutate(base, 'POST', `/api/servers/${serverId}/channels`, owner.token, { name: `mn-${rnd()}`, type: 'text' });
  if (c.status >= 300) throw new Error(`channel create ${c.status} ${JSON.stringify(c.body)}`);
  const channelId = c.body._id || c.body.id;
  if (members.length) {
    const inv = await mutate(base, 'POST', '/api/servers/invites', owner.token, { serverId });
    if (inv.status >= 300) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
    for (const m of members) {
      const u = await mutate(base, 'POST', `/api/servers/invites/${inv.body.code}/use`, m.token, {});
      if (u.status >= 300) throw new Error(`invite use ${u.status} ${JSON.stringify(u.body)}`);
    }
  }
  return { serverId, channelId };
}

/**
 * Connect a Socket.IO client to one base URL. Resolves once the server has
 * finished authenticating (`userAuthenticated`), rejects on connect_error.
 */
export function connectSocket(base, token, { timeoutMs = 15_000, extraHeaders } = {}) {
  return new Promise((resolve, reject) => {
    const s = io(base, {
      auth: { token }, transports: ['websocket'], reconnection: false, timeout: timeoutMs,
      extraHeaders: { 'User-Agent': BROWSER['User-Agent'], ...(extraHeaders || {}) },
    });
    const t = setTimeout(() => { s.close(); reject(new Error('socket auth timeout')); }, timeoutMs);
    s.once('userAuthenticated', () => { clearTimeout(t); resolve(s); });
    s.once('connect_error', (err) => { clearTimeout(t); s.close(); reject(err); });
  });
}

/** Resolve with the first event matching `pred`, or null after `ms`. */
export function nextEvent(socket, event, pred = () => true, ms = 5_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(event, h); resolve(null); }, ms);
    const h = (payload) => { if (pred(payload)) { clearTimeout(t); socket.off(event, h); resolve(payload); } };
    socket.on(event, h);
  });
}

/** Collect every matching event for `ms`. */
export function collect(socket, event, pred = () => true, ms = 2_000) {
  return new Promise((resolve) => {
    const got = [];
    const h = (payload) => { if (pred(payload)) got.push(payload); };
    socket.on(event, h);
    setTimeout(() => { socket.off(event, h); resolve(got); }, ms);
  });
}

export function sendMessage(socket, { channelId, serverId, content, ackId }) {
  const ack = nextEvent(socket, 'message:ack', (a) => a?.ackId === ackId, 8_000);
  socket.emit('message:send', { channelId, serverId, content, ackId });
  return ack;
}

/**
 * Socket through the load balancer with automatic reconnection, the way a
 * real client behaves. `prefer` names the node the LB should route to while
 * it is alive (sticky affinity that fails over when the node dies).
 * Every (re)authentication is recorded with the node that served it.
 */
export function connectSocketLB(lb, token, { prefer } = {}) {
  const s = io(lb, {
    auth: { token }, transports: ['websocket'], reconnection: true,
    reconnectionDelay: 200, reconnectionDelayMax: 1_000, timeout: 10_000,
    extraHeaders: { 'User-Agent': BROWSER['User-Agent'], ...(prefer ? { 'x-mn-prefer': prefer } : {}) },
  });
  s.authentications = [];
  s.on('userAuthenticated', () => s.authentications.push(Date.now()));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('LB socket auth timeout')), 15_000);
    s.once('userAuthenticated', () => { clearTimeout(t); resolve(s); });
  });
}

/** One chunk of a resumable upload. */
export async function uploadChunk(base, token, { uploadId, index, total, body, name = 'file.txt', type = 'text/plain', ip, headers = {}, csrf: givenCsrf }) {
  // A CSRF token is user-bound and valid on every node (Redis store); reuse
  // one per upload so the per-user CSRF issuance budget is not the bottleneck.
  const csrf = givenCsrf || await csrfToken(base, token, headers);
  return request(base, 'POST', '/api/upload/chunk', {
    token, csrf, ip, raw: body,
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'x-upload-id': uploadId, 'x-chunk-index': String(index), 'x-total-chunks': String(total),
      'x-file-name': name, 'x-file-type': type,
    },
  });
}
