// server/tests/native-app-links.test.ts
//
// App Links / Universal Links association for the native sign-in callback
// (security review finding 1). Server contract only: this is NOT evidence that
// Android/iOS verify the association on a device; that needs a real domain,
// signed builds and physical devices.
import request from 'supertest';
import express from 'express';
import { loadNativeAppLinksConfig } from '../lib/nativeAppLinks';
import { createNativeAppLinksRouter } from '../routes/nativeAppLinks';

const CERT = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const BASE: NodeJS.ProcessEnv = {
  BASE_URL: 'https://bridge.example',
  NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native/callback,com.bridge.nativepilot:/oauth',
  NATIVE_APP_LINKS_ANDROID_PACKAGE: 'com.bridge.nativepilot',
  NATIVE_APP_LINKS_ANDROID_CERT_SHA256: CERT,
  NATIVE_APP_LINKS_IOS_APP_IDS: 'ABCDE12345.com.bridge.nativepilot',
};
const CB = 'auth.bridge-callback.example';

function app(env: NodeJS.ProcessEnv) {
  const a = express();
  a.use(createNativeAppLinksRouter(env));
  a.use((_req, res) => { res.status(404).send('fallthrough'); });
  return a;
}

describe('config: off by default, fail closed', () => {
  test('nothing configured → off', () => {
    expect(loadNativeAppLinksConfig({ BASE_URL: 'https://bridge.example' })).toEqual({ enabled: false, reason: 'not_configured' });
  });
  test('only custom-scheme redirects → off (no host can vouch for a scheme)', () => {
    expect(loadNativeAppLinksConfig({ ...BASE, NATIVE_AUTH_REDIRECT_URIS: 'com.bridge.nativepilot:/oauth' }))
      .toEqual({ enabled: false, reason: 'no_https_redirect' });
  });
  test.each([
    ['package without certificate', { NATIVE_APP_LINKS_ANDROID_CERT_SHA256: '' }],
    ['certificate without package', { NATIVE_APP_LINKS_ANDROID_PACKAGE: '' }],
    ['lower-case certificate', { NATIVE_APP_LINKS_ANDROID_CERT_SHA256: CERT.toLowerCase() }],
    ['short certificate', { NATIVE_APP_LINKS_ANDROID_CERT_SHA256: CERT.slice(3) }],
    ['bad package', { NATIVE_APP_LINKS_ANDROID_PACKAGE: 'bridge' }],
    ['bad iOS app ID', { NATIVE_APP_LINKS_IOS_APP_IDS: 'com.bridge.nativepilot' }],
    ['too many certificates', { NATIVE_APP_LINKS_ANDROID_CERT_SHA256: Array(5).fill(CERT).join(',') }],
    ['invalid redirect list', { NATIVE_AUTH_REDIRECT_URIS: 'http://auth.bridge-callback.example/native/callback' }],
    ['redirect on the web origin', { NATIVE_AUTH_REDIRECT_URIS: 'https://bridge.example/native/callback' }],
    ['wildcard callback path', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native/*' }],
    ['wildcard inside a path segment', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native/call*back' }],
    ['encoded wildcard callback path', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native/%2A' }],
    ['encoded single-character wildcard', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native/%3F' }],
    ['encoded path separator', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example/native%2Fcallback' }],
    ['iOS callback on a nonstandard port', { NATIVE_AUTH_REDIRECT_URIS: 'https://auth.bridge-callback.example:8443/native/callback' }],
  ])('%s → invalid_configuration, nothing served', async (_name, override) => {
    const env = { ...BASE, ...override };
    expect(loadNativeAppLinksConfig(env)).toEqual({ enabled: false, reason: 'invalid_configuration' });
    for (const path of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association', '/native/callback']) {
      const res = await request(app(env)).get(path).set('Host', CB);
      expect(res.status).toBe(404);
      expect(res.text).toBe('fallthrough');
    }
  });
});

describe('association files: only on the callback host', () => {
  test('assetlinks.json vouches for exactly the configured package and certificate', async () => {
    const res = await request(app(BASE)).get('/.well-known/assetlinks.json').set('Host', CB);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.bridge.nativepilot', sha256_cert_fingerprints: [CERT] },
    }]);
  });

  test('apple-app-site-association limits Universal Links to the callback path and adds webcredentials', async () => {
    for (const path of ['/.well-known/apple-app-site-association', '/apple-app-site-association']) {
      const res = await request(app(BASE)).get(path).set('Host', CB.toUpperCase());
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(JSON.parse(res.text)).toEqual({
        applinks: { details: [{ appIDs: ['ABCDE12345.com.bridge.nativepilot'], components: [{ '/': '/native/callback', comment: 'Bridge native sign-in callback' }] }] },
        webcredentials: { apps: ['ABCDE12345.com.bridge.nativepilot'] },
      });
    }
  });

  test('the Bridge web origin (or any other host) never claims a path for the app', async () => {
    for (const host of ['bridge.example', 'evil.example', '']) {
      for (const path of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association', '/native/callback']) {
        const res = await request(app(BASE)).get(path).set('Host', host);
        expect(res.text).toBe('fallthrough');
      }
    }
  });

  test('forwarded callback host cannot make an unconfigured host publish associations', async () => {
    for (const route of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association', '/native/callback']) {
      const response = await request(app(BASE)).get(route).set('Host', 'bridge.example')
        .set('X-Forwarded-Host', CB).set('Forwarded', `host=${CB};proto=https`);
      expect(response.status).toBe(404);
      expect(response.text).toBe('fallthrough');
    }
  });

  test('each callback host receives only its own exact iOS paths', async () => {
    const env = { ...BASE, NATIVE_AUTH_REDIRECT_URIS: `https://${CB}/native/callback,https://second-callback.example/other/callback` };
    for (const [host, own, other] of [[CB, '/native/callback', '/other/callback'], ['second-callback.example', '/other/callback', '/native/callback']]) {
      const response = await request(app(env)).get('/.well-known/apple-app-site-association').set('Host', host);
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text).applinks.details[0].components).toEqual([{ '/': own, comment: 'Bridge native sign-in callback' }]);
      expect((await request(app(env)).get(other).set('Host', host)).status).toBe(404);
    }
  });

  test('a platform that is not configured is not served', async () => {
    const androidOnly = { ...BASE, NATIVE_APP_LINKS_IOS_APP_IDS: '' };
    expect((await request(app(androidOnly)).get('/.well-known/apple-app-site-association').set('Host', CB)).text).toBe('fallthrough');
    expect((await request(app(androidOnly)).get('/.well-known/assetlinks.json').set('Host', CB)).status).toBe(200);
    const iosOnly = { ...BASE, NATIVE_APP_LINKS_ANDROID_PACKAGE: '', NATIVE_APP_LINKS_ANDROID_CERT_SHA256: '' };
    expect((await request(app(iosOnly)).get('/.well-known/assetlinks.json').set('Host', CB)).text).toBe('fallthrough');
    expect((await request(app(iosOnly)).get('/.well-known/apple-app-site-association').set('Host', CB)).status).toBe(200);
  });
});

describe('callback landing page (app missing or link not verified)', () => {
  test('inert: never echoes the code, no script, no referrer, not cached or indexed', async () => {
    const code = 'secret-authorization-code-value';
    const res = await request(app(BASE)).get(`/native/callback?code=${code}&state=s`).set('Host', CB);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(code);
    expect(res.text).not.toMatch(/<script|<link|<img|https?:\/\//i);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });
  test('only the configured path, only GET/HEAD', async () => {
    expect((await request(app(BASE)).get('/native/other').set('Host', CB)).text).toBe('fallthrough');
    expect((await request(app(BASE)).post('/native/callback').set('Host', CB)).text).toBe('fallthrough');
    expect((await request(app(BASE)).head('/native/callback').set('Host', CB)).status).toBe(200);
  });
});

test('the router is mounted by setupRoutes', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = require('fs').readFileSync(require('path').join(__dirname, '../app/setupRoutes.ts'), 'utf8');
  expect(src).toMatch(/app\.use\(createNativeAppLinksRouter\(\)\);/);
});
