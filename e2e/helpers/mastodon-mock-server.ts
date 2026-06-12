// e2e/helpers/mastodon-mock-server.ts
// Sprint 119: Gerçek Mastodon olmadan ActivityPub protokolünü CI'da test etmeye yarar.
//
// Bu mock, mastodon-activitypub.spec.ts'in MASTODON_URL/MASTODON_TOKEN
// değişkenleri yokken atlandığı sorununu çözer. CI'da gerçek bir AP peer
// simüle eder — gerçek bir Mastodon instance gerektirmez.
//
// Kullanım (test dosyasında):
//   import { startMastodonMock, stopMastodonMock } from './mastodon-mock-server';
//   test.beforeAll(async () => { mockServer = await startMastodonMock(); });
//   test.afterAll(async  () => { await stopMastodonMock(mockServer); });

import http from 'http';
import { AddressInfo } from 'net';
import crypto from 'crypto';

export interface MockServer {
  url: string;
  server: http.Server;
  /** Mock sunucuya gelen istekler (doğrulama için) */
  receivedRequests: MockRequest[];
}

export interface MockRequest {
  method: string;
  path:   string;
  body:   unknown;
  headers: Record<string, string | string[] | undefined>;
  ts:     number;
}

// Sabit RSA anahtar çifti — test amacıyla (üretimde kullanılmaz)
const MOCK_PRIVATE_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLF29amygykEMmYz0+Kcj3bKBp29O2mB0dJ/IUkP
H/3qdYxDQ5dO9VVZDXB5LFIY3O0ysHLMCFzI5k25VjWv2LoPJa02Qf5x0SyMXY
mvJZEwI7vMRhXGiNnrZhK01NTGwTn4kCdN1T/oJZcVBJ4kJMJZGpxQN4TwlXO1
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMwIDAQABAoIBAEiRRFBb1bMGmYVQFHGKqwDmM1IxzE7P3x7Sg3L8QZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
-----END RSA PRIVATE KEY-----`;

// Mock sunucu yanıt verileri
const MOCK_ACTOR_ID_SUFFIX = '/users/mockuser';
let mockBaseUrl = '';

function buildActor(baseUrl: string) {
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id:                `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}`,
    type:              'Person',
    preferredUsername: 'mockuser',
    name:              'Mock User (CI Test)',
    inbox:             `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}/inbox`,
    outbox:            `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}/outbox`,
    followers:         `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}/followers`,
    following:         `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}/following`,
    publicKey: {
      id:           `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}#main-key`,
      owner:        `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}`,
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2a2rwplBQLkylHGbNSAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nQIDAQAB\n-----END PUBLIC KEY-----\n`,
    },
  };
}

function buildNodeInfo(baseUrl: string) {
  return {
    version:   '2.1',
    software:  { name: 'mastodon-mock', version: '4.0.0-mock' },
    protocols: ['activitypub'],
    usage: {
      users:          { total: 1, activeMonth: 1, activeHalfyear: 1 },
      localPosts:     5,
      localComments:  0,
    },
    openRegistrations: false,
  };
}

function buildWebFinger(baseUrl: string, resource: string) {
  const username = resource.split('@')[0]?.replace('acct:', '') || 'mockuser';
  return {
    subject: resource,
    aliases: [`${baseUrl}${MOCK_ACTOR_ID_SUFFIX}`],
    links: [
      {
        rel:  'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}`,
      },
      {
        rel:  'self',
        type: 'application/activity+json',
        href: `${baseUrl}${MOCK_ACTOR_ID_SUFFIX}`,
      },
    ],
  };
}

/**
 * Basit bir HTTP mock server başlatır.
 * ActivityPub endpoint'lerini simüle eder.
 */
export async function startMastodonMock(): Promise<MockServer> {
  const receivedRequests: MockRequest[] = [];

  const server = http.createServer((req, res) => {
    const url    = new URL(req.url!, `http://${req.headers.host}`);
    const path   = url.pathname;
    const search = url.searchParams;

    // İstek kaydı
    let bodyStr = '';
    req.on('data', (chunk) => { bodyStr += chunk.toString(); });
    req.on('end', () => {
      let body: unknown = bodyStr;
      try { body = JSON.parse(bodyStr); } catch { /* ignore */ }
      receivedRequests.push({
        method:  req.method!,
        path,
        body,
        headers: req.headers as Record<string, string | string[] | undefined>,
        ts:      Date.now(),
      });

      // Route
      res.setHeader('Content-Type', 'application/json');

      // NodeInfo
      if (path === '/.well-known/nodeinfo') {
        res.writeHead(200);
        res.end(JSON.stringify({
          links: [{
            rel:  'http://nodeinfo.diaspora.software/ns/schema/2.1',
            href: `${mockBaseUrl}/nodeinfo/2.1`,
          }],
        }));
        return;
      }

      if (path === '/nodeinfo/2.1') {
        res.writeHead(200);
        res.end(JSON.stringify(buildNodeInfo(mockBaseUrl)));
        return;
      }

      // WebFinger
      if (path === '/.well-known/webfinger') {
        const resource = search.get('resource') || '';
        res.writeHead(200);
        res.end(JSON.stringify(buildWebFinger(mockBaseUrl, resource)));
        return;
      }

      // Actor
      if (path === MOCK_ACTOR_ID_SUFFIX) {
        res.setHeader('Content-Type', 'application/activity+json');
        res.writeHead(200);
        res.end(JSON.stringify(buildActor(mockBaseUrl)));
        return;
      }

      // Outbox
      if (path === `${MOCK_ACTOR_ID_SUFFIX}/outbox`) {
        res.setHeader('Content-Type', 'application/activity+json');
        res.writeHead(200);
        res.end(JSON.stringify({
          '@context':   'https://www.w3.org/ns/activitystreams',
          id:           `${mockBaseUrl}${MOCK_ACTOR_ID_SUFFIX}/outbox`,
          type:         'OrderedCollection',
          totalItems:   1,
          orderedItems: [],
        }));
        return;
      }

      // Inbox — Bridge'den gelen POST aktivitelerini kabul et
      if (path === `${MOCK_ACTOR_ID_SUFFIX}/inbox` && req.method === 'POST') {
        res.writeHead(202);
        res.end(JSON.stringify({ accepted: true }));
        return;
      }

      // Followers / Following
      if (path === `${MOCK_ACTOR_ID_SUFFIX}/followers` || path === `${MOCK_ACTOR_ID_SUFFIX}/following`) {
        res.setHeader('Content-Type', 'application/activity+json');
        res.writeHead(200);
        res.end(JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          type:       'OrderedCollection',
          totalItems: 0,
          orderedItems: [],
        }));
        return;
      }

      // 404
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = (server.address() as AddressInfo).port;
  mockBaseUrl = `http://127.0.0.1:${port}`;

  return { url: mockBaseUrl, server, receivedRequests };
}

/**
 * Mock sunucuyu durdurur.
 */
export async function stopMastodonMock(mock: MockServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}
