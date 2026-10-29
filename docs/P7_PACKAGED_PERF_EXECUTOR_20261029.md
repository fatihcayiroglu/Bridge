# Real packaged desktop subset executor — P7 #570

Stacked on #577 (`38e6f198e7757d2f1f909e3f293b3b541855da5d`), retaining
#574 dependency fixes. P7 and #570 remain OPEN. This tooling changes no product
authentication, rendering architecture, permissions, Capacitor or Abuse Lab B1.

## Actual execution path

`scripts/perf-acceptance/packaged.mjs` launches the actual packaged executable
using Playwright's experimental Electron driver. It requires `app.isPackaged`,
`app.asar`, sandbox/context isolation enabled, node integration disabled and no
sandbox/certificate/web-security bypass flags. It hashes the actual ASAR and
records the checkout SHA, app version, OS and measurement environment. A fresh
private profile is used; existing profiles/output directories are never reused.

The runner opens the configured real HTTPS Bridge server, fills the ordinary
login form and requires a successful actual `/api/login` response. It selects
the seeded server and channels through the real UI. There is no token injection,
mock API response, replacement renderer, registry-driven history loader or fake
SFU. Authentication inputs, storage, screenshots, traces and error messages that
could contain credentials are excluded from artifacts.

- PA01: after a fixed 10-second warmup, measure 300 seconds of signed-in idle on
  a channel with one message. `app.getAppMetrics()` supplies real CPU and working
  set per process, with one-second samples and sums over observed processes.
  CPU is Electron's interval-average percentage; working set is KiB. The initial
  CPU interval is discarded. Summed working sets may count shared pages more than
  once; they are not unique physical memory or private bytes. Raw growth series
  is retained; a five-minute interval is not a memory-leak proof.
- PA08: measure at least 120 seconds while driving the product's ordinary scroll
  handler. Require authenticated message-history responses to contain exactly
  10,000 unique fixture message IDs, plus a visible fixture message in the real
  Svelte list. Record first-page visibility/traversal times, process resources,
  actual animation-frame intervals and long-task durations. Failure to traverse
  all messages fails this subset; merely seeding rows does not qualify it.

Frame intervals describe the observed renderer under instrumentation, including
history/network work and idle frames. They are not isolated GPU presentation or
input-to-photon latency. The recorded launch-to-login-UI observation includes
Playwright inspector setup and is **not** the under-1s/under-2s startup acceptance
method. No performance threshold is declared passed by collecting numbers.

PA01's SFU prerequisite is corrected: idle does not make a call. Voice scenarios
still require an actual SFU and independent clients. PA02–PA07/PA09–PA10 remain
NOT EXECUTED without their actual hardware/media/network requirements.

## Disposable CI environment

`.github/workflows/p7-packaged-performance.yml` builds the actual Svelte UI,
backend and Electron DEB, installs the DEB with its root-owned setuid sandbox,
and runs on hosted Linux/X11 under Xvfb. This is **not Wayland #416 evidence**,
physical-device certification or representative gaming hardware performance.

New job-local PostgreSQL 16 and Redis 7 service containers have no host-volume
mounts or production secrets. The fixture writer additionally requires GitHub
Actions, explicit disposable mode, a loopback PG URL and `bridge_perf_*` database
name. It inserts random test identities and exactly 10,000 history rows in a
transaction, with a real bcrypt password hash. Seeding bypasses message ingestion
only for dataset construction; subsequent UI login, authorization, history reads,
pagination and rendering use the real product. This does not test message sends.

A fresh CA and server certificate establish genuine HTTPS in front of the
unmodified loopback backend. Only that ephemeral CA is installed in the fresh
runner NSS trust database. The workflow refuses an existing NSS database rather
than replacing it. It does not use `ignoreHTTPSErrors`, `--ignore-certificate-errors`,
`NODE_TLS_REJECT_UNAUTHORIZED=0` or a sandbox opt-out. The proxy supports real
Socket.IO upgrades and never manufactures backend responses.

Only `report.json`, `resources.jsonl` and closed-stage `attempt.json` are uploaded.
Fixture credentials, TLS keys, browser profile and private backend log are not.
The private runner/container state disappears with the disposable CI job.

## Result semantics

The existing probe still reports every unavailable scenario NOT EXECUTED and
exits 3. Its Windows CLI/import file-URL handling is repaired without altering
that contract. The packaged runner exits 0 only after **both actual subset
executions** satisfy their evidence checks. Its report still has eight scenarios
NOT EXECUTED, `complete: false` and `performanceThresholdsQualified: false`.
A green subset job is not green complete performance acceptance or P7 closure.

