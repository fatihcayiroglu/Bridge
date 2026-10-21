# P8 client readiness plan — shared TypeScript core, React Native mobile, measured performance

**Status: PLAN ONLY. No P8 implementation is authorized while P7 is open** ([P7 contract](P7_TRUST_SOCIAL_FOUNDATION.md) § Global working rules 1; [closure ledger](P7_FINAL_CLOSURE_LEDGER_20261016.md)). Decisions and their reversal criteria: [ADR-0014](ADR-0014-cross-platform-client-architecture.md).
**Measured at:** `main` `17d0a6a84c846e74ad0feec08cdc6d336eb554a4` (2026-10-21). Coupling numbers: `node scripts/measure-client-coupling.cjs`.

Evidence labels: **MEASURED** (command above or a cited test), **CODE** (read from source, not run), **UNVERIFIED** (no measurement yet).

---

## 0. Scope gate — needs owner acceptance

The frozen P8 scope in the P7 contract (§ Frozen downstream phase order) lists transport, media, SVC, overlay, WASM plugins and migration gateways. It does **not** list a React Native client or a shared client core. This plan proposes adding both to P8. Until the owner accepts that change in the contract, sections 2–3 are a proposal, not P8 scope.

## 1. Platform audit (what is reusable, what is coupled)

| Area | Today | Class | Evidence |
|---|---|---|---|
| Local-first store, outbox, drafts, history, search, operation log (`core/local-first/`, 15 modules) | No Svelte imports; `EncryptedLocalStore` takes injected `LocalFirstRecordBackend` + `LocalFirstKeyProvider`; memory and IndexedDB implementations exist | **Reusable now** (two `document.dispatchEvent` error signals and one `BridgeRegistry` use in `message-operation-sync.ts` to replace with an injected sink) | MEASURED |
| Message text format (`core/messages/message-format.ts`, twin of `server/lib/storedText.ts`) | Pure functions | **Reusable now** | CODE |
| Socket.IO connection (`SocketManager.svelte`) | Uses `globalThis.io` from a `<script>` tag; token refresh, reconnect and auth-revocation handling live in the component | **Browser-specific + UI-coupled** — needs an injected `IoFactory` and a plain-TS connection manager | CODE |
| Message loading / pagination (`MessageLoader.svelte`, 664 lines, 1 markup line) | 2 `apiFetch`, 6 socket handlers, 19 `window`/`document`, 63 `BridgeRegistry` uses | **Logic in a renderless component** — first extraction candidate | MEASURED |
| App message state (`AppState.svelte`, 248 lines, 1 markup line) | Owns the message list behind `BridgeRegistry` keys (`getMessages`, `setMessages`, `prependMessages`, …) | **Logic in a renderless component**; the dedup/ack reconciliation is pure and portable | MEASURED |
| Message list and renderer (`MessageListPanel.svelte` 579 lines, `MessageRenderer.svelte` 1385 lines) | Real UI | **UI** — stays Svelte; React Native gets its own renderer | MEASURED |
| SFU client (`webrtc-sfu.ts`, 1774 lines) | 21 `sfu:*` signaling events, 39 socket calls, 8 `navigator.mediaDevices` uses, mediasoup-client loaded on demand | **Signaling portable, media capture platform-specific** — split protocol/state machine from device access | MEASURED |
| Capacitor | `window.Capacitor` in 6 files, no `@capacitor/*` imports | **Platform-specific**; stays until a replacement passes acceptance | MEASURED |
| Cross-module wiring | 247 `BridgeRegistry` keys / 455 call sites; 53 `bridge:*` DOM events / 50 dispatch sites; 0 import cycles | **Runtime coupling** — the main extraction cost | MEASURED |
| Server Socket.IO contracts (`server/socket/contracts.ts`, 372 lines) | Server-only types; the client does not import them; no `sfu:*` types | **Should become the shared protocol package** | CODE |

Integrity finding: `scripts/check-svelte-boundary.sh` skips listed files that do not exist; 3 of its 8 (`core/socket.ts`, `core/auth.ts`, `core/offline-queue.ts`) are gone, so the ADR-0008 boundary is narrower than documented. Fix in a separate low-risk PR (fail on a missing listed file; list the modules that now hold service logic).

## 2. Incremental extraction (P8, after acceptance of § 0)

No big-bang restructure. A `packages/bridge-core` npm workspace is created when the first module moves; each step is one reviewable PR that leaves the web client behaviour unchanged.

