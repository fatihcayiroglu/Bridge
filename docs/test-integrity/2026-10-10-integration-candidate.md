# Repository-wide audit integration candidate — 2026-10-10

**DRAFT, UNVERIFIED COMBINED TREE. DO NOT MERGE WITHOUT OWNER APPROVAL.** This is a synthetic commit based on pinned main `c517364b9289d13e16101a30d080ca51125971a5`, for running exact-tree CI before considering the open Draft PRs. No source PR branch was altered or merged.

## Exact input heads

- #155 `c1a72a9a88e85cf4408fa7d8cd82453949cba710`: Firefox COOP warm-up, plugin registry test.
- #157 `d7e148182156eab9f4efffa0df9bce925c179d67`: zero-skipped Jest guard in CI.
- #161 `cefc15ca1d2f2e8d82e1e21cb0ce3855a9295b7d` including #156: E2E false-green fixes, voice REST route fix.
- #160 `b612a177aa42ec9d4d987dc10f098f0c2a31845e`: successful login, HttpOnly refresh cookie, profile persistence.
- #162 `e025bb159d96d6cfcf0d2d27f822d0b92edc42aa` including #159: semantic history and hidden-presence security regressions.

## Conflict handling

- `e2e/helpers/apiTest.ts`: exact-context #155 Firefox/COOP hunks applied atop #161's exported generic CSRF proxy.
- `e2e/tests/profile.spec.ts` and `settings.spec.ts`: exact-context #160 unconditional assertions applied atop #161 changes.
- `e2e/tests/security.spec.ts`: #160's full refresh-cookie test section substituted for the unchanged original section in #161, preserving #161's separate SVG/upload/rotation/CSRF tests.
- `.github/workflows/quality-gate.yml`: extends existing full-browser PR gate to this Draft branch. No retries, rate-limit or assertion relaxation.

## Unverified and excluded

This combined tree has NOT passed CI. Run exact-HEAD Quality Gate and full Chromium, Firefox, WebKit, media, a11y, keyboard and mobile-web suites with `--retries=0`, plus independent Android/iOS, federation and self-host workflows; distinguish executed tests, intentional skips and MEASURED-only scenarios. Existing Android WebView attach and federation Redis bootstrap flakes remain not proven permanently fixed. Real Cloudflare R2 and hardware-only scenarios remain unverified. **#158 is excluded** because it is a separate P7 B3 feature subject to issue #133's prior closure gate. Do not close #133, force-push, auto-merge, or touch `scripts/abuse-lab/run.mjs`.
