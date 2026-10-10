# CODEX HANDOFF — Bridge security audit

Continue the security audit of `fatihcayiroglu/Bridge` from remote branch `handoff/security-audit-20261010`. The existing security Draft PR is https://github.com/fatihcayiroglu/Bridge/pull/159. Do not merge anything or modify another agent's branch. Never modify `scripts/abuse-lab/run.mjs`.

## Source and integrity

Preserve these five existing audit commits:

- `161aa969e4354c512e4dd4ec4ff18046b1a914fa`
- `5dae3293726cca4f245c05e165da925a868c044a`
- `a97a481f0cabed156855cc0c06db4283b417b8ac`
- `274d270df0c55079a5993e6170bd70e2d2f949c7`
- `8e10f51b7c60bab533edad4373414002caae4a7a`

Pinned source tree: `b26a1b1d6061e02772699a8c8eaa1fe0b9db5c21`.
Exported patch: `handoff/security-audit/semantic-followup.UNVERIFIED.patch`.
Patch SHA-256: `3f839834d08341d1f3ba86be82ebef00920c6750ca459ff2957c2360efa8a1ed`.
Integration tree: `4cced804918961678ac7b32de2ccedaaba4c5228` = pinned source plus exported patch, excluding handoff artifacts. This tree proves reproducibility, not correctness.

Read `CODEX_HANDOFF.md`, the artifact manifest and the existing audit/evidence documents under `docs/security-audits/`. Work in your own clean branch/worktree. Preserve the uncommitted follow-up edits in `/workspace/Bridge-security-audit`; do not reset, stash or overwrite them.

## Exact unfinished state

The exported test patch is **UNVERIFIED**. It adds READ_HISTORY engagement, system-message digest, and edited cached-explanation controls. No new tests were run during handoff.

The browser matrix is **INCOMPLETE**. No Chromium/Playwright/Node/npm process was running at inspection; nothing was killed or awaited. A recovered six-spec Chromium report records 60 expected results, 0 unexpected, 0 skipped, 0 flaky, duration 36,561.677 ms, one worker and zero retries. The old process exit status was not recovered and source-to-runtime binding was not re-established. See `handoff/security-audit/chromium-partial.INCOMPLETE.json`. These subset results do not validate the full matrix or the exported unit-test patch.

Remote CI for PR159 remains **UNVERIFIED**. Earlier committed-source evidence records 12,011 server tests, 806 security-corpus tests, 5,403 client tests, 127 mobile tests and 3 live PG/Redis/CSRF tests. Electron had 50 passed and one Windows-only skip. Do not transfer these results to new edits.

## Next commands

First verify artifacts; this runs no application tests:

```sh
bash handoff/security-audit/verify-handoff.sh
gh pr checks 159 --repo fatihcayiroglu/Bridge
```

Review the patch, then apply it only in your own clean working copy:

```sh
git apply --check handoff/security-audit/semantic-followup.UNVERIFIED.patch
git apply handoff/security-audit/semantic-followup.UNVERIFIED.patch
export PATH=/workspace/.bridge-env/tools/node-v24.20.0-linux-x64/bin:$PATH
cd server
npx jest --runInBand --runTestsByPath tests/semantic-confidentiality-regression.test.ts
npm run typecheck:test-strict
npm run lint
```

Set `PG_TEST_URL` and `REDIS_TEST_URL` to explicit disposable services, then run from `server/`:

```sh
npx jest --config jest.pg.config.js --runInBand --runTestsByPath tests/pg-integration/semantic-confidentiality.pgtest.ts
```

For a bounded reproduction of the selected Chromium subset, return to repository root, ensure frozen-lockfile dependencies/browser prerequisites and disposable services are ready, activate Node 24.20.0, set `MEDIASOUP_WORKER_BIN` to the verified worker, and choose a NEW absolute runtime directory:

```sh
export BRIDGE_HANDOFF_RUNTIME=/workspace/.bridge-env/codex-handoff-runtime
bash handoff/security-audit/prepare-runtime.sh
bash handoff/security-audit/run-chromium.sh
```

The runner requires the disposable `PG_TEST_URL`/`REDIS_TEST_URL`, uses port 3000, writes fresh evidence under `/tmp`, runs only Chromium with zero retries and has a bounded deadline. Its reproduction scripts were syntax-checked only. Preserve proxy/CA trust and check local service readiness; do not assume processes survived environment publication.

Finish the remaining browser matrix and S3/pgvector/media/TURN/federation/native labs in this fresh task with bounded runs and synthetic data. Do not send adversarial traffic to production or third parties. Preserve meaningful positive controls and demonstrate failures when protections are removed. Report incomplete, skipped and unverified work separately from passed checks. Keep PR155–158 and other agents' work intact; keep PR159 in Draft until its evidence is complete. No merges are authorized.
