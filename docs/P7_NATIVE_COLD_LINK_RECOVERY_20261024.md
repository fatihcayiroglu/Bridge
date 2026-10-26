# Native cold-link restoration

The first Android run on `14b21524`,
[40119916172](https://github.com/fatihcayiroglu/Bridge/actions/runs/40119916172),
reports **35 PASS / 1 FAIL / 0 skipped / 6 measured**. DL02 times out waiting
for the cold-linked channel; D2L01 passes. The screenshot shows the restored app
on its ordinary channel. This is a real failure, not an ANR classification or
a passing rerun. Artifact `12571197664` preserves the original result.

Two tests using the default native registry adapter and the real HTTP context
fence reproduce a relevant startup ordering. A stored JWT exists before
`/api/me` establishes the AppState identity. The native router consumes the
parked cold link immediately, then the successful restore invalidates that
pre-restoration HTTP lookup. The intent is lost. A logout can also arrive after
the premature lookup has already started. Before the fix these two cases fail;
the authorized-API denial control passes.

The default adapter now uses the existing canonical navigation-owner identity
as well as the token before routing. Until then, the link remains in the
existing bounded sign-in queue. Normal restoration drains it after identity is
installed; logout forgets it. Every destination still requires the server's
permission-filtered lookup. No retry, forced navigation, reload, timeout change
or synthetic native acceptance event is introduced.

Focused native/default-adapter, native route, desktop route and HTTP-context
tests: **46 PASS / 0 FAIL / 0 skipped**. The artifact does not record every
startup callback, so this deterministic reproduction does not prove the cause
of every historical native failure. Exact corrected-head emulator acceptance
is required. Keep #209, #321 and P7 open; preserve prior failures and I07's
UNVERIFIED classification.
