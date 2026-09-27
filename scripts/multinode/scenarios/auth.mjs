// Cross-node authentication: access tokens, refresh rotation, revocation.
// Every step names the node that served it; nothing is routed implicitly.

import { register, login, refresh, request, csrfToken, connectSocket, nextEvent, mutate, fakeIp } from '../lib/client.mjs';

export async function run({ cluster, record, measure }) {
  const A = cluster.nodeUrl('A');
  const B = cluster.nodeUrl('B');
  const C = cluster.nodeUrl('C');

  // ── login on A, use on B ─────────────────────────────────────────────────
  const u = await register(A, 'auth');
  const s1 = await login(A, u);
  const me = await request(B, 'GET', '/api/me', { token: s1.token });
  record('AUTH-01', 'access token issued on A accepted on B', me.status === 200 ? 'PASS' : 'FAIL', `B /api/me ${me.status}`);

  const csrfA = await csrfToken(A, s1.token);
  const cross = await request(B, 'PATCH', '/api/me', { token: s1.token, csrf: csrfA, body: { displayName: 'cross-node' } });
  record('AUTH-02', 'CSRF token issued on A accepted by B (shared Redis store)',
    cross.status < 300 ? 'PASS' : 'FAIL', `PATCH on B with A's CSRF → ${cross.status}`);

  // ── refresh consumed on A, successor used on B ───────────────────────────
  const r1 = await refresh(A, s1.refresh);
  const succ = r1.cookies.bridge_refresh;
  const r2 = succ ? await refresh(B, succ) : { status: 0 };
  record('AUTH-03', 'refresh rotated on A, successor rotated on B',
    r1.status === 200 && r2.status === 200 ? 'PASS' : 'FAIL', `A ${r1.status} → B ${r2.status}`);
  const replayOld = await refresh(C, s1.refresh);
  record('AUTH-04', 'consumed refresh token replayed on C is rejected as reuse',
    replayOld.status === 401 && replayOld.body?.reason === 'reuse' ? 'PASS' : 'FAIL', `C ${replayOld.status} ${replayOld.body?.reason}`);
  const afterReplay = await refresh(B, r2.cookies.bridge_refresh);
  record('AUTH-05', 'replay revokes the whole family (latest successor dead on B)',
    afterReplay.status === 401 ? 'PASS' : 'FAIL', `B ${afterReplay.status} ${afterReplay.body?.reason}`);

  // ── the same refresh token raced on A and B ──────────────────────────────
  const TRIALS = 12;
  let exactlyOne = 0;
  let familyDead = 0;
  const outcomes = [];
  for (let i = 0; i < TRIALS; i++) {
    const ip = fakeIp();
    const s = await login(C, u, ip);
    const [ra, rb] = await Promise.all([refresh(A, s.refresh, ip), refresh(B, s.refresh, ip)]);
    const statuses = [ra.status, rb.status].sort();
    outcomes.push(statuses.join('/'));
    const winner = ra.status === 200 ? ra : rb.status === 200 ? rb : null;
    if (statuses[0] === 200 && statuses[1] === 401) exactlyOne += 1;
    // Documented contract: the loser is a replay; the family (including the
    // winner's successor) is revoked, so the winner's new token must die.
    if (winner) {
      const w = await refresh(C, winner.cookies.bridge_refresh, ip);
      if (w.status === 401) familyDead += 1;
    }
  }
  record('AUTH-06', `same refresh token raced on A and B (${TRIALS} trials): exactly one success`,
    exactlyOne === TRIALS ? 'PASS' : 'FAIL', `outcomes ${JSON.stringify(outcomes)}`);
  record('AUTH-07', 'race loser revokes family: winner successor rejected',
    familyDead === TRIALS ? 'PASS' : 'FAIL', `${familyDead}/${TRIALS}`);

  // ── logout-all on A: token on B and socket on B die immediately ──────────
  const s2 = await login(A, u);
  const sock = await connectSocket(B, s2.token);
  const revoked = nextEvent(sock, 'auth:revoked', () => true, 10_000);
  const disconnected = new Promise((resolve) => sock.once('disconnect', () => resolve(Date.now())));
  const t0 = Date.now();
  const la = await mutate(A, 'POST', '/api/logout-all', s2.token, {});
  const tAck = Date.now();
  const onB = await request(B, 'GET', '/api/me', { token: s2.token });
  const tB = Date.now();
  const rev = await revoked;
  const discAt = await Promise.race([disconnected, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  record('AUTH-08', 'logout-all on A: access token rejected on B on the very next request',
    la.status === 200 && onB.status === 401 ? 'PASS' : 'FAIL', `A ${la.status}; B /api/me ${onB.status} ${tB - tAck}ms after ack`);
  record('AUTH-09', 'logout-all on A: live socket on B receives auth:revoked and is disconnected',
    rev && discAt ? 'PASS' : 'FAIL', `revoked=${JSON.stringify(rev)} disconnect=${discAt ? discAt - t0 : 'none'}ms`);
  if (discAt) measure('auth.cross_node_socket_revocation_ms', discAt - t0, 'ms', 'logout-all on A → socket on B disconnected');
  sock.close();

  // ── password change on A observed on B/C ─────────────────────────────────
  const s3 = await login(B, u);
  const newPassword = `${u.password}-2`;
  const cp = await mutate(A, 'POST', '/api/change-password', s3.token, { currentPassword: u.password, newPassword });
  const oldOnC = await request(C, 'GET', '/api/me', { token: s3.token });
  const oldRefreshOnB = await refresh(B, s3.refresh, fakeIp());
  const newOnB = await request(B, 'GET', '/api/me', { token: cp.body?.token });
  const oldPwLogin = await request(C, 'POST', '/api/login', { body: { username: u.username, password: u.password } });
  record('AUTH-10', 'password change on A: old access token rejected on C',
    cp.status === 200 && oldOnC.status === 401 ? 'PASS' : 'FAIL', `A ${cp.status}; C ${oldOnC.status}`);
  record('AUTH-11', 'password change on A: old refresh token rejected on B',
    oldRefreshOnB.status === 401 ? 'PASS' : 'FAIL', `B ${oldRefreshOnB.status} ${oldRefreshOnB.body?.reason}`);
  record('AUTH-12', 'password change on A: new token valid on B; old password refused on C',
    newOnB.status === 200 && oldPwLogin.status === 401 ? 'PASS' : 'FAIL', `B ${newOnB.status}; C old-pw login ${oldPwLogin.status}`);
  u.password = newPassword;

  // ── plain logout on A: refresh dead everywhere; access token lifetime ────
  const s4 = await login(C, u);
  const lo = await request(A, 'POST', '/api/logout', { cookies: { bridge_refresh: s4.refresh } });
  const refAfter = await refresh(B, s4.refresh, fakeIp());
  const accAfter = await request(C, 'GET', '/api/me', { token: s4.token });
  record('AUTH-13', 'logout on A: refresh token rejected on B', lo.status === 200 && refAfter.status === 401 ? 'PASS' : 'FAIL',
    `A ${lo.status}; B refresh ${refAfter.status}`);
  record('AUTH-14', 'logout (not logout-all) leaves the short-lived access token valid until expiry', 'INFO',
    `C /api/me ${accAfter.status} — documented stateless-access-token contract (ACCESS_TOKEN_TTL, default 15m); logout-all/password change revoke immediately`);

  // ── the refresh limiter is one budget for the whole cluster ──────────────
  // RL_REFRESH_MAX (default 30/min, per client IP for unauthenticated calls).
  // Per-node limiters would allow 3 × 30 across A/B/C.
  const ip = fakeIp();
  const nodes = [A, B, C];
  let accepted = 0;
  let firstLimited = null;
  for (let i = 0; i < 120; i++) {
    const r = await refresh(nodes[i % 3], `invalid-${i}`, ip);
    if (r.status === 429) { firstLimited = { i, node: 'ABC'[i % 3] }; break; }
    accepted += 1;
  }
  record('AUTH-15', 'refresh rate limit is enforced once across all nodes (shared Redis authority)',
    firstLimited && accepted <= 30 ? 'PASS' : 'FAIL', `${accepted} requests passed before the first 429 (limit 30; per-node limits would allow 90); first 429 on node ${firstLimited?.node}`);
}
