# Tower Chaos — local arcade foundation (experimental)

**Status:** Gameplay model and 3D mesh generation only. The catalog entry stays
`planned`. This is **not yet a playable third mini-game**: it has no WebGL
scene lifecycle, interactive panel, mobile acceptance, saved result, or online
authority. The existing ten-item game catalog remains unchanged.

## Scope and rules

- Two people take turns on one device; no Socket.IO messages or server scoring.
- A six-layer tower has 18 uniquely numbered blocks, three per layer.
- Each layer alternates the long axis of its blocks in the 3D view.
- Players may remove one of the 15 blocks below the full top layer.
- A layer remains supported if its middle block remains **or** both outer
  blocks remain. Removing the final support collapses the tower and the
  current player loses immediately; the other player wins.
- This is a deliberately simplified **arcade** support rule, not a general
  rigid-body or Jenga rules simulation. The future falling animation will be
  cosmetic; rendering is not allowed to adjudicate the game.

## Verification and safety

`tower-chaos-physics.ts` has pure deterministic moves, rejects impossible
matches, malformed block IDs, non-finite inputs, changed top-layer blocks and
out-of-turn actions, and never mutates the previous snapshot.
`tower-chaos-geometry.ts` returns a bounded, colored, interleaved xyz/RGB
triangle buffer. Geometry refuses corrupt matches and invalid collapse
progress. The mesh cannot influence the rules result.

Dedicated Vitest suites are required in the supplemental 3D and foundation
lanes alongside the unchanged full Quality Gate. No retries, skipped tests,
fake green or weakened thresholds.

## Next acceptance gate before changing the catalog status

Build a proper WebGL2 renderer with WebGL1 fallback, loss and dispose
handling, bounded frame pacing, actual on-screen block picking and an
accessible two-player turn panel. Then prove the interaction through a real
authenticated Chromium GPU acceptance test. Do not mark the game playable
until all those requirements pass on the exact head.
