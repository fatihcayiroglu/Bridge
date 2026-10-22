# P7 D2: thread reads and new content subscriptions

The thread/forum HTTP read routes and new socket room subscriptions use the
same live PostgreSQL expiry preflight as channel message reads. The shared
availability helper checks the canonical channel/tenant and durable tombstone
with the database clock. It does not grant membership or permissions.

The existing membership and channel permission checks still run. HTTP thread
details, thread replies and forum listings return 404 when their parent channel
is unavailable, or 503 when the database check cannot complete. New
`thread:join` and `channel:join` requests are denied before room membership
changes when the lifecycle check fails.
Leaving a pending channel selection or selecting a newer channel invalidates
the older asynchronous join, so it cannot later restore an unwanted room.

The content-producing thread creation and reply routes also check before
deriving a title from a stored parent message, returning an existing thread on
conflict, or returning a stored reply for a client-nonce retry. This is a
preflight before those writes and replay responses, not a transactional write
barrier.

Legacy unit mocks without a PostgreSQL pool must supply a matching canonical
parent channel. Production requires PostgreSQL and fails closed without it.
This avoids treating a thread's missing expiry columns as evidence that its
parent channel is permanent.

## Remaining D2 work

These checks have the same check-to-response and check-to-join race as #352.
They do not remove sockets that subscribed before expiry, stop later room
broadcasts, enforce writes atomically or clean up content. Existing subscribers
require delivery/eviction enforcement as part of the complete lifecycle.

Search, saved/inbox previews, other readers, transactional writers, workers,
offline caches and federation remain open under #321. Public ephemeral-channel
creation remains disabled. These preflights do not establish D2 closure.
