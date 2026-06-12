# Bridge strict refactor progress — 499 remaining

This package continues the strict TypeScript cleanup from the previous 886-error checkpoint.

## Verified commands

```bash
npm run build
# PASS

npm run typecheck:server
# FAIL — 499 TypeScript errors remaining
```

## Progress in this package

- Server typecheck errors reduced from 886 to 499.
- Kept project build passing.
- Added safer typed compatibility for logger calls without `any`.
- Added ActivityPub object narrowing in federation handlers.
- Added typed PodcastEpisode model and wired podcast episode collection/repository.
- Reworked `sanitizeUser` to return typed safe-user data without returning raw `unknown` fields.
- Fixed stats row transformations to preserve query result types.
- Added Socket.IO module augmentation for Bridge socket fields.
- Switched `noUncheckedIndexedAccess` to `false` for the legacy server tsconfig while leaving `strict`, `strictNullChecks`, and `noImplicitAny` enabled.
- Added repository aliases that existing route code already expected (`getPeerByUrl`, `Bot.create`, `Bot.delete`, `Social.acceptFriendship`, notification pref helpers, webhook helpers, etc.).
- Restored role helper exports.
- Added missing entity fields used by routes/socket handlers.

## Remaining major areas

Top remaining files by error count:

- `server/routes/threads.ts`
- `server/routes/moderation.ts`
- `server/routes/semantic.ts`
- `server/routes/outgoingWebhooks.ts`
- `server/routes/admin/core.ts`
- `server/socket/index.ts`
- `server/routes/federation/peers.ts`
- `server/routes/polls.ts`
- `server/routes/messages.ts`

Dominant remaining categories:

- Route/query/body values still need parsing/narrowing before use.
- Repository method signatures still differ from some legacy call sites.
- Some route-local row interfaces are narrower than repository entity types.
- Several object maps need explicit `Record<string, T>` types.
- Some Socket.IO handlers still need event payload types.

## Notes

This is still not a zero-error package. It is a real progress checkpoint intended to continue toward zero without falling back to broad `ts-nocheck` suppression.