| Step | Module(s) | Interfaces introduced | Gate |
|---|---|---|---|
| 1 | `server/socket/contracts.ts` + the 21 `sfu:*` events → `bridge-core/contracts` | Typed event maps, shared by server and clients | Server and client typecheck against one source; no runtime change |
| 2 | `core/local-first/*` → `bridge-core/offline` | `RecordBackend`, `KeyProvider` (exist), `EventSink` (replaces `document.dispatchEvent`) | Existing local-first suites run unchanged in Node and jsdom; A1–A7 offline/account-isolation acceptance re-run |
| 3 | Message state reconciliation from `AppState.svelte` → `bridge-core/messaging` | `MessageStore` with explicit subscribe; Svelte adapter keeps the `BridgeRegistry` keys | Dedup/ack/ordering property tests; existing message E2E journeys |
| 4 | Loader/pagination from `MessageLoader.svelte` → `bridge-core/messaging` | `HttpClient` (wraps `apiFetch`), `Clock` | Pagination + cursor tests; offline history acceptance |
| 5 | Connection manager from `SocketManager.svelte` → `bridge-core/api` | `IoFactory`, `TokenStore`, `NetworkStatus` | Reconnect convergence acceptance; auth-revocation tests |
| 6 | SFU signaling state machine from `webrtc-sfu.ts` → `bridge-core/media-signaling` | `MediaDevicesPort`, `MediasoupDeviceFactory` | `media-evidence.yml` unchanged; RTP harness green |

Rules for every moved module: no `svelte`/`react` imports, no implicit `window`/`document`, tokens and keys only through injected interfaces, protocol and stored formats unchanged (a contract test compares old and new outputs), and the module runs in Node.

## 3. React Native mobile (P8, in parallel; Capacitor stays)

- **Workflow choice by spike, not preference.** Build the same 3-screen slice (sign in, channel list, channel with send/receive and offline queue) with an Expo development build and with bare React Native, and record for each: native module integration effort for CallKit/PushKit, Telecom `ConnectionService`, Keystore/Keychain, `react-native-webrtc` + mediasoup-client `ReactNative106`; build reproducibility in CI; binary size; cold start on a reference device.
- **Native modules (Kotlin/Swift) only for:** background/foreground services and Telecom (Android), CallKit + VoIP push (iOS), hardware-backed key storage, audio routing and focus, local database I/O, camera/microphone lifecycles.
- **Shared with web via bridge-core:** contracts, offline store logic (SQLite `RecordBackend`, Keystore/Keychain `KeyProvider`), messaging state, signaling.
- **Acceptance before replacing Capacitor:** authentication, delivery + ack identity, offline queue + reload, channel/community flows, notifications, deep links, account separation (zero cross-account local exposure), media permissions, voice/video calls — on real Android and iOS devices (emulator-only results do not count).

## 4. Web and desktop performance — measure before changing

**Virtualized message list: UNVERIFIED need.** CODE finding: `prependMessages` (`AppState.svelte`) keeps every older page with no upper bound, re-sorts the whole list on each page, and `MessageListPanel.svelte` renders all loaded messages in one keyed `{#each}`. DOM size therefore grows linearly with scroll-back. Whether that costs measurable frame time at realistic depths is not measured. Plan:

1. Extend `e2e/tests/perf-benchmark.spec.ts` with a scroll-back scenario (N pages of 50 messages, mixed heights, replies, reactions, attachments) recording DOM node count, JS heap, long-task total and p50/p95 frame time per page load.
2. Set the threshold from the baseline on the reference hardware, not a guess.
3. Only if the threshold is exceeded, prototype variable-height windowing that preserves ordering, reply navigation, unread marker, older-page pagination, scroll anchoring, keyboard navigation, screen-reader reading order, focus restoration, live updates and edit/selection — each with a regression test.

**Metrics to collect** (all currently UNVERIFIED for P8 purposes): cold/warm start, p50/p95/p99 interaction latency, channel switch, message render time, scroll frame stability, DOM nodes, JS heap, initial JS download (the `build:ci` budget gate already reports first-load 1034.5 KB for `app`, MEASURED 2026-10-21 locally), Electron per-process memory and idle CPU, media-session CPU/memory, jitter/RTT/loss, reconnect recovery, crash/ANR rate. Each result records hardware, OS, commit SHA, data set and network conditions.

## 5. Bridge Media Engine investigations (P8)

Keep mediasoup. Investigate with controlled impairment profiles (loss/jitter/bandwidth via netem) and fixed hardware: Opus settings (DTX, FEC, bitrate, ptime), noise suppression / echo cancellation / AGC paths per platform, ICE restart and network switching, bandwidth estimation, AV1/VP9 SVC layers, hardware encoders, worker CPU/memory per participant, multi-region routing. Report network transport quality (RTT, loss, jitter, recovery time) separately from perceived audio quality (a listening test or a reference metric). No "world-class voice" claim without a side-by-side against established platforms under the same conditions.

## 6. Exit criteria for this plan

P8 client work starts when: P7 is formally closed; the owner accepts § 0 into the P8 contract; step 1 (shared contracts) is merged with server and client typechecking against it.
