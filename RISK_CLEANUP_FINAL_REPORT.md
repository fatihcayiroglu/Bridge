# Bridge v3.2 — Risk Cleanup Final Checkpoint

This checkpoint continues from `bridge_v3-2_final_stabilized.zip` and focuses on the remaining risky legacy test/runtime areas instead of suppressing TypeScript.

## Verified commands

```bash
npm run build          # PASS
npm run typecheck      # PASS
npm run lint           # PASS: 0 errors, 963 warnings
npm audit --omit=dev   # PASS: 0 production vulnerabilities
```

## Important remaining note

`npm run lint` exits successfully and has **0 errors**, but the legacy server code still emits **963 warnings**, mostly `no-unused-vars` in old route/test/helper declarations and `.d.ts` compatibility files. `@typescript-eslint/no-explicit-any` warnings were removed from project code in this pass.

The full Jest suite is very large and still exceeds the execution window in this environment when run as a single command. The risk-oriented suites below were run directly and pass after the fixes.

## Risk/test blocks fixed and verified

These suites were run directly and passed:

- `tests/federation-peers-inbox.test.ts` — PASS, 38 tests
- `tests/plugins.test.ts` — PASS, 55 tests
- `tests/channelPermsIntegration.test.ts` — PASS, 39 tests
- `tests/sprint83-smoke.test.ts` — PASS, 22 tests
- `tests/pushSender-integration.test.ts` — PASS, 18 tests
- `tests/storageAdapter.test.ts` — PASS, 33 tests
- `tests/serverEvents.test.ts` — PASS, 22 tests
- `tests/discover-sort-members.test.ts` — PASS, 12 tests
- `tests/bridge9.test.ts` — PASS, 23 tests
- `tests/servers.test.ts` — PASS, 38 tests
- `tests/pgvector.test.ts` — PASS, 25 tests
- `tests/ipReputation.test.ts` — PASS, 35 tests
- `tests/users.test.ts` — PASS, 6 tests
- `tests/twoFactor.test.ts` — PASS, 7 tests
- `tests/socket-contract.test.ts` — PASS, 3 tests
- `tests/mediasoup-scaling.test.ts` — PASS, 15 tests
- `tests/bridge11.test.ts` — PASS, 19 tests
- `tests/upload.test.ts` — PASS
- `tests/polls.test.ts` — PASS
- `tests/vault.test.ts` — PASS
- `tests/bridge10.test.ts` — PASS

A batch containing these also completed those suites as PASS before the environment timeout: `stage`, `messages-send`, `plugins-sandbox`, `ai-extended`, `voice`, `music-routes`, `music-branch-coverage`, `music`, `serverTemplates`, `channelPermsAdvanced`, `activitypub-c2s`, `apns`, `stage-socket-extra`, `socket-contracts`, `messages-edit`, and `activitypub`.

## Notable production-risk fixes in this pass

- Fixed `X-Forwarded-For` trusted-proxy client IP resolution in `middleware/ipBan.ts`.
- Prevented local storage adapter from deleting original local files when `deleteLocal=true` in local provider mode.
- Hardened `/upload/cdn` ownership tests against the actual loader boundary.
- Kept refresh tokens stored hashed with `REFRESH_SECRET`; updated legacy tests to verify hashed storage instead of raw-token storage.
- Fixed poll vote semantics: invalid options now return 400, single-choice repeated vote toggles off, multi-choice votes toggle selected options.
- Fixed Vault logger compatibility and made `_resetConfig()` clear secret cache for test/dev correctness.
- Added ActivityPub JSON parser compatibility for C2S content types.
- Added network-safe fetch mocks in legacy link-preview tests, preserving private-host blocking.
- Removed remaining explicit-any lint warnings in project code.
- Added `.unref()` for SFU scaling/room refresh intervals to reduce lingering process handles.

## Remaining cleanup opportunities

- Reduce the remaining 963 lint warnings, mostly unused variables and legacy compatibility declarations.
- Split the 154-file Jest suite into CI shards so it can complete reliably without environment timeouts.
- Continue replacing legacy CommonJS compatibility shims with native ESM/test imports once tests are modernized.
