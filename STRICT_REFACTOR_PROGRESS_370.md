# Strict Refactor Progress — 370 Remaining

This checkpoint continues the strict TypeScript cleanup from the previous 499-error package.

## Verified

```bash
npm run build
# PASS

npm run typecheck:server
# FAIL — 370 TypeScript errors remaining
```

## Progress in this checkpoint

Error count reduced:

```text
499 -> 370
```

Main fixes applied:

- Thread entity and thread route typing normalized.
- Thread message insertion paths now guard missing users.
- Thread tag parsing no longer treats strings as arrays.
- Admin route exports restored for `adminOnly` / `logAction` compatibility.
- Admin user global request type refined to the real `User` entity.
- Admin stats/log maps typed as `Record<string, number>` / structured objects instead of `unknown` buckets.
- Moderation route fixed for `JwtPayload` actor audit logging.
- Moderation timeout/body numeric parsing corrected.
- Member repository gained `setTimeout` and safer ban/unban compatibility signatures.
- Message repository `deleteUserMessages` supports date/number lower-bound filtering.
- Semantic search now uses typed maps, typed AI parse result, exported `EMBEDDING_PROVIDER`, and generic keyword search.
- Outgoing webhooks now use `OutgoingWebhook` entity typing, safe payload object wrapping, typed headers, and event parsing helper.
- Poll `options` normalized to `PollOption[]` and route body parsing improved.
- Federation delivery queue now validates stored payloads before retrying.
- `@types/qrcode` added to dev dependencies.

## Remaining large blocks

Top remaining strict typecheck areas:

- `server/socket/index.ts`
- `server/routes/federation/peers.ts`
- `server/routes/messages.ts`
- `server/routes/servers/invites.ts`
- `server/routes/bot-marketplace.ts`
- `server/routes/groupDm.ts`
- `server/routes/webauthn.ts`
- `server/plugins/loader.ts`
- federation ActivityPub helpers/routes

## Note

This package does not use a new blanket `ts-nocheck` strategy. The remaining errors are still visible in `npm run typecheck:server` and need continued targeted refactor work.
