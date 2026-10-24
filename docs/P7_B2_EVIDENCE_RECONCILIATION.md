# P7 B2: evidence reconciliation (2026-10-24, `main` at `c061d72f`)

The closure ledger marks B2 "OPEN: evidence reconciliation". The B2 material
in `P7_TRUST_SOCIAL_FOUNDATION.md` is extensive, but nobody had re-checked it
against current `main` since it shipped. This document takes each B2
acceptance item, names its current runnable evidence, and records the result
of running that evidence **today** on `main` `c061d72f`. Where an item had
prose and nothing executable, this change adds the test
(`server/tests/p7-b2-signal-contract.test.ts`).

Runs referenced below:
- **Local:** this branch, i.e. `main` `c061d72f` plus the new test.
- **Step-up lab on `main`:** [run 40056408174](https://github.com/fatihcayiroglu/Bridge/actions/runs/40056408174)
  (`workflow_dispatch`, exact head `c061d72f`): `SUMMARY {"attacks":{"OPEN":1,
  "STEPUP":10,"BLOCKED":2},"controls":{"OK":3,"FRICTION":4,"FALSE_POSITIVE":0}}
  gate=pass`, identical to the post-B2 totals in the design doc. Before it,
  the last run on `main` was the weekly schedule of 10-20 on `b1a5ed38`.
- **Step-up lab on the D2 candidate** (#375, `6d9eeede`):
  [run 40049120987](https://github.com/fatihcayiroglu/Bridge/actions/runs/40049120987), pass.

## 1. Contract rules

| Rule | Evidence | Today |
|---|---|---|
| No opaque permanent "trust score" | `p7-b2-signal-contract` (**new**): the step-up owner (`lib/stepUp.ts`, `routes/stepUp.ts`) has no score, reputation or `riskScore`; its imports are a reviewed allowlist, so a new input source fails the test until reviewed | pass (9/9) |
| Risk inputs are documented | The design names five inputs: grant, action catalog, account factors, burst counter, failed-proof counter. `p7-b2-signal-contract` checks the code uses exactly those: `Users.findById` reading `password` / `twoFactorEnabled` / `tokenVersion`, `countInWindow`, the failed-proof cache counter, the `x-bridge-step-up` header | pass |
| Sensitive attributes are not inferred | `p7-b2-signal-contract`: no client IP (`req.ip`, `x-forwarded-for`, `remoteAddress`), user agent, `sec-ch-ua`, `accept-language`, geo/country/timezone, and no `checkSuspiciousLogin` (the fingerprint-like signal B3 owns); only one request header is read | pass |
| Signals have retention bounds | `p7-b2-signal-contract`: the defaults are a 10 min grant, a 60 s burst window and a 15 min failed-proof window. Configuring any of them past its cap (1 h, 1 h, 24 h) makes the server refuse to start. Both counters expire with their window, and the step-up owner writes nothing to the database. Grants are never stored server-side (`p7-step-up-core`) | pass |
| Step-up decisions are explainable | Refusal is `403 STEP_UP_REQUIRED` with a closed `reasons[]` set, the action, its `why`, level, methods and TTL (`p7-step-up-core`, `p7-step-up-route-matrix`). The client gives a localised reason per action (`p7-step-up-client`), and `check:i18n` reports 10/10 locales in parity | pass |
| Accessibility and recovery escape paths are tested | `p7-step-up-dialog`: keyboard-only, labelled input, `role="alert"`, `aria-invalid`, focus trap. Escape paths: sign in again, a backup code (L2), the unchanged e-mail password reset, the failed-proof lock never blocking sign-in (`p7-step-up-proofs`, lab SU-ATK-10), SSO-only account deletion (`privacy-account-deletion`) | pass |

## 2. Protected actions

Every action in `STEP_UP_ACTIONS` has a route call site on `main`:

| Category | Actions → route |
|---|---|
| Account security | `email.change` (email.ts), `passkey.add` / `.remove` (webauthn.ts, begin + complete + delete), `two_factor.enable` / `.disable`, `backup_codes.regenerate` (twoFactor.ts) |
| Sensitive export | `account.export` (account.ts ×3, servers/core.ts) |
| Irreversible | `account.delete` (account.ts), `server.delete` (servers/core.ts), `admin.user.delete` / `admin.server.delete` (admin/users.ts) |
| Destructive moderation (after 5 / 60 s) | `moderation.ban`, `moderation.kick` (moderation.ts, roles.ts), `messages.bulk_delete` (messages.ts) |
| Mass invite | **deferred** by approved decision (B2 design); the 10/min limiter stays the bound; lab SU-ATK-09 OPEN by design |
| Suspicious new session | covered by the grant and the failed-proof lock |
| Added later (C4) | `account.import` (account.ts, servers/portable-*.ts) |

## 3. Closure evidence items (design § "Evidence required for B2 closure")

| # | Item | Evidence | Today |
|---|---|---|---|
| 1 | Baseline lab, before implementation | label `baseline-5e84283`: 10 attacks OPEN, 4 controls OK (recorded in the design doc) | historical, not re-runnable on purpose |
| 2 | The same lab after, gated by `expectations.json` | `scripts/stepup-lab`, `.github/workflows/stepup-lab.yml` (two nodes, PostgreSQL, Redis) | `main` run 40056408174: **gate pass**, 10 STEPUP / 2 BLOCKED / 1 OPEN (SU-ATK-09, approved deferral); 3 OK / 4 FRICTION / 0 FALSE_POSITIVE. SU-ATK-08: 5/40 bans landed, first refusal at request 6. Candidate #375: pass |
| 3 | Unit + route matrix | `p7-step-up-core`, `-proofs`, `-proof-limits`, `-route-matrix`, `-moderation-burst` | **129/129** locally |
| 4 | Client: interception, one prompt, cancel, memory-only, i18n, dialog a11y | `p7-step-up-client`, `-dialog`, `-sign-in`, `privacy-account-deletion`; `check:i18n` | **73/73** locally; i18n 10/10 locales, parity PASS |
| 5 | Typecheck, coverage, CI; design-decision contract; rollback | Quality Gate on every PR; contract in the design doc; rollback `STEP_UP_DISABLED_SCOPES` (tested in `p7-step-up-core`) | green on the current PRs |

## 4. Open questions for the owner (not regressions)

1. **Channel expiry (D2) and channel deletion are not in the step-up catalog.**
   `PUT …/channels/:cid/expiry` (D2 candidate) is owner-only and can be
   cleared until it fires, but a stolen owner session could set the minimum
   1-hour lifetime on a channel full of history. Channel deletion is
   immediate, available to `MANAGE_CHANNELS`, and also unprotected. Both are
   consistent with the approved catalog, which lists server deletion but not
   channel deletion. Adding them (to `destructive-admin`) is a product
   decision.
2. **The invite step-up is still deferred** (SU-ATK-09). The approved
   follow-up is a dedicated invite-rate budget, then a measurable threshold.
3. **`account.import`** (C4) shows the generic step-up explanation rather
   than its own. No client UI calls that route today, so only API clients see
   it. Give it its own string when a UI is added.

## Result

B2 is **implemented and its evidence is current**. Every contract rule now has
executable evidence. The two prose-only rules (no inferred attributes; bounded
retention) are now enforced by a test, and that test fails under five
mutations: a user-agent read, a client-IP read, importing the suspicious-login
fingerprint, a counter without a TTL, and a durable write. The items in § 4
are owner decisions, not defects.
