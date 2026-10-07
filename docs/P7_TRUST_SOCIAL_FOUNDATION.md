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

### B2 design (proposed — no production code until approved)

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

**Step-up levels.** L1 = a recent password proof or a fresh sign-in. L2 = a recent second factor
(TOTP or a backup code) or a sign-in that included one (2FA or passkey). *Required level* = L2 if
the account has 2FA enabled, otherwise L1 — so step-up is never weaker than the account's own
sign-in.

**Grant.** Short-lived proof `{sub, v (tokenVersion), lvl, amr, exp}` signed with a key *derived*
from `JWT_SECRET` and its own audience, so it never verifies as an access token and vice versa.
`tokenVersion++` (sign-out everywhere, password change/reset, 2FA change) revokes all grants. The
client keeps it in memory only (P7 rule D), sends it as `X-Bridge-Step-Up`.

**Obtaining a grant (reusing each credential's existing verifier).** `POST /api/step-up/password`
(new, L1; refused for 2FA accounts), `POST /api/2fa/step-up` (TOTP/backup code with the existing
replay protection, L2), and every sign-in response (password, 2FA, passkey, SSO) carries one —
"sign in again" is the escape path that always exists. Proof attempts use the existing
`limits.twoFactor()` budget plus a per-account `failed_proofs` lock (5 in 15 min → step-up locked
for that account for the window; sign-in and existing sessions are unaffected; structured
`step_up.locked` event).

**Protected actions (first implementation).**

| Category | Actions | When |
|---|---|---|
| Account recovery / security | e-mail change; passkey add (begin + complete) and remove; 2FA enable (setup + verify), disable, backup-code regeneration | always |
| Sensitive export | account export | always |
| Irreversible | account deletion (grant **or** existing password; SSO-only accounts use a grant), owned-server deletion, instance-admin user/server deletion | always |
| Destructive moderation | bans, kicks (both routes), bulk message delete | after a burst: more than 10 per actor per 60 s |
| Mass invite | invite creation | after a burst: more than 10 per actor per 60 s |
| Suspicious new session | any of the above from a session without a recent proof; repeated failed proofs | covered by the grant + `failed_proofs` lock |

Existing inline checks stay (password on 2FA disable / regenerate / account deletion; TOTP on
`DELETE /api/2fa`) — the guard adds to them and never replaces a stronger one.

**User-facing contract.** Refusal is `403 { error: 'STEP_UP_REQUIRED', action, reasons[], why,
level, methods[], ttlMs }` — never 401 (the client treats 401 as an expired session). `reasons`
is a closed set (`step_up_missing | _expired | _invalid | _revoked | _other_account | _level |
moderation_burst | invite_burst | step_up_locked`); `why` is the action's plain-language reason.
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
