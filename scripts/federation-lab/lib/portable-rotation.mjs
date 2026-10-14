// P7 C4: live source-key lifecycle between two independent installations.
// B's operator builds and changes its pinned registry ONLY through the real
// operator tool (scripts/portable-trust-registry.mjs: add -> rotate ->
// revoke), redeploying B each time; A switches its signer like a real source
// operator. Every trust decision is observed on B's real HTTPS review route.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getTls } from './apsign.mjs';
import { freshGrants, labMutate, paceWrite, tlsMutation } from './portable.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../portable-trust-registry.mjs');
const iso = (ms) => new Date(ms).toISOString();

function operator(...args) {
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15_000 });
  if (out.status !== 0) throw new Error('operator tool refused: ' + out.stderr.trim());
  return out.stdout;
}
function envValue(registry) {
  const line = operator('env', '--registry', registry).trim();
  return line.slice(line.indexOf('=') + 1);
}
function bootTrust(inst, tag) {
  const file = inst.logPath(tag);
  const line = fs.readFileSync(file, 'utf8').split('\n').reverse().find((l) => l.includes('"portable.trust.effective"'));
  return line ? JSON.parse(line) : null;
}

export async function runPortableKeyRotation({ lab, origins, check, workDir }) {
  const A = lab.inst.a.base, B = lab.inst.b.base, ca = lab.pki.ca;
  const ownerA = lab.users.alice, ownerB = lab.users.bob;
  const trust = lab.portableTrust;

  // The destination operator's own protected registry directory.
  const dir = path.join(workDir, 'portable-operator');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const registry = path.join(dir, 'registry.json');
  const oldPub = path.join(dir, 'source-current.pub.pem');
  const newPub = path.join(dir, 'source-next.pub.pem');
  fs.writeFileSync(oldPub, trust.pinnedPublicPem);
  fs.writeFileSync(newPub, trust.next.publicPem);

  const src = await labMutate(A, 'POST', '/api/servers', ownerA, { name: 'P7 rotation source' });
  const srcId = src.body?._id || src.body?.id;
  const dst = await labMutate(B, 'POST', '/api/servers', ownerB, { name: 'P7 rotation destination' });
  const dstId = dst.body?._id || dst.body?.id;
  if (!srcId || !dstId) throw new Error('rotation lab setup failed');

  async function exportA() {
    const g = await freshGrants(A, ownerA);
    await paceWrite(origins.a, ownerA);
    const r = await getTls(`${origins.a}/api/servers/${encodeURIComponent(srcId)}/portable-export/attested-pair`, ca, {
      Authorization: 'Bearer ' + ownerA.token, 'X-Bridge-Step-Up': g['sensitive-export'],
    });
    if (r.status !== 200) throw new Error('A export HTTP ' + r.status);
    return r.body;
  }
  async function reviewOnB(bundle) {
    const g = await freshGrants(B, ownerB);
    const r = await tlsMutation(`${origins.b}/api/servers/${encodeURIComponent(dstId)}/portable-import/source-attestation-review`,
      ownerB, g['account-security'], {
        structure: bundle.structure, permissions: bundle.permissions, attestation: bundle.attestation,
        expectedSourceOrigin: origins.a, expectedSourceServerId: srcId,
      }, ca);
    return r.status;
  }
  async function redeployB(tag) {
    await lab.inst.b.stop();
    await lab.inst.b.start({ tag, env: { BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: envValue(registry) } });
    return bootTrust(lab.inst.b, tag);
  }

  try {
    // ── ROT-01: first pin through the operator tool ─────────────────────────
    const wrong = spawnSync(process.execPath, [CLI, 'add', '--registry', registry, '--origin', origins.a,
      '--public-key', oldPub, '--expect-fingerprint', trust.next.fingerprint,
      '--active-from', iso(Date.now() - 3600_000), '--active-until', iso(Date.now() + 30 * 86400_000),
      '--operator', 'lab-dest-operator', '--reason', 'deliberately wrong fingerprint'], { encoding: 'utf8' });
    operator('add', '--registry', registry, '--origin', origins.a, '--public-key', oldPub,
      '--expect-fingerprint', trust.fingerprint,
      '--active-from', iso(Date.now() - 3600_000), '--active-until', iso(Date.now() + 30 * 86400_000),
      '--operator', 'lab-dest-operator', '--reason', 'initial pin, fingerprint confirmed out of band');
    const boot1 = await redeployB('portable-rot-pinned');
    const oldBundle = await exportA();
    const r1 = await reviewOnB(oldBundle);
    check('P7-ROT-01', 'B trusts A only after the operator tool pinned the independently confirmed key',
      wrong.status === 1 && /Fingerprint mismatch/.test(wrong.stderr) && r1 === 200 &&
      boot1?.destination?.keys?.length === 1 && boot1.destination.keys[0].fingerprint === trust.fingerprint &&
      boot1.destination.keys[0].state === 'active',
      `wrong-fingerprint add exit ${wrong.status}; review ${r1}; B boot pins ${boot1?.destination?.activeKeys ?? '?'} active key(s)`);

    // ── ROT-02/03: rotation with an overlap window ──────────────────────────
    operator('rotate', '--registry', registry, '--origin', origins.a, '--retire-fingerprint', trust.fingerprint,
      '--public-key', newPub, '--expect-fingerprint', trust.next.fingerprint,
      '--overlap-until', iso(Date.now() + 2 * 3600_000), '--active-until', iso(Date.now() + 60 * 86400_000),
      '--operator', 'lab-dest-operator', '--reason', 'scheduled rotation');
    const boot2 = await redeployB('portable-rot-overlap');
    // Only after B deployed the rotation does the source switch its signer.
    await lab.inst.a.stop();
    await lab.inst.a.start({ tag: 'portable-rot-next-signer', env: trust.next.sourceEnv });
    const aBoot = bootTrust(lab.inst.a, 'portable-rot-next-signer');
    const newBundle = await exportA();
    const r2old = await reviewOnB(oldBundle);
    const r2new = await reviewOnB(newBundle);
    check('P7-ROT-02', 'during the overlap B accepts both the old-key and the new-key snapshot',
      r2old === 200 && r2new === 200 && newBundle.attestation.keyFingerprint === trust.next.fingerprint &&
      boot2?.destination?.activeKeys === 2,
      `old ${r2old}, new ${r2new}; B active keys ${boot2?.destination?.activeKeys}`);
    check('P7-ROT-03', 'A logs its new signer fingerprint and it equals the key B pinned (public data only)',
      aBoot?.source?.keyFingerprint === trust.next.fingerprint &&
      boot2?.destination?.keys?.some((k) => k.fingerprint === trust.next.fingerprint && k.state === 'active'),
      `A signer ${String(aBoot?.source?.keyFingerprint).slice(0, 12)}…`);

    // ── ROT-04: emergency revocation of the old key ─────────────────────────
    operator('revoke', '--registry', registry, '--fingerprint', trust.fingerprint,
      '--operator', 'lab-dest-operator', '--reason', 'lab compromise drill');
    const boot3 = await redeployB('portable-rot-revoked');
    const r4old = await reviewOnB(oldBundle);
    const r4new = await reviewOnB(newBundle);
    check('P7-ROT-04', 'after revocation the old-key snapshot is refused and the new key still works',
      r4old === 422 && r4new === 200 &&
      boot3?.destination?.keys?.find((k) => k.fingerprint === trust.fingerprint)?.state === 'revoked',
      `old ${r4old}, new ${r4new}`);

    // ── ROT-05: the operator audit trail ────────────────────────────────────
    const audit = fs.readFileSync(registry + '.audit.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const finalSha = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(registry)).digest('hex');
    const auditText = fs.readFileSync(registry + '.audit.jsonl', 'utf8');
    check('P7-ROT-05', 'the operator audit trail records add, rotate and revoke, bound to the deployed registry, with no key material',
      audit.map((r) => r.action).join(',') === 'add,rotate,revoke' &&
      audit[2].registrySha256 === finalSha && !/BEGIN|PRIVATE/.test(auditText) &&
      audit.every((r) => r.operator === 'lab-dest-operator' && typeof r.reason === 'string'),
      audit.map((r) => r.action).join(' → '));
  } finally {
    // Restore both installations to their original configuration.
    await lab.inst.a.stop();
    await lab.inst.a.start({ tag: 'portable-rot-restored' });
    await lab.inst.b.stop();
    await lab.inst.b.start({ tag: 'portable-rot-restored' });
  }
}
