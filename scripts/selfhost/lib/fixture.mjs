// scripts/selfhost/lib/fixture.mjs
//
// A small but real dataset created through the product's own API, and a
// verifier that re-reads all of it through the API. Used to prove that data
// survives a restart, an upgrade and a backup → restore — not by counting
// rows, but by logging in with the original password and reading it back.

import crypto from 'node:crypto';
import {
  register, login, mutate, makeServer, connectSocket, sendMessage, nextEvent, request, csrfToken, rnd, BROWSER,
} from '../../multinode/lib/client.mjs';

// A well-formed 1×1 RGBA PNG (IHDR, IDAT, IEND; every CRC valid, nothing after
// IEND). Uploads are parsed, not just magic-byte checked: the previous constant had
// a corrupt IDAT CRC and a truncated IEND and is refused with 422
// IMAGE_UNPARSEABLE. It carries no metadata chunk, so it is stored and served
// byte-identical, which `verify()` relies on.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000d4944415478da6364f8cf500f00038601805a347d6b0000000049454e44ae426082', 'hex');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function rows(body) {
  if (Array.isArray(body)) return body;
  for (const k of ['messages', 'items', 'data', 'conversations']) if (Array.isArray(body?.[k])) return body[k];
  return [];
}

export async function uploadFile(base, token, bytes = PNG, name = 'selfhost.png', type = 'image/png') {
  const csrf = await csrfToken(base, token);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', body: form,
    headers: { 'User-Agent': BROWSER['User-Agent'], Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-CSRF-Token': csrf },
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 || !body?.url) throw new Error(`upload ${res.status} ${JSON.stringify(body)}`);
  return body.url;
}

export async function download(base, token, url) {
  const res = await fetch(new URL(url, base), { headers: { 'User-Agent': BROWSER['User-Agent'], Authorization: `Bearer ${token}` } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** Creates the dataset. Returns everything verify() needs (passwords included). */
export async function seed(base, tag = 'sh') {
  const a = await register(base, `${tag}a`);
  const b = await register(base, `${tag}b`);
  const { serverId, channelId } = await makeServer(base, a, [b]);

  const sock = await connectSocket(base, a.token);
  const channelText = `selfhost channel message ${rnd()}`;
  const ack = await sendMessage(sock, { channelId, serverId, content: channelText, ackId: `sh-${rnd()}` });
  if (!ack) throw new Error('message:send was not acknowledged');

  const dmText = `selfhost dm ${rnd()}`;
  const nonce = `n${rnd()}`;
  const dmEcho = nextEvent(sock, 'dm:message', (m) => m?.clientNonce === nonce, 8_000);
  sock.emit('dm:send', { toUserId: b.id, content: dmText, clientNonce: nonce });
  if (!(await dmEcho)) throw new Error('dm:send was not echoed');
  sock.close();

  const uploadUrl = await uploadFile(base, a.token);
  return {
    users: { a: { username: a.username, password: a.password, id: a.id }, b: { username: b.username, password: b.password, id: b.id } },
    serverId, channelId, channelText, dmText, uploadUrl, uploadSha: sha(PNG),
  };
}

/**
 * Re-reads the dataset with fresh logins. Returns a list of
 * { check, ok, detail } — the caller records each one.
 */
export async function verify(base, fx) {
  const out = [];
  const check = (name, ok, detail = '') => out.push({ check: name, ok: Boolean(ok), detail });
  let a; let b;
  try { a = await login(base, fx.users.a); check('login with the original password (user A)', true); } catch (e) { check('login with the original password (user A)', false, e.message); }
  try { b = await login(base, fx.users.b); check('login with the original password (user B)', true); } catch (e) { check('login with the original password (user B)', false, e.message); }
  if (!a || !b) return out;

  const servers = await request(base, 'GET', '/api/servers', { token: a.token });
  check('server still listed for its owner', rows(servers.body).some((s) => (s._id || s.id) === fx.serverId) || JSON.stringify(servers.body).includes(fx.serverId), `status ${servers.status}`);

  const hist = await request(base, 'GET', `/api/channels/${fx.channelId}/messages`, { token: b.token });
  check('channel message readable by the other member', hist.status === 200 && JSON.stringify(hist.body).includes(fx.channelText), `status ${hist.status}`);

  const dms = await request(base, 'GET', '/api/dm', { token: b.token });
  const conv = rows(dms.body).find((c) => JSON.stringify(c).includes(fx.users.a.id));
  const dmId = conv?._id || conv?.id;
  const dmHist = dmId ? await request(base, 'GET', `/api/dm/${dmId}/messages`, { token: b.token }) : { status: 0, body: null };
  check('DM readable by the recipient', dmHist.status === 200 && JSON.stringify(dmHist.body).includes(fx.dmText), `dm ${dmId ? 'found' : 'missing'}, status ${dmHist.status}`);

  const file = await download(base, a.token, fx.uploadUrl);
  check('uploaded file byte-identical', file.status === 200 && sha(file.bytes) === fx.uploadSha, `status ${file.status}`);

  const write = await mutate(base, 'POST', `/api/servers/${fx.serverId}/channels`, a.token, { name: `post-${rnd()}`, type: 'text' });
  check('accepts writes afterwards', write.status < 300, `status ${write.status}`);
  return out;
}
