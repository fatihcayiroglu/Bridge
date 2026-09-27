'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(process.env.BRIDGE_AUDIT_ROOT || path.join(__dirname, '..'));
const read = (rel, enc='utf8') => fs.readFileSync(path.join(ROOT, rel), enc);

test('private servers never enter Discover fallback or Featured catalog', () => {
  const s = read('server/routes/discover.ts');
  assert.doesNotMatch(s, /if\s*\(!servers\.length\)[\s\S]{0,500}Servers\.find\(\{\}\)/);
  assert.match(s, /Servers\.find\(\{\s*featured:\s*true,\s*discoverable:\s*1\s*\}\)/);
  assert.match(s, /discover:featured:list:v2/);
});

test('Discover client can request the product catalog limit and categories have one canonical vocabulary', () => {
  const server = read('server/routes/discover.ts');
  const client = read('client/js/core/DiscoverPanel.svelte');
  assert.match(client, /\/api\/discover\?limit=\$\{MAX_SERVERS\}/);
  assert.match(server, /'education'/);
  assert.doesNotMatch(server, /DISCOVER_CATEGORIES\s*=\s*\[[^\]]*'edu'/s);
  assert.match(server, /raw\s*===\s*'edu'[^\n]*return\s*'education'/);
  assert.match(server, /rawCategory\s*!==\s*'edu'/);
  assert.match(server, /update\.category\s*=\s*normalizeDiscoverCategory\(category\)/);
});

test('deployment never serves /uploads directly ahead of Node authorization', () => {
  for (const rel of ['nginx.conf','infra/nginx-site.conf','infra/nginx-cloudflare.conf']) {
    const s = read(rel);
    const block = s.match(/location\s+\^~\s+\/uploads\/\s*\{[\s\S]*?\n\s*\}/)?.[0] || '';
    assert.ok(block, `${rel}: protected uploads block missing`);
    assert.doesNotMatch(block, /\balias\b|\broot\b/, `${rel}: direct static uploads bypass`);
    assert.match(block, /proxy_pass/, `${rel}: uploads must reach Bridge authorization`);
  }
});


test('monitoring understands protected upload-root responses after the authz fix', () => {
  const s = read('monitoring/uptime.yml');
  assert.match(s, /expectedStatusCodes:\s*\[200,\s*401,\s*404\]/);
});

