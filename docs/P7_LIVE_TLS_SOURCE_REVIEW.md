# P7 C4 — two independently deployed TLS instances, signed source review

**Scope: real TLS source attestation review only. This is NOT import.**

The existing `scripts/federation-lab/run.mjs` provisions **two separate**
production-mode Bridge installations, each with its own PostgreSQL database,
Redis server, uploads and process. Their distinct HTTPS names are served by
actual TLS frontends using a lab CA; the verifier pins that CA and authenticates
each requested name. This is not two tenants in one Bridge process.

The new `portable` scenario uses that already accepted infrastructure.
Before either installation starts, the lab creates a fresh Ed25519 signer for
A and independently places **only A's SPKI public key** in B's operator-pinned
revocable trust registry. It never derives B's trusted key from the exported
manifest, Host header, network discovery or the destination HTTP request.

A source community is created on A, and a separate destination community
on B. Actual user password sign-in provides fresh `sensitive-export` and
`account-security` scoped step-up grants; no mocked credentials, grants or
signatures are used. The real HTTPS routes are exercised:

1. **P7-TLS-01** — A exports a transactional pair with real Ed25519
   signature over HTTPS. The key fingerprint matches the pre-provisioned
   public key. The response explicitly says `importSupported: false`.
2. **P7-TLS-02** — B accepts the exact source identity using its own
   operator-pinned public registry, via HTTPS.
3. **P7-TLS-03** — B refuses a tampered cryptographic signature.
4. **P7-TLS-04** — B refuses a different expected source community ID.
5. **P7-TLS-05** — B refuses an unexpected HTTPS source origin.
6. **P7-TLS-06** — An independently authenticated nonowner on B cannot
   review another owner's destination community.
7. **P7-TLS-07** — B's PostgreSQL snapshot-consumption ledger remains
   unchanged after positive and negative **read-only** review.

In CI, the mandatory Federation + AI workflow runs `portable` in the
normal lab scenario set, using its actual two TLS endpoints. Reports record
PASS/FAIL/BLOCKED/SKIPPED/MEASURED separately and fail CI if any check fails.
The precise head commit must pass before this change can merge.

The laboratory CA establishes **test transport authenticity**, not
real-world production domain ownership. These assertions do not establish
that a user inspected a mapping before approval, that a destination applied
metadata, that any users/messages/grants migrated, or that a real network
outage/restart during apply preserves topology parity.

**Follow-up:** the same scenario continues with the full owner review →
one-use approval → atomic mapped apply → re-export parity round trip, with
concurrent edits, outage, crash/restart, replay, revocation and unpinned-key
attacks: see [P7_LIVE_TLS_ROUND_TRIP.md](P7_LIVE_TLS_ROUND_TRIP.md)
(`P7-RT-01..22`).
