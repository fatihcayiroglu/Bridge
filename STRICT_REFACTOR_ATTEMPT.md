# Strict Type-Safety Refactor Attempt

This package contains a strict type-safety refactor attempt that avoids the previous blanket `@ts-nocheck` approach.

## What was changed

- Added missing runtime/type dependencies at the root package level:
  - `cookie-parser`
  - `@types/express`
  - `@types/cookie-parser`
  - `@types/pg`
  - `@types/uuid`
  - `@types/jsonwebtoken`
  - `@types/multer`
  - `@types/nodemailer`
  - `@types/web-push`
  - `@types/swagger-jsdoc`
  - `@types/swagger-ui-express`
- Fixed PostgreSQL collection construction in `server/db/postgres/index.ts`.
- Refactored `server/db/postgres/pgCollection.ts` toward a generic typed collection boundary.
- Typed `server/db/loader.ts` known collections with domain entity types instead of leaving every collection as raw `Record<string, unknown>`.
- Added Express request augmentation for Bridge-specific request properties.
- Build still succeeds.

## Verification

```bash
npm run build
# PASS

npm run typecheck:server
# FAIL — 1556 strict TypeScript errors remain
```

## Remaining state

The project still needs a large real refactor across routes, socket handlers, and repositories. The largest remaining categories are:

- Express route params/query/body narrowing
- Repository method signatures with wrong `string`/object query types
- Domain entity fields that do not match real runtime DB rows
- ActivityPub/federation payload typing
- WebAuthn payload typing
- Request user/auth assumptions
- Legacy code that treats unknown DB data as typed objects

## Important note

A true production-ready strict refactor is not just a compiler suppression pass. It requires method-by-method route and repository typing work. This package intentionally does not mass-add `@ts-nocheck` to hide errors.
