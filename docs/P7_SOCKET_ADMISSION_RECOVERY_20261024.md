# P7 socket admission and lifecycle recovery

Status: client defects reproduced and corrected; native acceptance remains open.
This does not close #209, #321, I07 or P7, and authorizes no production merge.

## Preserved handoff

The owner authorized taking over Claude's unfinished work on 2026-10-24.
The original dirty worktree remains unchanged. Its tracked binary patch,
status, untracked-file inventory and base commit were saved before applying
only the SocketManager source patch in an isolated worktree. Patch SHA-256:
`0433c587f59f058e00f9edc57b51090aa45d3de986cd2f895414ca9aac793ca6`.
Generated assets and Android manifest changes remain preserved separately.
Authentication recovery is completed separately with its handed-off tests; see
[P7 offline bootstrap recovery](P7_OFFLINE_AUTH_RECOVERY_20261024.md).

## Reproduced behavior

Mounted SocketManager regressions fail against #409's original `03aa5235`:

- Disconnect before admission still permits a queued readiness announcement.
- Queued callbacks from a replaced socket affect the new account's connection.
- A successful late refresh tears down the new account's connection.
- A failed late refresh logs out the new account.
- A successful refresh after component destruction reconnects without an owner.

The original code passes four preexisting behavior tests and fails all five
new cases. The handed-off cancellation, listener removal and generation fence
correct these paths. Test transports now implement the real Socket.IO listener
removal contract. The fallback test also reports an actually connected transport.

Three additional regressions mount both SocketManager and ChannelListManager:

- An HTTP list read before server-room admission misses a creation/expiry
  notification and remains stale after admission.
- A resume read immediately before admission suppresses a required reconciliation
  under the old resume throttle.
- The three-second fallback fires before admission, then discards the real
  `userAuthenticated` signal; the authorized list never reconciles.

All three fail before the admission correction, with zero skipped cases. Readiness now refetches the current
server's authorized list using the existing jitter/coalescer independently of
the resume throttle. Late authoritative admission emits one existing reconnect
reconciliation while application readiness remains idempotent. Cancellation
invalidates admission callbacks across disconnect, replacement and destruction.
No permission, expiry policy, backend admission or native timeout is relaxed.

## Evidence boundary

#408 iOS run [40097043889](https://github.com/fatihcayiroglu/Bridge/actions/runs/40097043889)
failed live channel creation without reload. Its artifact does not establish
which of these client interleavings, if any, occurred. These deterministic
regressions prove client defects, not the historical native failure's cause.
#409's failure-only diagnostics remain intact, with the same native assertion
and no retry, artificial reload, synthetic acceptance event or longer timeout.

Exact-head native simulator/emulator CI and the full Quality Gate are separate
requirements. A later green native run cannot erase the earlier failure or
replace physical-device, I07, Android ANR or production integration acceptance.
