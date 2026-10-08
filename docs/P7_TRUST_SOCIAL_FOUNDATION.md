# P7 — Bridge Trust & Social Foundation

P7 starts from the verified P6 closure and is the required foundation before P8.

- P6 closure merge: `972f30cde9719d9285e2da9a448ccd7dbae97679`
- P7 A1–A7 foundation merge: `4eee3cf9496c13a1a72427b6ba18ddf0e840d468` (PR #124)
- P7 branch: `p7/local-first-openai`
- active P7 PR (canonical B1 closure candidate): #129
- PR #124 is **not** the P7 closure record; it merged the verified local-first foundation only.

## Goal

Make Bridge's core communication model local-first, privacy-preserving, safer
against abuse, portable across servers, and ready for larger PostgreSQL data
volumes.

P7 is complete only when all four pillars below are measured and closed:

1. Local-First Data Architecture
2. Trust, Safety & Privacy
3. Portable Identity & Community
4. Database Scaling

### Current closure status

- Pillar A (A1–A7 local-first foundation) reached exact-head green at
  `ac021863b464bf9f9ada945ef18f1a86d77e0100`; PR #124 merged it to `main` as
  `4eee3cf9496c13a1a72427b6ba18ddf0e840d468`.
- B1 (anti-spam / anti-raid, § B1 evidence below) is the closure candidate in PR #129.
  PR #127 (`p7/trust-safety-openai`) is a parallel B1 line that #129 is expected to
  supersede; its unique evidence items were audited and ported into #129.
- B2–B5, C1–C4 and D1–D3 remain open.
- Therefore **P7 is not closed** and P8 remains blocked.

P7 must close before P8 work begins.

---

## Global working rules

### 1. No scope skipping

Phase order is strict:

`P6 CLOSED → P7 → P8 → P9 → P10`

No P8 implementation is accepted while a P7 closure gate remains open.

### 2. Benchmark-driven development

Claims such as "faster", "lighter", "instant", "zero-lag" or "more reliable"
must be backed by measured evidence.

Relevant metrics include, as applicable:

- startup time;
- local database open/migration time;
- offline channel-open latency;
- reconnect convergence latency;
- API/socket latency;
- CPU and RAM;
- disk/storage growth;
- sync throughput;
- voice/video FPS;
- dropped frames;
- server query latency;
- PostgreSQL index/partition size;
- abuse-control false-positive/false-negative rates.

Each major PR records before/after measurements and the command/lab used.

### 3. Privacy by architecture

New work minimizes centralized data by default.

- only data required for authoritative server behaviour is sent centrally;
- local cache/search/AI stays local or edge-side where practical;
- sensitive local state is encrypted at rest;
- metadata collection requires an explicit operational purpose and retention
  boundary;
- E2EE material or decrypted local cache is never sent to an AI/provider merely
  to make a feature easier to implement.

### 4. Design-decision contract

Every major P7 PR must answer:

1. What real problem is being solved?
2. Why is this architecture appropriate?
3. What is the security/abuse impact?
4. What is the UX impact?
5. What is the rollback plan?

---

# Pillar A — Local-First Data Architecture

## A1. Encrypted local database

Desktop and mobile clients gain a canonical encrypted local persistence layer.

Target:

- Desktop/Mobile: SQLite-backed local state;
- web/PWA: the strongest available durable local backend with explicit capability
  reporting; do not claim native SQLite durability where the runtime does not
  provide it;
- one storage contract across adapters;
- encryption envelope independent of physical backend.

Sensitive long-lived plaintext must not remain in `localStorage`.

### Security invariants

- stable per-account namespace;
- no cross-account reads;
- local encryption keys are not stored as plaintext web-storage strings;
- AES-GCM uses a fresh nonce/IV per encrypted write;
- authenticated scope binds ciphertext to account + logical record;
- corruption fails closed and is recoverable;
- logout/account deletion closes the active store and releases in-memory key
  material.

The initial P7 implementation already begins this boundary in
`client/js/core/local-first/crypto.ts`.

## A2. Offline messaging and optimistic UI

Existing Bridge delivery semantics remain canonical:

- server stays authoritative;
- existing `ackId` idempotency remains the message-send identity;
- there is one send queue, not a second local-first queue;
- UI may render optimistic state immediately;
- network loss does not make typed/sent content disappear;
- server rejection is visible and never silently overwritten by local state.

## A3. Draft and canonical outbox migration

Move the current production-reachable stores behind the encrypted persistence
contract:

- `draft-store.ts`;
- `outbox-store.ts`.

Migration rules:

- migrate legacy plaintext only after verified encrypted persistence;
- remove the plaintext source only after successful migration;
- preserve draft identity and attachment-pending state;
- preserve outbox ordering, retry state and `ackId`;
- quota/storage failure degrades honestly and never reports a durable write that
  did not happen.

## A4. Offline message history

Authorized message snapshots are cached locally after a successful server read or
live event.

Offline channel open:

- renders the newest local window without waiting for the network;
- clearly exposes stale/offline state;
- preserves pending optimistic messages;
- does not resurrect a known-deleted item;
- does not invent current membership/permission truth.

Reconnect:

- revalidates server state;
- converges without duplicate bubbles;
- purges content the client learns it can no longer access.

## A5. Operation Log / CRDT boundary

Background sync is operation-log based first.

Initial operation classes:

- send message;
- edit own message;
- delete own message;
- desired-state reaction update;
- relevant portable-profile/community mutations.

States:

`queued → sending → applied | rejected | superseded`

A CRDT is introduced only where a measured multi-writer problem cannot be safely
represented by operation-specific reconciliation. P7 does not add CRDTs as a
fashion requirement.

## A6. Local search

Offline search covers the bounded authorized local cache.

Rules:

- no cross-account index;
- deletion and revocation remove local searchable content;
- E2EE content is indexable locally only after legitimate client decryption;
- ciphertext is not sent to a remote search/AI service;
- online global search remains server-authoritative.

## A7. Background sync lifecycle

Measure and cover:

- browser online/offline;
- Socket.IO reconnect;
- tab/process reload;
- service-worker wake where supported;
- Capacitor background/foreground;
- mobile network handover conditions available in CI/lab;
- clock skew and retry backoff;
- crash/restart during migration or replay.

There is exactly one replay owner for each operation type.

---

# Pillar B — Trust, Safety & Privacy

## B1. Anti-spam and anti-raid

Build abuse controls from measured attack patterns, not blanket friction.

Scope includes:

- account/message burst detection;
- join/invite raid detection;
- repeated mention/DM abuse;
- coordinated multi-account behaviour where observable without invasive
  tracking;
- server-configurable mitigation levels;
- moderator visibility and reversible actions;
- rate-limit behaviour that remains safe during reconnect bursts.

Required evidence includes controlled attack simulations and legitimate-user
controls so false positives are measured.

### B1 evidence (measured)

**Precondition — A1–A7 exact-HEAD green.** P7 head `ac021863b464bf9f9ada945ef18f1a86d77e0100`:
Quality Gate #572 (`37587480936`), Self-host #207 (`37587480954`), Federation + AI #202
(`37587480948`), Mobile Android #265 (`37587480933`), Mobile iOS #246 (`37587480909`) — all
success. Reaching it fixed, on the P7 head: a memory-key race that orphaned concurrently
written records, a hot retry after a failed socket emit, promise APIs that threw instead of
rejecting (stuck composer state), a cached history window shown unlabelled after a server
error, a crypto test file that never ran, and client branch coverage 89.61% → 90.07%.

**Lab.** `scripts/abuse-lab` (README there): two Bridge processes (`NODE_ENV=production`,
`BRIDGE_MULTI_NODE=true`) sharing PostgreSQL and Redis; every simulated person has its own
client address and alternates nodes. Attacks *and* the legitimate behaviour that resembles
them; legitimate controls use a model of the production client (automatic hold/resend, paced
replay). `node scripts/abuse-lab/run.mjs [--gate]`; CI: `.github/workflows/abuse-lab.yml`
(pull requests touching abuse owners, weekly, manual) runs it gated by
`scripts/abuse-lab/expectations.json`.

**Audit of existing owners (before any change).** HTTP per-route budgets
(`middleware/rateLimit.ts`), the per-event socket gate (`socket/socketRateLimit.ts`, 20
`message:send` / 10 s, drops *without* an ACK), the burst/duplicate detector
(`lib/security.ts` `checkSpamAsync`, 5 messages / 4 s), DM send rate (20/min), opt-in AutoMod
rules (`lib/automodPolicy.ts`, nothing by default), per-actor join/invite budgets (10/min).
Nothing was server-scoped for joins, nothing bounded repetition beyond 4 s, mentions, or new
DM recipients, and the client replayed its whole outbox at once on reconnect.

| Id | Scenario | Baseline (`ac02186`, before B1) | After B1 |
|---|---|---|---|
| ATK-01 | 40 messages at once | BLOCKED — 6 persisted, muted | BLOCKED — 6 persisted, muted |
| ATK-02 | identical text every 1.4 s | **OPEN** — 15/15 (~2,569/h) | BLOCKED — 3/15 (`spam_repeat`) |
| ATK-03 | varied spam to one site every 900 ms | **OPEN** — 20/20 (~3,996/h) | BLOCKED — 4/20 (`spam_links`) |
| ATK-04a | 26 people in one message (no AutoMod rule) | **OPEN** — delivered | BLOCKED — `TOO_MANY_MENTIONS` |
| ATK-04b | one victim pinged every 900 ms | **OPEN** — 15 notifications / 15 s | BLOCKED — 5 notifications (messages still delivered) |
| ATK-05 | 40 new DM conversations | LIMITED — socket gate only (~2,400 recipients/h) | BLOCKED — 10/40, then `DM_NEW_CONVERSATION_LIMIT` (10 per 10 min) |
| ATK-06 | join/leave one community ×15 | LIMITED — 5/15 | LIMITED — 5/15 |
| ATK-07 | 25 invites by one member | LIMITED — 9/25 | LIMITED — 9/25 |
| ATK-08 | 60 fresh accounts / 60 addresses raid one community and post | **OPEN** — 60 joined, 60 raid messages | BLOCKED — 60 joined, **0** raid messages; an established person right after joins and posts |
| ATK-09 | 20 ackIds replayed ×5 | BLOCKED — no duplicates | BLOCKED — no duplicates |
| LEG-01 | 4 lines in 3 s | OK | OK |
| LEG-02.700 | fast typist, 8 lines / 700 ms | **FALSE_POSITIVE** — 2 lost, muted 30 s | FRICTION — 8/8, one automatic 2 s hold |
| LEG-02.1000 / .1500 | fast typist, 1 s / 1.5 s | OK | OK |
| LEG-03 | 12-person chat, 45 s (152 messages) | OK | OK — 0 rejected, slowest 418 ms |
| LEG-04.5 | reconnect replays 5 queued | OK | OK — 4 s |
| LEG-04.10 | reconnect replays 10 queued | **FALSE_POSITIVE** — muted 30 s, 35 s to converge | OK — 10/10 in 9 s, no hold |
| LEG-04.25 | reconnect replays 25 queued | **FALSE_POSITIVE** — muted, 5 dropped with no ACK | OK — 25/25 in 24 s |
| LEG-05 | 25 ACK-lost (already delivered) replays | **FALSE_POSITIVE** — 13 shown "failed" | OK — 25/25 re-acknowledged, 25 rows |
| LEG-06 | slow client resends one message ×4 | OK | OK |
| LEG-07 / 08 | 3 joins / 25 established people in 15 s | OK | OK |
| LEG-10 | 40 established people in 10 s (crosses the raid threshold), then post | — | OK — 40/40 joined, 40/40 posted |
| LEG-11 | 40 **brand-new** accounts in 10 s, post, moderator ends raid mode | — | FALSE_POSITIVE *(accepted trade-off)* — 0/40 posted while held; lift released 40 holds; then 40/40 posted |
| LEG-09 | owner bans 40 raid accounts back-to-back | **FALSE_POSITIVE** — 30/40 | FALSE_POSITIVE *(deferred to B5)* — 30/40 |
| LEG-12 | one explicit mention of one member *(ported from #127 LEG-03)* | — | OK — message acked, exactly 1 notification |
| LEG-13 | 5 DMs in an existing conversation, 1.1 s apart *(#127 LEG-04)* | — | OK — 5/5 delivered, no refusals |
| LEG-14 | DMs to 3 new recipients, 1.5 s apart *(#127 LEG-05)* | — | OK — 3/3 delivered, no refusals |

Totals: baseline attacks 2 BLOCKED / 3 LIMITED / 5 OPEN, controls 8 OK / 5 FALSE_POSITIVE;
after B1 attacks 8 BLOCKED / 2 LIMITED / 0 OPEN, controls 12 OK / 1 FRICTION / 2 FALSE_POSITIVE
(both documented in `expectations.json`). ATK-08 and the join controls are from the final
join-scenario run after the raid-race fix; the rest from the final full run.
LEG-12–14 were added when PR #127's unique evidence was ported into #129: B1 changed the
mention-notification and new-DM paths, and before them the lab measured only the attacks on
those paths. Clean full gated run with them (local, two nodes): attacks 8 BLOCKED / 2 LIMITED /
0 OPEN; controls 15 OK / 1 FRICTION / 2 FALSE_POSITIVE (LEG-09, LEG-11, as above); gate pass.

Resources (node CPU time and RSS per scenario, two nodes; fixture registration dominates):
no change distinguishable from run-to-run noise — e.g. 12-person chat 3.7 + 4.0 s CPU before,
4.1 + 3.8 s after; 40-message burst 0.7 + 1.2 s before, 0.9 + 1.1 s after; RSS 120–160 MB per
node throughout. Redis: every new counter is a short-TTL sorted set (≤ 60 s, DM budget 10 min).

**What changed and why (design-decision contract).**

1. *Real problem* — the measured OPEN rows and false positives above.
2. *Architecture* — one owner per concern, no new generic limiter:
   `lib/abusePolicy.ts` (repeats, link hosts, mentions, new DM conversations) counts through
   the existing cluster-wide window (`socketRateLimit.countInWindow`, now exported);
   `lib/security.ts` keeps the burst window but rejects excess with a short retry and mutes only
   a sustained flood (3 strikes / 60 s); `lib/raidProtection.ts` (from the merged
   `p7/b1-antiraid-openai` branch) owns join surges; the client's single replay owner paces
   reconnect replay through its existing held FIFO. Every threshold is an explicit
   `ABUSE_*` / `RAID_*` setting.
3. *Security/abuse impact* — the table. Fail-closed when the Redis authority is unavailable
   (as every existing limiter). Counters hold account ids and truncated SHA-256 digests only:
   no message text or visited host reaches Redis. Encrypted content is not inspected (cannot
   be); burst and DM limits still apply to it. Raid audit records counts, never identities.
4. *UX impact* — fast typists and reconnecting users now see at most a short automatic hold
   instead of a 30 s mute or "failed" messages; refusals carry explained, localized reasons
   (10 locales); repeated text is a terminal "same message" failure; mass-mention and DM limits
   explain themselves. Brand-new accounts that join during a detected surge wait (LEG-11).
5. *Rollback* — thresholds relax by environment without a deploy of code; a server owner can
   set raid protection to `off`; ending raid mode lifts its holds; migration 080 has a
   rollback (`rollback/080_server_raid_protection.down.sql`); every change is a separate
   commit.

**Defects found in the merged raid branch** (it had no CI run): the inline mirror of
migration 080 used `DO $ … END $` (fresh installs could not initialize; guard test added);
a TypeScript narrowing error failed the build; the new columns were missing from the server
column whitelist, so raid mode never persisted (its refusals came from the failure path); three
route suites mocked the limiter without `moderation`. Its lockdown semantics were then
measured (30 of 60 raiders admitted and posting; 10 of a 40-person launch refused; a real
person after the raid refused) and replaced: balanced never refuses a join and holds young
surge accounts — including the cohort that triggered it, and inserts that race the crossing —
from posting until raid mode ends; strict still refuses joins.

**Known limitations.** LEG-11 (new accounts in a surge are held until raid mode ends or a
moderator ends it — the account-age signal cannot tell a brand-new fan from a raider);
LEG-09 (bulk raid cleanup is capped at 30 bans/min per moderator; an audited bulk action is
B5); a raid below the threshold (30 joins / 10 s balanced, 10 strict) is not detected; DM
content is not inspected for repetition or links (DMs are bounded by the new-conversation
budget and the DM send rate); thresholds were measured against scripted patterns on one host,
not an adaptive adversary or production traffic.

## B2. Risk-adaptive security

High-risk actions may require stronger verification based on bounded, explainable
risk signals.

Potential protected actions include:

- account recovery/security changes;
- destructive moderation;
- mass invite/member actions;
- sensitive export;
- suspicious new-session behaviour.

Rules:

- no opaque permanent user "trust score";
- risk inputs are documented;
- sensitive attributes are not inferred;
- signals have retention bounds;
- step-up decisions are explainable to the user/operator;
- accessibility and account-recovery escape paths are tested.

### B2 audit (read-only, `main` at `ffc2a9d`)

**Threat this answers.** An attacker who holds only an access token or refresh cookie (XSS, a
shared or unlocked computer, a leaked token) — but not the person's credentials — can today:

| Action | Route | Current check | Effect for the attacker |
|---|---|---|---|
| change recovery e-mail | `POST /api/email/add` | session only | add own address → verify → `/email/forgot` → password reset → **account takeover** |
| register a passkey | `POST /api/webauthn/register/begin`, `/complete` | session only | **permanent** way back in |
| remove a passkey | `DELETE /api/webauthn/credentials/:id` | session only | owner lock-out |
| enable 2FA | `POST /api/2fa/setup`, `/verify` | session only | own authenticator; `rotateSecuritySession` signs the owner out → **lock-out** |
| export the account | `GET /api/account/export` | session only | whole history exfiltrated |
| delete an owned server | `DELETE /api/servers/:sid` | session + owner | **irreversible** for every member |
| instance-admin deletes | `DELETE /api/admin/users/:id`, `/admin/servers/:id` | session + admin | irreversible, instance-wide |
| disable 2FA / regenerate backup codes | `POST /api/2fa/disable`, `/backup-codes/regenerate` | password only | a phished password + stolen session removes the second factor |
| destructive moderation | bans, kicks (two routes), `DELETE /api/messages/bulk` | permission + 30/min limiter | a stolen moderator session bans ~30 members/min indefinitely |
| mass invites | `POST /api/servers/invites` | generic `limits.servers()` (10/min, shared with other server actions) | bounded per minute, unbounded over time (lab ATK-07: 9/25 in a burst) |

Already protected and left as they are: password change (`currentPassword`), `DELETE /api/2fa`
(a TOTP code inline), account deletion (password + typed confirmation), password reset (verified
address only; revokes every session). **Gap in the other direction:** SSO-only accounts store no
password, so they cannot delete their account at all today.

**Existing owners to reuse (no parallel auth flow):**
- *Credentials* — `routes/twoFactor.ts` (TOTP with per-step replay protection
  `Users.consumeTotpStep`, backup codes `Users.consumeBackupCode`), bcrypt checks inline in
  `routes/auth.ts` / `account.ts` / `twoFactor.ts`, WebAuthn assertion in `routes/webauthn.ts`
  `login/complete`, SSO handoff in `routes/sso.ts`.
- *Sessions* — `middleware/auth.ts` (access JWT carries `tokenVersion`; refresh rows store only
  `userId, family, createdAt, expiresAt, used, tokenVersion` — **no IP or device**),
  `lib/securitySession.ts`, `lib/sessionRevocation.ts`; revocation = `tokenVersion++`.
- *Counters* — `socket/socketRateLimit.ts` `countInWindow` (cluster-wide in Redis, fail-closed).
- *Audit* — `audit_logs` is server-scoped (`logAudit` in `lib/permissions.ts`); there is no
  account-level security log, only structured `logger` events.
- *Client* — `core/api-fetch.ts` is the single HTTP owner (CSRF and refresh already handled
  there); `core/product-dialog.ts` (`promptProductText` / `confirmProductAction`) is the
  accessible modal (focus trap, Escape, labelled); `auth-compat.ts` `startApp()` is where every
  sign-in path converges; Security/Privacy settings tabs call the protected routes via `apiFetch`.
  The web client has no owner-side "delete server" UI (only the API and the admin panel).
- *Device metadata* — the only device signal is `lib/captcha.ts` `checkSuspiciousLogin`
  (SHA-256 of IP + user-agent, 30-day Redis TTL) used for an advisory e-mail. B2 does **not** use
  it: it is fingerprint-like and B3 owns its review.

### B2 design (approved; implemented on `p7/risk-adaptive-security`)

**Principle.** Risk-adaptive here means *the bar rises with the action and with what the account
itself has configured* — never with a hidden judgement of the person. Every decision is a pure
function of four inputs, each documented and bounded:

| Signal | Source | Retention |
|---|---|---|
| `proof_age` — when this account last proved a credential | a signed **step-up grant** carried by the client | never stored server-side; grant lifetime 10 min (`STEP_UP_TTL_MS`) |
| `action` — which protected action | static catalog in code | n/a |
| `account_factors` — password present? 2FA enabled? | the account's own settings (read, never inferred) | the account itself |
| `burst` — this actor's destructive-moderation or invite count | `countInWindow` (Redis, cluster-wide) | the window (60 s default) |
| `failed_proofs` — failed step-up attempts on this account | `countInWindow` | 15 min |

No score, no reputation, no IP/geo/device input, no inference about the person.

**Step-up levels.** L1 = a recent password proof or a fresh password sign-in. L2 = a recent second
factor (TOTP or a backup code) or a sign-in that *demonstrably* used one (2FA check, or a passkey
assertion). A plain SSO return satisfies **L1 only**: arbitrary SSO is not treated as L2 unless the
IdP response actually demonstrates second-factor assurance (e.g. an AMR/ACR claim), which this
first implementation does not assume. *Required level* = L2 if the account has 2FA enabled,
otherwise L1 — so step-up is never weaker than the account's own sign-in.

**Grant — scoped, not just levelled.** A proof for one kind of action must not authorise an
unrelated sensitive action, so a grant carries a `scope` (an action *group*) and is accepted only
for actions in that group. Groups:

- `account-security` — e-mail change, passkey add/remove, 2FA enable/disable, backup-code regeneration
- `sensitive-export` — account export
- `destructive-admin` — account deletion, owned-server deletion, instance-admin user/server deletion
- `moderation-burst` — bans, kicks, bulk message delete, once over the measured burst (invite creation
  is **not** in this group: deferred, see the invite decision below)

Grant shape: `{ sub, v (tokenVersion), level, method, scope, iat, exp, typ: 'stepup' }`. Signed
with a **domain-separated** key: `STEP_UP_SECRET` when set, otherwise an HMAC derivation from
`JWT_SECRET` with a fixed `bridge-step-up-grant-v1` label, plus its own `typ`/audience — so a
step-up token never validates as an access token and an access token never validates as a grant.
`tokenVersion++` (sign-out everywhere, password change/reset, 2FA change) revokes all grants. The
client keeps it in memory only (P7 rule D), never in persistent browser storage, and sends it in
the explicit `X-Bridge-Step-Up` header (one grant per request; the owner holds the newest grant
per scope).

**Obtaining a grant (reusing each credential's existing verifier).** `POST /api/step-up/password`
(new, L1; refused for 2FA accounts), `POST /api/2fa/step-up` (TOTP/backup code with the existing
replay protection, L2), and every sign-in response carries one. Each proof endpoint names the
`scope` it is for and keeps the normal CSRF middleware and its existing rate limiter
(`limits.twoFactor()`); the per-account `failed_proofs` lock (5 in 15 min → step-up proofs refused
for that account for the window) is **additional** and deliberately does **not** touch the sign-in
or account-recovery paths, so a locked-out attacker cannot lock the owner out of signing back in.

**Protected actions (first implementation).**

| Category | Actions | When |
|---|---|---|
| Account recovery / security | e-mail change; passkey add (begin + complete) and remove; 2FA enable (setup + verify), disable, backup-code regeneration | always |
| Sensitive export | account export | always |
| Irreversible | account deletion (grant **or** existing password; SSO-only accounts use a grant), owned-server deletion, instance-admin user/server deletion | always |
| Destructive moderation | bans, kicks (both routes), bulk message delete | after a burst, per-action threshold **measured, not assumed** (see below) |
| Mass invite | invite creation | **deferred** (approved decision below): the existing `limits.servers()` 10/min limiter stays the bound; no invite step-up in the first B2 implementation |
| Suspicious new session | any of the above from a session without a recent proof; repeated failed proofs | covered by the grant + `failed_proofs` lock |

**Burst thresholds are measured, not hard-coded.** The B2 baseline lab (below) records, per action,
both a legitimate operator's cadence (a moderator cleaning up a raid; an organiser creating
invites) and an abusive burst, and the thresholds are then chosen from that evidence — separately
per action, not one shared `>10/min`. Two reachability rules constrain the choice: (1) the step-up
check must run **before** the action's existing route limiter, so the person gets an explainable
`STEP_UP_REQUIRED` rather than a bare 429; (2) for invite creation specifically, the generic
`limits.servers()` budget is already 10/min, so a step-up threshold at or above 10 would be dead —
the threshold is set below it (and the limiter left as the outer bound). Chosen thresholds are
reported for approval before they are written into production code.

Existing inline checks stay (password on 2FA disable / regenerate / account deletion; TOTP on
`DELETE /api/2fa`) — the guard adds to them and never replaces a stronger one. Step-up is
additional protection layered on top of the credential checks already present, never a substitute.

**User-facing contract.** Refusal is `403 { error: 'STEP_UP_REQUIRED', action, reasons[], why,
level, methods[], ttlMs }` — never 401 (the client treats 401 as an expired session). `reasons`
is a closed set (`step_up_missing | _expired | _invalid | _revoked | _other_account | _level |
_scope_mismatch | moderation_burst | invite_burst | step_up_locked`); `why` is the action's
plain-language reason. The refusal also names the `scope` the client must obtain a proof for.
`apiFetch` hands the refusal to one client owner, which asks for **one** proof through the
existing product dialog (password or one-time-code input, labelled, keyboard-only operable),
keeps the grant in memory and retries the request once. Concurrent refusals share one prompt.
Cancel returns the original 403 to the caller.

**Fallbacks.** No password (SSO): sign in again. Lost authenticator: backup code (L2). Lost
everything: the existing verified-e-mail password reset (unchanged; it never grants L2). A
failed-proof lock expires on its own and never blocks sign-in.

**Multi-node.** Grants are stateless and verify on any node; revocation rides the existing
shared `tokenVersion`; counters are the existing cluster-wide window (fail-closed without Redis
in production); TOTP-step and backup-code consumption are already atomic in the database.

**Evidence required for B2 closure.**
1. Baseline *before* implementation in the abuse lab (two nodes): stolen-session attacks on each
   row of the audit table, the compromised-moderator burst, distributed proof guessing.
2. The same lab after implementation: every stolen-session attack BLOCKED; legitimate controls —
   fresh sign-in acts without a prompt (OK), an older session acts after one proof (FRICTION),
   a 2FA account proves with TOTP and with a backup code, ordinary moderation is never asked,
   a moderator's cleanup continues after one proof — gated in `expectations.json`.
3. Unit + route matrix: every protected route refuses without a grant and passes with one;
   level enforcement; revocation after sign-out-everywhere; cross-account grant refused; grant
   minted on node A accepted on node B; SSO-only account deletion via a sign-in grant.
4. Client: interception, one prompt for concurrent refusals, cancel path, memory-only grant,
   cleared on identity change; i18n in all locales; dialog accessibility.
5. Full server/client typecheck, coverage gates, CI green; design-decision contract (problem,
   architecture, security, UX, rollback = per-action env switch + revert commits).

### B2 baseline (measured, before any step-up)

**Lab.** `scripts/stepup-lab` (README there): the same two-node harness as B1 (two
`NODE_ENV=production` processes, shared PostgreSQL + Redis, clients alternating nodes). A *stolen
session* is the victim's own access token replayed from the attacker's address with no
credentials. Baseline run on `main` (ungated); every attack is expected OPEN.

| Id | Attack (stolen session) | Baseline | After B2 (target) |
|---|---|---|---|
| SU-ATK-01 | change recovery e-mail (`POST /api/email/add`) | **OPEN** — 200 | STEP_UP_REQUIRED (`account-security`) |
| SU-ATK-02 | begin passkey registration | **OPEN** — begin 200, list 200 | STEP_UP_REQUIRED (`account-security`) |
| SU-ATK-03 | begin 2FA enrolment | **OPEN** — 200, secret issued | STEP_UP_REQUIRED (`account-security`) |
| SU-ATK-04 | disable 2FA with a phished password | **OPEN** — password-only guard, no L2 | STEP_UP_REQUIRED L2 (`account-security`) |
| SU-ATK-05 | export the whole account | **OPEN** — 200 | STEP_UP_REQUIRED (`sensitive-export`) |
| SU-ATK-06 | delete an owned server | **OPEN** — 200 | STEP_UP_REQUIRED (`destructive-admin`) |
| SU-ATK-07 | instance-admin delete a user and a server | **OPEN** — 200 / 200 | STEP_UP_REQUIRED (`destructive-admin`) |
| SU-ATK-08 | compromised moderator bans 40 as fast as possible | **OPEN** — 30/40 in 12.8 s (only the 30/min limiter) | STEP_UP_REQUIRED after the burst threshold (`moderation-burst`) |
| SU-ATK-09 | create 25 invites back-to-back | **OPEN** — 8/25 in 2.4 s (only the 10/min servers limiter) | see invite note below |
| SU-ATK-10 | distributed step-up proof guessing | **OPEN** — no endpoint yet | failed-proof lock (5 / 15 min per account) |

| Id | Legitimate operator | Baseline |
|---|---|---|
| SU-LEG-01 | ordinary moderation: 3 bans handling reports | OK — 3/3; the common case |
| SU-LEG-02 | raid cleanup: 40 bans back-to-back | OK — 30/40 (30/min limiter); the only legit case far above the ordinary volume |
| SU-LEG-03 | organiser creates 6 invites over ~12 s | OK — 6/6 |
| SU-LEG-04 | fresh sign-in then account export | OK — 200/200; no sign-in grant at baseline |

Baseline totals: attacks 10 OPEN / 0 STEPUP / 0 BLOCKED; controls 4 OK. Run label
`baseline-5e84283`.

**Proposed per-action burst thresholds (measured, for approval before production code).**

- *Account-security, sensitive-export, destructive-admin, owned-server/account deletion
  (SU-ATK-01..07):* **always** require a scoped proof — no threshold. Nothing legitimate here is
  high-volume, so there is no cadence to measure.
- *Destructive moderation — bans, kicks, bulk message delete (SU-ATK-08):* **step up after 5
  destructive actions per 60 s per actor**, then one `moderation-burst` proof (10-min grant)
  lets the rest proceed. Evidence: ordinary moderation is 3 actions (SU-LEG-01, under the
  threshold → no prompt); a raid cleanup is the one legitimate case above it (SU-LEG-02, 30+
  actions → one proof, then continues); a compromised session (SU-ATK-08) is stopped at 5
  instead of the 30 the limiter alone allows. 5 sits far below the existing 30/min moderation
  limiter, so the step-up fires first (an explainable 403, not a bare 429).
- *Invite creation (SU-ATK-09):* **deferred — approved decision.** The measured legitimate
  organiser does ~6 invites in a sitting (SU-LEG-03) while the existing generic `limits.servers()`
  limiter already caps invites at ~10/min (the burst got 8/25). A step-up threshold below 6 would
  prompt ordinary organisers; one at 8–9 leaves only a one-to-two-invite band before the limiter
  rejects anyway — i.e. ineffective. Decision: keep the existing 10/min limiter unchanged as the
  bound, do **not** add an artificial invite threshold, and do **not** broaden `moderation-burst`
  grants to invite creation. Follow-up (outside the first B2 implementation): a dedicated
  invite-rate budget with real headroom, after which an invite step-up threshold can be measured
  and made reachable. Mass-member risk in B2 is covered by the moderation-burst group (mass
  kicks/bans).

**Approved thresholds (in production code).** `moderation-burst`: 5 destructive moderation actions
per 60 s per actor (`STEP_UP_MODERATION_BURST_MAX` / `_WINDOW_MS`); after one valid proof the
cleanup continues for the grant's lifetime (10 min, `STEP_UP_TTL_MS`). The check runs inside each
route after its own permission, ownership and hierarchy checks — so only actions the moderator may
actually perform are counted or prompted — and long before the route limiters (moderation 30/min,
roles 20/min), so the person gets an explainable `STEP_UP_REQUIRED`, not a bare 429.

### B2 after (measured, gated)

**Lab.** The same two-node lab (`scripts/stepup-lab`, gated by `expectations.json`; CI workflow
`.github/workflows/stepup-lab.yml`). The simulated legitimate client behaves like the product
client: it holds the grants its sign-in returned (memory only), sends the grant for the action's
scope, and on a refusal performs ONE proof (password, or a real RFC 6238 TOTP / backup code for a
2FA account) and retries; proofs and retries go to the other node. A thief holds only the stolen
access token. Run label `after-b2-b0d1340` — gate **pass**.

| Id | Attack (stolen session) | Baseline | After B2 |
|---|---|---|---|
| SU-ATK-01 | change recovery e-mail | OPEN | **STEPUP** — 403 `step_up_missing` (`account-security`) |
| SU-ATK-02 | begin passkey registration | OPEN | **STEPUP** (read-only credential list stays open) |
| SU-ATK-03 | begin 2FA enrolment | OPEN | **STEPUP** |
| SU-ATK-04 | disable 2FA with a phished (correct) password | OPEN | **STEPUP** — level 2 required |
| SU-ATK-05 | export the account | OPEN | **STEPUP** (`sensitive-export`) |
| SU-ATK-06 | delete an owned server | OPEN | **STEPUP** (`destructive-admin`) |
| SU-ATK-07 | instance-admin delete user + server | OPEN | **STEPUP** / **STEPUP** |
| SU-ATK-08 | compromised moderator bans 40 | OPEN — 30/40 | **STEPUP** — 5/40; first refusal at request 6 (before the 30/min limiter) |
| SU-ATK-09 | 25 invites back-to-back | OPEN — 8/25 | OPEN — 8/25 (**approved deferral**; unchanged 10/min limiter) |
| SU-ATK-10 | distributed proof guessing (new address + alternating node per guess) | no endpoint | **BLOCKED** — locked after 5 wrong; the correct password is then refused too (429 `STEP_UP_LOCKED`); the owner still signs in (200, fresh grants) |
| SU-ATK-11 | grant replayed after sign-out-everywhere | — | **STEPUP** — `step_up_revoked` (even beside a new valid session) |
| SU-ATK-12 | stolen token + the attacker's own grant | — | **STEPUP** — `step_up_other_account` |
| SU-ATK-13 | a grant for one scope used for another | — | export **STEPUP** `step_up_scope_mismatch`; account deletion **BLOCKED** by the existing password guard |

| Id | Legitimate person | After B2 |
|---|---|---|
| SU-LEG-01 | ordinary moderation, 3 bans (older session) | **OK** — 0 proofs |
| SU-LEG-02 | raid cleanup, 40 bans (older session) | **FRICTION** — asked once at the burst, then 29/40 (the remaining 429s are the unchanged 30/min limiter; baseline 30/40) |
| SU-LEG-03 | organiser, 6 invites | **OK** |
| SU-LEG-04 | fresh sign-in → export + server deletion, cross-node | **OK** — 0 proofs (4 sign-in grants) |
| SU-LEG-05 | older session exports twice (proof on node A, export on node B) | **FRICTION** — one password proof; the second export uses the held grant |
| SU-LEG-06 | 2FA account, TOTP | **FRICTION** — one TOTP proof (refusal level 2, methods totp/backup_code/sign_in) |
| SU-LEG-07 | 2FA account, backup code | **FRICTION** — one backup-code proof (8 → 7 codes) |

Totals: attacks 10 STEPUP / 2 BLOCKED / 1 OPEN (the deferred invite row); controls 3 OK /
4 FRICTION / 0 FALSE_POSITIVE. The B1 abuse lab (`scripts/abuse-lab`) was re-run gated against
the same build (label `b2-b0d1340`, gate **pass**): attacks 8 BLOCKED / 2 LIMITED / 0 OPEN,
controls 15 OK / 1 FRICTION / 2 known FALSE_POSITIVE — identical to B1 after. Its raid-cleanup
control (LEG-09) models the product client (a freshly signed-in moderator holds the sign-in
`moderation-burst` grant) and is unchanged by B2: 30/40 applied, the 10 refusals are all the
existing 30/min moderation limiter (429), 0 are `STEP_UP_REQUIRED` — still the known B1 false
positive deferred to B5.

**Tests.**
- `server/tests/p7-step-up-core.test.ts` — grant shape, domain-separated key (also when
  `STEP_UP_SECRET` equals `JWT_SECRET`), access token ↔ grant never interchangeable, every refusal
  reason, failed-proof lock (fail-closed), burst counter, rollback switch; 100% of `lib/stepUp.ts`.
- `server/tests/p7-step-up-proofs.test.ts`, `p7-step-up-proof-limits.test.ts` — password and
  TOTP/backup-code proofs, replay, the lock (never applied to sign-in), sign-in grants per path,
  revocation when enabling 2FA rotates the session, CSRF and the unchanged `limits.twoFactor()`
  accounting.
- `server/tests/p7-step-up-route-matrix.test.ts` — every always-protected route at its production
  mount: no grant / other scope / other account / expired / tampered / access token / pre-revocation
  grant / password-level grant on a 2FA account / the right grant; grants minted in one module
  instance verify in another (and not with a different `STEP_UP_SECRET`).
- `server/tests/p7-step-up-moderation-burst.test.ts` — real routers and real limiters: 3 bans
  unprompted; the 6th asks once and the cleanup continues; a stolen session is stopped at 5 with
  `STEP_UP_REQUIRED` for requests 6–30 and 429 only after 30; bans, both kick routes and bulk delete
  share one per-actor counter; non-moderators are never asked or counted.
- Existing suites that exercise protected actions present a real grant (`tests/helpers/stepUp.ts`);
  the guard is never disabled in tests.
- Client: `client/tests/p7-step-up-client.test.ts` (interception, one prompt for concurrent
  refusals, cancel, wrong/empty proof, sign-in-again path, memory-only grants, per-action
  localised explanations), `p7-step-up-dialog.test.ts` (keyboard-only operation, associated label,
  `role="alert"` error, `aria-invalid`, focus trap, safe default focus),
  `p7-step-up-sign-in.test.ts`, `privacy-account-deletion.test.ts` (SSO-only deletion in Settings).
- E2E: the request fixture proves step-up like the client (`e2e/helpers/stepUp.ts`); the privacy
  suite asserts the export refusal and the one-proof unlock; the passkey spec answers the real
  step-up dialog from a restored session.

**Decisions made during implementation (all strengthen, none relax).**
- Every always-protected route runs *auth → its existing limiter → step-up*, so limiter accounting
  is exactly as before B2.
- Account deletion: a supplied password is always verified (a grant never makes a wrong one
  acceptable); the grant replaces the password only when none is sent — the SSO-only path. Settings
  shows SSO-only accounts (`hasPassword: false` in the own-user payload; only the fact, never the
  hash) a deletion flow without a password field.

**Design-decision contract.** *Problem:* a stolen session could take over, lock out, exfiltrate or
irreversibly delete (baseline: 10 attacks OPEN). *Architecture:* one server owner (`lib/stepUp.ts`),
one client owner (`client/js/core/step-up.ts`) behind the single HTTP owner; stateless scoped
grants; no new storage beyond two bounded counters. *Security:* domain-separated signing, scope /
account / level / `tokenVersion` checks, fail-closed counters, no IP / location / device input, no
score. *UX:* fresh sessions are never prompted; older sessions prove once per scope per 10 min;
ordinary moderation is never prompted. *Rollback:* `STEP_UP_DISABLED_SCOPES` per scope (logged), or
revert the B2 commits. *Follow-ups:* a dedicated invite-rate budget, after which an invite step-up
threshold can be measured and made reachable (SU-ATK-09).

## B3. Metadata minimization

Audit what Bridge stores/emits beyond message content.

For each retained metadata class record:

- why it is required;
- where it is stored;
- who can access it;
- retention;
- deletion/export behaviour;
- whether a less identifying representation works.

Logs/telemetry must not become a shadow social graph.

## B4. E2EE research and hardening

P7 does not make unsupported cryptographic claims.

Work includes:

- threat model for channel/DM E2EE;
- key lifecycle and multi-device implications;
- offline/local-cache interaction;
- backup/recovery implications;
- member removal/key rotation;
- metadata that E2EE cannot hide;
- compatibility with moderation/reporting;
- measured implementation gaps.

Only properties demonstrated by code/tests are labelled implemented.

## B5. Moderation tooling

Moderators need usable controls alongside abuse prevention:

- evidence-safe reporting;
- raid response actions;
- rate-limit/lockdown visibility;
- audit trail;
- expiry/reversal for temporary controls;
- permission-safe operation under multi-node deployment.

---

# Pillar C — Portable Identity & Community

## C1. User identity export

A user can export a documented, versioned package of portable account/community
data that Bridge is allowed to expose.

Design requirements:

- machine-readable schema;
- explicit version;
- integrity metadata;
- privacy-safe defaults;
- secrets/private cryptographic keys are not casually exported;
- user can understand included/excluded fields.

## C2. Community export

Server/community owners can export portable community structure subject to
permissions and privacy constraints.

Candidate portable structure:

- community metadata;
- channel/category topology;
- roles and permission intent;
- selected settings;
- emoji/sticker metadata where licence/ownership permits;
- moderation/configuration metadata where safe.

Member private data and message history require separate policy, consent and
authorization treatment.

## C3. Import / migration contract

Portability is not proven by producing a ZIP file.

P7 requires:

- schema validation;
- deterministic import mapping;
- id collision handling;
- dry-run/report mode;
- rollback on partial import;
- explicit unsupported-field report;
- source/target version compatibility rules.

P8's Matrix/IRC migration gateways build on these contracts rather than inventing
another migration format.

## C4. Lock-in test

Closure evidence must demonstrate that a representative user/community can export
from one Bridge instance and restore/import the supported portable subset into a
fresh target without manual database surgery.

---

# Pillar D — Database Scaling

## D1. PostgreSQL table partitioning

Partition only where measured table growth/query patterns justify it.

Before implementation record:

- current row counts/size;
- hot queries;
- index size;
- write/read distribution;
- retention characteristics.

Partition design must document:

- partition key;
- pruning evidence;
- unique/FK implications;
- migration path;
- rollback;
- zero/low-downtime operational plan.

No partitioning is accepted solely because the table is "large someday".

## D2. Ephemeral channels

Add channels/content with explicit expiry semantics.

Requirements:

- user-visible expiry policy;
- server-authoritative expiry time;
- background cleanup that is idempotent;
- local cache receives/persists tombstone/expiry state;
- attachments/search/vector indexes are cleaned consistently;
- audit requirements are explicitly separated from user-visible content;
- federation behaviour is defined;
- clock skew does not resurrect expired content.

## D3. Database migration safety

P7 DB work must be compatible with P9's zero-downtime goal.

Each migration includes:

- forward path;
- compatibility window where needed;
- rollback or roll-forward recovery;
- lock/runtime impact measurement;
- production preflight;
- backup/restore implications.

---

# Cross-pillar closure gates

P7 cannot close until the final evidence ledger marks every required item PASS or
explicitly classifies a genuinely external item without mislabelling it as PASS.

| Gate | Required result |
|---|---|
| Encrypted local persistence | canonical sensitive drafts/outbox/history do not rely on plaintext long-lived localStorage |
| Offline reload | cached authorized channel history opens without network |
| Offline send + reload | no lost/duplicate message; ackId identity preserved |
| Reconnect convergence | deterministic server-authoritative final state |
| Account switch | zero cross-account local-content exposure |
| Corrupt local DB | recoverable without a send loop or server data loss |
| Storage pressure | bounded eviction; pending writes never silently disappear |
| Local search | account/channel/deletion/E2EE boundaries enforced |
| Anti-spam/raid | measured attack scenarios blocked/mitigated with legitimate controls |
| Risk-adaptive security | documented signals, bounded retention, deterministic step-up tests |
| Metadata audit | retained metadata classes documented and minimized |
| E2EE | claims match measured implementation/threat model |
| User portability | versioned export + validation + representative restore/import proof |
| Community portability | supported topology/settings round-trip proof |
| PostgreSQL scaling | partitioning decision backed by measurements and regression benchmarks |
| Ephemeral channels | expiry converges across DB/cache/search/attachments/client |
| Rollback | each major storage/schema change has a tested recovery path |
| Quality Gate | green on final P7 PR head |
| Post-merge | required `main` checks green after P7 merge |
| Evidence | P7 closure ledger records commands, run ids, metrics and known limitations |

---

# P7 implementation order

1. Local storage contract, crypto/key threat model and corruption tests.
2. Encrypted draft migration.
3. Canonical outbox migration with unchanged `ackId` delivery semantics.
4. Offline history + local search + reconnect operation log.
5. Trust/Safety baseline attack lab; anti-spam/anti-raid and risk-adaptive controls.
6. Metadata minimization + E2EE threat-model/hardening work.
7. Portable user/community export/import contract and lock-in proof.
8. PostgreSQL growth measurements; partition only where justified.
9. Ephemeral-channel lifecycle and cross-cache/search cleanup.
10. Full benchmark, abuse, privacy, migration, mobile lifecycle and rollback evidence.
11. Final closure ledger, merge and post-merge verification.

---

# Frozen downstream phase order

These scopes are recorded now to prevent P7 scope drift. They are not P7
implementation tasks.

## P8 — Bridge Next-Generation Communication Engine

Goal: modernize network transport, media, gaming/voice and extensibility.

- QUIC / WebTransport evolution from WebSocket where justified and supported;
- connection migration / low reconnect targets measured across Wi-Fi ↔ cellular;
- AV1/VP9 SVC adaptive SFU;
- hardware encoding and zero-copy capture research/implementation with FPS/CPU
  evidence;
- anti-cheat-friendly out-of-process overlay;
- in-game SDK, proximity/radio voice;
- asynchronous voice, waveforms and local AI transcription;
- isolated WASM bot/plugin runtime with capability permissions;
- E2EE P2P file distribution with origin fallback;
- encrypted Community Relay research/implementation;
- official migration gateways such as Matrix/IRC built on P7 portability formats.

## P9 — Global Scale & Production Resilience

Goal: enterprise-grade large-scale resilience.

- multi-node architecture at sustained scale;
- global edge routing;
- Redis/PostgreSQL large-scale architecture;
- zero-downtime migrations;
- disaster recovery and PITR;
- soak/load testing with documented ceilings;
- real Android/iOS device verification;
- cellular-network labs;
- VoiceOver/NVDA accessibility lab.

## P10 — Social Platform Evolution & Ecosystem

Goal: build advanced social experiences after the communication substrate is
proven.

- explainable community/event discovery;
- user-controlled social graph;
- permission-aware Community Memory and AI-assisted indexing;
- music bots/shared playlists/social listening with legal provider boundaries;
- creator/community value-transfer tooling;
- advanced analytics.

P8, P9 and P10 remain blocked until the preceding phase is formally closed.
