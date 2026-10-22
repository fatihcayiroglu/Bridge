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

## Local-first copies (offline clients)

`client/js/core/local-first/channel-reconcile.ts`: after every **authorized**
channel-list load for a server (the `channel:expired` reload, the first load
after reconnecting from an offline window, a permission change), the encrypted
history snapshots and queued outbox sends of that server's channels that the
list no longer contains are deleted. Before, they survived until the user
re-opened the channel and got a 404, so offline search kept returning expired
content and its queued sends kept waiting. A snapshot is attributed to the
server only through its cached messages' `serverId`; other servers, DMs and
empty snapshots are never touched. Evidence:
`client/tests/local-first-channel-reconcile.test.ts` (pure decision and a run
against the real encrypted history runtime: the expired channel's text is gone,
live and foreign copies stay).
Drafts are purged the same way: the user's unsent text for a vanished channel,
in the encrypted draft store and in the legacy plaintext store (a draft written
before encryption and never migrated because the channel was not reopened).
Drafts of other servers that reuse the same channel id are untouched (draft
records are scoped by server). Evidence: the same test file, against the real
encrypted draft runtime and localStorage.
Not covered: an offline client that never loads that server's list again keeps
its copies until it does (it cannot learn about the expiry otherwise).

## Live room members are evicted

After announcing a claim, the job calls
`evictSocketsWithoutChannelAccess(io, serverId, channelId, { channelGone: true })`:
every socket in the channel's text, voice and thread rooms leaves them on every
node, live voice sessions are evicted and the socket receives
`channel:access-revoked` with the channel id (it already knew it). The normal
permission re-check is skipped because the claimed row still resolves while it
drains. Typing relays and voice never touch the database, so the write barrier
alone would not have stopped them. Evidence: `live-voice-access-revocation.test.ts`
(channelGone evicts text and voice rooms although VIEW still resolves; other
channels untouched; control without the flag) and `jobs-channelExpiry.test.ts`
(the job evicts only with a full socket server). Re-joining is refused by the
admission checks of #354.
