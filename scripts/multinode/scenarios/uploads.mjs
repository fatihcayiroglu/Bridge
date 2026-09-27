// Cross-node chunked upload and protected-upload failure paths.
//
// Chunk staging lives under the node's upload root (`<root>/_chunks`). The
// cluster runs in one of two topologies (run.mjs --uploads):
//   per-node — every node has its own root (Kubernetes emptyDir, k8s/bridge.yaml)
//   shared   — one root for all nodes (docker-compose.cluster.yml volume)
// Final files always go to the shared private object store (BRIDGE_MULTI_NODE
// requires it), so only STAGING differs between the topologies.

import { register, request, csrfToken, uploadChunk, rnd, fakeIp, BROWSER } from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parts(n, size = 64) {
  return Array.from({ length: n }, (_, i) => Buffer.from(`${String(i).padStart(3, '0')}:${'x'.repeat(size - 5)}\n`));
}

/** Send one chunk to `base` (a node URL or the LB) and report who served it. */
async function send(base, user, csrf, uploadId, i, total, body, { cookies } = {}) {
  const headers = cookies?.MNNODE ? { Cookie: `MNNODE=${cookies.MNNODE}` } : {};
  const r = await uploadChunk(base, user.token, { uploadId, index: i, total, body, csrf, ip: user.ip, headers });
  return { status: r.status, body: r.body, servedBy: r.servedBy, cookies: r.cookies };
}

async function fetchFile(base, user, url) {
  const res = await fetch(base + url, { headers: { ...BROWSER, Authorization: `Bearer ${user.token}`, 'X-Forwarded-For': user.ip } });
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

async function formUpload(base, user, csrf, name, bytes, type = 'text/plain') {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type }), name);
  const res = await fetch(`${base}/api/upload`, {
    method: 'POST', body: fd,
    headers: { ...BROWSER, Authorization: `Bearer ${user.token}`, 'X-CSRF-Token': csrf, 'X-Forwarded-For': user.ip },
  });
  let body = null; try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

