# P7 B3-2 — Client error report data minimization (candidate)

**Scope:** only `server/routes/client-error.ts` and its tests. **B3 remains OPEN** and the work is not a full metadata retention audit.

## Verified source behavior before this candidate
- Public `POST /api/client-error` accepted an error message and additional client-supplied fields. It stored precise `req.ip`, authenticated `userId`, full `userAgent`, URL (including query), locale, and a client-provided timestamp inside `_errorStats.recent`.
- Every accepted report refreshed the shared `client_error_stats_v1` Redis snapshot TTL to 24 hours. A rolling count of 100 capped quantity, **not per-entry age**. On-demand admin `/stats` exposed these extra fields.
- The server logger recorded the untrusted error message together with `userId`. External log exporter retention was not bounded by this route.

## Change
- Stop collecting direct IP/user/account/device/URL identifiers inside recent reports; server-side timestamps alone govern expiry. The raw message and stack remain for limited debugging, so these fields are still potentially personal or secret-bearing data.
- Filter both new and older Redis snapshots through a strict allowlist. Legacy entries without a trusted `receivedAt` are removed, rather than preserving historical personally identifying payloads.
- Expire individual recent entries after 24 hours at ingest/persistence/admin read, independent of the shared Redis key refresh. Preserve aggregated totals as existing operational counters.
- Remove the client-supplied message and user id from the structured Pino event. This does not establish retention of independently configured external log infrastructure.
- Add negative tests for identity-bearing keys and for clock/retention behavior.

## Still open
- Review remaining unstructured message/stack fields for tokens, addresses and accidental identifiers; assess whether collecting them is justified and establish a safe diagnostic alternative.
- Audit IP-reputation caches, CAPTCHA abuse state, session/device history, OTel/Sentry, request logs and timestamps individually, including deletion/export, operator/processor access, storage locations and retention.
- Validate backup/restore and multi-node Redis behaviour in live tests. This candidate is not independent live-proven privacy closure.

**Acceptance:** exact-head server and client test/coverage/zero-skip gates, real Redis integration, self-host and platform CI as triggered; no waived tests and no B3 completion claim.
