# P7 — Bridge Trust & Social Foundation

P7 starts from the verified P6 closure and is the required foundation before P8.

- P6 closure merge: `972f30cde9719d9285e2da9a448ccd7dbae97679`
- working `main` baseline: `36e9f9c35e45bff9991833e50588c0c57551b1af`
- P7 branch: `p7/local-first-openai`
- P7 PR: #124

## Goal

Make Bridge's core communication model local-first, privacy-preserving, safer
against abuse, portable across servers, and ready for larger PostgreSQL data
volumes.

P7 is complete only when all four pillars below are measured and closed:

1. Local-First Data Architecture
2. Trust, Safety & Privacy
3. Portable Identity & Community
4. Database Scaling

P7 must close before P8 work begins.

---

## Global working rules

### 1. No scope skipping

Phase order is strict:

`P6 CLOSED → P7 → P8 → P9 → P10`

No P8 implementation is accepted while a P7 closure gate remains open.

### 2. Benchmark-driven development

Claims such as "faster", "lighter", "instant", "zero-lag" or "more reliable"
must be backed by measured evidence.

Relevant metrics include, as applicable:

- startup time;
- local database open/migration time;
- offline channel-open latency;
- reconnect convergence latency;
- API/socket latency;
- CPU and RAM;
- disk/storage growth;
- sync throughput;
- voice/video FPS;
- dropped frames;
- server query latency;
- PostgreSQL index/partition size;
- abuse-control false-positive/false-negative rates.

Each major PR records before/after measurements and the command/lab used.

### 3. Privacy by architecture

New work minimizes centralized data by default.

- only data required for authoritative server behaviour is sent centrally;
- local cache/search/AI stays local or edge-side where practical;
- sensitive local state is encrypted at rest;
- metadata collection requires an explicit operational purpose and retention
  boundary;
- E2EE material or decrypted local cache is never sent to an AI/provider merely
  to make a feature easier to implement.

### 4. Design-decision contract

Every major P7 PR must answer:

1. What real problem is being solved?
2. Why is this architecture appropriate?
3. What is the security/abuse impact?
4. What is the UX impact?
5. What is the rollback plan?

---

# Pillar A — Local-First Data Architecture

## A1. Encrypted local database

Desktop and mobile clients gain a canonical encrypted local persistence layer.

Target:

- Desktop/Mobile: SQLite-backed local state;
- web/PWA: the strongest available durable local backend with explicit capability
  reporting; do not claim native SQLite durability where the runtime does not
  provide it;
- one storage contract across adapters;
- encryption envelope independent of physical backend.

Sensitive long-lived plaintext must not remain in `localStorage`.

### Security invariants

- stable per-account namespace;
- no cross-account reads;
- local encryption keys are not stored as plaintext web-storage strings;
- AES-GCM uses a fresh nonce/IV per encrypted write;
- authenticated scope binds ciphertext to account + logical record;
- corruption fails closed and is recoverable;
- logout/account deletion closes the active store and releases in-memory key
  material.

The initial P7 implementation already begins this boundary in
`client/js/core/local-first/crypto.ts`.

## A2. Offline messaging and optimistic UI

Existing Bridge delivery semantics remain canonical:

- server stays authoritative;
- existing `ackId` idempotency remains the message-send identity;
- there is one send queue, not a second local-first queue;
- UI may render optimistic state immediately;
- network loss does not make typed/sent content disappear;
- server rejection is visible and never silently overwritten by local state.

## A3. Draft and canonical outbox migration

Move the current production-reachable stores behind the encrypted persistence
contract:

- `draft-store.ts`;
- `outbox-store.ts`.

Migration rules:

- migrate legacy plaintext only after verified encrypted persistence;
- remove the plaintext source only after successful migration;
- preserve draft identity and attachment-pending state;
- preserve outbox ordering, retry state and `ackId`;
- quota/storage failure degrades honestly and never reports a durable write that
  did not happen.

## A4. Offline message history

Authorized message snapshots are cached locally after a successful server read or
live event.

Offline channel open:

- renders the newest local window without waiting for the network;
- clearly exposes stale/offline state;
- preserves pending optimistic messages;
- does not resurrect a known-deleted item;
- does not invent current membership/permission truth.

Reconnect:

- revalidates server state;
- converges without duplicate bubbles;
- purges content the client learns it can no longer access.

## A5. Operation Log / CRDT boundary

Background sync is operation-log based first.

Initial operation classes:

- send message;
- edit own message;
- delete own message;
- desired-state reaction update;
- relevant portable-profile/community mutations.

States:

`queued → sending → applied | rejected | superseded`

