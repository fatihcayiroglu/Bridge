# SHARED-IP / NAT POLICY — Bridge v1.124

Schools, dorms, offices and CGNAT ranges put many legitimate users behind **one**
public IP. This document records what was measured, what was fixed, and what an
operator must still tune.

---

## 1. Why this needed work — three independent observations

| # | Observation | Where |
|---|---|---|
| 1 | With production `MAX_WS_PER_IP=10`, exactly **10 sockets** connected from one IP; the 11th was refused (`TOO_MANY_CONNECTIONS_FROM_IP`) | v1.123 |
| 2 | One user's repeated failed 2FA setup attempts escalated to a **whole-IP HTTP ban for 600 s** (`ratelimit.auto_ban.applied — twoFactor 10x aşıldı`) | v1.123 |
| 3 | A 200-VU load test from one IP triggered `global 29x aşıldı` and banned the IP — while the server was comfortably serving **443 req/s at p50 5 ms** | v1.124 |

Observation 3 is the sharpest: the practical ceiling was **the abuse protection, not
the server's capacity**.

## 2. The model that already existed

Bridge's limiter was already account-aware in `combined` mode. For an authenticated
request it charges two buckets:

```
rl:<prefix>:u:<userId>    limit = max                            ← the real quota
rl:<prefix>:ipa:<ip>      limit = max * RL_SHARED_IP_FACTOR (20)  ← emergency ceiling
```

Anonymous traffic is charged `rl:<prefix>:ip:<ip>` (limit = max) only.

> **Final21 Phase 11 (F21-11-04).** Two corrections, both measured. (1) The global
> `/api` limiter runs before route authentication, so it never saw `req.user` and
> charged every request to the anonymous IP bucket: five signed-in users behind one IP
> at 21% of their own quota got the IP auto-banned for 10 minutes. It now identifies
> the caller from a signature-verified access token (media tokens and forged
> signatures stay anonymous). (2) The authenticated ceiling used the same key as the
> anonymous bucket, so busy signed-in neighbours made anonymous requests from that
> IP (login, register) return 429. The ceiling now has its own `ipa` key; the
> anonymous limit is unchanged. That structure is the right shape —
account limit **plus** IP aggregate — and was not redesigned.

## 3. The defect — an abuser could drain the neighbours' budget

Both counters were incremented **before** either limit was checked. So a user who was
already over their own quota kept consuming the shared IP budget with every
*rejected* request. One person hammering the API could exhaust the IP ceiling and
lock out everyone behind the same NAT.

Measured with a regression harness (quota 5, IP ceiling 100, one abuser sending 150
requests):

| | innocent neighbour's successful requests |
|---|---|
| **Before fix** | **0 / 4** |
| **After fix** | **4 / 4** |

## 4. The fix

For authenticated traffic the **account quota is evaluated first**. If the account is
already over its own limit, the request is rejected **without charging the shared IP
aggregate**.

```
event=ratelimit.account_quota
"Account exceeded its own quota; shared IP budget NOT charged."
```

### What did NOT change — security is intact

| Path | Behaviour |
|---|---|
| Anonymous traffic | IP bucket only, exactly as before — floods still stopped |
| Accounts **within** quota | still charged to the IP aggregate, so many-account abuse still hits the ceiling |
| Fail-closed on Redis outage | unchanged |
| `X-Forwarded-For` trust | unchanged — still ignored unless `TRUSTED_PROXY_COUNT` is set |
| Auto-ban escalation | unchanged |

The only difference is that **already-rejected requests no longer burn other
people's budget**. An abuser is contained to their own quota instead of being handed
a lever against their neighbours.

## 5. NAT matrix — measured

`server/tests/shared-ip-fairness.test.ts`, each scenario on its own public IP:

| Scenario | Result |
|---|---|
| **A.** 20 authenticated users behind one IP, each within quota | all 20 served fully, **0** rate-limited |
| **B.** One user exhausts their own quota | that user is limited; **neighbour unaffected** |
| **C.** One abuser sends 150 requests (well past the IP ceiling) | abuser stopped (>100 rejected); **innocent neighbour still gets 4/4** |
| **D.** Anonymous flood (25 requests, no account) | limited — protection intact |
| **E.** 40 distinct accounts flooding from one IP | IP aggregate ceiling still engages |
| Rate-limit response | carries `Retry-After` |

The test was verified to **discriminate the fix**: with the fix disabled, scenario C
fails with the innocent user at 0/4.

## 6. What an operator must still tune

The IP aggregate is a real ceiling: roughly `RL_SHARED_IP_FACTOR` users can each use
their full personal quota before the shared bucket engages. With the default factor
of 20, a NAT with far more than ~20 simultaneously-active users will still see
throttling.

| Variable | Default | When to raise |
|---|---|---|
| `RL_SHARED_IP_FACTOR` | 20 | Deployments serving large shared networks (a school, a company) |
| `MAX_WS_PER_IP` | 10 | **Raise for any NAT deployment** — this is the hardest limit; 10 concurrent users per public IP is low for a school |
| `MAX_UNAUTH_WS_PER_IP` | 3 | Rarely; this guards pre-auth floods |
| `TRUSTED_PROXY_COUNT` | unset | **Always set behind a proxy** — otherwise every user resolves to the proxy's IP and shares a single budget, which is the worst case for this whole class |

`TRUSTED_PROXY_COUNT` deserves emphasis: left unset behind a reverse proxy, *every*
user appears to come from one address, and the shared-IP problem applies to the entire
user base at once.

## 7. Still open

- **Auto-ban is still IP-wide.** The fix prevents an abuser from *draining* the shared
  budget, but a sufficiently determined single abuser can still trip the auto-ban
  threshold and affect their IP. A per-account ban tier (ban the account, throttle the
  IP) is the natural next step and is deliberately **not** attempted here — it changes
  abuse semantics and warrants security review.
- **Socket connect RATE is now account-aware (Final21 Phase 19).** Before, the pre-auth
  connect limiter (`RL_SOCKET_CONNECT_MAX`, 20/min per IP) counted every connection by IP
  alone, and 5 overflows banned the IP for 15 minutes — so 20+ people opening Bridge in the
  same minute behind one NAT got their whole office banned. It now follows the F21-11-04
  model: a connection carrying a *signature-verified* access token is counted against that
  account (`user:<id>`, same max; exceeding it is refused but is **not** an IP violation), plus a
  separate IP emergency ceiling of max × 20 (exceeding it is a violation, as before).
  Anonymous or forged-token connections are unchanged. Test: `server/tests/socket-nat-fairness.test.ts`.
- **The concurrent socket cap is still per IP.** `MAX_WS_PER_IP` (10) limits simultaneous
  sockets per public address regardless of identity. It is a DoS guard on socket exhaustion
  and is deliberately left flat; NAT deployments must raise it (see §6).
