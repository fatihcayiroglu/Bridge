# 8-Ball local rule prototypes (test-only)

These four modules are **not shipped as Bridge gameplay**. They are deliberate
proof-of-concept contracts exercised by Vitest, retained for engineering work:

- `pool-eight-ball-rules.ts`: two-player break, turn, class and foul reducer.
- `pool-ball-in-hand.ts`: bounded cue placement with actor and geometry checks.
- `pool-called-pocket.ts`: declared pocket, safety, and per-shot evidence.
- `pool-eight-on-break.ts`: explicit re-rack / physical eight-ball respot.

The default 3D Pool user interface runs the **local-only called-pocket
practice** in `client/js/core/activities/pool-practice-call.ts`. It does
not offer an official competitive 8-Ball match or a server-authoritative mode.

Before promoting any prototype to `client/js/core/activities/`:
1. Wire the entire contract to an actual owned, explicitly opt-in UI/session.
2. Implement missing WPA rules and ensure invalid evidence fails closed.
3. Test full physics→rules→render behavior with real browser acceptance.
4. Preserve production reachability and Quality Gate without whitelist entries,
   skipped tests, coverage reductions, or speculative success claims.

This location avoids shipping unreachable runtime code **without hiding it
from its existing tests**. Do not use a dummy import only to satisfy the guard.