A CRDT is introduced only where a measured multi-writer problem cannot be safely
represented by operation-specific reconciliation. P7 does not add CRDTs as a
fashion requirement.

## A6. Local search

Offline search covers the bounded authorized local cache.

Rules:

- no cross-account index;
- deletion and revocation remove local searchable content;
- E2EE content is indexable locally only after legitimate client decryption;
- ciphertext is not sent to a remote search/AI service;
- online global search remains server-authoritative.

## A7. Background sync lifecycle

Measure and cover:

- browser online/offline;
- Socket.IO reconnect;
- tab/process reload;
- service-worker wake where supported;
- Capacitor background/foreground;
- mobile network handover conditions available in CI/lab;
- clock skew and retry backoff;
- crash/restart during migration or replay.

There is exactly one replay owner for each operation type.

---

# Pillar B — Trust, Safety & Privacy

## B1. Anti-spam and anti-raid

Build abuse controls from measured attack patterns, not blanket friction.

Scope includes:

- account/message burst detection;
- join/invite raid detection;
- repeated mention/DM abuse;
- coordinated multi-account behaviour where observable without invasive
  tracking;
- server-configurable mitigation levels;
- moderator visibility and reversible actions;
- rate-limit behaviour that remains safe during reconnect bursts.

Required evidence includes controlled attack simulations and legitimate-user
controls so false positives are measured.

## B2. Risk-adaptive security

High-risk actions may require stronger verification based on bounded, explainable
risk signals.

Potential protected actions include:

- account recovery/security changes;
- destructive moderation;
- mass invite/member actions;
- sensitive export;
- suspicious new-session behaviour.

Rules:

- no opaque permanent user "trust score";
- risk inputs are documented;
- sensitive attributes are not inferred;
- signals have retention bounds;
- step-up decisions are explainable to the user/operator;
- accessibility and account-recovery escape paths are tested.

## B3. Metadata minimization

Audit what Bridge stores/emits beyond message content.

For each retained metadata class record:

- why it is required;
- where it is stored;
- who can access it;
- retention;
- deletion/export behaviour;
- whether a less identifying representation works.

Logs/telemetry must not become a shadow social graph.

## B4. E2EE research and hardening

P7 does not make unsupported cryptographic claims.

Work includes:

- threat model for channel/DM E2EE;
- key lifecycle and multi-device implications;
- offline/local-cache interaction;
- backup/recovery implications;
- member removal/key rotation;
- metadata that E2EE cannot hide;
- compatibility with moderation/reporting;
- measured implementation gaps.

Only properties demonstrated by code/tests are labelled implemented.

## B5. Moderation tooling

Moderators need usable controls alongside abuse prevention:

- evidence-safe reporting;
- raid response actions;
- rate-limit/lockdown visibility;
- audit trail;
- expiry/reversal for temporary controls;
- permission-safe operation under multi-node deployment.

---

# Pillar C — Portable Identity & Community

## C1. User identity export

A user can export a documented, versioned package of portable account/community
data that Bridge is allowed to expose.

Design requirements:

- machine-readable schema;
- explicit version;
- integrity metadata;
- privacy-safe defaults;
- secrets/private cryptographic keys are not casually exported;
- user can understand included/excluded fields.

## C2. Community export

Server/community owners can export portable community structure subject to
permissions and privacy constraints.

Candidate portable structure:

- community metadata;
- channel/category topology;
- roles and permission intent;
- selected settings;
- emoji/sticker metadata where licence/ownership permits;
- moderation/configuration metadata where safe.

Member private data and message history require separate policy, consent and
authorization treatment.

## C3. Import / migration contract

Portability is not proven by producing a ZIP file.

P7 requires:

- schema validation;
- deterministic import mapping;
- id collision handling;
- dry-run/report mode;
- rollback on partial import;
- explicit unsupported-field report;
- source/target version compatibility rules.

P8's Matrix/IRC migration gateways build on these contracts rather than inventing
another migration format.

## C4. Lock-in test

Closure evidence must demonstrate that a representative user/community can export
from one Bridge instance and restore/import the supported portable subset into a
fresh target without manual database surgery.

---

# Pillar D — Database Scaling

## D1. PostgreSQL table partitioning

Partition only where measured table growth/query patterns justify it.

Before implementation record:

- current row counts/size;
- hot queries;
- index size;
- write/read distribution;
- retention characteristics.

Partition design must document:

- partition key;
- pruning evidence;
- unique/FK implications;
- migration path;
- rollback;
- zero/low-downtime operational plan.

No partitioning is accepted solely because the table is "large someday".

## D2. Ephemeral channels

Add channels/content with explicit expiry semantics.

Requirements:

