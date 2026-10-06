# P6 closure evidence

This file is the final evidence ledger for P6. It complements `P6_INTEROP_AI_RELIABILITY.md`; it does not rewrite the frozen P5 evidence.

Statuses are PASS, MEASURED, UNVERIFIED, KNOWN LIMITATION, or FAIL. A product-controlled stand-in is never described as third-party evidence, and accelerated time is always identified explicitly.

## W1 / W2 baseline carried into closure

- Per-server AI opt-out and the installation-level master switch are implemented and already covered by unit, real-PostgreSQL, restart and real-process provider evidence.
- The pgvector writer has a live guarded caller; eligibility, edit/delete invalidation, opt-out purge, outage/restart and permission-filtered search are covered by the dedicated PostgreSQL/pgvector suite and the federation lab.
- The final P6 regression must keep these gates green; previous PASS evidence is not used to excuse a regression on the closure head.

## W3 — authored ActivityPub lifecycle

**Contract.** A Bridge-authored Note is one durable object identity. Editing it persists a new `Update` activity and fans that exact activity out to followers. Deleting it persists a `Delete`, returns a Tombstone from the authored-note reader, and prevents later PATCH resurrection.

Evidence on the closure branch:

- focused route/unit tests cover ownership, validation, durable activity history, fan-out failures and Tombstone reads;
- real PostgreSQL coverage verifies the activity history and migration boundary;
- federation lab scenario `outbound-lifecycle` uses two independent production Bridge processes over CA-signed HTTPS:
  - `F-OUTL-01` — authored Create reaches the remote follower;
  - `F-OUTL-02` — PATCH persists one Update and the signed fan-out edits the remote durable copy;
  - `F-OUTL-03` — DELETE persists one Delete, hides the remote copy and leaves durable tombstones on both sides;
  - `F-OUTL-04` — PATCH after deletion returns HTTP 410 and cannot resurrect the Note.

## W4 — remote ActivityPub direct messages

**Contract.** A direct Note is recipient-scoped durable state. A thread cannot be manufactured into an arbitrary delivery/SSRF target: a local recipient can reply only when an inbound direct Note from that actor already exists. Replies use normal signed durable ActivityPub delivery. `clientNonce` is the local idempotency boundary.

Evidence on the closure branch:

- server tests cover recipient isolation, pagination/validation, delivery and nonce idempotency;
- `RemoteDmPanel.svelte` is wired to the authenticated remote-DM API and has a component regression for loading a thread, sending a reply and blocking over-limit content before network I/O;
- federation lab scenario `remote-dm` uses a real signed hostile-remote actor plus a production Bridge process over HTTPS:
  - `F-RDM-01` — a signed remote direct Note is stored with `targetUserId` and exposed to its recipient;
  - `F-RDM-02` — the recipient reply is journaled and delivered over HTTPS with an HTTP Signature and direct-only audience;
  - `F-RDM-03` — replaying the same client nonce reuses one journal row and causes no second delivery;
  - `F-RDM-04` — a neighbouring local user gets an empty history and cannot reply to the recipient's thread.

## W5 — full federation retry/outage horizon

The production default retry delays are:

`30s, 2m, 10m, 30m, 1h, 2h, 4h, 8h, 12h, 24h, 24h, 24h`

Their exact sum is **358,950,000 ms = 4.155 days**. The earlier approximate “3.5 day” wording was stale and is not used as closure evidence.

`scripts/federation-lab/retry-outage.mjs` keeps the production delay table unchanged. It runs real production Bridge processes with real PostgreSQL, Redis and HTTPS fronts while only the Bridge application wall clock is shifted with `libfaketime`; PostgreSQL, Redis, the harness and network stay on real time. The virtual clock advances only while the relevant app is stopped, then the production startup-recovery path performs the due retry.

Required evidence:

- peer outage survives app restart and a later peer return drains the durable row;
- each persisted generation matches the next production delay;
- exactly **1 initial attempt + 12 retries = 13 failed network attempts** occur under a sustained outage;
- retry #12 exhausts the row and the production `federation.delivery.max_retries` event contains the durable delivery id;
- no shortened retry constants or worker-only test hook exists.

The normal federation lab remains a separate control. Its run immediately before this closure expansion produced **101 PASS / 7 MEASURED / 0 FAIL**; the final closure run must additionally pass `outbound-lifecycle`, `remote-dm` and `retry-outage`.

## External interoperability / provider evidence

P6 distinguishes external evidence from Bridge-controlled stand-ins.

- Third-party ActivityPub interoperability: **UNVERIFIED on the closure head until a real non-Bridge implementation run is recorded.** The Bridge-vs-Bridge/hostile-actor lab is strong protocol evidence but is not relabelled as third-party interoperability.
- Hosted AI provider smoke: **UNVERIFIED unless CI/operator credentials are deliberately supplied.** The self-hosted OpenAI-compatible and Ollama-shaped lab providers prove request plumbing, policy and failure behaviour, not a hosted vendor account.
- Physical Android/iPhone, real FCM/APNs, radio handover and device audio routing remain external evidence inherited from the earlier mobile limitations; simulator/emulator PASS does not claim physical-device proof.

These external items must either gain real evidence before closure or remain explicitly classified as external/unverified; no mock may be promoted to PASS for them.

## Final closure bar

P6 is CLOSED only when all of the following are true on the final PR head and then verified after merge to `main`:

1. Quality Gate: security audit, minimum Node runtime, typecheck/build, full server/client/unit/integration, migration chain + ordered rollback, real PostgreSQL/Redis/MinIO, pgvector and unified-search planner are green.
2. Federation + AI Evidence: the legacy P5/P6 scenarios remain green and the new authored-lifecycle, remote-DM and accelerated full retry/outage evidence all PASS.
3. Self-host Evidence is green.
4. Android and iOS evidence workflows complete without a product regression; external physical-device limits remain classified rather than disguised.
5. PR #120 is mergeable and merged to `main`.
6. The resulting `main` commit is checked again; merge is not inferred from PR-head success.

### Final run ledger

Pending final closure-head CI. Run IDs, exact PASS counts, merge commit and post-merge verification are written here only after they actually exist.
