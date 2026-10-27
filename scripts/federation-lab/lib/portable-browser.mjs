// C4 owner UI acceptance on the lab's two independently deployed installations.
// No API mocks, injected auth tokens, ignored TLS errors or saved HAR/traces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO } from '../../selfhost/lib/instance.mjs';
import { PgFaultProxy } from '../../multinode/lib/faultProxy.mjs';
import { getTls } from './apsign.mjs';
import { freshGrants, labMutate, pace, paceWrite, tlsMutation } from './portable.mjs';
import { dbState, matchesSnapshot, pairRows, rowsKey } from './portable-roundtrip.mjs';

const SEND = 1 << 8;

function certutil(args) {
  const r = spawnSync('certutil', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('Lab CA trust setup failed; certutil and a writable NSS database are required');
}

/** Trust this public lab CA only, removing this entry when the journey ends. */
function trustLabCa(caFile) {
  const dir = path.join(os.homedir(), '.pki/nssdb');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'cert9.db'))) certutil(['-N', '-d', `sql:${dir}`, '--empty-password']);
  const nickname = 'bridge-c4-' + createHash('sha256').update(fs.readFileSync(caFile)).digest('hex').slice(0, 16);
  certutil(['-A', '-d', `sql:${dir}`, '-n', nickname, '-t', 'C,,', '-i', caFile]);
  return () => certutil(['-D', '-d', `sql:${dir}`, '-n', nickname]);
}

