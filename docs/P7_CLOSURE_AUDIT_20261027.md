# P7 closure audit — 2026-10-27

**State: P7 OPEN. P8 not started and not authorized.** This audit maps every
P7 criterion in [P7_TRUST_SOCIAL_FOUNDATION.md](P7_TRUST_SOCIAL_FOUNDATION.md)
and every open P7 issue and PR to where its work is and what still blocks it.
It replaces nothing: [the closure ledger](P7_FINAL_CLOSURE_LEDGER_20261016.md)
keeps its history, and every result below names its head and run.

## Codex verification checkpoint — 2026-10-27

This checkpoint supplements the original inventory below; it does **not**
declare the closure candidate accepted. `main` is still `c061d72f`, #375 is
unmerged, #497 is draft at `ca49e0b2`, and #500 is draft at `dd98331c` with no
reviews. #500 has **not** been integrated into #497. Offline reload is now
owner-approved P7 scope; the historical OWNER/FAIL rows below describe the
pre-#500 inventory, not a new policy decision.

Verified on #500 `dd98331c`:

- [Quality Gate 40475772622](https://github.com/fatihcayiroglu/Bridge/actions/runs/40475772622):
  all nine jobs succeeded, including full browser/media, security and the real
  database/storage gate. Job success is not independent security review.
- [Android 40475775199](https://github.com/fatihcayiroglu/Bridge/actions/runs/40475775199):
  succeeded; emulator log explicitly records N02 missed-message reconciliation
  and D2L01 passing.
- [iOS 40475778861](https://github.com/fatihcayiroglu/Bridge/actions/runs/40475778861):
  succeeded; logs explicitly record the **actual OS confirmation / same-process
  channel journey** I07-XCUITest and D2L01-iOS passing. This is simulator
  evidence; physical-device acceptance remains external.
- Independent npm audits of root, server, Electron, E2E and iOS tooling each
  report zero advisories. Dependency changes are already present: no duplicate
  upgrade was made.
- Independent Chromium against a newly isolated PostgreSQL database and Redis:
  all eight offline-reload journeys and both adjacent local-first journeys
  passed, with zero retries/skips. Includes logout, account switch, revocation,
  tampering, expiry, erasure and missed-message reconciliation.

The failures on #497 remain evidence:
[Android 40470478921](https://github.com/fatihcayiroglu/Bridge/actions/runs/40470478921)
failed N02 and native navigation;
[iOS 40470482049](https://github.com/fatihcayiroglu/Bridge/actions/runs/40470482049)
failed I07-XCUITest. Its later dispatch-only I07 smoke passed and does not
replace the failed native journey. Multi-node 40470484752 and media 40470505863
also failed. Passing #500 runs do not establish a cause for those failures.

### Auth / native navigation recovery

Isolated implementation branch: `codex/p7-session-startup-recovery-20261027`,
based on #500. It reuses the existing router, navigation owner and HTTP fence.
The change preserves the original intent deadline, cancels stale completions,
and repeats only read-only channel resolution after same-account validation.
Logout/account changes discard the intent; local-only sessions wait for server
validation. Invite/DM mutations are never replayed. The channel-list owner
invalidates deferred work and pending navigation, then restarts an interrupted
authorized load after validation, including repeated auth-success events.

Executable reproduction on unchanged production code:

- Two same-account recovery cases issued one lookup instead of a fresh second
  one (allowed and newly withheld destination).
- A previous-account completion changed the next account's toast UI.
- An interrupted list was never restarted; pending navigation could select a
  late response across an auth transition.
- A repeated auth-success without auth-transition also stranded a list load.

These are consumer recovery defects, **not proof of duplicate startApp() or the
root cause of all EX01/I07/N02 failures**. Production callers were traced:
password/registration/2FA, passkey, SSO, and session restoration/recovery all use
startApp. Bootstrap chooses SSO or restore; recovery is single-flight and
transition-guarded. startApp writes setMe and AppState mirrors its auth-success
payload; these two assignments alone do not prove a second session start.
The HTTP generation changes on auth-transition, auth-success and auth-logout
capture listeners. No fence, retry budget or assertion was weakened.

Both runs' archived simulator console files contain startup 409s and a second
socket connection. The smoke script launches a later app instance and captures
console output there: these files must not be presented as an event trace of
the earlier failing XCUITest. Android N02 still needs evidence of admission,
join and authoritative fetch at its first failure; no shared cause is proven.

The new unit regressions pass in the focused 168-test auth/navigation/socket
run. A new real-browser regression holds an actual authorized HTTP response
across production startApp, requires a fresh lookup and verifies the actual
selected channel. Svelte and E2E typechecks and production bundle budgets pass.
The first full client run passed 5,847 tests with coverage S/B/F/L
95.37/90.35/94.79/96.46; this predates the final repeated-event case. Final
full-suite and exact-head CI status belong to the recovery PR's checks/results;
this checkpoint does not predeclare them green.

### Offline-reload security review remains open

The account/token/key/AAD boundary, grant corruption/expiry/erasure rejection,
API local-only gate and reconnect refusal have code and executable evidence.
That is not clearance of all twelve review requirements:

- Native debug iOS artifact console output contains decrypted local values
  from Capacitor's generic result logger. The provider's own fixed error logs
  are not sufficient to establish plaintext-free native logging. Release uses
  Capacitor's default debug-only logging; assess both distribution and evidence
  paths without publishing plaintext fixtures or suppressing failure evidence.
  The next security revision replaces only Capacitor 8.4.3's generic successful
  result-payload print with registered plugin/method metadata. The normal iOS
  overlay applies it before compilation, pins the reviewed SDK file hash, is
  idempotent, refuses shared dependency symlinks, and fails closed on unknown
  source/version. Error handlers and result delivery remain unchanged. The new
  native CI assertion rejects raw result lines and requires an actual native
  decrypt log as a positive control. The assertion fails on #500's archived
  console, rather than accepting an empty log. Local mobile tests pass 147/147
  (zero skips), and the iOS evidence/transport/checker tests pass 30/30. Actual
  compiled-SDK and simulator privacy acceptance still require the new exact-head
  iOS run; this is not inferred from the source-patch unit tests.
  **That run failed as intended by the privacy gate:** on `7f574386`,
  [iOS 40488786954](https://github.com/fatihcayiroglu/Bridge/actions/runs/40488786954)
  passed compilation, D2L01 and I07-XCUITest but the archived console still
  contains 30 JSON result lines and no redacted result lines. SwiftPM downloads
  a prebuilt XCFramework from `capacitor-swift-pm`; editing the npm SDK source
  cannot change it. The correction uses Capacitor's supported CocoaPods source
  build and workspace, packages the existing crypto sources through a podspec,
  and refuses existing SwiftPM projects without rewriting them. SDK version,
  crypto implementation, entitlement scope and the privacy assertion are
  unchanged. Local mobile checks pass 149/149 with zero skips; actual npm pack
  includes the podspec and both existing Swift files, and the actual Capacitor
  CLI discovers the expected pod and plugin class. A new compiled-source iOS
  run is still required. The first failed privacy artifact is retained, rather
  than weakening its positive control or calling functional success privacy
  acceptance.
  The source build on `8531e5d9` compiled successfully, but its native journey
  stopped **before Appium** because CocoaPods' template omits the SPM Debug
  marker: `Print: Entry, ":CAPACITOR_DEBUG", Does Not Exist`. The privacy gate
  then correctly rejected the missing decrypt control. The follow-up restores
  the same Info.plist placeholder in the generated CI app and sets its value
  only on the Debug simulator build command. The curated/release plist and the
  journey prerequisite remain unchanged. This early stop is not a completed
  expiry journey or a privacy pass; the subsequent exact-head run is required.
- Delayed grant writes racing logout/switch and their durable invalidation
  were subsequently reproduced: a paused grant write completed after a
  successful clear and made the old token unlock history again. The isolated
  `codex/p7-offline-grant-review-20261027` correction registers the latest
  operation per account before any await, carries a cancellation guard through
  encryption and immediately before the IndexedDB transaction, and guards
  production writes with the current auth transition/account/canonical token.
  A late clear cannot remove a newer validated grant. Regression coverage also
  includes reversed refresh completion, asynchronous DB open, encryption,
  another account's independent mutations, an already-invalid session and
  canonical-token removal by another tab. The final focused store/auth run
  passes 50 tests; the final adjacent run passes 401, and the final rebuilt
  client passes 11 real Chromium/PostgreSQL/Redis journeys. A new full client
  run after freezing the grant code passes 5,856/5,856 in 346 files, with
  coverage S/B/F/L 95.37/90.35/94.80/96.47. This corrects the reproduced race;
  it does not establish
  durable deletion when the storage device itself rejects the delete, or a
  cross-process durable revocation protocol. Those boundaries remain review
  items, rather than being justified by the former incorrect comment that an
  undeletable grant cannot be read.
- Seven days is unchanged. Offline revocation cannot be learned until the
  device reaches the server; device-clock checks do not defend against an
  OS-level clock/storage attacker. No new grant-lifetime decision is inferred.

Do not integrate #500 or close P7/#321/#209 based on this checkpoint. Required
reviews, exact-head checks, multi-node/media failures, unresolved product-policy
decisions and external-device gates remain outstanding. No merge or deployment
was performed.

## Evidence update — 2026-10-27 afternoon

Supplements the checkpoints above; nothing here is acceptance. No merge, no
deployment; #375 and `main` are untouched.

### Multi-node SFU ownership (#503 `13e6fef2`)

- `scenarios=sfu` [40502887882](https://github.com/fatihcayiroglu/Bridge/actions/runs/40502887882):
  9 PASS / 0 FAIL / 0 skipped / 2 INFO on PostgreSQL 18.6, Redis 8.0.5 and
  moto S3 with three Bridge processes. Every SFU verdict rests on observed
  router events delivered over harness-only IPC (no channel ids in routine
  logs):
  - SFU-01: one router per race, creator observed in 6/6 races.
  - SFU-06: `intervals=A[3059ms] B[open] overlaps=[] anomalies=0`.
  - SFU-08: `intervals=A[open] overlaps=[] anomalies=0`.
  - SFU-04 `routers=none` counts only because every node acknowledged the
    IPC flush barrier.
- Full matrix [40503812552](https://github.com/fatihcayiroglu/Bridge/actions/runs/40503812552):
  per-node job 93 PASS / 2 FAIL\* / 14 INFO, 0 skipped; shared job green.
  The FAIL\* rows are UP-02 and UP-06, the documented per-node upload
  limitations, **not fixed**. #502's earlier full run 40489599746 was
  89 PASS / 6 FAIL including the four SFU evidence gaps.
- Open: review of the `BRIDGE_SFU_EVIDENCE_IPC=1` hook. SFU-02's detail
  line still prints two disposable lab UUIDs.

### iOS I07 (#502 `64b1c215`, diagnostics in #504 `3aa15253`)

- #502's exact-head [iOS 40495735869](https://github.com/fatihcayiroglu/Bridge/actions/runs/40495735869)
  remains **FAIL** (I07-XCUITest: no OS confirmation within 30 s). I07 passed
  on the SwiftPM build of `7f574386`.
- That run's smoke misattributed a modal. SpringBoard set
  `systemModalAlert` on Bridge's scene 3 s after launch, 25 s **before** the
  URL was opened, and the app's deactivation reason 13 was never removed. The
  smoke still reported I07 UNVERIFIED as if that were the open confirmation.
  #504 fixes the classification: a modal logged only before the URL request
  is now FAIL. I07 also records the category of any system alert up before
  the request (and at timeout), never its text, and accepts nothing.
- On #504's head, with product code identical to `64b1c215`, runs
  [40503639823](https://github.com/fatihcayiroglu/Bridge/actions/runs/40503639823)
  and [40506367411](https://github.com/fatihcayiroglu/Bridge/actions/runs/40506367411)
  both passed I07-XCUITest, the smoke I07 and D2L01-iOS. The I07 failure is
  **intermittent**, not deterministic for the source build.
- Lead (unproven): `tccd` logs `Handling access request to
  kTCCServiceMicrophone` from Bridge about 4 s after every launch, before the
  web app is ready. No Bridge JS calls a media API at startup and no native
  plugin touches the audio session at load, so it most likely comes from
  WKWebView. In the passing runs it produced no prompt.
- Four of four runs on #504's head passed (40503639823, 40506367411,
  40520392524, 40520397225). No failure has been caught with attribution yet.

### Android N02 reconnect resync (#505)

- #497's [40470478921](https://github.com/fatihcayiroglu/Bridge/actions/runs/40470478921)
  N02 failure remains the only failure; its cause is **not established**.
- #505 now records where a resync stops, counting history requests inside the
  page. The packaged app routes REST through CapacitorHttp, so Playwright's
  network events cannot see them; #505's first version was blind to this,
  which is corrected in `b8858503`.
- Valid evidence from four passing runs: 1 reconnect event, 1 history
  request with status 200, message visible after 2.2–3.4 s. These passes are
  not a fix.
- A product gap that produces N02's symptom is fixed in draft #506
  (`e75ddaab`). A network failure of the post-reconnect re-read was never
  retried while the socket stayed up; REST uses CapacitorHttp and the socket
  its own WebSocket, so the re-read can fail right after a network change.
  It is now retried after 1/2/4 s while the socket is connected. 2 of 5 new
  tests fail before the change; the client suite passes 5,824 tests with 0
  skipped and the coverage gates. It is not shown to be the cause of the one
  N02 failure.

### Android #209 cold-start ANR

- Reproduced on #505 `46fecc44` ([40513437976](https://github.com/fatihcayiroglu/Bridge/actions/runs/40513437976)):
  - CS01 cold start 2 hit an ANR, category `input_dispatch_timeout` on a focus
    event, with the main thread in `Native / graphics / frame-sync`.
  - L01 and ANR01 failed as a consequence.
  - The base had passed twice earlier the same day.
- Environment: the CI emulator uses `-gpu swiftshader_indirect` (every frame is
  rasterised in software on the host). SF05's plain WebView loading the same
  content tracks the Capacitor activity run by run, so runner speed sets most of
  the variance.
- A code-size cause was ruled out for the higher stalls on the #497 line versus
  the #495 line: CSS identical, +22 KB JS, and Chromium at 6× throttle gives the
  same first paint, boot long task and DOM size for both heads.
- #499's first version (restore two frames after DOMContentLoaded) showed no
  reduction. `a60f0064` keeps effects off until the page has window focus (or
  first input, or a 10 s fallback) and records the trigger.
- Measured on `720a8f3a` (#505 `46fecc44` + `a60f0064`): runs 40520286564,
  40520292316 and 40520298322, 0 ANRs (one run failed DL02, the
  cold-deep-link class #501 addresses).
  - In **all 9** cold starts the trigger was `focused-at-load`: the window
    had focus before DOMContentLoaded. The focus event that times out in every
    #209 ANR is handled before Bridge's content exists. That matches the ANR
    run, whose largest stalls were `before-displayed` (6,544 ms) and
    `displayed-to-attached`.
  - CSS deferral cannot act there. SF02/CS01 stay within the baseline range
    (5 runs, 1 ANR); SF06's drop (2.6–3.7 s to 1.3–1.9 s) is the plain-WebView
    control, which never gets focus.
  - #499 is **not** a #209 fix. The next candidates are pre-content: Activity
    creation, WebView provider init and splash frames under software
    rendering.
- #209 stays **OPEN**. The physical device remains EXTERNAL.

### Media IMP-04

- Failed once on `ca49e0b2` ([40470505863](https://github.com/fatihcayiroglu/Bridge/actions/runs/40470505863)):
  A→B video dropped to 0 fps under the severe 150 kbit/s profile and did not
  recover within 90 s pre-squeeze, 20 s squeeze and 90 s post-squeeze, while
  audio and B→A continued.
- Passed on `d0a20228` (full resolution again after 20 s) and in the scheduled
  run on `main` (40485237274).
- The lab runs through the real SFU. The client never pauses consumers for
  bandwidth, so recovery is the SFU's downlink congestion control, and the lab
  records no consumer-layer or estimate state. **Root cause not established**;
  the next step is SFU-side consumer layer/score evidence.
- Separately, `webrtc.ts`'s P2P bitrate loop reads `packetsLost` from
  `outbound-rtp`, which never carries it, so its loss branches cannot fire.
  That path is not used in the SFU lab and only raises the cap; it is
  recorded, not changed.

## Where the work is

- **`main` `c061d72f`** (2026-10-23) is the last merge. Since then nothing has
  merged. `main`'s Security audit fails on advisories published after that
  merge (body-parser, multer, undici high; fast-uri, nodemailer moderate);
  [#413](https://github.com/fatihcayiroglu/Bridge/pull/413) fixes it and was
  green on its own head (Quality Gate 40107636853). **Owner merge decision.**
- **#375** (D2 final integration, `1bde050f`) is not a draft and is waiting for
  the owner's review. Merging it to `main` is not authorized.
- **#495** (`claude/p7-android-integration`) is built on #375 and, by
  ancestry, contains 68 open PRs (the D2 stack, the D3 preflights, the C4
  destination-lifetime work, the account/deletion fences, the B3 voice and SFU
  log fixes, the Android evidence line and #491–#494).
- **#497** (`claude/p7-closure-candidate`) merges onto #495 every remaining
  P7 PR that was not in it (#376, #377, #378, #379, #380, #381, #383, #384,
  #385, #387–#394, #414, #425, #456, #457, #459, #496 and #373). It is the
  single head on which P7 can be verified. Its PR lists the two conflict
  resolutions that touch behaviour or tests.

Not carried into #497, on purpose: Wayland experiments and CI-only PRs
(#397, #426, #427, #445, #449, #451–#454; #456 is their bounded
integration), DO NOT MERGE PRs (#405, #415, #453), drafts superseded per #375
(#326, #331, #348, #349, #351) and #460 (content already present), older
Android diagnostics (#238, #330, #339, #340, #342, #343, #350), dependency
bumps, and every P8 PR (#428–#450). **P8 drafts exist in the repository
(opened 2026-10-25); none is merged or part of P7.**

## Criteria

Classification: **PASS** only with exact-head evidence on the closure head;
**IMPLEMENTED** means code and local or older-head evidence, not yet proven on
the closure head; **OWNER** needs a decision only the owner can make;
**EXTERNAL** needs hardware or an operator; **OPEN** needs work.

| Item | State | Evidence and what is left |
|---|---|---|
| A1–A7 local-first | IMPLEMENTED; **one gate FAILS**; OWNER | Foundation on `main` (#124). New real-browser spec `e2e/tests/p7-local-first-acceptance.spec.ts` (#498): an **offline channel open** showed "server error" instead of the cached window because the service worker's offline answer was classified as a server 503; fixed in #498 (FAIL before, PASS after, Chromium). **Account switch**: no plaintext copy at rest and nothing shown to the next account (PASS). **Offline reload FAILS**: a reload without network stays on the sign-in screen, because `restoreSession` starts the app only after a successful `/api/me` (see the gate list). Account erasure of local data (#372) and deletion fences (#409, #417, #423, #424, #459) are in #497 |
| B1 anti-spam/raid | IMPLEMENTED; OWNER | Ingress fixes on `main` (#335). Welcome name moderated (#376, in #497). **Owner:** NFKC/homoglyph evasion; whether timed-out members may vote and react; display-name moderation |
| B2 risk-adaptive security | IMPLEMENTED; OWNER | #383 (in #497) maps every rule to runnable evidence and makes the two prose rules executable. **Owner:** the questions listed in #383 (step-up scope for channel expiry/deletion is implemented by #400, in #497) |
| B3 metadata minimization | IMPLEMENTED for the audited classes; OPEN overall | Image metadata (B3-1), client errors (#312/#315), server logs (B3-2: #384, #402, #414, #434, #436, #438, #455, #457), metrics labels (#385), Android evidence (#411). Still unaudited: database IP/device records, timestamps, telemetry beyond logs |
| B4 E2EE | OWNER; OPEN | Claims are truthful (#309, #310, #313). No E2EE cryptosystem exists. **Owner:** whether P7 requires one or the truthful-capability boundary closes B4 |
| B5 moderation | IMPLEMENTED; OWNER | See the B5 evidence map below. **Owner:** erasure precedence on #336 if the recorded default is not accepted; DM/group-DM/voice-message reporting scope |
| C1 identity export | PASS on `main` (bounded subset) | Re-verify on the closure head |
| C2–C3 community export/import | PASS on `main` for the metadata-only subset | C4 hardening (#387–#394) in #497 |
| C4 lock-in test | OWNER; EXTERNAL | Lab round-trip evidenced (#236, P7-RT-01..22). **Owner:** whether the metadata-only subset is P7's scope (#205). **External:** independent production DNS/operator authenticity |
| D1 partitioning | OWNER | #380 (in #497): measured no-partition recommendation on a named dataset. **Owner:** accept or reject |
| D2 ephemeral channels | IMPLEMENTED (#375 stack, in #495/#497) | Exact-head evidence on #375 `1bde050f`. **Owner:** P2P media-expiry threat model (#375); iOS legacy browser-key migration |
| D3 migration safety | IMPLEMENTED | Lock/runtime evidence (#377), upgrade path and preflights (#382, #398, #404, #420), backup/restore (#366). On the closure head (local): fresh 001→095, upgrade from #495's schema identical to fresh, ordered rollback gate rc 0. Outside #377's 085–092 evidence: 093 is a catalog-only nullable column; 094 builds three plain indexes and documents a measured write stall (5.6 s at 6M messages, about 1 s per million) with the CONCURRENTLY pre-build an operator can run first; 095 only replaces two triggers |

### B5 evidence map (contract § B5)

Every test named here ran in the local full server/client runs on the closure
head (server 13,337/13,337, client 5,816/5,816); the abuse lab is dispatched
on #497.

| Contract item | Implementation | Evidence |
|---|---|---|
| Evidence-safe reporting | Report-time bounded snapshot, survives edit/delete/hard delete (085), channel expiry/deletion (088, 090); thread replies (093, #379); retention job: scrub 90 days after resolution | `report-evidence.test.ts`, `report-evidence-flow.test.ts`, `jobs-reportEvidenceRetention.test.ts`, `thread-message-report-endpoint.test.ts`; real PG `report-evidence`, `report-retention`, `thread-message-reports` |
| Raid response actions | `lib/raidProtection.ts`: balanced holds accounts younger than 24 h that joined in the surge from posting; strict also refuses joins | `p7-raid-protection.test.ts`, `p7-server-membership-raid.test.ts`, `server-join-raid-answers.test.ts`; abuse lab ATK-08, LEG-08, LEG-10, LEG-11 |
| Rate-limit / lockdown visibility | `GET /api/servers/:sid/raid-protection` (MANAGE_SERVER) returns level, thresholds and `lockdownUntil`; moderation tab shows it (#347) | `servers-core-member-listing-branches.test.ts`, `client/tests/moderation-tab.test.ts` |
| Audit trail | `raid_lockdown_auto` (automatic), `raid_protection_updated` / `raid_protection_reversed` with previous/next state and released holds; audit failure is logged without undoing the change | `p7-raid-protection.test.ts`, `servers-core-member-listing-branches.test.ts` |
| Expiry / reversal | Raid mode ends at `lockdownUntil`; `clearLockdown` or level `off` ends it and releases only the holds it placed (`Members.releaseRaidHold`); member timeouts expire | `p7-member-raid-hold-repository.test.ts`, `member-timeout-policy.test.ts`; abuse lab LEG-11 (moderator ends raid mode, newcomers post again) |
| Multi-node | Join counters and dedupe use the authoritative Redis cache; process memory only without Redis | abuse lab runs two Bridge nodes on shared PostgreSQL + Redis and alternates requests between them |

### B3-3 inventory: IP, device and location records (closure head, 2026-10-27)

Read-only inventory: every `public` column of a database migrated 001→095 whose
name matches IP, agent, address, device, fingerprint, location, last-seen or
platform, plus every Redis write keyed by an IP. No code changed.

| Class | Where | Retention | Why kept / finding |
|---|---|---|---|
| Client IP + user agent | `client_error_events.ip`, `.user_agent` (migration 001) | — | **No writer.** No revision in this repository inserts into the table (`git log -S`); client errors go to Redis since #312. Empty columns; erasure anonymizes `user_id`. Dropping the table is a schema change left to the owner |
| Session / refresh tokens | `refresh_tokens` | until `expiresAt` | No IP or user agent stored |
| New-device detection | Redis `captcha:known-device:<user>:<hash>` | 30 days (`CFG.knownDeviceTtlSec`) | Hashed device, per account; raw IP and user agent go only to the account holder's alert e-mail |
| Login abuse counters | Redis `captcha:ip:<ip>` | 2 h | Lockout keyed by the address it acts on |
| IP reputation (AbuseIPDB lookups) | process memory, `expiresAt` per entry | 1 h by default (`ABUSEIPDB_CACHE_TTL`, at most 7 days); 15 min for unblocked results | Caches the lookup for the address it gates |
| IP bans | Redis `bridge:ipban:<ip>` | automatic: fixed duration; admin: until lifted or the chosen duration | Admin bans are an explicit operator action and are written to the admin audit log with the address |
| Passkeys | `webauthn_credentials.deviceType` | credential lifetime | WebAuthn attribute needed to verify the credential |
| Push | `fcm_tokens.platform`, `native_push_tokens.platform`, `oauth_tokens.platform`, `user_connections.platform` | token lifetime | Needed to route the push or the connection |
| Location text | `users.location`, `server_events.location` | user-controlled | Entered by the user or event creator, at most 200 characters; not derived |
| Federation | `federation_peers.lastSeen` | peer lifetime | A server, not a person |

Still not audited: timestamps as a metadata class, and telemetry beyond logs
and the Prometheus labels (#385).

## Cross-pillar gates

| Gate | State |
|---|---|
| Offline reload (cached authorized history opens without network) | **FAIL** in Chromium on `main` and on #497: the sign-in screen is shown. **OWNER**: opening the encrypted local history before `/api/me` confirms the session (read-only until the server answers, purge on 401/403) satisfies A4/A7 but changes the rule "no stored identity alone establishes a session" |
| Offline channel open | FAIL before #498, PASS with it (Chromium, local) |
| Account switch, zero cross-account local exposure | PASS (Chromium, local, #498 spec) |
| Corrupt local DB, storage pressure, local search boundaries | client unit suites only (`local-first-*`, `outbox-store-*`); no real-browser test yet |
| Quality Gate green on the final P7 head | dispatched on #497 |
| Real PostgreSQL / Redis / S3, zero skips | local 454 pass / 0 fail / 14 skipped (S3 only, no MinIO locally); CI decides |
| Android acceptance (CS01, L01–L04, ANR01, EX01, NAVSTORE, D2L01, PD01) | **FAIL, intermittent**: #209 ANR reproduced on #505 `46fecc44` (40513437976; CS01/L01/ANR01). ANR-free runs on #505 `0abe3b01`/`b8858503` and #495 `139024f6` (×2; the second failed DL02) do not clear it. **#209 open** |
| Android physical device | EXTERNAL: procedure in `P7_ANDROID_209_DEVICE_STARTUP_PROCEDURE_20261027.md`, not performed |
| iOS | Simulator only. #502 exact-head I07-XCUITest **FAIL** (40495735869); I07 passed twice on #504 with identical product code (intermittent). Physical device EXTERNAL |
| Desktop Windows / macOS / Linux X11 / Wayland | dispatched on #497; physical GNOME/KDE EXTERNAL (#396, #416) |
| Browsers Chromium / Firefox / WebKit | Quality Gate E2E; WebKit edit/delete flake (#496 evidence in #497), cause not established |
| Federation, self-host, multi-node, media, abuse, step-up labs | #497 `ca49e0b2`: federation, self-host, abuse and step-up green; media FAIL (IMP-04, cause open); multi-node FAIL (SFU evidence gap, closed by #503: sfu 9/9, full 93 PASS / 2 FAIL\* known UP-02/UP-06) |
| Post-merge `main` green | requires the owner's merge decisions |
| #494 visual change | OWNER: artifact and options on #494 |

## Owner decisions, in one list

1. Merge #413 to restore `main`'s audit (or name another route).
2. Review and merge path for #375 → #495 → #497 (or a different order).
3. #494 auth-glow visual change.
4. B1: NFKC; timed-out voting/reactions; display-name moderation.
5. B2: #383's open questions.
6. B4: whether an E2EE cryptosystem is in P7.
7. B5: #336 erasure precedence (if the default is not accepted); report
   scope beyond channel and thread messages.
8. C4/#205: metadata-only subset as P7 scope.
9. D1: accept the no-partition recommendation (#380).
10. D2: P2P media-expiry threat model; MEDIA-11 trade-off (#378).
11. B3 #384 vs #402: no INFO line (current) or an identifier-free one.
12. Whether physical-device certification is a P7 gate or a release gate.
13. Offline reload: open the encrypted local history before the server
    confirms the session (A4/A7 gate), or accept that P7's offline history
    applies only within a running session.
