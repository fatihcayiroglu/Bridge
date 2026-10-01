// scripts/federation-lab/lib/apsign.mjs
//
// A remote ActivityPub actor the lab controls ("mallory" on evil.bridge.test):
// a real RSA key pair, an actor document served over HTTPS by the lab's TLS
// front, and a draft-cavage HTTP Signature implementation identical in shape
// to Bridge's own `delivery.ts` signRequest — but with every parameter
// (signed header list, Date, body after signing) under the lab's control, so
// adversarial requests can be built that a well-behaved server never sends.

import crypto from 'node:crypto';
import https from 'node:https';

export function rsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export const digestOf = (body) => 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');

/**
 * Signs a request the way Mastodon/Bridge do.
 * @returns headers for the request (Date, Digest, Signature, Host, Content-Type)
 */
export function signAp({ method = 'POST', url, body = '', privateKey, keyId, headers = ['(request-target)', 'host', 'date', 'digest'], date = new Date() }) {
  const u = new URL(url);
  const values = {
    '(request-target)': `${method.toLowerCase()} ${u.pathname}${u.search}`,
    host: u.host,
    date: date.toUTCString(),
    digest: digestOf(body),
  };
  const signingString = headers.map((h) => `${h}: ${values[h]}`).join('\n');
  const signature = crypto.createSign('RSA-SHA256').update(signingString).sign(privateKey, 'base64');
  return {
    Host: values.host,
    Date: values.date,
    Digest: values.digest,
    'Content-Type': 'application/activity+json',
    Signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="${headers.join(' ')}",signature="${signature}"`,
  };
}

/** POST over the lab's TLS (CA pinned). Returns { status, body }. */
export function postTls(url, headers, body, ca) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      host: '127.0.0.1', servername: u.hostname, port: u.port, method: 'POST', path: `${u.pathname}${u.search}`,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, ca,
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', (err) => resolve({ status: 0, body: String(err) }));
    req.end(body);
  });
}

export function getTls(url, ca, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    https.get({ host: '127.0.0.1', servername: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { Host: u.host, Accept: 'application/activity+json, application/json', ...headers }, ca }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let parsed = text; try { parsed = JSON.parse(text); } catch { /* text */ } resolve({ status: res.statusCode, body: parsed, headers: res.headers }); });
    }).on('error', (err) => resolve({ status: 0, body: String(err) }));
  });
}

/** Actor document for a lab-controlled remote actor. */
export function actorDoc(origin, username, publicKeyPem) {
  const id = `${origin}/api/federation/users/${username}`;
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id, type: 'Person', preferredUsername: username, inbox: `${id}/inbox`, outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
  };
}
