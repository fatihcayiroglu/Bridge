# C4 — independent-installation owner browser journey

The existing TLS lab exercised the real signed export/import APIs on separate
Bridge/PostgreSQL/Redis installations, but not the owner-facing browser flow.
This addition makes that UI flow mandatory in the existing portable scenario.
It reuses the lab's mapping, persisted-state and complete mapped-field checks;
there is no second importer or substitute browser application.

The journey has six authored acceptance checks:

1. Chromium first refuses the untrusted lab certificate. The test then adds
   only the public lab CA to the runner's NSS trust database and removes that
   entry afterward. TLS verification stays enabled throughout.
2. A's owner uses the real sign-in form and portability tab to download the
   signed source snapshot. No authentication token is injected into storage.
3. B's owner opens its actual portability tab, uploads that file, independently
   enters the source origin/community, selects explicit mappings and obtains
   server-verified review. Destination rows remain unchanged, and approval is
   disabled before explicit consent.
4. Consent stages a real unused approval. Its token must remain absent from
   DOM, localStorage and sessionStorage; metadata is still unchanged.
5. The browser's Apply action must receive an acknowledged atomic commit and
   show success. B's own database must match every supported signed field,
   preserving grants, role power and membership, with exactly one consumption,
   snapshot barrier and audit entry.
6. The journey's HTTP/WebSocket traffic stays on the two lab origins and its
   credentials, proofs, approval and private source key are absent from logs.

Fixtures are created through the existing APIs. Permission parity is prepared
independently on B; no identity, membership or grant is imported. Chromium and
its driver come from the existing E2E lockfile. The workflow installs the NSS
tool and that locked browser dependency; it does not change package versions,
coverage policy, product permissions or timeouts. The existing API roundtrip,
expiry-during-lock-wait regression and key-rotation journey remain mandatory.

These are authored checks, **not passed evidence until exact-head CI completes**.
Local syntax, diff and workflow checks do not constitute a browser run. Local
native PostgreSQL/Redis/browser infrastructure is unavailable in this managed
environment, so the existing CI deployment lab is the acceptance environment.
No request traces or HARs are saved; diagnostic artifacts contain action labels
and HTTP status codes only.

This follows #390's isolated C4 client route declarations and preserves the
existing server proof authority. Claude's D2/channel step-up work is untouched.
Production DNS/operator identity, physical hardware and explicit product-scope
acceptance remain external gates. Keep #205 open.
