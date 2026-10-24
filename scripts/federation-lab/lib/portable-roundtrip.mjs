// P7 C4: FULL round trip between two INDEPENDENT Bridge installations over
// CA-verified HTTPS: A signed snapshot -> B pinned-key verification -> owner
// mapping review -> one-use owner approval -> atomic mapped apply -> re-export
// parity. Every outcome is read back from B's OWN PostgreSQL, never inferred
// from an HTTP status. Supported scope is existing-row metadata only (see
// docs/P7_PORTABLE_IMPORT_SCOPE.md): no row creation, members, identities,
// messages, files or permission grants ever cross the boundary.
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { REPO } from '../../selfhost/lib/instance.mjs';
import { BROWSER } from '../../multinode/lib/client.mjs';
import { getTls, postTls } from './apsign.mjs';
import { freshGrants, labCsrf, labMutate, paceWrite, tlsMutation } from './portable.mjs';

const SEND = 1 << 8;
const APPROVE = 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES';
const APPLY = 'APPLY_MAPPED_PORTABLE_METADATA_ONLY';
const AUDIT_ACTION = 'portable.mapped_metadata.apply';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const { Pool } = createRequire(import.meta.url)(path.join(REPO, 'server/node_modules/pg'));

/** SQL literal for a server-generated ID; anything else is a lab bug. */
function lit(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error('unexpected identifier shape');
  }
  return `'${id}'`;
}

function idOf(body) {
  const id = body?._id ?? body?.id ?? body?.role?._id ?? body?.category?._id;
  if (typeof id !== 'string') throw new Error('created row has no id');
  return id;
}

async function must(promise, what) {
  const r = await promise;
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  return r.body;
}

/** The destination's real persisted rows for one community. */
function dbState(inst, sid) {
  const s = lit(sid);
  const json = inst.psql('bridge', `SELECT json_build_object(
    'categories', COALESCE((SELECT json_agg(json_build_object('id',_id,'name',name,'position',position,'collapsed',collapsed) ORDER BY _id) FROM channel_categories WHERE "serverId"=${s}), '[]'::json),
    'roles', COALESCE((SELECT json_agg(json_build_object('id',_id,'name',name,'color',color,'permissions',permissions,'position',position) ORDER BY _id) FROM roles WHERE "serverId"=${s}), '[]'::json),
    'channels', COALESCE((SELECT json_agg(json_build_object('id',_id,'name',name,'type',type,'topic',topic,'categoryId',"categoryId",'category',category,'order',"order",'nsfw',nsfw,'slowmode',slowmode) ORDER BY _id) FROM channels WHERE "serverId"=${s}), '[]'::json),
    'grants', COALESCE((SELECT json_agg(json_build_object('channelId',"channelId",'roleId',"roleId",'allow',allow,'deny',deny) ORDER BY "channelId","roleId") FROM channel_permissions WHERE "serverId"=${s}), '[]'::json),
    'legacyOverrides', (SELECT COUNT(*) FROM channel_overrides o JOIN channels c ON c._id=o."channelId" WHERE c."serverId"=${s}),
    'members', (SELECT COUNT(*) FROM members WHERE "serverId"=${s}),
    'approvals', (SELECT COUNT(*) FROM portable_import_approvals WHERE target_server_id=${s}),
    'consumed', (SELECT COUNT(*) FROM portable_import_approvals WHERE target_server_id=${s} AND consumed_at IS NOT NULL),
    'snapshots', (SELECT COUNT(*) FROM portable_import_snapshot_consumptions WHERE target_server_id=${s}),
    'audits', (SELECT COUNT(*) FROM audit_logs WHERE "serverId"=${s} AND action='${AUDIT_ACTION}')
  )::text`);
  return JSON.parse(json);
}

/** Everything a write could touch, as one comparable string. */
function rowsKey(state) {
  const { categories, roles, channels, grants, legacyOverrides, members } = state;
  return JSON.stringify({ categories, roles, channels, grants, legacyOverrides, members });
}

const byPosition = (a, b) => a.position - b.position || a.sourceId.localeCompare(b.sourceId);
const byOrder = (a, b) => a.order - b.order || a.sourceId.localeCompare(b.sourceId);

/**
 * The owner's explicit choice in this lab: pair rows of the same kind by
 * their displayed order. Unequal shapes are a setup error, never guessed.
 */
function pairRows(source, target) {
  const pair = (from, to, sort, label) => {
    const a = [...from].sort(sort), b = [...to].sort(sort);
    if (a.length !== b.length) throw new Error(`${label}: source ${a.length} vs target ${b.length}`);
    return a.map((row, i) => ({ sourceId: row.sourceId, targetId: b[i].sourceId }));
  };
  const channels = [];
  for (const type of new Set(source.channels.map((c) => c.type))) {
    channels.push(...pair(source.channels.filter((c) => c.type === type),
      target.channels.filter((c) => c.type === type), byOrder, `channels(${type})`));
  }
  if (channels.length !== target.channels.length) throw new Error('target has unmatched channel types');
  return {
    categories: pair(source.categories, target.categories, byPosition, 'categories'),
    roles: pair(source.roles, target.roles, byPosition, 'roles'),
    channels,
  };
}

