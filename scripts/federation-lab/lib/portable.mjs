// P7 C4: live two-INDEPENDENT-Bridge-installation TLS source review evidence.
// One signer belongs to A; B's trusted SPKI registry is operator-provisioned
// in the lab BEFORE A exports any payload. This is not TOFU / automatic trust.
// This file measures the read-only stage; portable-roundtrip.mjs the writes.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { request, makeServer, BROWSER } from '../../multinode/lib/client.mjs';
import { getTls, postTls } from './apsign.mjs';

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateB64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()).toString('base64'),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
  };
}

export function makePortableLabTrust(sourceOrigin, now = Date.now()) {
  const pinned = signer();
  // A second, NEVER pinned key for the same origin: what a stolen-host or
  // misprovisioned signer would produce. B must refuse it.
  const rogue = signer();
  const from = new Date(now - 86400000).toISOString();
  const until = new Date(now + 86400000).toISOString();
  const registry = (revoked) => Buffer.from(JSON.stringify({
    format: 'bridge-portable-source-trust-registry', version: 1,
    keys: [{ sourceOrigin, publicKeyPem: pinned.publicPem, activeFrom: from, activeUntil: until, revoked }],
  })).toString('base64');
  const sourceEnv = (key) => ({
    BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: 'true',
    BRIDGE_PORTABLE_SOURCE_ORIGIN: sourceOrigin,
    BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: key.privateB64,
  });
  // The destination env has only the public source registry. Owner approval
  // and mapped apply are separate operator opt-ins, both enabled for the lab.
  const destinationEnv = (revoked) => ({
    BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED: 'true',
    BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: registry(revoked),
    BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED: 'true',
    BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED: 'true',
  });
  return {
    sourceEnv: sourceEnv(pinned),
    rogueSourceEnv: sourceEnv(rogue),
    destinationEnv: destinationEnv(false),
    revokedDestinationEnv: destinationEnv(true),
    fingerprint: pinned.fingerprint,
  };
}

// Production rate limits stay ON in the lab. These scenarios pace
// themselves below them (login 10/min per IP, write 30/min per account)
// exactly as a well-behaved owner client would, instead of relaxing them.
const spent = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function pace(key, max, windowMs = 61_000) {
  for (;;) {
    const now = Date.now();
    const recent = (spent.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length < max) { recent.push(now); spent.set(key, recent); return; }
    await sleep(windowMs - (now - recent[0]) + 50);
  }
}

/** Bridge's `limits.write()` budget is per account, on each installation. */
export const paceWrite = (base, who) => pace('write:' + new URL(base).host + ':' + who.username, 24);

/** Every step-up scope from one real password sign-in (no synthetic grant). */
export async function freshGrants(base, person) {
  for (let attempt = 0; ; attempt++) {
    await pace('login:' + base, 8);
    const result = await request(base, 'POST', '/api/login', {
      body: { username: person.username, password: person.password },
    });
    // Another scenario may have used this IP's login budget moments ago:
    // wait out the limiter's own window rather than bypassing it.
    if (result.status === 429 && attempt < 2) {
      const wait = Number(result.headers.get('retry-after'));
      await sleep((Number.isFinite(wait) && wait > 0 ? wait : 61) * 1000);
      continue;
    }
    if (result.status !== 200 || !result.body?.stepUp?.grants) {
      throw new Error('Could not obtain fresh real step-up proofs; HTTP ' + result.status);
    }
    return result.body.stepUp.grants;
  }
}

async function scopedGrant(base, person, scope) {
  const grants = await freshGrants(base, person);
  if (typeof grants[scope] !== 'string') throw new Error('Could not obtain a fresh real ' + scope + ' proof');
  return grants[scope];
}

// One CSRF token per user and installation, reused like a real client:
// Bridge rate-limits CSRF issuance per account, and tokens are reusable
// until they expire (Redis-backed, so they survive an app restart).
const csrfCache = new Map();
const isCsrfRefusal = (r) => r.status === 403 && /CSRF/i.test(String(r.body?.error || ''));

export async function labCsrf(base, owner, ca, { fresh = false } = {}) {
  const key = base + '|' + owner.token;
  if (!fresh && csrfCache.has(key)) return csrfCache.get(key);
  const csrf = base.startsWith('https:')
    ? await getTls(base + '/api/csrf-token', ca, { ...BROWSER, Authorization: 'Bearer ' + owner.token })
    : await request(base, 'GET', '/api/csrf-token', { token: owner.token });
  if (csrf.status !== 200 || typeof csrf.body?.token !== 'string') {
    throw new Error('CSRF issuance unavailable (' + csrf.status + ')');
  }
  csrfCache.set(key, csrf.body.token);
  return csrf.body.token;
}

/** Plain-HTTP setup mutation on one installation with a cached CSRF token. */
export async function labMutate(base, method, urlPath, owner, body) {
  const send = async (fresh) => request(base, method, urlPath, {
    token: owner.token, body, csrf: await labCsrf(base, owner, null, { fresh }),
  });
  const first = await send(false);
  return isCsrfRefusal(first) ? send(true) : first;
}

export async function tlsMutation(url, owner, grant, body, ca) {
  const base = new URL(url).origin;
  const send = async (fresh) => paceWrite(base, owner).then(async () => postTls(url, {
    ...BROWSER, Host: new URL(url).host, Authorization: 'Bearer ' + owner.token,
    'X-CSRF-Token': await labCsrf(base, owner, ca, { fresh }),
    'X-Bridge-Step-Up': grant,
    'Content-Type': 'application/json',
  }, JSON.stringify(body), ca));
  const first = await send(false);
  return isCsrfRefusal(first) ? send(true) : first;
}

