# Final combined P0 candidate + real toast accessibility test (2026-10-10)

Draft verification branch, **NOT owner-approved for merge**.

- Base exact tested #165 tree: `67413d592c7633ba2356fe0082afe343392797ec` (original #163 integration + #164 visual assertions).
- Exact additional #166 toast test change: `eeb12c6ab27b163c80aac359a8fa6cf711d42db0`.
- In `e2e/tests/a11y.flows.spec.ts` only the original vacuous conditional toast block is replaced, retaining #161's unrelated higher-contrast and fixture changes.
- Quality Gate's full browser + media job is enabled for this branch to obtain same-head zero-retry Chromium, Firefox, WebKit, media, keyboard/mobile/a11y and visual assertions.
- No code changes to product security gates, CSP, production rate limits or abandoned `scripts/abuse-lab/run.mjs`; no test skip, assertion weakening or retries.
- Prior source PRs stay untouched. Their independent CI runs are not proof of combined status.
- Remaining issue #133 gaps: WebAuthn browser step-up under isolated IP budget, conditional remote link-preview tests, intermittent 404 stylesheet root, actual Cloudflare R2 and hardware-only labs, and Android/federation startup-flake root causes. Maintain explicit external classifications; issue remains open.
