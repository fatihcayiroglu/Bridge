// P7 C4: live two-INDEPENDENT-Bridge-installation TLS source review evidence.
// One signer belongs to A; B's trusted SPKI registry is operator-provisioned
// in the lab BEFORE A exports any payload. This is not TOFU / automatic trust.
// Only the read-only stage is measured: never imply approved apply/import.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { request, makeServer } from '../../multinode/lib/client.mjs';
import { getTls, postTls } from './apsign.mjs';

export function makePortableLabTrust(sourceOrigin, now = Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const from = new Date(now - 86400000).toISOString();
  const until = new Date(now + 86400000).toISOString();
  const registry = {
    format: 'bridge-portable-source-trust-registry', version: 1,
    keys: [{ sourceOrigin, publicKeyPem: publicPem, activeFrom: from, activeUntil: until, revoked: false }],
  };
  // Do not retain the private PEM in the exported trust fixture. The
  // destination env has only the public source registry.
  return {
    sourceEnv: {
      BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: 'true',
      BRIDGE_PORTABLE_SOURCE_ORIGIN: sourceOrigin,
      BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: Buffer.from(privatePem).toString('base64'),
    },
    destinationEnv: {
      BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED: 'true',
      BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: Buffer.from(JSON.stringify(registry)).toString('base64'),
    },
    fingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
  };
}

async function scopedGrant(base, person, scope) {
  // Exercise real password sign-in (not a synthetic grant or admin bypass).
  const result = await request(base, 'POST', '/api/login', {
    body: { username: person.username, password: person.password },
  });
  if (result.status !== 200 || typeof result.body?.stepUp?.grants?.[scope] !== 'string') {
    throw new Error('Could not obtain a fresh real ' + scope + ' proof; HTTP ' + result.status);
  }
  return result.body.stepUp.grants[scope];
}

async function tlsMutation(url, owner, grant, body, ca) {
  const base = new URL(url).origin;
  const csrf = await getTls(base + '/api/csrf-token', ca, {
    Authorization: 'Bearer ' + owner.token,
  });
  if (csrf.status !== 200 || typeof csrf.body?.token !== 'string') {
    throw new Error('TLS CSRF issuance unavailable (' + csrf.status + ')');
  }
  return postTls(url, {
    Host: new URL(url).host, Authorization: 'Bearer ' + owner.token,
    'X-CSRF-Token': csrf.body.token,
    'X-Bridge-Step-Up': grant,
    'Content-Type': 'application/json',
  }, JSON.stringify(body), ca);
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

  // Real HTTPS: DNS name in SNI, trust-anchored lab CA; independent A & B
  // processes/stores, not two tenants on one process or a mocked server.
  const sourceUrl = origins.a + '/api/servers/' + encodeURIComponent(source.serverId) +
    '/portable-export/attested-pair';
  const bundle = await getTls(sourceUrl, ca, {
    Authorization: 'Bearer ' + ownerA.token,
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

  const nonOwner = await tlsMutation(reviewUrl, otherB, importGrant, baseBody, ca);
  check('P7-TLS-06', 'a nonowner on B cannot review an independently signed source',
    nonOwner.status === 403, 'TLS POST ' + nonOwner.status);

  const after = lab.inst.b.psql('bridge',
    'SELECT COUNT(*) FROM portable_import_snapshot_consumptions');
  check('P7-TLS-07', 'read-only cross-instance review makes zero destination consumption writes',
    before === after && reviewed.body?.writesPerformed === false,
    'snapshot ledger count unchanged: ' + String(after === before));

  // Full owner mapping review, approval, write apply, parity, outages and
  // restarts still need separate accepted evidence; issue #205 stays OPEN.
}
