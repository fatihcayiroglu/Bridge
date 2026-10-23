# D2 — stale client responses after access loss

The authorized channel list cleared AppState's selection when its open channel
disappeared, but emitted no selection event if there was no next visible
channel. MessageLoader also ignored an explicitly null selection. Its internal
channel id, request generation and socket-room state could outlive access.

Three negative controls failed before the correction: the real list component
emitted no clear notification; a delayed successful history response restored
the expired channel's content after local purge; and a delayed socket message
was accepted while reconnect could rejoin the old room. The backend's expiry
guards cannot retract responses already in transit.

The list now emits the existing `bridge:channel-selected` event with an explicit
null id when authorized selection is lost. MessageLoader advances its existing
request generation, clears its internal selection/live reconciliation, leaves
its socket room, and clears typing/loading/offline state. Delayed REST bodies,
cached hydration and pagination use the same existing generation guard; socket
admission and reconnect see no active channel. Ordinary notifications without a
channel id keep their existing meaning. Selecting another authorized permanent
channel continues to load and persist its history.

Focused component verification passes 62 tests, including the three reproduced
negative controls and a permanent-channel compatibility control. Strict client
and bridge typechecks, Svelte diagnostics (zero errors/warnings), and client
lint pass. Full client coverage and final-commit CI are separate required gates;
their actual results belong on the review PR. No server authorization, migration,
Android source, coverage threshold or test assertion is weakened.

This branch follows #368 and does not include #365's native encryption adapter.
Human review, final integration/mobile checks and post-merge verification remain
required. Issue #321 remains open.