/** Sends the full request, then cuts the TCP/TLS connection before any reply. */
function sendThenCut(url, headers, body, ca) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = Buffer.from(body);
    const head = [`POST ${u.pathname} HTTP/1.1`, `Host: ${u.host}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${payload.length}`, '', ''].join('\r\n');
    let replyBytes = 0;
    const sock = tls.connect({ host: '127.0.0.1', port: Number(u.port), servername: u.hostname, ca }, () => {
      sock.on('data', (d) => { replyBytes += d.length; });
      sock.write(Buffer.concat([Buffer.from(head), payload]), () => {
        setTimeout(() => { sock.destroy(); resolve({ written: true, replyBytes }); }, 5);
      });
    });
    sock.on('error', () => resolve({ written: false, replyBytes }));
  });
}

export async function runPortableTlsRoundTrip({ lab, origins, check }) {
  const A = lab.inst.a.base, B = lab.inst.b.base, ca = lab.pki.ca;
  const ownerA = lab.users.alice, ownerB = lab.users.bob, otherB = lab.users.adminb;
  const trust = lab.portableTrust;
  const secrets = [];

  // ── independent topologies (setup over each installation's own API) ──────
  const srcId = idOf(await must(labMutate(A, 'POST', '/api/servers', ownerA, { name: 'P7 source community' }), 'A server'));
  const srcCat = idOf(await must(labMutate(A, 'POST', `/api/servers/${srcId}/categories`, ownerA, { name: 'Signal Ops' }), 'A category'));
  await must(labMutate(A, 'PATCH', `/api/servers/${srcId}/categories/${srcCat}`, ownerA, { collapsed: true }), 'A category collapse');
  const srcRole = idOf(await must(labMutate(A, 'POST', `/api/servers/${srcId}/roles`, ownerA, { name: 'Relay Crew', color: '#3366ff', permissions: SEND }), 'A role'));
  const srcText = idOf(await must(labMutate(A, 'POST', `/api/servers/${srcId}/channels`, ownerA, {
    name: 'signed-ops', type: 'text', topic: 'Signed topic from A', category: 'Signal Ops', slowmode: 30, nsfw: true,
  }), 'A text channel'));
  await must(labMutate(A, 'POST', `/api/servers/${srcId}/channels`, ownerA, { name: 'signed-voice', type: 'voice' }), 'A voice channel');
  await must(labMutate(A, 'PUT', `/api/servers/${srcId}/channels/${srcText}/permissions/${srcRole}`, ownerA, { allow: 0, deny: SEND }), 'A role grant');
  // No public API assigns a channel to a category BY ID (only the legacy
  // name string). Seed that link in A's OWN database so the mapped
  // categoryId translation is exercised; B is never touched this way.
  lab.inst.a.psql('bridge', `UPDATE channels SET "categoryId"=${lit(srcCat)} WHERE _id=${lit(srcText)} AND "serverId"=${lit(srcId)}`);

  const dstId = idOf(await must(labMutate(B, 'POST', '/api/servers', ownerB, { name: 'P7 destination community' }), 'B server'));
  await must(labMutate(B, 'POST', `/api/servers/${dstId}/categories`, ownerB, { name: 'Old Lobby' }), 'B category');
  const dstRole = idOf(await must(labMutate(B, 'POST', `/api/servers/${dstId}/roles`, ownerB, { name: 'Old Crew', color: '#999999', permissions: SEND }), 'B role'));
  const dstText = idOf(await must(labMutate(B, 'POST', `/api/servers/${dstId}/channels`, ownerB, { name: 'old-text', type: 'text', topic: 'B topic' }), 'B text channel'));
  const dstVoice = idOf(await must(labMutate(B, 'POST', `/api/servers/${dstId}/channels`, ownerB, { name: 'old-voice', type: 'voice' }), 'B voice channel'));

  // A real owner signs in once and reuses the step-up proof while it is
  // fresh. Server-side, approval/apply demand a proof <= 120 s old; reuse
  // stops at 90 s so every protected call is made well inside that bound.
  const grantCache = new Map();
  async function grantsOf(base, who, { fresh = false } = {}) {
    const key = base + '|' + who.username;
    const hit = grantCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < 90_000) return hit.grants;
    const at = Date.now();
    const grants = await freshGrants(base, who);
    secrets.push(...Object.values(grants));
    grantCache.set(key, { at, grants });
    return grants;
  }

  // ── signed source snapshot over HTTPS ────────────────────────────────────
  async function exportA() {
    const g = await grantsOf(A, ownerA);
    await paceWrite(origins.a, ownerA);
    const r = await getTls(`${origins.a}/api/servers/${encodeURIComponent(srcId)}/portable-export/attested-pair`, ca, {
      Authorization: 'Bearer ' + ownerA.token, 'X-Bridge-Step-Up': g['sensitive-export'],
    });
    if (r.status !== 200 || !r.body?.attestation) throw new Error(`A attested export HTTP ${r.status}`);
    return r.body;
  }
  const exp1 = await exportA();
  const aAtExport = dbState(lab.inst.a, srcId);
  // A concurrent SOURCE edit after the snapshot: B must receive the signed
  // snapshot, never this later value.
  await must(labMutate(A, 'PATCH', `/api/servers/${srcId}/channels/${srcText}`, ownerA, { name: 'edited-after-export' }), 'A post-export edit');

  // ── destination owner flow helpers (all over HTTPS to B) ─────────────────
  let g = null;
  async function grantsB(opts) { g = await grantsOf(B, ownerB, opts); return g; }
  const sidPath = `/api/servers/${encodeURIComponent(dstId)}`;
  async function ownExport(kind) {
    await paceWrite(origins.b, ownerB);
    const r = await getTls(`${origins.b}${sidPath}/${kind}`, ca, {
      Authorization: 'Bearer ' + ownerB.token, 'X-Bridge-Step-Up': g['sensitive-export'],
    });
    if (r.status !== 200) throw new Error(`B ${kind} HTTP ${r.status}`);
    return r.body;
  }
  /** The owner's review: live fingerprint + explicit mapping + signed check. */
  // The owner's mapping decision is made once, from B's own export, and then
  // reused: later reviews must not silently re-pair rows.
  let links = null;
  async function review(exp) {
    await paceWrite(origins.b, ownerB);
    const fp = await getTls(`${origins.b}${sidPath}/portable-import/target-fingerprint`, ca, {
      Authorization: 'Bearer ' + ownerB.token, 'X-Bridge-Step-Up': g['account-security'],
    });
    if (fp.status !== 200) throw new Error(`B target-fingerprint HTTP ${fp.status}`);
    if (!links) links = pairRows(exp.structure, await ownExport('portable-export'));
    const mapping = {
      targetServerId: dstId,
      structureDigest: exp.structure.integrity.digest,
      permissionsDigest: exp.permissions.integrity.digest,
      expectedTargetDigest: fp.body.targetTopologyDigest,
      ...links,
    };
    const signed = {
      structure: exp.structure, permissions: exp.permissions, attestation: exp.attestation,
      expectedSourceOrigin: origins.a, expectedSourceServerId: srcId, targetServerId: dstId, mapping,
    };
    const r = await tlsMutation(`${origins.b}${sidPath}/portable-import/signed-mapping-review`,
      ownerB, g['account-security'], signed, ca);
    return { signed, links, fingerprint: fp.body, result: r };
  }
  const approve = (rev, who = ownerB, grant = g['account-security']) =>
    tlsMutation(`${origins.b}${sidPath}/portable-import/owner-approval`, who, grant, {
      ...rev.signed, confirmedReviewFingerprint: rev.result.body?.reviewFingerprint, confirmation: APPROVE,
    }, ca);
  const applyBody = (rev, token) => ({
    ...rev.signed, confirmedReviewFingerprint: rev.result.body?.reviewFingerprint,
    confirmation: APPLY, approvalToken: token,
  });
  const apply = (rev, token) => tlsMutation(`${origins.b}${sidPath}/portable-import/mapped-apply`,
    ownerB, g['account-security'], applyBody(rev, token), ca);

  /** B rows equal the signed snapshot values for every mapped item. */
  function matchesSnapshot(state, exp, links, rolePermsBefore) {
    const cat = new Map(links.categories.map((l) => [l.sourceId, l.targetId]));
    const role = new Map(links.roles.map((l) => [l.sourceId, l.targetId]));
    const chan = new Map(links.channels.map((l) => [l.sourceId, l.targetId]));
    const rows = (k) => new Map(state[k].map((r) => [r.id, r]));
    const C = rows('categories'), R = rows('roles'), H = rows('channels');
    const bad = [];
    for (const s of exp.structure.categories) {
      const t = C.get(cat.get(s.sourceId));
      if (!t || t.name !== s.name || t.position !== s.position || t.collapsed !== s.collapsed) bad.push('category ' + s.name);
    }
    for (const s of exp.structure.roles) {
      const t = R.get(role.get(s.sourceId));
      if (!t || t.name !== s.name || t.color !== s.color) bad.push('role ' + s.name);
      else if (t.permissions !== rolePermsBefore.get(t.id)) bad.push('role mask changed ' + t.name);
    }
    for (const s of exp.structure.channels) {
      const t = H.get(chan.get(s.sourceId));
      const wantCat = s.categorySourceId === null ? null : cat.get(s.categorySourceId);
      if (!t) { bad.push('channel ' + s.name + ' missing'); continue; }
      const fields = { name: [t.name, s.name], topic: [t.topic, s.topic], categoryId: [t.categoryId, wantCat],
        category: [t.category, s.legacyCategoryName], order: [Number(t.order), s.order],
        nsfw: [t.nsfw, s.nsfw ? 1 : 0], slowmode: [t.slowmode, s.slowmode], type: [t.type, s.type] };
      for (const [f, [got, want]] of Object.entries(fields)) {
        if (got !== want) bad.push(`channel ${s.name}.${f}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
      }
    }
    return bad;
  }

  await grantsB();
  // ── P7-RT-01: owner review over TLS ──────────────────────────────────────
  let rev = await review(exp1);
  check('P7-RT-01', 'B owner reviews A\'s signed snapshot with an explicit live-topology mapping over HTTPS',
    rev.result.status === 200 && /^[0-9a-f]{64}$/.test(rev.result.body?.reviewFingerprint || '') &&
    rev.result.body?.writesPerformed === false && rev.result.body?.counts?.unsafeRoleMappings === 0 &&
    rev.result.body?.counts?.unsupportedPermissionRows === 0,
    `review ${rev.result.status}, mapped ${rev.links.categories.length}/${rev.links.roles.length}/${rev.links.channels.length}`);

  // ── P7-RT-02: grant parity refusal (B lacks the signed override) ─────────
  let before = dbState(lab.inst.b, dstId);
  const noParity = await approve(rev);
  let after = dbState(lab.inst.b, dstId);
  check('P7-RT-02', 'approval is refused while B\'s channel grants differ from the signed mapped grants',
    noParity.status === 422 && after.approvals === before.approvals && rowsKey(after) === rowsKey(before),
    `approval ${noParity.status}, approval rows ${before.approvals}->${after.approvals}`);

  // The owner reproduces the source grant on B's own mapped channel/role.
  const mappedRole = rev.links.roles.find((l) => l.sourceId === srcRole)?.targetId;
  const mappedText = rev.links.channels.find((l) => l.sourceId === srcText)?.targetId;
  if (mappedRole !== dstRole || mappedText !== dstText) throw new Error('lab mapping did not pair the intended rows');
  await must(labMutate(B, 'PUT', `/api/servers/${dstId}/channels/${dstText}/permissions/${dstRole}`, ownerB, { allow: 0, deny: SEND }), 'B grant');

  // ── P7-RT-03: concurrent destination edit invalidates the review ─────────
  rev = await review(exp1);
  await must(labMutate(B, 'PATCH', `/api/servers/${dstId}/channels/${dstVoice}`, ownerB, { name: 'renamed-during-review' }), 'B concurrent edit');
  before = dbState(lab.inst.b, dstId);
  const stale = await approve(rev);
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-03', 'a destination edit after review makes the stale approval fail closed',
    stale.status === 422 && after.approvals === before.approvals && rowsKey(after) === rowsKey(before),
    `approval ${stale.status}`);

  // ── P7-RT-04: nonowner on B ──────────────────────────────────────────────
  rev = await review(exp1);
  const other = await grantsOf(B, otherB);
  before = dbState(lab.inst.b, dstId);
  const nonOwner = await approve(rev, otherB, other['account-security']);
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-04', 'a nonowner on B cannot approve the signed mapping',
    nonOwner.status === 403 && after.approvals === before.approvals, `approval ${nonOwner.status}`);

  // ── P7-RT-05: owner approval writes ONE hashed, short-lived ledger row ───
  before = dbState(lab.inst.b, dstId);
  const ok = await approve(rev);
  after = dbState(lab.inst.b, dstId);
  const token = ok.body?.approvalToken;
  if (typeof token === 'string') secrets.push(token);
  const tokenRows = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    ? Number(lab.inst.b.psql('bridge', `SELECT COUNT(*) FROM portable_import_approvals a WHERE strpos(row_to_json(a)::text, '${token}') > 0`))
    : -1;
  const ttl = Number(lab.inst.b.psql('bridge',
    `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM expires_at - created_at)), -1) FROM portable_import_approvals WHERE target_server_id=${lit(dstId)} AND consumed_at IS NULL`));
  check('P7-RT-05', 'owner approval stores one unconsumed hashed record (<=120 s) and writes no topology',
    ok.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(token || '') && ok.body?.approvalRecordWritten === true &&
    ok.body?.destinationDataWritesPerformed === false &&
    ok.body?.targetReviewFingerprint === rev.result.body.reviewFingerprint &&
    after.approvals === before.approvals + 1 && after.consumed === before.consumed &&
    tokenRows === 0 && ttl > 0 && ttl <= 120 && rowsKey(after) === rowsKey(before),
    `approval ${ok.status}, ttl ${ttl}s, plaintext token rows ${tokenRows}`);
  if (ok.status !== 201) return;
  const rolePermsBefore = new Map(after.roles.map((r) => [r.id, r.permissions]));
  const preApply = after;

  // ── P7-RT-06: forged bearer token ────────────────────────────────────────
  const forged = await apply(rev, randomBytes(32).toString('base64url'));
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-06', 'a forged approval token changes nothing and does not consume the real approval',
    forged.status === 422 && rowsKey(after) === rowsKey(preApply) && after.consumed === preApply.consumed &&
    after.snapshots === preApply.snapshots, `apply ${forged.status}`);

  // ── P7-RT-07: network outage in front of B ───────────────────────────────
  // CSRF is fetched while the network is up; only the apply hits the outage.
  const csrfUp = await labCsrf(origins.b, ownerB, ca);
  await paceWrite(origins.b, ownerB);
  lab.front.b.setMode('refuse');
  let down;
  try {
    down = await postTls(`${origins.b}${sidPath}/portable-import/mapped-apply`, {
      ...BROWSER, Host: new URL(origins.b).host, Authorization: 'Bearer ' + ownerB.token,
      'X-CSRF-Token': csrfUp, 'X-Bridge-Step-Up': g['account-security'],
      'Content-Type': 'application/json',
    }, JSON.stringify(applyBody(rev, token)), ca);
  } finally {
    lab.front.b.setMode('open');
  }
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-07', 'an apply attempt during a network outage leaves B untouched and the approval unused',
    down.status === 0 && rowsKey(after) === rowsKey(preApply) && after.consumed === preApply.consumed,
    `apply transport status ${down.status}`);

  // ── P7-RT-08: B process crash between approval and apply ────────────────
  const killed = await lab.inst.b.stop({ signal: 'SIGKILL' });
  await lab.inst.b.start({ tag: 'portable-crash' });
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-08', 'a SIGKILL of B keeps exactly the committed unconsumed approval and unchanged rows',
    killed?.signal === 'SIGKILL' && rowsKey(after) === rowsKey(preApply) &&
    after.approvals === preApply.approvals && after.consumed === preApply.consumed,
    `exit ${JSON.stringify(killed)}`);

  // ── P7-RT-09: approved atomic apply after restart ───────────────────────
  await grantsB();
  const applied = await apply(rev, token);
  const done = dbState(lab.inst.b, dstId);
  const diff = matchesSnapshot(done, exp1, rev.links, rolePermsBefore);
  check('P7-RT-09', 'the approved apply commits once on restarted B with grants and identities preserved',
    applied.status === 200 && applied.body?.applied === true && applied.body?.transactionCommitted === true &&
    applied.body?.grantsPreserved === true && applied.body?.membershipImported === false &&
    applied.body?.permissionGrantsImported === false &&
    done.consumed === preApply.consumed + 1 && done.snapshots === preApply.snapshots + 1 &&
    done.audits === preApply.audits + 1, `apply ${applied.status}, audits ${preApply.audits}->${done.audits}`);

  // ── P7-RT-10: B's PostgreSQL rows equal the signed source rows ───────────
  const aText = aAtExport.channels.find((c) => c.id === srcText);
  const bText = done.channels.find((c) => c.id === dstText);
  const sameShape = done.categories.length === preApply.categories.length &&
    done.roles.length === preApply.roles.length && done.channels.length === preApply.channels.length;
  check('P7-RT-10', 'B database rows match A\'s snapshot rows field by field; masks, grants, members and row counts unchanged',
    diff.length === 0 && sameShape && JSON.stringify(done.grants) === JSON.stringify(preApply.grants) &&
    done.members === preApply.members && done.legacyOverrides === 0 &&
    !!aText && !!bText && aText.name === bText.name && aText.topic === bText.topic &&
    aText.nsfw === bText.nsfw && aText.slowmode === bText.slowmode && Number(aText.order) === Number(bText.order),
    diff.length ? 'mismatch: ' + diff.join(', ') : `A nsfw ${aText?.nsfw} -> B nsfw ${bText?.nsfw}`);

  // ── P7-RT-11: source edits after the snapshot are NOT transported ───────
  const aNow = dbState(lab.inst.a, srcId).channels.find((c) => c.id === srcText);
  check('P7-RT-11', 'B holds the signed snapshot value, not A\'s later concurrent edit',
    bText?.name === 'signed-ops' && aNow?.name === 'edited-after-export', `B ${bText?.name} / A ${aNow?.name}`);

  // ── P7-RT-12: audit row is bounded and secret-free ──────────────────────
  const auditDetail = lab.inst.b.psql('bridge',
    `SELECT detail FROM audit_logs WHERE "serverId"=${lit(dstId)} AND action='${AUDIT_ACTION}' ORDER BY "createdAt" DESC LIMIT 1`);
  const leaks = [token, ownerB.id, srcId, srcRole, srcText, exp1.attestation.signature]
    .filter((s) => typeof s === 'string' && s && auditDetail.includes(s));
  check('P7-RT-12', 'the committed audit record carries counts only (no token, owner, source IDs or signature)',
    auditDetail.includes('existing-mapped-metadata-only') && leaks.length === 0, `leaks ${leaks.length}`);

  // ── P7-RT-13: replay of the consumed token ──────────────────────────────
  const replay = await apply(rev, token);
  after = dbState(lab.inst.b, dstId);
  check('P7-RT-13', 'replaying the consumed approval token is refused and changes nothing',
    replay.status === 422 && rowsKey(after) === rowsKey(done) && after.audits === done.audits,
    `replay ${replay.status}`);

  // ── P7-RT-14: a FRESH approval cannot re-apply the same signed snapshot ──
  const again = await review(exp1);
  const reApproval = again.result.status === 200 ? await approve(again) : { status: again.result.status };
  const reApply = reApproval.status === 201 ? await apply(again, reApproval.body.approvalToken) : null;
  if (reApproval.body?.approvalToken) secrets.push(reApproval.body.approvalToken);
  after = dbState(lab.inst.b, dstId);
  // Approval staging does not consult the barrier, so this reaches the
  // apply transaction: the refusal below is the barrier itself.
  check('P7-RT-14', 'the durable snapshot barrier refuses a second apply of the same signed snapshot',
    again.result.status === 200 && reApproval.status === 201 && reApply?.status === 422 &&
    rowsKey(after) === rowsKey(done) && after.snapshots === done.snapshots && after.audits === done.audits,
    `review ${again.result.status}, approval ${reApproval.status}, apply ${reApply?.status ?? '-'}`);

  // ── P7-RT-15: re-export parity over TLS ─────────────────────────────────
  const reStructure = await ownExport('portable-export');
  const rePerms = await ownExport('portable-permissions-export');
  const structureByTarget = (kind) => new Map(reStructure[kind].map((r) => [r.sourceId, r]));
  const cats = structureByTarget('categories'), roles = structureByTarget('roles'), chans = structureByTarget('channels');
  const link = (kind) => new Map(rev.links[kind].map((l) => [l.sourceId, l.targetId]));
  const lc = link('categories'), lr = link('roles'), lh = link('channels');
  const reBad = [];
  for (const s of exp1.structure.categories) {
    const t = cats.get(lc.get(s.sourceId));
    if (!t || t.name !== s.name || t.position !== s.position || t.collapsed !== s.collapsed) reBad.push('category');
  }
  for (const s of exp1.structure.roles) {
    const t = roles.get(lr.get(s.sourceId));
    if (!t || t.name !== s.name || t.color !== s.color) reBad.push('role');
  }
  for (const s of exp1.structure.channels) {
    const t = chans.get(lh.get(s.sourceId));
    const wantCat = s.categorySourceId === null ? null : lc.get(s.categorySourceId);
    if (!t) { reBad.push('channel ' + s.name + ' missing'); continue; }
    const fields = { name: [t.name, s.name], topic: [t.topic, s.topic], categorySourceId: [t.categorySourceId, wantCat],
      legacyCategoryName: [t.legacyCategoryName, s.legacyCategoryName], order: [t.order, s.order],
      nsfw: [t.nsfw, s.nsfw], slowmode: [t.slowmode, s.slowmode], type: [t.type, s.type] };
    for (const [f, [got, want]] of Object.entries(fields)) {
      if (got !== want) reBad.push(`channel ${s.name}.${f}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
  }
  const grantShape = (manifest, roleMap, chanMap) => JSON.stringify(manifest.channels
    .map((c) => ({ ch: chanMap ? chanMap.get(c.channelSourceId) : c.channelSourceId,
      o: c.overrides.map((o) => ({ r: o.roleSourceId === '__everyone__' ? o.roleSourceId
        : (roleMap ? roleMap.get(o.roleSourceId) : o.roleSourceId), a: o.allow, d: o.deny }))
        .sort((x, y) => x.r.localeCompare(y.r)) }))
    .sort((x, y) => String(x.ch).localeCompare(String(y.ch))));
  check('P7-RT-15', 'B re-export over TLS reproduces A\'s signed topology and mapped grants',
    reBad.length === 0 && grantShape(exp1.permissions, lr, lh) === grantShape(rePerms, null, null),
    reBad.length ? 'mismatch: ' + reBad.join(', ') : 'structure + permissions parity');

  // ── P7-RT-16: concurrent double submit of ONE approval ──────────────────
  await must(labMutate(A, 'PATCH', `/api/servers/${srcId}/channels/${srcText}`, ownerA, { name: 'second-round', topic: 'Round two topic' }), 'A round-2 edit');
  await must(labMutate(A, 'PATCH', `/api/servers/${srcId}/roles/${srcRole}`, ownerA, { name: 'Relay Crew II', color: '#22aa66' }), 'A round-2 role');
  const exp2 = await exportA();
  await grantsB();
  const rev2 = await review(exp2);
  const ok2 = rev2.result.status === 200 ? await approve(rev2) : { status: rev2.result.status };
  if (ok2.body?.approvalToken) secrets.push(ok2.body.approvalToken);
  const pre2 = dbState(lab.inst.b, dstId);
  const racers = ok2.status === 201
    ? await Promise.all([apply(rev2, ok2.body.approvalToken), apply(rev2, ok2.body.approvalToken)]) : [];
  const post2 = dbState(lab.inst.b, dstId);
  const wins = racers.filter((r) => r.status === 200).length;
  const losses = racers.filter((r) => r.status === 422).length;
  check('P7-RT-16', 'two simultaneous applies of one approval commit exactly once',
    ok2.status === 201 && wins === 1 && losses === 1 && post2.audits === pre2.audits + 1 &&
    post2.snapshots === pre2.snapshots + 1 &&
    matchesSnapshot(post2, exp2, rev2.links, rolePermsBefore).length === 0,
    `review ${rev2.result.status}, approval ${ok2.status}, results ${racers.map((r) => r.status).join('/')}`);

  // ── P7-RT-17: expired approval ──────────────────────────────────────────
  await must(labMutate(A, 'PATCH', `/api/servers/${srcId}/channels/${srcText}`, ownerA, { name: 'third-round' }), 'A round-3 edit');
  const exp3 = await exportA();
  await grantsB();
  let rev3 = await review(exp3);
  const shortLived = rev3.result.status === 200 ? await approve(rev3) : { status: rev3.result.status };
  if (shortLived.body?.approvalToken) secrets.push(shortLived.body.approvalToken);
  let expired = { status: -1 };
  const pre3 = dbState(lab.inst.b, dstId);
  if (shortLived.status === 201) {
    await sleep(Math.max(0, Date.parse(shortLived.body.expiresAt) - Date.now()) + 2_000);
    await grantsB({ fresh: true }); // only the approval's age can refuse
    expired = await apply(rev3, shortLived.body.approvalToken);
  }
  const post3 = dbState(lab.inst.b, dstId);
  check('P7-RT-17', 'an expired approval is refused even with a fresh owner step-up',
    shortLived.status === 201 && expired.status === 422 && rowsKey(post3) === rowsKey(pre3) &&
    post3.consumed === pre3.consumed,
    `review ${rev3.result.status}, approval ${shortLived.status}, apply after expiry ${expired.status}`);

  // ── P7-RT-23: expiry DURING the real HTTP apply's tuple-lock wait ──────
  // Keep RT-17's full production-lifetime check above. Only this new fixture
  // gets a shorter stored deadline; all clocks, SQL locks and HTTP are real.
  await grantsB({ fresh: true });
  const lockReview = await review(exp3);
  const queued = lockReview.result.status === 200 ? await approve(lockReview) : { status: lockReview.result.status };
  if (queued.body?.approvalToken) secrets.push(queued.body.approvalToken);
  let lockObserved = false, freshAtStart = false, expiredBeforeRelease = false;
  let queuedResult = { status: -1 };
  const preLock = dbState(lab.inst.b, dstId);
  if (queued.status === 201) {
    // Do potentially paced HTTP preparation before shortening the fixture.
    const csrf = await labCsrf(origins.b, ownerB, ca);
    await paceWrite(origins.b, ownerB);
    const db = new Pool({ connectionString: lab.inst.b.dbUrl, max: 2 });
    const blocker = await db.connect();
    let pending;
    try {
      const digest = createHash('sha256').update('bridge-portable-import-approval-v1\n')
        .update(queued.body.approvalToken).digest('hex');
      await db.query(`UPDATE portable_import_approvals SET expires_at=clock_timestamp()+INTERVAL '5 seconds'
        WHERE token_hash=$1 AND target_server_id=$2`, [digest, dstId]);
      await blocker.query('BEGIN');
      const locked = await blocker.query(`SELECT pg_backend_pid() AS pid,
        expires_at>clock_timestamp() AS fresh FROM portable_import_approvals
        WHERE token_hash=$1 AND target_server_id=$2 FOR UPDATE`, [digest, dstId]);
      freshAtStart = locked.rows.length === 1 && locked.rows[0].fresh === true;
      if (!freshAtStart) throw new Error('queued approval fixture was not fresh at lock acquisition');
      pending = postTls(`${origins.b}${sidPath}/portable-import/mapped-apply`, {
        ...BROWSER, Host: new URL(origins.b).host,
        Authorization: 'Bearer ' + ownerB.token, 'X-CSRF-Token': csrf,
        'X-Bridge-Step-Up': g['account-security'], 'Content-Type': 'application/json',
      }, JSON.stringify(applyBody(lockReview, queued.body.approvalToken)), ca);
      for (let i = 0; i < 100; i++) {
        const state = await db.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
          WHERE state='active' AND wait_event_type='Lock'
            AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE '%portable_import_approvals%') AS waiting`, [locked.rows[0].pid]);
        if (state.rows[0].waiting) { lockObserved = true; break; }
        await sleep(20);
      }
      if (!lockObserved) throw new Error('real HTTP apply did not enter the expected approval row-lock wait');
      await db.query(`SELECT pg_sleep(GREATEST(0,
        EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.1)
        FROM portable_import_approvals WHERE token_hash=$1`, [digest]);
      const deadline = await db.query(`SELECT expires_at<=clock_timestamp() AS expired
        FROM portable_import_approvals WHERE token_hash=$1`, [digest]);
      expiredBeforeRelease = deadline.rows[0].expired === true;
      await blocker.query('COMMIT');
      queuedResult = await pending;
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      // Release every lock before joining the request, including on failure.
      if (pending) await pending;
      await db.end();
    }
  }
  const postLock = dbState(lab.inst.b, dstId);
  check('P7-RT-23', 'B refuses an approval that expires during the HTTPS apply lock wait, preserving every row and ledger',
    queued.status === 201 && freshAtStart && lockObserved && expiredBeforeRelease &&
    queuedResult.status === 422 && rowsKey(postLock) === rowsKey(preLock) &&
    postLock.approvals === preLock.approvals && postLock.consumed === preLock.consumed &&
    postLock.snapshots === preLock.snapshots && postLock.audits === preLock.audits,
    `approval ${queued.status}, real lock wait ${lockObserved}, expired before release ${expiredBeforeRelease}, apply ${queuedResult.status}`);

  // ── P7-RT-18: response lost after B received the full request ───────────
  rev3 = await review(exp3);
  const ok3 = rev3.result.status === 200 ? await approve(rev3) : { status: rev3.result.status };
  if (ok3.body?.approvalToken) secrets.push(ok3.body.approvalToken);
  const pre4 = dbState(lab.inst.b, dstId);
  const seenBefore = lab.front.b.seen.length;
  let cut = { written: false, replyBytes: 0 };
  if (ok3.status === 201) {
    const csrf = await labCsrf(origins.b, ownerB, ca);
    await paceWrite(origins.b, ownerB);
    cut = await sendThenCut(`${origins.b}${sidPath}/portable-import/mapped-apply`, {
      ...BROWSER, Connection: 'close', Authorization: 'Bearer ' + ownerB.token,
      'X-CSRF-Token': csrf, 'X-Bridge-Step-Up': g['account-security'],
      'Content-Type': 'application/json',
    }, JSON.stringify(applyBody(rev3, ok3.body.approvalToken)), ca);
  }
  // Wait for B's own answer to reach the front, then inspect PostgreSQL.
  let upstream = null;
  for (let i = 0; i < 80 && !upstream; i++) {
    upstream = lab.front.b.seen.slice(seenBefore).find((s) => s.path.endsWith('/portable-import/mapped-apply')) || null;
    if (!upstream) await sleep(250);
  }
  const mid = dbState(lab.inst.b, dstId);
  const committed = mid.consumed === pre4.consumed + 1;
  const atomic = committed
    ? mid.snapshots === pre4.snapshots + 1 && mid.audits === pre4.audits + 1 &&
      matchesSnapshot(mid, exp3, rev3.links, rolePermsBefore).length === 0
    : rowsKey(mid) === rowsKey(pre4) && mid.snapshots === pre4.snapshots && mid.audits === pre4.audits;
  const retry = ok3.status === 201 ? await apply(rev3, ok3.body.approvalToken) : { status: -1 };
  const post4 = dbState(lab.inst.b, dstId);
  check('P7-RT-18', 'a connection cut before the reply is all-or-nothing and the client retry applies exactly once',
    ok3.status === 201 && cut.written && cut.replyBytes === 0 && atomic &&
    (committed ? retry.status === 422 : retry.status === 200) &&
    post4.audits === pre4.audits + 1 && post4.snapshots === pre4.snapshots + 1 &&
    matchesSnapshot(post4, exp3, rev3.links, rolePermsBefore).length === 0,
    `B answered ${upstream?.status ?? 'nothing'} to the cut request; committed=${committed}; retry ${retry.status}`);

  // ── P7-RT-19: graceful restart keeps state and the replay barrier ───────
  await lab.inst.b.stop();
  await lab.inst.b.start({ tag: 'portable-restart' });
  await grantsB();
  const replay2 = await apply(rev3, ok3.body?.approvalToken || randomBytes(32).toString('base64url'));
  const post5 = dbState(lab.inst.b, dstId);
  check('P7-RT-19', 'after a B restart the applied rows persist and the consumed token stays refused',
    ok3.status === 201 && rowsKey(post5) === rowsKey(post4) && replay2.status === 422 &&
    post5.audits === post4.audits && post5.consumed === post4.consumed,
    `replay ${replay2.status}`);

  // ── P7-RT-20: operator revokes the pinned source key on B ───────────────
  // Reviewed and approved while the key is trusted, then revoked: neither a
  // new review, a new approval nor the OUTSTANDING approval may proceed.
  const exp4 = await exportA();
  await grantsB();
  const rev4 = await review(exp4);
  const ok4 = rev4.result.status === 200 ? await approve(rev4) : { status: rev4.result.status };
  if (ok4.body?.approvalToken) secrets.push(ok4.body.approvalToken);
  await lab.inst.b.stop();
  await lab.inst.b.start({ tag: 'portable-revoked', env: trust.revokedDestinationEnv });
  await grantsB();
  const pre6 = dbState(lab.inst.b, dstId);
  const revRevoked = await tlsMutation(`${origins.b}${sidPath}/portable-import/signed-mapping-review`,
    ownerB, g['account-security'], rev4.signed, ca);
  const approveRevoked = await approve(rev4);
  const applyRevoked = ok4.status === 201 ? await apply(rev4, ok4.body.approvalToken) : { status: -1 };
  const post6 = dbState(lab.inst.b, dstId);
  await lab.inst.b.stop();
  await lab.inst.b.start({ tag: 'portable-unrevoked' });
  check('P7-RT-20', 'after operator revocation B refuses review, new approval and the outstanding approval',
    rev4.result.status === 200 && ok4.status === 201 &&
    revRevoked.status === 422 && approveRevoked.status === 422 && applyRevoked.status === 422 &&
    rowsKey(post6) === rowsKey(pre6) && post6.approvals === pre6.approvals && post6.consumed === pre6.consumed,
    `review ${revRevoked.status}, approval ${approveRevoked.status}, outstanding apply ${applyRevoked.status}`);

  // ── P7-RT-21: A signs with a key that B never pinned ───────────────────
  await lab.inst.a.stop();
  await lab.inst.a.start({ tag: 'portable-rogue-key', env: trust.rogueSourceEnv });
  let rogue = null;
  try { rogue = await exportA(); } catch (err) { rogue = { error: String(err) }; }
  await lab.inst.a.stop();
  await lab.inst.a.start({ tag: 'portable-source-restored' });
  await grantsB();
  const pre7 = dbState(lab.inst.b, dstId);
  const swapped = rogue?.attestation
    ? { ...rev4, signed: { ...rev4.signed, structure: rogue.structure, permissions: rogue.permissions, attestation: rogue.attestation } }
    : null;
  const revRogue = swapped ? await tlsMutation(`${origins.b}${sidPath}/portable-import/signed-mapping-review`,
    ownerB, g['account-security'], swapped.signed, ca) : { status: -1 };
  // Substitution: the owner's legitimately reviewed fingerprint plus the
  // rogue-signed bundle for the same community and origin.
  const approveRogue = swapped ? await approve(swapped) : { status: -1 };
  const post7 = dbState(lab.inst.b, dstId);
  // Positive control: the identical request with A's pinned-key bundle is
  // accepted, so the refusal above is caused by the key alone.
  const control = await approve(rev4);
  if (control.body?.approvalToken) secrets.push(control.body.approvalToken);
  check('P7-RT-21', 'a snapshot signed by an unpinned key for the right origin and community is refused by B',
    !!rogue?.attestation && rogue.attestation.keyFingerprint !== trust.fingerprint &&
    rogue.attestation.sourceOrigin === origins.a && rogue.attestation.sourceServerId === srcId &&
    revRogue.status === 422 && approveRogue.status === 422 &&
    rowsKey(post7) === rowsKey(pre7) && post7.approvals === pre7.approvals && control.status === 201,
    `rogue export ${rogue?.attestation ? 200 : 'failed'}, review ${revRogue.status}, approval ${approveRogue.status}, pinned control ${control.status}`);

  // ── P7-RT-22: no bearer/step-up/key material in either server log ───────
  const logs = [lab.inst.a, lab.inst.b].flatMap((inst) => fs.readdirSync(inst.logs)
    .filter((f) => f.startsWith(inst.name + '-')).map((f) => path.join(inst.logs, f)))
    .map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }).join('\n');
  const keyMaterial = [trust.sourceEnv.BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64,
    trust.rogueSourceEnv.BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64];
  const leaked = [...secrets, ...keyMaterial].filter((s) => typeof s === 'string' && s.length >= 20 && logs.includes(s));
  check('P7-RT-22', 'A and B logs contain no approval token, step-up grant or source private key',
    logs.length > 0 && leaked.length === 0, `${secrets.length + keyMaterial.length} secrets checked, ${leaked.length} leaked`);
}
