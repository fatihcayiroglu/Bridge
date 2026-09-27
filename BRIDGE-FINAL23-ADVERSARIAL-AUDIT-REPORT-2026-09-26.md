# Bridge Final23 — adversarial backend/security/privacy audit

Date: 2026-09-26  
Baseline: `bridge-v1.125.0-final22-post-ux-complete-2026-09-26.zip`  
Baseline SHA-256: `b7d8e4be9e966e38fd92740977a78e16d01fcac3aac1938c4e02d8065746c2e2`

## Scope and truth rules

Final22 was treated as the source of truth. The audit re-checked the previously identified backend/security/privacy/API/deployment findings against the uploaded Final22 source instead of assuming that the UX round fixed them. Cross-layer failures were fixed only when they were reproduced in source/contracts. No skipped or unavailable gate is counted as PASS.

This environment does **not** contain the repository `node_modules`; therefore the modified tree has not been re-certified here with the full Jest/Vitest/Svelte/Playwright/real-PostgreSQL chain. Final22's earlier certification remains evidence for the unchanged baseline only. Final23 must be re-certified in a dependency-complete execution environment before production release.

## Executive result

- Dependency-free adversarial contract: **16/16 PASS on Final23 work tree**.
- Same contract pointed at untouched Final22 baseline: **0/16 PASS, 16/16 FAIL**.
- Release-integrity standalone suite available without dependencies: **35/35 PASS**.
- Production TypeScript `any`: **0 / 0 threshold**.
- i18n: **10/10 locales, 2,270 keys each, parity PASS; 0 missing referenced keys; 0 hardcoded user-facing violations**.
- Changed TypeScript / Svelte script syntax transpile: **41 units, 0 syntax errors**.
- Generated OpenAPI JSON parses successfully.
- Product-surface contract: **122/126 assertions PASS; 4 BLOCKED by missing local `js-yaml` module**. The four failures are module-resolution failures, not product assertion failures.

## Re-check of the previously known findings

| # | Final22 finding | Final23 status | Closure |
|---|---|---|---|
| 1 | Private Discover fallback could expose private-server metadata | **FIXED** | Removed all-server fallback; Discover only reads discoverable servers. |
| 2 | `featured` private servers could appear in Discover | **FIXED** | Featured query requires `discoverable: 1`; featured cache namespace bumped. |
| 3 | Nginx `/uploads/` static serving bypassed Node authorization | **FIXED** | All shipped Nginx configs proxy `^~ /uploads/` to Bridge; no direct alias/root. |
| 4 | `/api/health/stats` trusted RFC1918/loopback source IP | **FIXED** | Requires authenticated database-admin authority; source IP is not authorization. |
| 5 | Private server OG image leaked metadata by server ID | **FIXED** | Private OG needs a valid invite or vanity capability; public discoverable servers remain public. |
| 6 | Discover/search saw only the first 50 catalog rows | **FIXED for current 1,000-row client model** | Client requests the product catalog limit; default API limit remains 50. Very large catalogs still need server-side search/pagination. |
| 7 | Backend/frontend category vocabulary drift (`edu` vs `education`, etc.) | **FIXED** | One canonical vocabulary; legacy `edu` is accepted and normalized to `education`. |
| 8 | Discoverable/private server setting existed in backend but not normal owner UI | **FIXED** | General Settings exposes discoverability and category controls. |
| 9 | Invite SVG QR endpoint returned a placeholder, not a QR | **FIXED** | SVG route uses the QR encoder and returns real QR data. |
| 10 | `/api/mobile/info` returned stale `50.0.0` | **FIXED** | Uses canonical `BRIDGE_VERSION`. |
| 11 | Vanity slug backend existed while frontend claimed it did not | **FIXED** | Real GET/PUT wiring and owner settings UI added. |
| 12 | CSP nonce detector contained literal backspace byte | **FIXED** | Literal control byte removed; regex uses a real `\b` word boundary. |
| 13 | Hidden presence still exposed status metadata | **FIXED and widened** | Both `/presence` and ordinary public profile redact status/statusText/statusEmoji; invalid legacy visibility fails closed. |
| 14 | Several backend surfaces are API-only / not wired into normal product flows | **NOT AUTO-FIXED** | This is a broader product-scope decision, not a single correctness bug; no random feature expansion was performed. |

## Additional findings discovered in this audit

### A. Public esbuild metafile information disclosure — FIXED
`/dist/meta.json` was publicly reachable in Final22 and could expose build-machine absolute paths and the module graph. The route is now denied with 404 before the static-file middleware and is non-cacheable.

### B. 2FA setup rendered text as an image QR — FIXED
The server returned a `data:text/plain` URI containing the TOTP URI while the client rendered it in an `<img>`. Final23 generates a real QR image data URI. Existing tests were strengthened so a text URI no longer satisfies the QR contract.

### C. Hidden-presence leak through normal public profile — FIXED
Fixing the dedicated presence endpoint alone was insufficient: `GET /api/users/:userId` also exposed status text/emoji. Final23 applies the same fail-closed redaction there.

### D. Vanity slug settings capability disclosed by server ID — FIXED
`GET /api/servers/:sid/slug` allowed any authenticated user who knew the server ID to learn a private server's vanity capability. The settings endpoint is now owner-only. Public `/s/:slug` behavior is unchanged.

