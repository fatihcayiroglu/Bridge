# P7 D2 — dormant expiry policy foundation

**NOT FEATURE-COMPLETE, NOT ENABLED.** Issue [#321](https://github.com/fatihcayiroglu/Bridge/issues/321) remains open.

This change adds fail-closed, pure server-side validation and expiry classification with Jest regressions. Production routes, workers and storage **do not call it yet**. It does not implement any ephemeral channel.

- Existing channels without expiry columns remain permanent. Explicit null is permanent.
- Timestamps use server-authoritative Unix milliseconds. At expiry equality, read eligibility is already false, even before worker cleanup.
- A durable tombstone, once written by a future implementation, must deny access even if the clock moves backwards. Malformed persisted expiry is rejected, not silently treated as permanent.
- Proposed expiry requires explicitly configured server min/max windows and explicit permanent-channel policy. Test values (1 minute, 1 day) are fixtures, **not adopted product decisions**.
- This is expiry-only eligibility, **not channel authorization**. Owner permissions, actual membership and tenant bindings must be separately enforced.

**Mandatory before user-facing activation:** policy decisions for expiry/extension; nullable PostgreSQL schema, lock/version and durable tombstone; full read/write authorization including websocket and federation; atomic tenant cleanup with durable external-storage deletion outbox; offline/client encrypted cache and outbox invalidation; skew, concurrent worker, outage, restart, migration rollback and two-instance PostgreSQL/Redis/MinIO/physical-device acceptance. Do not enable writes or close D2 until those pass. This pure unit-test PR cannot establish any of those conditions.
