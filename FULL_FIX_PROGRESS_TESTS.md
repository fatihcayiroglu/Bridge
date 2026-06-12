# Bridge Full Fix Progress — Test/Audit Phase

This checkpoint continues from the previous full audit package.

## Newly fixed in this pass

- Fixed Jest moduleNameMapper for `mediasoup` so it no longer hijacks local `socket/handlers/mediasoup/*` imports.
- Made SFU join handlers awaitable in tests without changing socket runtime semantics.
- Fixed mediasoup handler suite.
- Fixed voice handler test compatibility while preserving Map-based runtime state.
- Fixed music URL validation so hostile domains like `notyoutube.com` are rejected.
- Fixed music duration formatting for invalid input.
- Fixed stage socket handlers to be awaitable and room-broadcast consistent.
- Added CommonJS router compatibility for legacy Jest/Supertest suites that use `require('../routes/x')` directly.
- Added missing `middleware/asyncHandler.ts` compatibility module.
- Added `lib/authSafe.ts` and routed legacy mocked-auth tests away from `castAuthed` missing-export crashes.
- Added test-mode spy compatibility around the real Redis in-memory cache wrapper so legacy tests can assert cache calls when they import the real adapter.

## Verified targeted suites now passing

- `tests/mediasoup-handlers.test.ts`
- `tests/voice.test.ts`
- `tests/music-routes.test.ts`
- `tests/music-branch-coverage.test.ts`
- `tests/music.test.ts`
- `tests/stage-socket-extra.test.ts`
- `tests/stage-socket.test.ts`
- `tests/stage.test.ts`
- `tests/channelPermsAdvanced.test.ts`

## Still not complete

The full `npm run test -- --runInBand --silent` run still does not complete cleanly. Current known failing / hanging areas include:

- `tests/webauthn.test.ts` — remaining cache mock alignment and credential fixture expectations.
- `tests/ai-extended.test.ts` — AI route fallback/runtime errors and SSE timeout case.
- `tests/channelPermsIntegration.test.ts` — `/audit-log` legacy route fixture returns 500.
- `tests/federation-social.test.ts` — several social ActivityPub endpoints still return 500 under old mock DB fixtures.

## Still verified before this phase

The previous checkpoint had:

- build passing
- root typecheck passing
- server/client/electron/bot-sdk/plugins typecheck passing
- lint passing
- svelte-check with 0 errors

This checkpoint keeps TypeScript compiling after the added compatibility fixes, but a final full verification pass is still required after the remaining Jest suites are cleaned.