Missing configuration exits 3 without numbers; runtime failures exit 1. Completed
prior scenarios and raw samples are retained when a later scenario fails.
There are no duration overrides or retry-for-green loops. The first runtime
attempt is authoritative for its exact head; fixes require new commits.

Preparation evidence: 10 local executor/report contract tests PASS, zero skipped;
all three new executables pass Node syntax checks on Windows. Real packaged
execution is **NOT EXECUTED** until the first hosted run is inspected. Local
PostgreSQL/Redis/container prerequisites are unavailable. No CPU/RAM/scroll
numbers or compatibility claim are inferred from these contract tests.

First hosted attempt: `1604a53fe9503c9041200f46cb61345da5a94d96`, run
40790339178 / job 123173710740. Locked dependencies, 9/9 contracts, actual
Svelte/backend/DEB build PASS. The installed-app/sandbox assertion step FAIL;
individual bare `test` commands did not identify which assertion failed. All
runtime performance scenarios on this head are NOT EXECUTED. Preserve this
failure. The follow-up prints sandbox owner/mode and explicitly provisions the
root-owned installed Chromium helper as mode 4755 in the disposable runner,
retaining both original sandbox assertions. This is **DEB plus explicit CI
sandbox provisioning**, not proof the DEB installer itself set those permissions.
No `--no-sandbox` or other sandbox bypass is introduced.

Additional gates reject connection-string host overrides/nonempty existing
product databases before fixture writes, and require the real newest and oldest
history messages to become visible during traversal.

Second attempt: `c6e132d55ccf0002d4692e61bf42bd99e4fcda05`, run 40790877387 /
job 123175498708. Build, 10/10 contracts, installed sandbox and TLS prerequisites
PASS. Before CI provisioning the sandbox helper was owner 0 / mode 755; the
explicit 4755 setup retained the strong sandbox gate. Schema/migrations applied,
then fixture insertion FAIL: PostgreSQL SQLSTATE 42703, `members._id` absent in
the actual migrated schema. The fixture used the legacy schema field. Fix it to
the canonical `(userId, serverId)` membership and retain this original failure.
Fixture diagnostics now expose only a closed operation stage and SQLSTATE, never
SQL arguments, passwords or database/error messages. No runtime scenario ran on
the second head either; no performance numbers are claimed.

Third attempt: `263db217b4ac7b28fcd0fb1b3e3c0069dedfb423`, run 40791304645 /
job 123176901232. PG16 fixture now persisted exactly 10,000 rows and previous
build/sandbox/TLS preparation passed. Backend health did not become ready within
the unchanged 60-second startup bound; runtime scenarios again NOT EXECUTED.
Inspection found the CI fixture omitted mandatory production `METRICS_SECRET`.
A controlled child-process experiment against the identical production validator
reproduced exit 1 with that secret absent and exit 0 when populated, without
connecting to a DB or printing values. The follow-up generates/masks this secret,
runs the actual production env validator before bootstrap and records only
closed HTTP/TLS failure codes on readiness failure. No gate is disabled or
startup timeout increased. Backend runtime still requires fresh exact-head proof.
History endpoint checks also require actual scroller-viewport intersection,
rather than relying on DOM/CSS visibility alone.

Fourth attempt: `36e556116789ffcc6d3d898dbee2768cdfdd053f`, run 40792240804 /
job 123180018231. Actual backend HTTPS readiness PASS; packaged execution FAIL
at launch/preconditions before any scenario. Artifact 12862282316 SHA-256
`68ee781a48582025690de98fdbf426e246142fd6c90ea172b4319e8a7ec65033`
preserves the closed failure stage. Inspection of the official
[Playwright Electron launcher](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/electron/electron.ts)
shows Linux adds `--no-sandbox` unless `chromiumSandbox` is explicitly true.
The runner now explicitly sets it true, retaining the prohibition on bypass
flags. This is a required security fix; the previous catch exposed only a broad
launch stage, so the exact fourth-run exception is not retrospectively claimed.
New diagnostics distinguish window/identity stages and expose only closed error
codes and security booleans/counts. An additional regression refuses unsafe
renderer settings, bypass flags and unpackaged/absent windows. Local contracts
are now 11/11 PASS. Actual measurements still need fresh runtime evidence.
