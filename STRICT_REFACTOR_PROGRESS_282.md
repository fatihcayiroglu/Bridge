# Bridge strict refactor progress — checkpoint 282

Goal: reduce strict TypeScript server errors toward zero without using global `ts-nocheck`.

## Verification

- `npm run build`: PASS
- `npm run typecheck:server`: FAIL, 282 TypeScript errors remaining

## Progress in this checkpoint

Previous checkpoint: 370 server strict errors.
This checkpoint: 282 server strict errors.

Additional strict errors removed: 88.

## Main changes

- Normalized `sanitizeUser` to accept strict object/domain entities without requiring broad record index signatures.
- Added safer socket user boundary object in `server/socket/index.ts` so handlers receive normalized display/avatar/id values.
- Improved Socket.IO voice and DM handler typing.
- Added Redis cache `_client()` accessor for legacy DM rate limiting while keeping cache API typed.
- Added missing `server/db/connection.ts` compatibility adapter for notification-pref extension.
- Added Mediasoup ambient module stub for optional deployment dependency typing.
- Improved repository parameter typing and DB helper return shapes.
- Added missing entity fields used by runtime code.
- Fixed several Svelte/server build blockers while preserving `npm run build` success.

## Remaining largest strict error clusters

- `server/routes/federation/peers.ts`
- `server/routes/messages.ts`
- `server/routes/webauthn.ts`
- `server/routes/servers/invites.ts`
- `server/routes/bot-marketplace.ts`
- `server/routes/admin/federation-acl.ts`
- `server/plugins/loader.ts`
- `server/routes/serverTemplates.ts`
- `server/routes/groupDm.ts`
- `server/routes/federation/activitypub.ts`

## Important note

This is not zero yet. It is a quality-preserving checkpoint that keeps build passing and reduces strict server type errors to 282. The project still needs route/federation/socket-specific strict typing work before it is production-ready under full TypeScript checks.