### E. Webhook “Copy URL” was functionally broken — FIXED without leaking list tokens
The webhook list correctly hides the token, but the UI still tried to copy `wh.url`, which did not exist. Final23 shows the usable secret webhook URL exactly once from the creation response, offers a one-time copy action, then reloads a token-free list. Secret/capability responses use `Cache-Control: no-store`; capability metadata also sends `Referrer-Policy: no-referrer`.

### F. Discover OpenAPI did not match runtime — FIXED
The generated spec described category results as strings and documented stale `listed` settings while runtime returned `{id,label}` and used `discoverable`. Source/runtime/generated contracts are aligned.

### G. First-admin bootstrap hardening — FIXED/HARDENED
The setup-secret comparison now uses constant-time digest comparison and the bootstrap endpoint has a dedicated IP limiter. This was added as defense-in-depth during the adversarial pass.

## Test-honesty changes

The audit did not preserve vacuous or stale expectations merely to keep existing tests green. Focused tests were changed or added for:

- private Discover and Featured filtering;
- legacy category normalization and large-catalog request behavior;
- identity-based health stats authorization;
- private OG capability access;
- exact canonical mobile version;
- real QR image payloads for invite/2FA;
- owner-only slug settings;
- hidden-presence redaction in both user surfaces;
- one-time webhook secret URL behavior and no-store/no-referrer headers;
- server-settings slug/discovery wiring.

`scripts/final23-adversarial-contract.test.js` intentionally spans source, client, deployment and generated-contract layers. Pointing the same 16 contracts at Final22 produces **16 failures**; pointing them at Final23 produces **16 passes**. This is the negative control for the closure claims.

## Gates run in this environment

| Gate | Result |
|---|---|
| Final23 adversarial contract | **16/16 PASS** |
| Final22 negative control | **0/16 PASS, 16/16 FAIL** |
| Release-integrity standalone | **35/35 PASS** |
| Production TypeScript `any` gate | **0 / 0 — PASS** |
| i18n parity | **10/10 locales × 2,270 keys — PASS** |
| i18n source usage | **2,826 calls; missing referenced key 0 — PASS** |
| Hardcoded user-facing strings gate | **0 violations — PASS** |
| Electron native i18n/security check | **10 locales × 34 keys — PASS** |
| Changed TS/Svelte script syntax transpile | **41 units / 0 syntax errors — PASS** |
| Generated OpenAPI JSON parse | **PASS** |
| Product-surface contract | **122/126 assertions pass; 4 BLOCKED: `js-yaml` dependency unavailable** |

## Gates not run here — do not count as PASS

The uploaded source package intentionally excludes `node_modules`, and this execution environment does not have a complete compatible dependency cache. Therefore the following modified-tree certification is **PENDING / BLOCKED BY LOCAL DEPENDENCIES**, not PASS:

- full server Jest suite and server coverage;
- full client Vitest/component suite and client coverage;
- Svelte compiler/svelte-check build validation;
- Playwright Chromium/Firefox/WebKit/a11y;
- real PostgreSQL X7/X8;
- chaos campaign;
- full mutation campaign;
- production dependency audit/preflight.

Claude Code (or another dependency-complete execution environment) should run the full Final23 chain from a fresh extract. Any failure must be classified and fixed; this report is not a substitute for that certification.

## Remaining known gaps / limitations

1. **Build hash is path-dependent.** Final22's packaging report established that `esbuild-svelte` virtual CSS input paths can change the generated `app-*.js` hash when the same source builds in a different directory. Served JS/CSS does not contain the absolute path and the source ZIP remains deterministic, but reproducible compiled assets are not yet directory-independent.
2. **Discover is still client-filtered with a 1,000-row product ceiling.** The original 50-row blindness is closed. If public communities exceed that scale, server-side search/sort/pagination should replace the client-wide catalog fetch.
3. **API-only product surfaces remain a product decision.** Semantic-search/cross-channel/templates/podcast-type surfaces were not wired merely because an endpoint exists.
4. **UX program's known product gaps remain:** DM home/rail model, split search surfaces/Turkish morphology, richer media/GIF/forwarding, voice/video maturity and several smaller polish items are outside this backend/security closure.
5. External production validation such as real multi-node infrastructure, TURN/WAN media quality, code signing/store distribution and third-party security review remains external to this artifact.

## Provisional score after this source audit

This score is **not** a production certification and should be re-evaluated after Final23 full regression:

| Area | Provisional score /10 | Note |
|---|---:|---|
| Backend/API correctness | 9.0 | Cross-layer drift and several latent functional bugs closed. |
| Security/privacy | 9.1 | High-impact metadata/authz/deployment leaks closed; external audit still pending. |
| Realtime/messaging architecture | 9.0 | No new regression evidence in this pass; full E2E pending. |
| Testing/test honesty | 9.3 | Strong baseline certification plus 16/16 vs 0/16 negative-control contract; full Final23 suite pending. |
| Release integrity | 9.3 | Deterministic Final22 lineage and source-level integrity strong; Final23 package still needs fresh-extract full cert. |
| UI/UX | 8.2 | Final22 UX program is certified, but known DM/search/media/voice gaps remain. |
| Maintainability | 8.1 | Strong typing/i18n/contracts; some large surfaces and duplicated product concepts remain. |
| **Overall provisional** | **8.8/10** | Conditional on a clean Final23 full regression/fresh-extract certification. |

## Required next handoff

Treat the packaged Final23 artifact as the next source of truth, then run the complete certification chain from a fresh extract. Do not treat unavailable tests as passed, do not weaken assertions to accommodate the fixes, and preserve the 16 adversarial contracts as regression evidence.
