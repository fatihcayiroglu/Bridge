# Bridge Activities — ten 3D mini games + a separate 3D Social Space

Status: **draft foundation only**, 2026-10-30; not shipped, not multiplayer-ready.

## Product separation

The Games tab contains the ten owner-approved **planned** titles: Mini Kart Racing, Parkour Party, Mini Golf, 8-Ball Pool, Mini Football, Hide & Seek 3D, Tower Chaos, Dodgeball Arena, Escape Room 3D, Last One Standing. Entries remain informational until each game is independently implemented and verified. They do **not** create socket sessions or promise playable functionality.

The **3D Sosyal Alan / 3D Social Space** tab is **not** an eleventh game. It is intended to become a persistent meeting environment for customizable avatars, real voice, consent-based presence, safety/muting and trusted friend invitations. It must stay an independent top-level destination, not a game score/match.

## Implemented in this draft

- Authenticated app left rail has a Bridge Activities button; dynamic UI is lazily imported on click.
- Separate Games and Social Space tabs, Escape/close, focus trapping, inert background, closing on logout and when another exclusive overlay opens.
- Social tab contains a **real local WebGL 3D scene** (triangles, vertex colors, perspective camera, depth buffer) with an avatar, stage, seating, walls, planters and bounded WASD/arrow/touch button movement. No CDN, textures, external JS, cookies or extra runtime library. Stops rendering on tab switch, close, background and logout. WebGL unsupported devices get an explicit message.
- The game catalog cannot invoke \`activity:start\`; the current allowlist stays untouched. Client coordinates never claim to be authoritative.
- Pure geometry/product/security invariant tests. The real desktop/mobile acceptance matrix is still required.

## Explicitly not implemented

No 3D game physics, 10 playable games, global matchmaking, user-generated content, online multiplayer, server-trusted avatar synchronization, camera/voice proximity, map persistence, anti-abuse for spatial interactions, NPCs or interoperable mobile native experience. Do not promote the room to online until server-owned room membership, channel expiry/tenant scope, cross-node Redis durability, rate limits, spam/harassment controls, privacy/consent, user reporting/blocking, resource budgets and real-device performance are verified. No access to existing audio tracks is requested in the prototype.

## Suggested incremental rollout

1. Validate this accessible separate-tab UI and actual WebGL rendering under Electron Windows/Linux/macOS, Android and iOS, including low-memory and no-WebGL fallbacks.
2. Build one fully playable mini game (8-Ball Pool) with real authoritative server validation, session lifecycle and zero-skip QA. Follow with Mini Golf and Parkour Party before attempting all ten.
3. Add an independent authorized social-space session backend with real cross-instance presence and voice permission contracts, coordinate limits/anti-cheat, privacy and safe moderation.
4. Gradually implement the remaining seven games. User-generated activities require an explicit isolated sandbox and review system.

This branch starts from main \`c061d72f\` only and does not inherit/integrate #375. **No production merge or deploy** while P7, #321, #209 and other native failures remain open. Abuse Lab B1 is untouched. Keep exact-head CI results separate from conceptual feature promises.
