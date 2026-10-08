# P7 B2 step-up lab

Measures, on a real two-node Bridge cluster (`NODE_ENV=production`, shared PostgreSQL + Redis —
the multinode harness in `../multinode/lib`), what a **stolen session** (a valid access token
without the person's credentials or in-memory grants) can do to high-risk actions, and what the
**legitimate person** experiences.

```
MN_MOTO_SERVER=moto_server node scripts/stepup-lab/run.mjs [--scenarios a,b] \
  [--out DIR] [--label NAME] [--gate] [--keep]
```

- **Baseline** (main before B2, ungated): every attack was `OPEN`; the legitimate scenarios
  measured the cadence that set the moderation-burst threshold (5 / 60 s / actor).
- **After B2** (`--gate`): fails if a legitimate control's experience differs from
  `expectations.json` (`OK` = never asked, `FRICTION` = exactly one proof, then the action
  continued), if any control is a `FALSE_POSITIVE`, or if an attack is weaker than its floor
  (`OPEN < STEPUP < BLOCKED`). The invite burst (SU-ATK-09) deliberately has no floor: invite
  step-up is deferred and the existing 10/min limiter stays the bound.

Outcomes: attacks `OPEN` / `STEPUP` (403 `STEP_UP_REQUIRED`) / `BLOCKED` (stopped outright, e.g.
the failed-proof lock); controls `OK` / `FRICTION` / `FALSE_POSITIVE`.

The simulated legitimate client behaves like `client/js/core/step-up.ts`: it keeps the grants its
sign-in returned (memory only), sends the grant for the action's scope in `X-Bridge-Step-Up`, and
on a refusal performs ONE proof (password, or TOTP / backup code for a 2FA account — real RFC 6238
codes against the account's real secret) and retries once. Proofs and retries go to the other
node, so grants minted on one node are verified on the other. A thief holds only the stolen access
token, and every simulated person has its own client address.

Rows: SU-ATK-01..07 always-protected actions; SU-ATK-08 compromised-moderator burst; SU-ATK-09
invite burst (deferred); SU-ATK-10 distributed proof guessing (new address + alternating node per
guess); SU-ATK-11 grant replayed after sign-out-everywhere; SU-ATK-12 the attacker's own grant;
SU-ATK-13 a grant for another scope. SU-LEG-01 ordinary moderation; SU-LEG-02 raid cleanup;
SU-LEG-03 invite organiser; SU-LEG-04 fresh sign-in; SU-LEG-05 older session; SU-LEG-06 2FA with
TOTP; SU-LEG-07 2FA with a backup code. SSO-only account deletion has no IdP in this harness; it
is covered by `server/tests/account-route-behavior.test.ts` (grant without password),
`server/tests/sso-deep-behavior.test.ts` (SSO handoff carries level-1 grants) and
`client/tests/privacy-account-deletion.test.ts` (Settings flow).

Measured numbers and the design live in `docs/P7_TRUST_SOCIAL_FOUNDATION.md` (§ B2).