function mutateCharacter(value) {
  if (typeof value !== 'string' || value.length < 8) throw new Error('Signature missing');
  const last = value.length - 2;
  return value.slice(0, last) + (value[last] === 'A' ? 'B' : 'A') + value.slice(last + 1);
}

export async function runPortableTlsSourceReview({ lab, origins, check }) {
  const A = lab.inst.a.base, B = lab.inst.b.base, ca = lab.pki.ca;
  const ownerA = lab.users.alice, ownerB = lab.users.bob;
  const otherB = lab.users.adminb;
  const source = await makeServer(A, ownerA);
  const dest = await makeServer(B, ownerB);
  const exportGrant = await scopedGrant(A, ownerA, 'sensitive-export');
  const importGrant = await scopedGrant(B, ownerB, 'account-security');
  const nonOwnerGrant = await scopedGrant(B, otherB, 'account-security');

  // Real HTTPS: DNS name in SNI, trust-anchored lab CA; independent A & B
  // processes/stores, not two tenants on one process or a mocked server.
  const sourceUrl = origins.a + '/api/servers/' + encodeURIComponent(source.serverId) +
    '/portable-export/attested-pair';
  await paceWrite(origins.a, ownerA);
  const bundle = await getTls(sourceUrl, ca, {
    ...BROWSER, Authorization: 'Bearer ' + ownerA.token,
    'X-Bridge-Step-Up': exportGrant,
  });
  const shape = bundle.body?.structure && bundle.body?.permissions && bundle.body?.attestation;
  check('P7-TLS-01', 'source A exports a signed paired snapshot via real CA-verified HTTPS',
    bundle.status === 200 && !!shape &&
    bundle.body.writesPerformed === false && bundle.body.importSupported === false &&
    bundle.body.attestation.sourceOrigin === origins.a &&
    bundle.body.attestation.sourceServerId === source.serverId &&
    bundle.body.attestation.keyFingerprint === lab.portableTrust.fingerprint,
    'TLS GET ' + bundle.status);

  if (bundle.status !== 200 || !shape) return;
  const baseBody = {
    structure: bundle.body.structure,
    permissions: bundle.body.permissions,
    attestation: bundle.body.attestation,
    expectedSourceOrigin: origins.a,
    expectedSourceServerId: source.serverId,
  };
  const reviewUrl = origins.b + '/api/servers/' + encodeURIComponent(dest.serverId) +
    '/portable-import/source-attestation-review';
  const before = lab.inst.b.psql('bridge',
    'SELECT COUNT(*) FROM portable_import_snapshot_consumptions');
  const reviewed = await tlsMutation(reviewUrl, ownerB, importGrant, baseBody, ca);
  check('P7-TLS-02', 'independent B validates the source signature against out-of-band pinned key',
    reviewed.status === 200 && reviewed.body?.sourceSignatureValid === true &&
    reviewed.body?.trustPolicy === 'operator-pinned-revocable-v1' &&
    reviewed.body?.mode === 'read-only' && reviewed.body?.writesPerformed === false &&
    reviewed.body?.importSupported === false && reviewed.body?.mappingApproved === false,
    'TLS POST ' + reviewed.status);

  const forged = await tlsMutation(reviewUrl, ownerB, importGrant, {
    ...baseBody,
    attestation: { ...baseBody.attestation, signature: mutateCharacter(baseBody.attestation.signature) },
  }, ca);
  check('P7-TLS-03', 'B rejects tampered Ed25519 signature without importing anything',
    forged.status === 422 && forged.body?.code === 'PORTABLE_SOURCE_ATTESTATION_INVALID',
    'TLS POST ' + forged.status);

  const mismatched = await tlsMutation(reviewUrl, ownerB, importGrant, {
    ...baseBody, expectedSourceServerId: source.serverId + '-wrong',
  }, ca);
  check('P7-TLS-04', 'B refuses an artifact for the wrong explicit source community',
    mismatched.status === 422 && mismatched.body?.code === 'PORTABLE_SOURCE_ATTESTATION_INVALID',
    'TLS POST ' + mismatched.status);

  const wrongOrigin = await tlsMutation(reviewUrl, ownerB, importGrant, {
    ...baseBody, expectedSourceOrigin: origins.b,
  }, ca);
  check('P7-TLS-05', 'B refuses a signed artifact bound to the wrong source HTTPS origin',
    wrongOrigin.status === 422 && wrongOrigin.body?.code === 'PORTABLE_SOURCE_ATTESTATION_INVALID',
    'TLS POST ' + wrongOrigin.status);

  const nonOwner = await tlsMutation(reviewUrl, otherB, nonOwnerGrant, baseBody, ca);
  check('P7-TLS-06', 'a nonowner on B cannot review an independently signed source',
    nonOwner.status === 403, 'TLS POST ' + nonOwner.status);

  const after = lab.inst.b.psql('bridge',
    'SELECT COUNT(*) FROM portable_import_snapshot_consumptions');
  check('P7-TLS-07', 'read-only cross-instance review makes zero destination consumption writes',
    before === after && reviewed.body?.writesPerformed === false,
    'snapshot ledger count unchanged: ' + String(after === before));

  // The approval/apply/parity round trip is runPortableTlsRoundTrip
  // (portable-roundtrip.mjs), run right after this read-only stage.
}
