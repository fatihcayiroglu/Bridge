# Bridge strict refactor progress — server zero checkpoint

## Verification

- `npm run build`: PASS
- `npm run typecheck:server`: PASS, 0 TypeScript errors

## Progress in this checkpoint

Started from the previous 94-error server checkpoint and fixed the remaining server-side strict TypeScript errors without reintroducing blanket `ts-nocheck` suppression.

Main areas fixed:

- Automod config parsing and null checks
- Bot/webhook repository compatibility signatures
- Channel permissions import/export/index access typing
- Channel/forum tag JSON parsing
- Federation delivery and ActivityPub helper typing
- Interactions route bot/message DTO narrowing
- Server invite/OG image/query param typing
- Server asset upload filters and permission guards
- Sticker pack route auth/param handling
- Two-factor secret/backup parsing guards
- WebAuthn embedded credential normalization
- Webhook token narrowing and safe comparison
- DM read marker shape and DM repository compatibility method
- Mediasoup optional dependency typing
- Message edit/reaction normalization
- WebSocket connection limit handshake casts

## Important scope note

This checkpoint proves the server strict typecheck is clean. The full root `npm run typecheck` still continues into client/electron/bot-sdk/plugin checks. Client legacy files such as `client/js/admin.ts`, `client/js/webauthn.ts`, `client/js/webrtc.ts`, and `client/js/webrtc-sfu.ts` still need a separate strict-client refactor pass.

Recommended next target:

```bash
npm run typecheck:client
```

Then fix the client-side strict errors in the same incremental way.
