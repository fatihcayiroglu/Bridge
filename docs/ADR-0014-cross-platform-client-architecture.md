# ADR-0014 — Cross-platform client architecture: Svelte 5 web, Electron desktop, React Native mobile, shared TypeScript core, Bridge Media Engine

**Date:** 2026-10-21
**Status:** Accepted as direction. Implementation of the shared core and the React Native client is **P8 work and has not started**; P8 is blocked until P7 closes ([P7 contract](P7_TRUST_SOCIAL_FOUNDATION.md), [closure ledger](P7_FINAL_CLOSURE_LEDGER_20261016.md)).
**Builds on:** [ADR-0002](ADR-0002-svelte-vs-vue.md), [ADR-0008](ADR-0008-frontend-framework-strategy.md), [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)
**Measured at:** `main` `17d0a6a84c846e74ad0feec08cdc6d336eb554a4` (2026-10-21)

These are engineering preferences supported by the repository as it is today, not claims that any framework is universally better. Each decision lists the evidence that would reverse it.

---

## Context — what the repository contains (measured, not estimated)

| Fact | Value | How measured |
|---|---|---|
| Client modules (`client/js`, excluding `.d.ts`) | 82 `.svelte`, 174 `.ts`, 1 `.svelte.ts` | `find` |
| Static import cycles across those 257 modules | **0** | Tarjan SCC over value imports (`node scripts/measure-client-coupling.cjs`) |
| `BridgeRegistry` (runtime service locator) | 247 registered keys, 455 `call/has/get` sites, imported by 104 files | same script |
| DOM `CustomEvent` bus | 50 dispatch sites, 53 distinct `bridge:*` event names | same script |
| `window.` / `document.` in non-Svelte TS under `client/js/core` | 447 references in 77 files | same script |
| `@capacitor/*` imports | 0 (Capacitor is reached through `window.Capacitor` in 6 files: `mobile.ts`, `app.ts`, `core/globals.ts`, `core/native-push.ts`, `core/native-deeplink.ts`, `core/local-first/indexeddb.ts`) | same script |
| Socket.IO client | not an npm import: `SocketManager.svelte` uses `globalThis.io` from the `/socket.io/socket.io.js` script tag | source |
| mediasoup client | `mediasoup-client@3.23.1`, loaded on demand by `core/mediasoup-client-loader.ts`; `webrtc-sfu.ts` (1774 lines) speaks 21 `sfu:*` Socket.IO events | source |
| Local-first store (P7 A1–A7) | 15 modules in `core/local-first/`, **0 Svelte imports**; `store.ts` already defines `LocalFirstRecordBackend` and `LocalFirstKeyProvider` with memory and IndexedDB implementations | source |

Two observations drive this ADR:

1. **Coupling is at runtime, not in imports.** There are no import cycles, so modules can be moved one at a time. The real coupling is the `BridgeRegistry` locator and the `bridge:*` DOM event bus, which an import graph does not show and a React Native runtime does not have (`document`).
2. **Some logic lives in renderless Svelte components.** `MessageLoader.svelte` (664 lines) and `AppState.svelte` (248 lines) have one markup line each; `MessageLoader` holds 2 `apiFetch` calls, 6 socket handlers, 19 `window`/`document` uses and 63 `BridgeRegistry` uses. ADR-0008's rule "the service layer never imports Svelte" is enforced by `scripts/check-svelte-boundary.sh`, but 3 of its 8 listed files (`core/socket.ts`, `core/auth.ts`, `core/offline-queue.ts`) no longer exist and the script skips missing files, so the guard passes on a narrower boundary than documented.

---

## Decisions

### D1. Web stays Svelte 5 + TypeScript

**Why:** 82 Svelte components cover the whole client, including message rendering, accessibility behaviour and offline states, with Vitest + Testing Library suites and a 90 % production-reachable coverage gate. Nothing measured shows a Svelte-specific limit. A rewrite would re-introduce regressions the current tests already guard against.

**Not done:** no React rewrite, no React Native Web replacement of the web client.

**Reverse if:** a reproducible, traced performance or accessibility defect is shown to be caused by Svelte's runtime (not by our component design) and an equivalent implementation in another framework, measured with `e2e/tests/perf-benchmark.spec.ts` under the same data and hardware, is materially better; or Svelte 5 stops being maintained.

### D2. Desktop stays Electron (Windows, Linux X11/Wayland, macOS Intel/Apple Silicon)

