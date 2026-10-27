# C4 — distinguish same-named rows during owner mapping

Bridge permits different channels to have the same name. The portability
picker left ambiguous name matches unselected, but rendered their destination
options with identical text. The source table also showed identical labels
for same-named source rows. Owners could not distinguish the actual identities
while making the required explicit mapping decision.

Two mounted-component regressions reproduce this: the two destination choices
have only one distinct visible label, and source labels omit their distinct
IDs. The clean baseline is 26 passing, 2 failing, zero skipped tests.

The picker now includes each row's exact opaque ID when its name collides
within that kind of row. Unique names retain their compact labels. Source
labels and destination options use the same name normalization as existing
auto-suggestions, which still never choose an ambiguous match implicitly.
Per-kind label maps are computed once when a snapshot/target changes, rather
than scanning all names for every rendered option. Map keys also support
opaque IDs such as `__proto__` without object-prototype side effects. Display
labels never mutate signed rows or become authorization credentials.

Select values and posted mappings remain the original IDs. A regression
explicitly selects the second same-named target and checks the exact reviewed
request body. Existing owner proof, signature, permission parity, topology
version, single-use approval and PostgreSQL guards remain authoritative.
The table keeps long identities within its available width.

Local validation passes 121 API/proof/portability tests across four files,
zero skips. Client types, strict types, bridge types, Svelte checking (zero
errors/warnings), full client ESLint, production build and diff checks pass.

The existing real browser lab now creates actual duplicate-named channels
through both installations' APIs, with different default/explicit grants.
Mandatory P7-UI-09 checks distinct visible source/destination identities and
no implicit choice before the real review/apply/database-parity journey.
The real COMMIT reply-loss and replay journey remains mandatory too.
This new live identity check is **authored, not passed evidence until its
exact-head CI report is inspected**.

This dependent C4 draft follows #392. No permission, identity transfer,
dependency, schema or channel-administration change is included. Preserve
Claude's D2/Android work and the unresolved #390 cold-start ANR evidence.
Do not merge failing PRs or close #205 before full release/product acceptance.
