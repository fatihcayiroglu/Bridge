# Bridge strict refactor progress — 94 errors remaining

Checkpoint from strict refactor continuation.

## Verification

```bash
npm run build
# PASS

npm run typecheck:server
# FAIL: 94 TypeScript errors remaining
```

## Progress in this checkpoint

Started from the previous 184-error checkpoint and reduced server strict typecheck errors to 94.

Major cleanups in this pass:

- ActivityPub inbox handler object-id narrowing and federation signature request header typing.
- Onboarding route config/body/channel mappers.
- Server template row mapper and category parsing.
- Podcast admin middleware return flow and episode body parsing.
- AP-key backfill script DB/user typing.
- Friend route sender map and Social repository call compatibility.
- Email verification/reset token guards.
- Link preview route limiter and preview array typing.
- Client error payload guard.
- Group DM member/user id boundary typing.
- Roles route role-array normalization.
- Channel permission helper limiter keys and audit action labels.
- Channel permission override map typing and nullable bitmask guards.

## Current remaining hot spots

The largest remaining clusters are:

- server/routes/federation/helpers.ts
- server/routes/interactions.ts
- server/routes/serverMemberProfile.ts
- server/routes/sticker-packs.ts
- server/socket/handlers/messages-edit.ts
- server/routes/automod.ts
- server/routes/servers/core.ts
- server/routes/twoFactor.ts

## Notes

This checkpoint avoids adding global `ts-nocheck` suppression. Some narrow compatibility casts remain at integration boundaries, especially around legacy DB records and ActivityPub payloads.