async function downloadedJson(download) {
  assert.equal(await download.failure(), null, 'signed source download must complete');
  const stream = await download.createReadStream();
  assert.ok(stream, 'signed source download must have bytes');
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024, 'signed source download must fit the supported import bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function runPortableBrowserJourney({ lab, origins, check, outDir }) {
  // Reuse the existing locked E2E dependency, never download a new version.
  const { chromium } = createRequire(import.meta.url)(path.join(REPO, 'e2e/node_modules/playwright'));
  const ownerA = lab.users.alice, ownerB = lab.users.bob;
  const secrets = [ownerA.password, ownerB.password,
    lab.portableTrust.sourceEnv.BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64];
  const statuses = [];
  const external = new Set();
  const allowed = new Set([origins.a, origins.b]);
  let browser, removeTrust, dbProxy;
  let proxiedDestination = false;
  try {
    // Positive trust is meaningless if this browser already ignores bad TLS.
    browser = await chromium.launch();
    const probe = await browser.newContext({ ignoreHTTPSErrors: false });
    const probePage = await probe.newPage();
    const untrusted = await probePage.goto(origins.a).then(() => false,
      error => String(error).includes('ERR_CERT_AUTHORITY_INVALID'));
    assert.equal(untrusted, true, 'browser must refuse the untrusted lab CA');
    check('P7-UI-01', 'Chromium refuses the untrusted lab certificate before explicit CA installation', true);
    await browser.close(); browser = null;
    removeTrust = trustLabCa(lab.pki.caFile);

    async function mutate(k, method, route, body) {
      const who = k === 'a' ? ownerA : ownerB;
      await paceWrite(origins[k], who);
      const r = await labMutate(lab.inst[k].base, method, route, who, body);
      assert.ok(r.status >= 200 && r.status < 300, `browser fixture ${method} returned ${r.status}`);
      return r.body;
    }
    const fixture = {};
    for (const k of ['a', 'b']) {
      const source = k === 'a';
      const server = await mutate(k, 'POST', '/api/servers', { name: source ? 'Browser source' : 'Browser destination' });
      const sid = server._id ?? server.id;
      assert.equal(typeof sid, 'string');
      const prefix = `/api/servers/${sid}`;
      const category = await mutate(k, 'POST', `${prefix}/categories`, { name: source ? 'Signed browser category' : 'Old browser category' });
      const catId = category._id ?? category.id ?? category.category?._id;
      assert.equal(typeof catId, 'string');
      const role = await mutate(k, 'POST', `${prefix}/roles`, {
        name: source ? 'Signed browser role' : 'Old browser role', color: source ? '#3366ff' : '#999999', permissions: SEND,
      });
      const defaultText = dbState(lab.inst[k], sid).channels.find(channel => channel.type === 'text');
      assert.ok(defaultText, 'browser fixture needs an existing text channel');
      const channel = await mutate(k, 'POST', `${prefix}/channels`, {
        // A real same-named channel on each instance: the owner must be able
        // to distinguish IDs whose labels and permission grants differ.
        name: defaultText.name, type: 'text',
        topic: source ? 'Snapshot imported through the owner UI' : 'Old topic',
      });
      const rid = role._id ?? role.id ?? role.role?._id;
      const cid = channel._id ?? channel.id;
      assert.equal(typeof rid, 'string'); assert.equal(typeof cid, 'string');
      await mutate(k, 'PUT', `${prefix}/channels/${cid}/permissions/${rid}`, { allow: 0, deny: SEND });
      fixture[k] = { sid, catId, ambiguousName: defaultText.name };
    }

    browser = await chromium.launch();
    async function signIn(k) {
      const who = k === 'a' ? ownerA : ownerB;
      const context = await browser.newContext({ ignoreHTTPSErrors: false, acceptDownloads: true });
      await context.addInitScript(uid => {
        localStorage.setItem('bridge_onboarding_v3:anon', 'done');
        localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
      }, who.id);
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('request', req => {
        const u = new URL(req.url());
        if (['http:', 'https:'].includes(u.protocol) && !allowed.has(u.origin)) external.add(u.origin);
      });
      page.on('websocket', socket => {
        const u = new URL(socket.url());
        u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
        if (!allowed.has(u.origin)) external.add(u.origin);
      });
      page.on('response', res => {
        const u = new URL(res.url());
        if (u.pathname.startsWith('/api/')) statuses.push({ action: u.pathname.split('/').at(-1), status: res.status() });
      });
      await pace('login:' + lab.inst[k].base, 8);
      await page.goto(origins[k], { waitUntil: 'domcontentloaded' });
      await page.locator('#l-username').fill(who.username);
      await page.locator('#l-password').fill(who.password);
      const login = page.waitForResponse(res => new URL(res.url()).pathname === '/api/login' && res.request().method() === 'POST');
      await page.locator('#login-form [data-auth-action="login"]').click();
      const answer = await login;
      assert.equal(answer.status(), 200, 'real browser sign-in must succeed');
      const body = await answer.json();
      secrets.push(body.token, body.accessToken, ...Object.values(body.stepUp?.grants ?? {}));
      secrets.push(...(await context.cookies()).map(cookie => cookie.value));
      await page.locator('#app').waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator(`.server-icon[data-id="${fixture[k].sid}"]`).first().click();
      await page.locator('.server-settings-opener').click();
      const modal = page.locator('#server-settings-modal[role="dialog"]');
      await modal.waitFor({ state: 'visible' });
      await modal.locator('[data-tab="portable"]').click();
      await page.getByTestId('pci-export').waitFor({ state: 'visible' });
      return { context, page };
    }
    const a = await signIn('a');
    await paceWrite(origins.a, ownerA);
    const download = a.page.waitForEvent('download');
    await a.page.getByTestId('pci-export').click();
    const bytes = await downloadedJson(await download);
    const exported = JSON.parse(bytes.toString('utf8'));
    assert.equal(exported.attestation.sourceOrigin, origins.a);
    assert.equal(exported.attestation.sourceServerId, fixture.a.sid);
    check('P7-UI-02', 'A owner signs in through the UI and downloads its real signed community snapshot', true);

    const b = await signIn('b');
    const before = dbState(lab.inst.b, fixture.b.sid);
    const own = await freshGrants(lab.inst.b.base, ownerB);
    secrets.push(...Object.values(own));
    await paceWrite(origins.b, ownerB);
    const target = await getTls(`${origins.b}/api/servers/${fixture.b.sid}/portable-export`, lab.pki.ca, {
      Authorization: 'Bearer ' + ownerB.token, 'X-Bridge-Step-Up': own['sensitive-export'],
    });
    assert.equal(target.status, 200);
    const links = pairRows(exported.structure, target.body);
    const duplicateSources = exported.structure.channels.filter(row => row.type === 'text' && row.name === fixture.a.ambiguousName);
    const duplicateTargets = target.body.channels.filter(row => row.type === 'text' && row.name === fixture.b.ambiguousName);
    assert.ok(duplicateSources.length >= 2 && duplicateTargets.length >= 2, 'both real instances must contain ambiguous channel names');
    async function reviewInBrowser(page, sourceBytes) {
      await page.getByTestId('pci-file').setInputFiles({ name: 'signed-community.json', mimeType: 'application/json', buffer: sourceBytes });
      await page.getByTestId('pci-origin').fill(origins.a);
      await page.getByTestId('pci-source-id').fill(fixture.a.sid);
      await paceWrite(origins.b, ownerB); await paceWrite(origins.b, ownerB);
      await page.getByTestId('pci-prepare').click();
      for (const kind of ['categories', 'roles', 'channels']) {
        for (const link of links[kind]) {
          const select = page.locator(`#pci-${kind}-${link.sourceId}`);
          if (kind === 'channels' && duplicateSources.some(row => row.sourceId === link.sourceId)) {
            assert.equal(await select.inputValue(), '', 'ambiguous names require an explicit owner choice');
            const label = await page.locator(`label[for="pci-${kind}-${link.sourceId}"]`).textContent();
            assert.ok(label.includes(link.sourceId), 'same-named source rows must have distinct visible identities');
            for (const row of duplicateTargets) {
              const option = select.locator(`option[value="${row.sourceId}"]`);
              assert.ok((await option.textContent()).includes(row.sourceId), 'same-named destination options must identify their actual rows');
            }
          }
          await select.selectOption(link.targetId);
        }
      }
      await paceWrite(origins.b, ownerB);
      await page.getByTestId('pci-review').click();
      await page.getByTestId('pci-review-result').waitFor({ state: 'visible' });
      assert.equal(await page.getByTestId('pci-approve').isDisabled(), true, 'approval requires explicit owner consent');
    }
    await reviewInBrowser(b.page, bytes);
    check('P7-UI-09', 'Owners can distinguish same-named source and destination channels and explicitly choose their exact existing identities', true);
    assert.equal(rowsKey(dbState(lab.inst.b, fixture.b.sid)), rowsKey(before));
    check('P7-UI-03', 'B owner chooses explicit mappings and sees verified review without destination writes or implicit consent', true);

    async function approveInBrowser(page) {
      await page.getByTestId('pci-confirm').check();
      await paceWrite(origins.b, ownerB);
      const approvalResponse = page.waitForResponse(res => res.url().endsWith('/portable-import/owner-approval') && res.status() === 201);
      await page.getByTestId('pci-approve').click();
      const approval = await (await approvalResponse).json();
      assert.equal(typeof approval.approvalToken, 'string');
      secrets.push(approval.approvalToken);
      await page.getByTestId('pci-approved').waitFor({ state: 'visible' });
      const privateToken = await page.evaluate(token =>
        !document.documentElement.textContent.includes(token) &&
        [localStorage, sessionStorage].every(storage =>
          Object.keys(storage).every(key => !String(storage.getItem(key)).includes(token))), approval.approvalToken);
      assert.equal(privateToken, true, 'approval token must remain outside DOM and browser storage');
    }
    await approveInBrowser(b.page);
    const staged = dbState(lab.inst.b, fixture.b.sid);
    assert.equal(rowsKey(staged), rowsKey(before));
    assert.equal(staged.approvals, before.approvals + 1); assert.equal(staged.consumed, before.consumed);
    check('P7-UI-04', 'Explicit browser consent creates a durable unused approval kept outside DOM and persistent browser storage', true);

    await paceWrite(origins.b, ownerB);
    const applyResponse = b.page.waitForResponse(res => res.url().endsWith('/portable-import/mapped-apply') && res.status() === 200);
    await b.page.getByTestId('pci-apply').click();
    const applied = await (await applyResponse).json();
    assert.equal(applied.applied, true); assert.equal(applied.transactionCommitted, true);
    await b.page.getByTestId('pci-applied').waitFor({ state: 'visible' });
    const after = dbState(lab.inst.b, fixture.b.sid);
    assert.deepEqual(matchesSnapshot(after, exported, links, new Map(before.roles.map(r => [r.id, r.permissions]))), []);
    assert.deepEqual(after.grants, before.grants); assert.equal(after.members, before.members);
    assert.equal(after.consumed, before.consumed + 1); assert.equal(after.snapshots, before.snapshots + 1);
    assert.equal(after.audits, before.audits + 1);
    check('P7-UI-05', 'Browser apply reports a real atomic commit; B database matches every signed mapped field with grants and identities preserved', true);

    // A real database-wire failure, using the established multinode proxy.
    // Only B's import transaction is targeted; the operator observes PG directly.
    await b.context.close();
    dbProxy = new PgFaultProxy({ listenPort: 24182, targetPort: lab.inst.b.pgPort });
    await dbProxy.start();
    proxiedDestination = true;
    await lab.inst.b.stop();
    const proxiedUrl = new URL(lab.inst.b.dbUrl);
    proxiedUrl.port = String(dbProxy.listenPort);
    await lab.inst.b.start({ tag: 'portable-browser-db-proxy', env: { DATABASE_URL: proxiedUrl.href } });
    await mutate('a', 'PATCH', `/api/servers/${fixture.a.sid}/categories/${fixture.a.catId}`,
      { name: 'Committed despite database reply loss' });
    await paceWrite(origins.a, ownerA);
    const nextDownload = a.page.waitForEvent('download');
    await a.page.getByTestId('pci-export').click();
    const nextBytes = await downloadedJson(await nextDownload);
    const nextExport = JSON.parse(nextBytes.toString('utf8'));
    assert.notEqual(nextExport.attestation.snapshotId, exported.attestation.snapshotId);
    const recovery = await signIn('b');
    await reviewInBrowser(recovery.page, nextBytes);
    await approveInBrowser(recovery.page);
    const preFault = dbState(lab.inst.b, fixture.b.sid);
    const fault = dbProxy.armTargeted({
      match: /INSERT INTO portable_import_snapshot_consumptions\b/i, onCommit: true, mode: 'reply-lost',
    });
    await paceWrite(origins.b, ownerB);
    const uncertainResponse = recovery.page.waitForResponse(res => res.url().endsWith('/portable-import/mapped-apply'));
    await recovery.page.getByTestId('pci-apply').click();
    const uncertain = await uncertainResponse;
    assert.equal(uncertain.status(), 422, 'server must preserve its opaque error boundary');
    assert.deepEqual(await uncertain.json(), { code: 'PORTABLE_MAPPED_APPLY_UNAVAILABLE' });
    assert.ok(fault.fired > 0, 'the real PostgreSQL COMMIT reply-loss fault must fire');
    await recovery.page.getByTestId('pci-outcome').waitFor({ state: 'visible' });
    const recovered = dbState(lab.inst.b, fixture.b.sid);
    assert.deepEqual(matchesSnapshot(recovered, nextExport, links, new Map(before.roles.map(r => [r.id, r.permissions]))), []);
    assert.deepEqual(recovered.grants, before.grants); assert.equal(recovered.members, before.members);
    assert.equal(recovered.consumed, preFault.consumed + 1);
    assert.equal(recovered.snapshots, preFault.snapshots + 1); assert.equal(recovered.audits, preFault.audits + 1);
    assert.deepEqual({ databaseCommitted: true,
      uiOutcome: await recovery.page.getByTestId('pci-outcome').getAttribute('data-outcome') },
    { databaseCommitted: true, uiOutcome: 'unknown' }, 'opaque error must not falsely promise rollback after an actual commit');
    assert.equal(await recovery.page.getByTestId('pci-applied').count(), 0);
    assert.equal(await recovery.page.getByTestId('pci-apply').count(), 0);
    check('P7-UI-07', 'After real PostgreSQL COMMIT reply loss, B keeps its opaque 422 while the browser reports uncertainty and PG proves atomic durable changes', true);

    const retryGrants = await freshGrants(lab.inst.b.base, ownerB);
    secrets.push(...Object.values(retryGrants));
    const replay = await tlsMutation(`${origins.b}/api/servers/${fixture.b.sid}/portable-import/mapped-apply`,
      ownerB, retryGrants['account-security'], uncertain.request().postDataJSON(), lab.pki.ca);
    assert.equal(replay.status, 422);
    assert.deepEqual(dbState(lab.inst.b, fixture.b.sid), recovered);
    check('P7-UI-08', 'A fresh authenticated retry after database reply loss cannot consume or apply the approval again', true);
    assert.deepEqual([...external], [], 'owner journey must not contact external origins');
    const logs = fs.readdirSync(lab.inst.a.logs).filter(name => name.endsWith('.log'))
      .map(name => fs.readFileSync(path.join(lab.inst.a.logs, name), 'utf8')).join('\n');
    assert.equal(secrets.filter(s => typeof s === 'string' && s.length > 12).some(s => logs.includes(s)), false,
      'browser credentials, grants, approval or private signing key leaked into app logs');
    check('P7-UI-06', 'The browser journey contacts no external origin and app logs contain none of its credentials or approval secrets', true);
  } finally {
    const cleanupErrors = [];
    for (const cleanup of [
      async () => { if (browser) await browser.close(); },
      async () => {
        if (proxiedDestination) {
          await lab.inst.b.stop();
          await lab.inst.b.start({ tag: 'portable-browser-db-restored' });
        }
      },
      async () => { if (dbProxy) await dbProxy.stop(); },
      () => { if (removeTrust) removeTrust(); },
      // Only bounded action labels and status codes; never bodies, URLs, tokens or traces.
      () => fs.writeFileSync(path.join(outDir, 'portable-browser-statuses.json'), JSON.stringify(statuses, null, 2)),
    ]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser lab cleanup failed');
  }
}
