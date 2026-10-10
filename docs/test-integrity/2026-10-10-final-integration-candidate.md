# Final P0 test-integrity combined CI candidate (2026-10-10)

**DRAFT, DOES NOT CONSTITUTE A MERGE APPROVAL.** This exact-tree candidate layers #164's verified UX-6/theme assertion coverage on top of Draft #163's pinned security/test-integrity integration without mutating either source branch. It must be separately tested at its own HEAD before claiming combined success.

Sources:
- #163 `e1cb43d3363f12410817db383c155f1bb9a54601` (integrates #155, #157, #160, #161/#156, #162/#159).
- #164 `986bde68b0f2b8d1abc3300159f4e9780e83efbe` (visual assertion CI, honest fixture setup).

Both source PRs had successful exact-head Quality Gates. #163's full Chromium, Firefox, WebKit, media, a11y, mobile suite ran without retries; #164's UX-6 and theme assertion checks ran 2/2. **Independent green runs do not prove this combined tree passed.**

The workflow keeps full browser/media job enabled for this branch and runs the two visual assertions on PR. Image metadata P7 B3 in #158 is excluded and remains separate. No changes to `scripts/abuse-lab/run.mjs`. Issue #133 remains OPEN until entire audited scope and external limitations are dispositioned. Do not force-push or merge Draft PRs without owner approval.
