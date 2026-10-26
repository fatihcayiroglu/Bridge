# P7 candidate: reuse the existing socket replacement fix

Draft #460 implemented socket replacement handling at
`1db34e20b60805cd3e83e36cae09a5c709e0889a`. That commit is not an ancestor of
the #476/#477 candidate, and the candidate still contains the old MessageLoader
behavior. This branch applies that existing two-file change without modifying
it. No SocketManager or concurrent Android work is incorporated.

Room membership belongs to a socket as well as a channel. Previously,
MessageLoader attached replacement listeners but suppressed `channel:join`
when the selected channel ID stayed unchanged. Mounting with a preselected
channel before the first socket arrived also marked it joined prematurely.
Reuse #460's shared join bookkeeping, channel-plus-socket comparison, and resets
on logout, channel clearing and destruction. Reconnect and foreground joins
retain their existing reconciliation behavior.

Against the unchanged candidate production file and #460's regression tests,
the real Svelte/Vitest runner reproduced **2 failures / 24 passes / 0 skips**:
same-channel socket replacement and preselected-channel late availability both
emitted no join. Restoring the existing fix produced **26/26 passes**. Controls
keep another component's listener, deliver replacement reactions once, prevent
duplicate ready joins, and reject stale channel/logout joins. Neither source
file differs from #460's implementation.

Local full client validation ran 5,742/5,742 tests across 341 suites, with zero
failed/skipped cases. Both unchanged coverage gates passed: all-source and
production-reachable S/B/F/L 95.54 / 90.61 / 94.86 / 96.56 (rounded by the
coverage verifier). Client and bridge5 TypeScript, Svelte (zero errors/warnings),
ESLint, production build/budget, mobile shell generation and all 142 mobile
tests passed. Exact-head CI remains required before acceptance. The original #455
WebKit reaction failure still has no established first failed transition;
reproducing a socket defect does not establish that historical incident's cause.
Likewise, this change is not a claimed Android ANR or storage durability fix.

This is an isolated draft child of #477, with no merge into any source branch
or production `main`. Keep #375 unmerged and #209/#321 open. Native #425/#456
remain separate review and integration work.