- user-visible expiry policy;
- server-authoritative expiry time;
- background cleanup that is idempotent;
- local cache receives/persists tombstone/expiry state;
- attachments/search/vector indexes are cleaned consistently;
- audit requirements are explicitly separated from user-visible content;
- federation behaviour is defined;
- clock skew does not resurrect expired content.

## D3. Database migration safety

P7 DB work must be compatible with P9's zero-downtime goal.

Each migration includes:

- forward path;
- compatibility window where needed;
- rollback or roll-forward recovery;
- lock/runtime impact measurement;
- production preflight;
- backup/restore implications.

---

# Cross-pillar closure gates

P7 cannot close until the final evidence ledger marks every required item PASS or
explicitly classifies a genuinely external item without mislabelling it as PASS.

| Gate | Required result |
|---|---|
| Encrypted local persistence | canonical sensitive drafts/outbox/history do not rely on plaintext long-lived localStorage |
| Offline reload | cached authorized channel history opens without network |
| Offline send + reload | no lost/duplicate message; ackId identity preserved |
| Reconnect convergence | deterministic server-authoritative final state |
| Account switch | zero cross-account local-content exposure |
| Corrupt local DB | recoverable without a send loop or server data loss |
| Storage pressure | bounded eviction; pending writes never silently disappear |
| Local search | account/channel/deletion/E2EE boundaries enforced |
| Anti-spam/raid | measured attack scenarios blocked/mitigated with legitimate controls |
| Risk-adaptive security | documented signals, bounded retention, deterministic step-up tests |
| Metadata audit | retained metadata classes documented and minimized |
| E2EE | claims match measured implementation/threat model |
| User portability | versioned export + validation + representative restore/import proof |
| Community portability | supported topology/settings round-trip proof |
| PostgreSQL scaling | partitioning decision backed by measurements and regression benchmarks |
| Ephemeral channels | expiry converges across DB/cache/search/attachments/client |
| Rollback | each major storage/schema change has a tested recovery path |
| Quality Gate | green on final P7 PR head |
| Post-merge | required `main` checks green after P7 merge |
| Evidence | P7 closure ledger records commands, run ids, metrics and known limitations |

---

# P7 implementation order

1. Local storage contract, crypto/key threat model and corruption tests.
2. Encrypted draft migration.
3. Canonical outbox migration with unchanged `ackId` delivery semantics.
4. Offline history + local search + reconnect operation log.
5. Trust/Safety baseline attack lab; anti-spam/anti-raid and risk-adaptive controls.
6. Metadata minimization + E2EE threat-model/hardening work.
7. Portable user/community export/import contract and lock-in proof.
8. PostgreSQL growth measurements; partition only where justified.
9. Ephemeral-channel lifecycle and cross-cache/search cleanup.
10. Full benchmark, abuse, privacy, migration, mobile lifecycle and rollback evidence.
11. Final closure ledger, merge and post-merge verification.

---

# Frozen downstream phase order

These scopes are recorded now to prevent P7 scope drift. They are not P7
implementation tasks.

## P8 — Bridge Next-Generation Communication Engine

Goal: modernize network transport, media, gaming/voice and extensibility.

- QUIC / WebTransport evolution from WebSocket where justified and supported;
- connection migration / low reconnect targets measured across Wi-Fi ↔ cellular;
- AV1/VP9 SVC adaptive SFU;
- hardware encoding and zero-copy capture research/implementation with FPS/CPU
  evidence;
- anti-cheat-friendly out-of-process overlay;
- in-game SDK, proximity/radio voice;
- asynchronous voice, waveforms and local AI transcription;
- isolated WASM bot/plugin runtime with capability permissions;
- E2EE P2P file distribution with origin fallback;
- encrypted Community Relay research/implementation;
- official migration gateways such as Matrix/IRC built on P7 portability formats.

## P9 — Global Scale & Production Resilience

Goal: enterprise-grade large-scale resilience.

- multi-node architecture at sustained scale;
- global edge routing;
- Redis/PostgreSQL large-scale architecture;
- zero-downtime migrations;
- disaster recovery and PITR;
- soak/load testing with documented ceilings;
- real Android/iOS device verification;
- cellular-network labs;
- VoiceOver/NVDA accessibility lab.

## P10 — Social Platform Evolution & Ecosystem

Goal: build advanced social experiences after the communication substrate is
proven.

- explainable community/event discovery;
- user-controlled social graph;
- permission-aware Community Memory and AI-assisted indexing;
- music bots/shared playlists/social listening with legal provider boundaries;
- creator/community value-transfer tooling;
- advanced analytics.

P8, P9 and P10 remain blocked until the preceding phase is formally closed.