export async function run({ cluster, proxy, lb, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const mode = cluster.uploadMode;
  const tag = (id) => `${id}-${mode}`;
  const newUser = async () => { const u = await register(url('A'), 'up'); u.ip = fakeIp(); u.csrf = await csrfToken(url('A'), u.token); return u; };
  const expected = (chunks) => Buffer.concat(chunks);

  // ── 1. control: every chunk on the same node ─────────────────────────────
  {
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(4);
    const rs = [];
    for (let i = 0; i < c.length; i++) rs.push(await send(url('A'), u, u.csrf, id, i, c.length, c[i]));
    const last = rs.at(-1);
    const got = last.body?.done ? await fetchFile(url('C'), u, last.body.url) : null;
    record(tag('UP-01'), 'control: all chunks on one node → done; file served by ANOTHER node from shared object storage',
      last.body?.done && got?.status === 200 && got.bytes.equals(expected(c)) ? 'PASS' : 'FAIL',
      `last=${last.status} ${JSON.stringify(last.body)} fetchViaC=${got?.status}`);
  }

  // ── 2. API client, no affinity: LB round-robin spreads the chunks ────────
  {
    proxy.setMode('round-robin');
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(4);
    const rs = [];
    for (let i = 0; i < c.length; i++) rs.push(await send(lb, u, u.csrf, id, i, c.length, c[i]));
    const last = rs.at(-1);
    const served = rs.map((r) => r.servedBy).join('');
    const got = last.body?.done ? await fetchFile(lb, u, last.body.url) : null;
    const ok = last.body?.done === true && got?.status === 200 && got.bytes.equals(expected(c));
    const silent = rs.every((r) => r.status === 200) && !last.body?.done;
    record(tag('UP-02'), 'API client without affinity (LB round-robin across nodes) completes a chunked upload',
      ok ? 'PASS' : 'FAIL',
      `servedBy=${served} statuses=${rs.map((r) => r.status).join(',')} last=${JSON.stringify(last.body)}${silent ? ' — SILENT: every chunk 200, upload never finalizes' : ''}`);
    // Whatever the topology, a chunk that cannot be staged must never be
    // answered with a silent 200 that leaves the upload unfinishable.
    const refused = rs.filter((r) => r.status === 409 && r.body?.code === 'CHUNK_STAGED_ELSEWHERE');
    record(tag('UP-02x'), 'no silent failure: a chunk reaching a node without the session staging is refused explicitly (409 + staging node)',
      ok || (!silent && refused.length > 0 && refused.every((r) => /^mn-[ABC]$/.test(r.body.stagingNode))) ? 'PASS' : 'FAIL',
      ok ? 'upload completed (shared staging)' : `refused=${refused.map((r) => `${r.servedBy}→${r.body.stagingNode}`).join(',')}`);
  }

  // ── 3. browser-style client with LB cookie affinity ───────────────────────
  {
    proxy.setMode('cookie');
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(4);
    const rs = [];
    let cookies = {};
    for (let i = 0; i < c.length; i++) {
      const r = await send(lb, u, u.csrf, id, i, c.length, c[i], { cookies });
      cookies = { ...cookies, ...(r.cookies || {}) };
      rs.push(r);
    }
    proxy.setMode('round-robin');
    const last = rs.at(-1);
    record(tag('UP-03'), 'client that keeps the LB affinity cookie completes a chunked upload',
      last.body?.done ? 'PASS' : 'FAIL', `servedBy=${rs.map((r) => r.servedBy).join('')} last=${JSON.stringify(last.body)}`);
  }

  // ── 4. same chunk retried on another node (first attempt "timed out") ────
  {
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(3);
    await send(url('A'), u, u.csrf, id, 0, 3, c[0]);
    await send(url('A'), u, u.csrf, id, 1, 3, c[1]);
    await send(url('A'), u, u.csrf, id, 2, 3, c[2]).catch(() => null); // lands on A, response "lost"
    const retry = await send(url('B'), u, u.csrf, id, 2, 3, c[2]);    // client retries via B
    const r = retry.body?.done ? retry : null;
    record(tag('UP-04'), 'final chunk retried on a different node after a lost response: the retry completes (or reports) the upload',
      r || retry.body?.duplicate ? 'PASS' : 'FAIL', `retry@B=${retry.status} ${JSON.stringify(retry.body)}`);
  }

  // ── 5. conflicting bytes for one index on two nodes ───────────────────────
  {
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(2);
    await send(url('A'), u, u.csrf, id, 0, 2, c[0]);
    const other = await send(url('B'), u, u.csrf, id, 0, 2, Buffer.from(`EVIL${c[0].subarray(4)}`));
    record(tag('UP-05'), 'different bytes for an already-committed index on another node are refused (409), not silently accepted',
      other.status === 409 ? 'PASS' : 'FAIL', `B → ${other.status} ${JSON.stringify(other.body)}`);
  }

  // ── 6. node death mid-upload; the client continues through the LB ─────────
  {
    const u = await newUser();
    const id = `up-${rnd()}`;
    const c = parts(4);
    await send(url('A'), u, u.csrf, id, 0, 4, c[0]);
    await send(url('A'), u, u.csrf, id, 1, 4, c[1]);
    const killedAt = Date.now();
    await cluster.killNode('A', 'SIGKILL');
    proxy.setMode('round-robin');
    const r2 = await send(lb, u, u.csrf, id, 2, 4, c[2]);
    const r3 = await send(lb, u, u.csrf, id, 3, 4, c[3]);
    const got = r3.body?.done ? await fetchFile(lb, u, r3.body.url) : null;
    record(tag('UP-06'), 'staging node dies after 2/4 chunks: the upload can be completed on the survivors',
      r3.body?.done && got?.status === 200 && got.bytes.equals(expected(c)) ? 'PASS' : 'FAIL',
      `after death: chunk2=${r2.status}@${r2.servedBy} ${JSON.stringify(r2.body)} chunk3=${r3.status}@${r3.servedBy} ${JSON.stringify(r3.body)}`);
    if (!r3.body?.done) {
      // Per-node staging: the chunks died with node A. Once A's liveness lease
      // lapses the session must be declared lost (quota released) so the
      // client can restart instead of being refused forever.
      let lost = null;
      while (Date.now() - killedAt < 60_000) {
        const r = await send(lb, u, u.csrf, id, 3, 4, c[3]);
        if (r.body?.code === 'CHUNK_STAGING_LOST') { lost = r; break; }
        await sleep(3_000);
      }
      let restarted = null;
      if (lost) {
        // Per-node staging still needs affinity for the restart itself.
        proxy.setMode('cookie');
        let cookies = {};
        for (let i = 0; i < c.length; i++) {
          restarted = await send(lb, u, u.csrf, id, i, c.length, c[i], { cookies });
          cookies = { ...cookies, ...(restarted.cookies || {}) };
        }
        proxy.setMode('round-robin');
      }
      record(tag('UP-06x'), 'staging node dead: the session is declared lost (quota released) and a restarted upload (affinity client) completes on the survivors',
        lost && restarted?.body?.done ? 'PASS' : 'FAIL',
        `lostAfter=${lost ? `${Date.now() - killedAt}ms` : 'never'} restart=${restarted ? `${restarted.status} done=${restarted.body?.done} (last via ${restarted.servedBy})` : 'n/a'}`);
      if (lost) measure('uploads.dead_staging_detected_ms', Date.now() - killedAt, 'ms', 'SIGKILL staging node → chunk answered CHUNK_STAGING_LOST (node lease 30 s)');
    }
    await cluster.startNode('A');
  }

  // ── 7. quota held by uploads that can never finish ────────────────────────
  {
    const u = await newUser();
    // Four uploads each split across two nodes, then a fifth.
    for (let k = 0; k < 4; k++) {
      const id = `up-q${k}-${rnd()}`;
      await send(url('A'), u, u.csrf, id, 0, 2, parts(2)[0]);
      await send(url('B'), u, u.csrf, id, 1, 2, parts(2)[1]);
    }
    const fifth = await send(url('C'), u, u.csrf, `up-q5-${rnd()}`, 0, 2, parts(2)[0]);
    record(tag('UP-07'), 'what a user sees after four uploads that were split across nodes', 'INFO',
      `5th upload first chunk → ${fifth.status} ${fifth.body?.code || ''} (sessions stay reserved until they finish or expire)`);
  }

  if (mode !== 'per-node') return;

  // ── Protected upload failure paths (real private storage + DB faults) ─────
  const pg = cluster.pgProxy;
  const s3 = cluster.s3Proxy;
  const objects = async () => new Set(await cluster.listPrivateObjects('uploads/'));
  const rows = (u) => Number(cluster.psql(`SELECT count(*) FROM uploads WHERE "userId"='${u.id}'`));
  const diff = (after, before) => [...after].filter((k) => !before.has(k));

  // UPF-01: metadata INSERT never runs (connection lost before it reaches PG)
  {
    const u = await newUser();
    const before = await objects();
    pg.armTargeted({ match: /INSERT INTO "?uploads"? /i, mode: 'fail' });
    const r = await formUpload(url('B'), u, u.csrf, 'upf1.txt', Buffer.from('protected upload failure path one\n'));
    await sleep(500);
    const leaked = diff(await objects(), before);
    record('UPF-01', 'metadata INSERT fails: request fails, stored bytes are rolled back, no row',
      r.status >= 500 && leaked.length === 0 && rows(u) === 0 ? 'PASS' : 'FAIL',
      `status=${r.status} newObjects=${leaked.length} rows=${rows(u)}`);
  }

  // UPF-02: metadata INSERT commits, reply lost (ambiguous)
  {
    const u = await newUser();
    const before = await objects();
    pg.armTargeted({ match: /INSERT INTO "?uploads"? /i, mode: 'reply-lost' });
    const r = await formUpload(url('B'), u, u.csrf, 'upf2.txt', Buffer.from('protected upload failure path two\n'));
    await sleep(500);
    const added = diff(await objects(), before);
    const n = rows(u);
    const keys = cluster.psql(`SELECT coalesce(string_agg(key, ','), '') FROM uploads WHERE "userId"='${u.id}'`).split(',').filter(Boolean);
    const dangling = keys.filter((k) => !added.includes(k));
    record('UPF-02', 'metadata INSERT committed but reply lost: no row may point at bytes that were rolled back',
      dangling.length === 0 ? 'PASS' : 'FAIL',
      `status=${r.status} rows=${n} newObjects=${added.length} rowsWithoutBytes=${dangling.length}`);
  }

  // UPF-03: object storage refuses the write
  {
    const u = await newUser();
    const before = await objects();
    const localBefore = cluster.listUploadRoot('B');
    s3.failMethods(['PUT', 'POST']);
    const r = await formUpload(url('B'), u, u.csrf, 'upf3.txt', Buffer.from('protected upload failure path three\n'));
    s3.failMethods([]);
    await sleep(500);
    const localLeft = cluster.listUploadRoot('B').filter((f) => !localBefore.includes(f));
    record('UPF-03', 'object storage refuses the write: request fails, no row, no object, no local leftover',
      r.status >= 500 && diff(await objects(), before).length === 0 && rows(u) === 0 && localLeft.length === 0 ? 'PASS' : 'FAIL',
      `status=${r.status} rows=${rows(u)} localLeftovers=${JSON.stringify(localLeft)}`);
    const again = await formUpload(url('B'), u, u.csrf, 'upf3.txt', Buffer.from('protected upload failure path three\n'));
    record('UPF-03r', 'storage recovered: the same upload succeeds on retry', again.status === 200 ? 'PASS' : 'FAIL', `retry=${again.status}`);
  }

  // UPF-04: metadata fails AND the storage rollback fails
  {
    const u = await newUser();
    const before = await objects();
    const logBefore = cluster.nodeLog('B').length;
    s3.failMethods(['DELETE']);
    pg.armTargeted({ match: /INSERT INTO "?uploads"? /i, mode: 'fail' });
    const r = await formUpload(url('B'), u, u.csrf, 'upf4.txt', Buffer.from('protected upload failure path four\n'));
    await sleep(500);
    s3.failMethods([]);
    const orphans = diff(await objects(), before);
    const observed = cluster.nodeLog('B').slice(logBefore).includes('upload.ownership_rollback_failed');
    record('UPF-04', 'metadata fails and rollback fails: request fails, no row, the orphaned object is reported (structured log)',
      r.status >= 500 && rows(u) === 0 && observed ? 'PASS' : 'FAIL',
      `status=${r.status} rows=${rows(u)} orphanObjects=${orphans.length} rollbackFailureLogged=${observed}`);
    record('UPF-04i', 'orphan object lifetime', 'INFO',
      `${orphans.length} unreferenced object(s) remain until the daily unreferenced-upload sweep (jobs/cleanupUploads.ts, >10 min old)`);
  }
  void measure; void request;
}
