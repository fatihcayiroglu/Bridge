# P7 D2: telling clients when a channel expires

Stacked on the expiry API (#358) → worker (#357) → write barrier (#356).

## Server

- **Listing hides expired channels at once.** `GET /api/servers/:sid/channels`,
  `GET /:cid` and `PATCH /:cid` treat a channel whose `expiresAt` has passed as
  gone, before the worker removes the row. This is metadata only, so the app
  clock is used. Content reads keep the authoritative PostgreSQL preflight.
  Corrupt expiry metadata hides the channel, so this fails closed. The filter
  runs after the 30 s list cache, so a cached list is filtered too. The expiry
  API invalidates that cache whenever it changes `expiresAt`.
- **The worker announces each claim.** After the claim commits,
  `jobs/channelExpiry.ts`:
  1. invalidates the channel list cache and the first-page message cache;
  2. emits `channel:expired { serverId }` to `server:<serverId>`.

  The payload carries no channel id, because members who cannot see a private
  channel must not learn its id. Each channel is claimed by exactly one node,
  so each is announced once. With the Redis adapter the event reaches every
  node. A failed announcement is logged and never undoes or repeats the claim.

## Client

`channel:expired` joins the access events in `channel-list/access-revocation.ts`.

- If the user is looking at that server, the channel list reloads. The reload
  lets go of the open channel when it is no longer in the list (the existing
  `activeChannelSurvives` rule).
- After a successful, current reload, the client shows a "This channel has
  expired." toast, but only if the channel that disappeared was the one the
  user had open (`openChannelExpired`). New key `channel_expired` in all
  10 locales.
- Sending to a channel that is already gone still ends in the terminal
  `CHANNEL_NOT_FOUND` error from the write barrier.

## Evidence

- **Real PG** (`channel-expiry-config.pgtest.ts`, new case):
  1. the API sets the expiry and the list shows the channel;
  2. once the app clock passes `expiresAt`, the list, `GET /:cid` and
     `PATCH /:cid` hide it while a sibling stays visible;
  3. after the database clock passes, the job claims it and emits exactly
     `channel:expired { serverId }` to that server's room;
  4. the row is gone once cleanup converges (the claim keeps it while the
     graph drains; a small channel converges in the same tick).

  Removing the list filter fails this case.
- **Unit:** `jobs-channelExpiry.test.ts` covers ordering, the payload,
  continuing after one announcement fails, and running without a socket server.
- **Client:** `access-revocation.test.ts` has 3 new cases.

## Every channel listing, not only the main list

`ChannelRepository.findByServer` itself omits expired channels (and fails
closed on corrupt expiry metadata). Since the expiry claim now keeps the row
until its graph is drained, this stops the draining row's metadata reaching
portable export / import fingerprints, the role permission editor, server
stats, health, channel activity and automod exemptions; portable export can no
longer copy an expired channel into another server as a permanent one.
Evidence: `channel-repository-coverage.test.ts` (permanent/active kept,
expired and corrupt hidden) and `channel-expiry-worker.pgtest.ts` (the claimed
row is absent from `findByServer` while it drains).