test('health stats use identity/authority, never source-IP trust', () => {
  const s = read('server/routes/health.ts');
  const start = s.indexOf("router.get('/stats'");
  assert.ok(start >= 0);
  const block = s.slice(start, start + 900);
  assert.match(block, /authMiddleware/);
  assert.match(block, /databaseAdminOnly/);
  assert.doesNotMatch(block, /startsWith\(['\"](?:10\.|172\.)/);
});

test('private OG metadata requires discoverability or an explicit invite/vanity capability', () => {
  const s = read('server/routes/servers/og-image.ts');
  assert.match(s, /if\s*\(!server\)\s*return\s+res\.status\(404\)/);
  assert.match(s, /!discoverable\s*&&\s*!await\s+hasPrivatePreviewCapability/);
  assert.match(s, /Invites\.isValid\(invite\)\s*===\s*null/);
  assert.match(s, /getLiveVanityServer/);
  assert.match(s, /private, no-store/);
});

test('mobile version comes from the canonical package version', () => {
  const s = read('server/routes/mobilePush.ts');
  assert.match(s, /serverVersion:\s*BRIDGE_VERSION/);
  assert.doesNotMatch(s, /serverVersion:\s*['\"]50\.0\.0/);
});

test('invite and 2FA setup return real QR image data rather than placeholder/text', () => {
  const invite = read('server/routes/servers/invites.ts');
  const twofa = read('server/routes/twoFactor.ts');
  assert.doesNotMatch(invite, /QR için:\s*npm i qrcode|npm i qrcode[^\n]*<\/text>/);
  assert.match(invite, /import\(['\"]qrcode['\"]\)/);
  assert.match(invite, /toString/);
  assert.doesNotMatch(twofa, /data:text\/plain/);
  assert.match(twofa, /toDataURL/);
});

test('server settings wire slug and discovery/privacy to real APIs', () => {
  const store = read('client/js/core/server-settings/stores/serverSettingsStore.ts');
  const tab = read('client/js/core/server-settings/tabs/GeneralTab.svelte');
  assert.match(store, /\/api\/servers\/\$\{serverId\}\/slug/);
  assert.match(store, /method:\s*'PUT'/);
  assert.match(store, /\/api\/discover\/settings/);
  assert.match(store, /method:\s*'PATCH'/);
  assert.doesNotMatch(store, /slug uç noktası HİÇ YOKTUR|loadSlug\(\)\s*\{\s*\/\*[^]*no-op/);
  assert.match(tab, /srv-discoverable-input/);
  assert.match(tab, /srv-category-input/);
});

test('CSP nonce detector contains a word-boundary regex, not a literal control byte', () => {
  const b = read('server/app/createApp.ts', null);
  assert.equal(Buffer.from(b).includes(Buffer.from([0x08])), false, 'literal backspace byte remains');
  const s = Buffer.from(b).toString('utf8');
  assert.match(s, /\\bnonce=/);
});

test('hidden presence fails closed and redacts both public profile and presence endpoint', () => {
  const s = read('server/routes/users.ts');
  assert.match(s, /normalizePresenceVisibility/);
  assert.ok((s.match(/normalizePresenceVisibility\(user\.presenceVisibility\)/g) || []).length >= 2);
  assert.ok((s.match(/status\s*[:=]\s*hidden\s*\?\s*['"]offline['"]/g) || []).length >= 2);
  assert.ok((s.match(/statusText\s*[:=]\s*hidden\s*\?\s*['"]['"]/g) || []).length >= 2);
  assert.ok((s.match(/statusEmoji\s*[:=]\s*hidden\s*\?\s*['"]['"]/g) || []).length >= 2);
});

test('server-id settings API does not disclose vanity capability to non-owners', () => {
  const s = read('server/routes/serverProfile.ts');
  const start = s.indexOf("router.get('/:sid/slug'");
  const end = s.indexOf("router.put('/:sid/slug'", start);
  const block = s.slice(start, end);
  assert.match(block, /server\.ownerId\s*!==\s*_u\.id/);
  assert.match(block, /status\(403\)/);
});

test('channel webhook secret URL is a one-time create surface, not a fake list field', () => {
  const ui = read('client/js/core/server-settings/tabs/WebhookTab.svelte');
  const api = read('server/routes/webhooks.ts');
  assert.doesNotMatch(ui, /copyUrl\(wh\.url/);
  assert.match(ui, /createdWebhookUrl/);
  assert.match(ui, /created\.token/);
  assert.match(api, /Cache-Control['"], ['"]no-store/);
  assert.match(api, /Referrer-Policy['"], ['"]no-referrer/);
});

test('Discover OpenAPI matches runtime category/settings shapes', () => {
  const spec = JSON.parse(read('server/generated/openapi.json'));
  const cats = spec.paths['/discover/categories'].get.responses['200'].content['application/json'].schema;
  assert.equal(cats.items.type, 'object');
  assert.deepEqual(cats.items.required, ['id', 'label']);
  const props = spec.paths['/discover/settings'].patch.requestBody.content['application/json'].schema.properties;
  assert.ok(props.discoverable);
  assert.equal(props.listed, undefined);
  assert.ok(props.category.enum.includes('education'));
  assert.ok(!props.category.enum.includes('edu'));
});

test('first-admin bootstrap uses a dedicated IP limiter and constant-time secret comparison', () => {
  const route = read('server/routes/admin/core.ts');
  const limiter = read('server/middleware/rateLimit.ts');
  assert.match(route, /make-first-admin['"],\s*limits\.adminSetup\(\)/);
  assert.match(route, /timingSafeEqual/);
  assert.match(limiter, /adminSetup:\s+_ip\('adminSetup'\)/);
});

test('esbuild metafile is denied before the static file server', () => {
  const s = read('server/app/createApp.ts');
  const deny = s.indexOf("'/dist/meta.json'");
  const staticUse = s.indexOf('express.static(staticRoot');
  assert.ok(deny >= 0 && staticUse >= 0 && deny < staticUse);
  assert.match(s.slice(deny, deny + 500), /status\(404\)/);
});