**Why:** Electron gives the same Chromium WebRTC stack the web client is tested against (screen capture, `getDisplayMedia`, hardware encoders where Chromium enables them), plus the native gates already in CI (`desktop-native-gates.yml`, Windows startup job). One rendering engine across web and desktop keeps one set of media bugs.

**Not done:** no Tauri migration (system WebViews differ per OS — WebKitGTK and WKWebView have different WebRTC and capture support — which would multiply media test matrices).

**Reverse if:** measured Electron memory/CPU on the reference hardware (see the P8 plan's methodology) exceeds a budget the owner sets *and* a prototype on another shell meets it with feature parity for screen share, system audio and device selection on all five targets.

### D3. Mobile moves to React Native with targeted Kotlin/Swift modules — in P8, in parallel

**Why:** the Android emulator investigation (#209) shows how much of the current mobile risk sits in the WebView layer (FontsProvider reference leaks, WebView attach failures, FocusEvent ANRs). Native UI on React Native removes the WebView from the critical path while keeping TypeScript, so the shared core (D5) can be reused. Kotlin/Swift modules cover what JavaScript cannot do well: Android foreground services and Telecom, iOS CallKit/PushKit, Keystore/Keychain keys, audio routing, local database I/O.

**Constraints:** the Capacitor clients stay supported until the React Native client passes real-device acceptance (P9 lists real Android/iOS device verification). Expo development builds vs bare React Native is decided by a spike against the native module list, not by preference (P8 plan § 3). A React Native client is **not in the frozen P8 scope today**; adding it needs owner acceptance (P8 plan § 0).

**Reverse if:** the spike shows a required native capability (CallKit + PushKit, Telecom `ConnectionService`, `mediasoup` via `react-native-webrtc`) cannot be delivered with acceptable effort, or real-device measurements show the Capacitor client meets the same reliability bar once #209 is resolved.

### D4. Kotlin/Swift only where the platform requires it

Native code is limited to platform services with no adequate JavaScript path. Each module exposes a small typed interface consumed by the shared core's adapter interfaces (D5), so business logic is not duplicated in Kotlin and Swift.

**Reverse if:** a module's JavaScript-side logic starts diverging between platforms; then the logic moves back into the shared core.

### D5. A framework-independent TypeScript core, extracted incrementally

**Why:** the local-first store already shows the pattern working: `EncryptedLocalStore` takes a `LocalFirstRecordBackend` and a `LocalFirstKeyProvider`, so a React Native SQLite backend and a Keystore/Keychain key provider can be added without touching its logic. The same pattern — explicit interfaces, injected platform services, no `window`/`document`, no Svelte/React imports, testable in Node — is extended to API, auth, messaging, synchronization and media signaling.

**How:** incremental, module by module, behind contract tests that run in Node and in the browser build (P8 plan § 2). No big-bang workspace move; a `packages/bridge-core` workspace is created only when the first module moves.

**Reverse if:** extraction of a module needs more adapter code than the logic it shares, measured per module; that module stays platform-specific.

### D6. Keep Bridge Media Engine (mediasoup + WebRTC + Socket.IO signaling)

**Why:** the server already has mediasoup workers, Redis room ownership across nodes (`redis-sfu-ownership.pgtest.ts`), participant permissions, simulcast, reconnection and media-plane test harnesses (`media-evidence.yml`). `mediasoup-client` runs in browsers and Electron, and the pinned `mediasoup-client@3.23.1` ships a `ReactNative106` handler (for `react-native-webrtc`; present in `node_modules/mediasoup-client/lib/handlers/`, not yet exercised by Bridge), so one signaling protocol (the 21 `sfu:*` events, to become a typed contract) serves all clients.

**Not done:** no LiveKit replacement.

**Reverse if:** a controlled comparison (same network impairment profiles, same codecs, same hardware) shows a substantial, reproducible quality or operability gap that cannot be closed within the engine, and the owner approves the migration cost.

---

## Consequences

- P7 work continues first. Nothing in this ADR authorizes P8 implementation while P7 gates are open.
- Two low-risk integrity items are recorded for follow-up (not done here): make `check-svelte-boundary.sh` fail on a missing listed file and list the files that now hold service logic; add `core/local-first/` to the guarded set.
- Performance claims (virtualized message list, startup, Electron memory, voice quality) stay **UNVERIFIED** until measured with the methodology in [P8_CLIENT_READINESS_PLAN.md](P8_CLIENT_READINESS_PLAN.md).
