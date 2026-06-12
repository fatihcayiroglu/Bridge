# Bridge strict TypeScript refactor progress

This package is a real-refactor progress snapshot, not a `ts-nocheck` suppression build.

## Verification

- `npm run build`: PASS
- `npm run typecheck:server`: FAIL, 886 remaining strict TypeScript errors

## Error count trajectory

- Starting strict server errors in this pass: 1556
- After real refactor patches: 886
- Net reduction in this pass: 670 strict errors

## Main changes

- Strengthened PostgreSQL collection API (`PgCollection`) with typed insert/update/remove/count/insertMany signatures.
- Added missing and observed entity fields to repository entity declarations, including E2EE/WebAuthn/ActivityPub/server-profile fields.
- Converted many route-param reads from unsafe Express 5 param unions to explicit string normalization.
- Fixed several repository method signatures that were typed as `string` or implicit `any` despite accepting filters/documents.
- Added missing `dompurify` and `@types/jsdom` dependencies.
- Fixed build-level router/import issues and excluded legacy documentation-only admin IP-ban route from strict compile.
- Reduced large classes of noUncheckedIndexedAccess and Express 5 `Params` union errors without adding `ts-nocheck`.

## Remaining largest categories

- Express route handlers with nullable repository results and untyped request bodies.
- WebAuthn credential payload typing still partially incomplete.
- Federation ActivityPub object typing.
- Socket.IO authenticated socket state typing.
- Redis adapter/client wrapper typing.
- Legacy repository methods still using implicit `any` or broad `Record<string, unknown>`.

## Important note

This is still not production-ready strict TypeScript. It is a cleaner baseline than the previous audit package, but `typecheck:server` still fails and must not be represented as fully type-safe.
