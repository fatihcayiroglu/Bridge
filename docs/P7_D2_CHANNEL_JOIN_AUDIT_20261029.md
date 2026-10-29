# P7 D2 channel join expiry and stale navigation

Base #582 exact8ad479cbe5da7d6cea5ad55e67fbed445d966138. Original histories preserved; no main merge/deployment. P7/#321 OPEN.

## Reproduced defects

Four added cases initially failed on the parent: expired channel admitted; explicit rejoin retained an expired subscription; delayed old join replaced a newer selection; explicit leave did not cancel a pending join. Six existing visibility controls passed, zero skipped. First failure JSON preserved locally as bridge-p7-channel-join-red-20261029.json. This is in-process handler regression evidence, not a network/browser result.

## Change

After actual membership/visibility permission checks, reuse the canonical PostgreSQL live-row/tenant/tombstone/database-clock authority before admitting a subscription. Unknown authority fails closed. A refused request removes only its own target room/currentChannel pointer; unrelated existing rooms survive. Missing row/membership or denied visibility similarly cannot retain that target on rejoin. A per-socket generation rejects stale async results; explicit leave cancels only the matching pending destination, preserving a different newer selection.

No ACK/authentication protocol, membership permission, expiry schema, cleanup or data-retention policy is weakened. The existing live-membership eviction infrastructure and channel:leave semantics remain. This is a preflight, not an atomic lifetime fence. It does not evict already-connected subscribers automatically when no event occurs, qualify watch/voice/thread rooms, or establish cluster-adapter delayed-join behavior.

## Verification

Local original/new visibility/expiry/canonical-policy suites:21 tests PASS, zero skipped. Production TypeScript PASS and strict test debt0. Four real-PG/Redis cases added: live-to-expired rejoin, stale initial DTO versus expired SQL row, permanent row with real tombstone, and expiry after actual asynchronous visibility permission work. Real-service CI pending; NOT EXECUTED locally (no PostgreSQL/Redis). These use production repositories/permissions/handler with a transport double; they do not claim Socket.IO authentication/real-client E2E or full D2 expiration/cleanup acceptance.

All original scheduling/voice/thread tests remain in the focused candidate workflow. Aggregate CI counts include parent tests and must not be summed with prior PR totals. Initial failures remain on record. Remaining expiry activation, full writer/room graph, transactional protocol, cleanup/reconnect/crash acceptance and owner lifecycle decisions remain OPEN.
