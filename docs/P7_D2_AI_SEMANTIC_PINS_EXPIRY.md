# P7 D2 — AI, semantic, pins and crosspost expiry

Stacked on the Search/Saved/Inbox change (#355); uses its authoritative
batch check (`liveChannelIdsForRead`, `liveChannelSet`).

An expired channel stays in the database until the expiry worker claims it
(normally within a minute; never, for a server's last live channel). These
surfaces read channel content directly, so each now asks PostgreSQL whether
the channel is live before reading:

| Surface | Change |
|---|---|
| `POST /api/semantic/search` (fresh and cached) | `liveReadableChannelIds` = VIEW_CHANNELS + READ_HISTORY ∩ live, before ranking, pgvector and AI |
| `GET /api/semantic/digest/:serverId`, `/engagement/:serverId` | same filter for every aggregate and excerpt |
| `readChannelForAi` (AI ask/stream/clyde) | 404 when not live, 503 when unverifiable |
| `GET /api/ai/summarize/:channelId`, `/suggest-reply/:channelId` | 404 when not live |
| `POST /api/ai/moderate` | 404 when the message's channel is not live |
| `GET /api/channels/:cid/pins`, `/files` | 404 when not live |
| `POST /api/channels/:cid/messages/:mid/crosspost`, `/follow` | 404 when the source is not live, so expired content is never republished into live channels |

Helpers in `server/lib/channelLiveReadSet.ts`: `liveReadableChannelIds`,
`channelRecordIsLive`, and `channelAvailabilityErrors`. That last one is the
router error middleware that turns `ChannelAvailabilityUnverifiable` into
503, mounted on the semantic, AI, pins and announcement routers.

Out of scope: moderation report evidence (B5 #345, owner policy), translate
(it takes caller-supplied text, not channel content), and push (no new
content can be written to an expired channel).

Known window: crosspost checks the source just before fan-out. A source that
expires during fan-out can still finish that one publish. The write barrier
guards targets, not sources.

## Evidence

`server/tests/pg-integration/ai-semantic-pins-expiry.pgtest.ts` (6 cases,
all failing without this change):

- semantic search, both fresh and from a cached answer, plus a search scoped
  to the expired channel;
- digest and engagement;
- AI context reads, summarize, suggest-reply and moderate;
- pins and files;
- crosspost and follow from an expired announcement channel;
- a tombstoned id that still has a channel row.

Unit: `channel-live-read-set.test.ts` (16), plus 441 existing AI, semantic,
pins and announcement unit tests unchanged.
