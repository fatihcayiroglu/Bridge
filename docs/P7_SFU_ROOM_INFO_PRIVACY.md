# Routine SFU room INFO privacy

Room creation and empty-room cleanup interpolated private channel/node IDs
directly into log messages. The normal ownership-loss INFO included channel
and owner-node fields. Pino also attached the ambient actor and socket. Five
actual-serialization unit controls reproduced the gap: two passed, three failed,
zero skips, including a background room without any request context.

These three routine events now reuse #436's `logRoutineMediaInfo` boundary.
The existing ownership-loss event remains, and room creation/cleanup gain fixed
event names. Messages are fixed; payload and ambient identities do not cross
the INFO boundary. The shared helper now owns eight event types.

Room ownership, native router calls, load tracking, timers, cleanup and
fail-closed behavior are unchanged. `RoomOwnedElsewhereError` still carries the
channel and owner-node IDs needed by the authorized routing protocol. Registry
release warnings and ownership-invalidated errors retain their existing
security context. No global logger, error or permission policy changes.

## Evidence and limits

- 193 focused SFU/registry/voice/privacy unit tests passed, zero skips. The
  five new controls capture actual Pino output and exercise real room-state
  transitions, the existing five-second abandoned-room deadline, occupied-room
  protection, routing rejection and release-failure recovery. Native routers
  and the registry are stubs in those unit controls; this is not RTP evidence.
- 39 real-service cases passed, zero skips: 28 PostgreSQL/Redis/Socket.IO media
  tests and 11 real Redis ownership/concurrency/recovery cases. The latter do
  not use PostgreSQL, and neither suite claims native SFU audio/video proof.
- Production, strict test and hardening typechecks plus server lint passed.
- The initial new-worktree validation lacked root development dependencies:
  the media suite could not load `socket.io-client` and types lacked `qrcode`
  declarations. That failed setup is preserved. After linking the identical
  installed root dependency tree, both complete checks passed; no dependency
  manifest or lock was modified.

Fresh full source-head Quality Gate, including real media, is still required.
This is a draft extension stacked on #436. P7 B3, #321, #209 and #416 remain
open; there is no production merge or release authorization.
