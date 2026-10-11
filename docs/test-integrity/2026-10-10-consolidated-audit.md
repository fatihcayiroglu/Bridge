# Consolidated P0 audit CI candidate (2026-10-10)

**DRAFT / NOT VERIFIED / DO NOT MERGE WITHOUT EXPLICIT OWNER REVIEW.**

Exact parent tree: PR #167 `cdf6926038b3208e4a69af38ec0c68059b8f97dd` (contains #155, #157, #160, #161/#156, #162/#159, #164 visual UX-6, and #166 non-vacuous toast accessibility).

Additional changes:
- #168 `82e55d332857fea793fb0a8fade068b1d8bd8b31`: applied five exact-context link-preview test hunks atop #167's SSRF changes. 200 response schemas and deterministic POST responses are mandatory; public OG 404 and cache timing are labelled `EXTERNAL_UNVERIFIED` rather than counted as remote successes.
- #169 `9205ddfd19f30ecce167057e258d2cc3b7cd255e`: applied the exact WebAuthn browser step-up spec (unchanged main version in #167). Its `e2e/helpers/clientAddress.ts` already exists byte-identically in this tree (`eab60cccf7430bc3cf431809ea5eb1ea7e3f0d12`); no duplicate helper.
- Updated Quality Gate full browser/media PR gate for this exact branch, retaining `--retries=0` and true changed-spec collection.

#165 and #167 combined CI, #168 preview E2E and #169 WebAuthn E2E have NOT all completed at this candidate creation. Successful independent CI DOES NOT prove this exact tree passes. The #169 first TypeScript failure (missing helper before inclusion) stays logged. Do not close issue #133 until exact-head Chromium/Firefox/WebKit/media/visual/a11y, real SQL/S3, Android/iOS/selfhost/federation evidence and classification of R2 hardware/externals. #158 P7 B3 remains separate; no changes to `scripts/abuse-lab/run.mjs`.
