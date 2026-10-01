# Interop, AI and reliability (P6)

P6 takes the gaps P5 carried forward and turns as many as possible into:
- implemented behaviour;
- reproducible regression tests;
- realistic integration evidence;
- clearly bounded limitations.

P5 is closed and frozen. Its results are referenced here, never rewritten:
`docs/P5_FEDERATION_AI_SELFHOSTING.md` and the P5 entry in `CHANGELOG.md`.

Every result carries one status: **PASS**, **MEASURED**, **SKIPPED**, **BLOCKED**,
**UNVERIFIED** or **KNOWN LIMITATION**. Only PASS satisfies a closure item. Every defect is
classified as a **product defect**, **test/harness defect**, **environment/infrastructure**
issue, **known documented limitation** or **external/unverified** item.

Evidence kinds are kept apart:
- **real** — real processes and real network traffic;
- **accelerated** — real processes on a shifted wall clock;
- **unit** — in-process, with doubles.

A Bridge-controlled stand-in is never called third-party evidence. A local mock is never
called hosted-provider evidence.

## Baseline

- **`main` at the start of P6:** `9b7a13e6a4b6a57a69e7d871cab4c79f8500feee`, the P5 closure
  (PR #117). The remote was fetched and verified before any change.
- **P5 status:** CLOSED. All 30 closure items PASS.
  - Final Quality Gate 36918660969: 8/8 jobs; the nightly ran.
  - Final media lab 36918666616: 77 PASS / 0 FAIL / 0 BLOCKED / 0 SKIPPED.
- **Working tree:** clean. Branch `claude/modest-albattani-fgg0uc` restarted from `main`.

## Audit of the P5 → P6 carry-over (against the code on `9b7a13e`)

Each row was checked in the code, not taken from the P5 report.

| # | Carry-over | Initial status | What the code actually does |
|---|---|---|---|
| 1 | Per-server AI opt-out | **Genuinely open** | No server-level AI setting exists. The only per-server AI flag, `autoModerate`, is read in 3 places but has no column and no writer, so it is always off. Provider calls are reachable from summarize, suggest-reply, the three stream routes, moderate, auto-moderate, translate, semantic search/digest, discover-match, voice-message transcription, the auto-moderation job and the embedding job. The only gate is the installation-level `AI_PROVIDER`. |
| 2 | Outbound `Update`/`Delete` | **Genuinely open** | Bridge-authored federated objects are Notes published through the C2S outbox (`POST /api/federation/users/:u/outbox`); they are stored as `Create` rows in `ap_activities` and fanned out through the durable queue. Bridge never emits `Update` or `Delete`, and there is no way to edit or delete a note. `GET …/notes/:id` always serves the original object. |
| 2b | Inbound `Update`/`Delete` ordering | **Open (found in audit)** | Inbound `Update` overwrites content with no `updated` comparison, so a late, older Update replaces newer content. Inbound `Delete` removes the row, so a `Create` redelivered after the `Delete` recreates the note. Both are to be proven by test before fixing. |
| 3 | Remote DMs in the UI | **Genuinely open** | A direct note from a remote actor is stored in `ap_messages` with `visibility: 'direct'` and `targetUserId`. No route reads it back for the recipient, and the client has no federation surface at all. A direct note from an actor that maps to a local account goes into ordinary DMs. |
| 4 | pgvector embedding caller | **Partially implemented — the P5 wording was inaccurate** | P5 said nothing calls the writer. The writer `saveMessageEmbedding` indeed has no caller, but a daily batch job (`jobs/embedHistory.ts`, 03:00 UTC, when `PGVECTOR_ENABLED=true`) calls `generateEmbedding` for every server message with `embedding IS NULL`. That path: (a) lacks the E2EE guard the writer has; (b) also embeds deleted rows' placeholder text; (c) has no per-server control; (d) ignores `AI_PROVIDER=none`; (e) leaves the old vector after an edit; (f) embeds new messages only on the next daily run. Vector search already filters by viewable channels and `deletedAt`. |
| 5 | Retry schedule under a real multi-hour outage | **Open** | The 12-step / ≈3.5-day default schedule is proven by unit tests. The P5 lab proved one retry (≈46 s). The queue uses JS `Date.now()` for `nextAt` and claims, so a shared shifted wall clock drives the real scheduler. libfaketime 0.9.10 shifts Node's `Date.now()` at runtime while timers keep real time (probe on this machine). |
| 6 | Third-party ActivityPub interop | **External / UNVERIFIED** | ADR-0004 names Mastodon/Pleroma as the target ecosystem. The P5 lab remote was lab code. This sandbox cannot download third-party servers (github.com release pages: 403 through the egress proxy), but CI runners can. |
| 7 | Hosted AI provider smoke | **External / UNVERIFIED** | No provider credentials exist in this environment, and no workflow references provider secrets. Ollama was never run in P5. A real Ollama can run in CI without credentials. |
| 8 | Record the missing unverified items | **Open** | Third-party AP interop and hosted providers are missing from the P5 evidence limitations. They are recorded here (§ External / unverified). P5 is not edited. |
| 9 | MEDIA-11 | **Known limitation (intermittent)** | `docs/MEDIA_RELIABILITY.md`. It passed in the last three full media-lab runs, which does not prove it fixed. |
| 10 | UP-02 / UP-06 (multi-node) | **Known limitation (intentional, per-node staging)** | `scripts/multinode/known-limitations.json`. Supported configurations are shared upload staging (PASS) and load-balancer affinity (PASS). The recorded follow-up is node-independent object-storage staging. |
| 11 | P4 physical devices | **External / UNVERIFIED** | Physical Android/iPhone, real FCM/APNs, radio handover and audio routing. Not available here. |

### Defects found in the audit (to be reproduced before any fix)

| ID | Area | Observation in code | Why it matters |
|---|---|---|---|
| AI-09 | AI / installation control | `routes/voicemsg.ts` sends every voice message's audio to Groq or OpenAI whenever `GROQ_API_KEY` or `OPENAI_API_KEY` is set. It reads the keys from the environment itself, bypassing `lib/aiProvider.ts`. | `AI_PROVIDER=none` does not stop it, although `docs/AI.md` promises "AI is off even if keys are set". There is also no server-level control. |
| AI-10 | AI / installation control | The embedding path (`lib/pgvector.ts`, query embedding in semantic search, and the daily batch) has its own provider config and ignores `AI_PROVIDER=none`. | It is the same broken promise: with `PGVECTOR_ENABLED=true` and `EMBEDDING_PROVIDER=openai`, message text reaches OpenAI with `AI_PROVIDER=none`. |
| AI-11 | AI / embeddings | The batch embedder has no E2EE guard, embeds deleted placeholders, and leaves stale vectors after an edit (row 4). | E2EE payloads (ciphertext) would be sent to a provider, and search would rank on text that no longer exists. |

The work items below are filled in as P6 proceeds.

## Workstreams

### W1 — AI: per-server opt-out, and one master switch (carry-over 1; AI-09, AI-10)

**Intended contract.**

| Level | Who sets it | Where | What "off" means |
|---|---|---|---|
| Installation | Operator | `AI_PROVIDER` | Nothing anywhere is sent to an AI provider: chat, voice transcription, embeddings. P6 made transcription and embeddings obey it (AI-09, AI-10). |
| Server | Owner | `servers."aiEnabled"`, migration 078, default TRUE | Nothing from that server is sent to an AI provider: channel context, message text, voice audio, search-query embeddings, tags or name for recommendations. |

Rules for the server setting:
- **Who can change it.** The owner only (`PATCH /api/servers/:id`, the existing owner-only route), and only with a real boolean.
- **Where it is read.** From the database on every request. It is never cached and never taken from the request.
- **Order of checks.** The requester's own permission check runs first, then the server setting.
- **Failure mode.** Fail closed: a missing or unreadable server means "no AI".
- **Fallbacks.** Routes with a local fallback still answer, flagged `aiDisabledForServer`. Streams and translation answer 403 `AI_DISABLED_FOR_SERVER`.
- **Translation.** It is gated when the client sends `serverId`. Free text without one cannot be attributed by the server; this is a bounded limitation, documented in `docs/AI.md`.

**Implementation.**
- `server/lib/aiServerPolicy.ts`: one reader, fail-closed.
- `server/lib/aiInstallation.ts`: the master-switch rule, dependency-free.
- `aiProvider.transcriptionTarget`.
- The gate is applied in:
  - `aiContext.readChannelForAi` (all three stream routes);
  - `summarize`, `suggest-reply`, `discover-match` and `/ai/status`;
  - `moderate`, `auto-moderate` and the auto-moderation job;
  - `translate`;
  - semantic `search` and `digest`;
  - `voicemsg` transcription.
- Owner endpoint: `PATCH /api/servers/:id`.
- Client: Server Settings → General toggle, in all 10 locales.

**Defects.**
- **AI-09 (product defect).** Reproduced on `9b7a13e`: 5 of the new transcription tests failed. With `AI_PROVIDER=none/off/rules` and both keys set, audio went to Groq. With `AI_PROVIDER=gemini` it went to Groq/OpenAI. With `AI_PROVIDER=groq` and no Groq key it fell back to OpenAI. Fixed: all pass.
- **AI-10 (product defect).** Reproduced: 3 failing tests. With `AI_PROVIDER=none/off/rules` and `PGVECTOR_ENABLED`, `EMBEDDING_PROVIDER=openai` and a key set, text went to OpenAI. Fixed. Control: with `AI_PROVIDER` unset, embeddings still work.

**Regression evidence (unit / in-process).**
- **`tests/ai-server-optout.test.ts`: 50 tests.** It uses the real routes, real permission resolution, the real provider module and the in-memory DB. Only the outbound HTTP function is replaced, and every request is recorded.
  - Positive control: an enabled server reaches the provider from all 9 routes.
  - Disabled server: 0 provider requests from all 9 routes, and the private canary never appears in anything sent out.
  - The neighbouring server is unaffected on all 9 routes.
  - Discover-match sends neither the opted-out server's name nor its tags.
  - An AI summary cached before the opt-out is not served after it. Re-enabling restores AI on the next request.
  - Non-members get the permission refusal, not the setting, and cause no traffic.
  - Owner only; non-boolean values are refused; `/ai/status` reports to members only.
  - **Negative control:** with the gate module replaced by "always allow", the same opted-out-server requests reach the provider (2 requests, canary included).
- **Other suites:**
  - `voicemsg-transcription-provider`: +8 (AI-09 matrix, server gate, control).
  - `pgvector`: +4 (AI-10 matrix, control).
  - `jobs-autoModeration-deep`: +2 (server gate, control).
  - Client `server-settings-ai-optout`: 6. `server-settings-general-component`: +2.
- **Real PostgreSQL** (`tests/pg-integration/server-ai-optout.pgtest.ts`: 6 tests):
  - the column is NOT NULL with default TRUE;
  - a pre-078 insert allows AI;
  - the opt-out written through the repository is read back by a **fresh connection** (a restart);
  - re-enable is read on the next call; neighbours are independent;
  - NULL is refused;
  - a missing server means "no AI".
- **Migration rollback gate (ordered, local, PG 16):** 62 LOSSLESS (P5: 61, +078), 0 ACTUAL_FAILURE, chain 0 lost / 0 extra.

**Integration evidence (real processes, real HTTPS, real provider process).** Federation lab scenario `aiserver`, F-AIS-01..07, run locally with the P5 `ai` scenario:

| Check | Result |
|---|---|
| F-AIS-01 | Control: with AI allowed, S1 content reaches the provider |
| F-AIS-02 | A non-owner member gets 403 and the setting is unchanged |
| F-AIS-03 | The owner turns AI off |
| F-AIS-04 | S1 sends **0 provider requests** from summarize, suggest-reply, ask/stream, translate, semantic search and digest |
| F-AIS-05 | The neighbouring server S2 still uses AI (6 requests), with no S1 content in them |
| F-AIS-06 | **After installation A restarts**, S1 still sends 0 provider requests |
| F-AIS-07 | After re-enabling, the next S1 summary is computed by the provider |

Result: F-AIS-01..07 **7 PASS**. The P5 checks F-AI-00..14 in the same run were all still PASS: 27 PASS, 1 MEASURED, 0 FAIL in total. CI run IDs are recorded with the PR.

**Harness notes.**
- **H-11 (test/harness).** The first lab run hit 429 from the AI rate limiter (10/min per user, a product setting). It sent every round as the same member that the P5 `ai` scenario had already used. Each round now uses its own fresh member; the product limit is unchanged.
- **H-12 (test/harness).** The re-enable check assumed a provider call. The cached AI summary of an unchanged message set, computed while AI was allowed, was served instead. That is correct behaviour. The check now posts a new message first, so the summary must be computed again by the provider.
- **H-13 (test/harness, first CI run of PR #118).** In the full lab, `aiserver` aborted with 429 from `/api/csrf-token`.
  - The scenario used the instance admin as server owner. The scenarios before it had already spent that user's CSRF budget (20 tokens per 5 minutes per user, a product setting).
  - Local runs used only `ai,aiserver`, so they never got there.
  - P6 scenarios now register their own owner. The product limit is unchanged.
- **H-20 (test/harness, iOS simulator, first CI run of PR #118).** I07 reported FAIL ("no dispatch and no confirmation alert") on a runner where the app launch took 192 s.
  - The simulator OS log was streamed starting only 3 s before the first `openurl`. Only the *second* link's routing line was recorded, and with the first link's confirmation alert still on screen there was no second alert to see.
  - On `main`, the same check reports UNVERIFIED (alert seen). This PR's diff does not touch deep links.
  - The stream now starts before the app launch, and the link is opened only after the stream reports that it is filtering.
  - The I07 rule is unchanged: PASS needs the dispatch line, UNVERIFIED needs the alert, anything else is FAIL.

**Known limitations.**
- Free text sent to translate without `serverId` cannot be attributed.
- `autoModerate` (a pre-existing server flag) has no writer and no column, so auto-moderation never runs (found in the audit; not changed in P6).


## External / unverified

_(filled in at closure)_

## Closure bar

_(filled in at closure)_
