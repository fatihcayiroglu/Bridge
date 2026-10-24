# C4 — approval expiry after a PostgreSQL row-lock wait

The approval claim's original conditional UPDATE checked `expires_at` before
waiting for its tuple lock. A competing transaction could hold that row without
changing it, let the approval expire, then release the lock. PostgreSQL would
continue the already-qualified UPDATE and commit the consumed approval.

A real PostgreSQL regression stages an approval, gives that fixture a
three-second lifetime, and locks its row from another physical connection.
The writer starts while the approval is fresh. An observer verifies its actual
`pg_stat_activity` lock wait and then verifies expiry using database time before
releasing the rival lock. The old helper reports success and leaves one
committed consumption. No database mock or fake clock is used.

The claim now first locks the exact token hash, destination and owner. Its
subsequent UPDATE evaluates database time with that row lock already held,
retaining every existing binding, ownership and single-use condition. The
helper also requires a writable SERIALIZABLE transaction and fences the UPDATE
to the lock acquisition's transaction ID. This prevents an autocommit session
from dropping the lock between statements. These are existing internal caller
requirements; public import services already start explicit SERIALIZABLE
transactions. This does not establish a new public autocommit attack path.

Two additional real PostgreSQL negative controls show that the previous helper
consumed approvals in READ COMMITTED and SERIALIZABLE autocommit sessions.
The clean baseline is **3 failed, 6 passed, zero skips**. After the correction,
all **21 tests across the five C4 PostgreSQL suites** and **323 portability
unit tests across 36 suites** pass with zero skips. Concurrent one-use claims,
rollback restoration, signed bindings, owner checks, replay refusal and lost
COMMIT acknowledgement behavior remain covered. Strict production/test types
pass with zero declared debt; production-source ESLint and diff checks pass.

This change adds one scoped indexed lookup per privileged import claim. It adds
no migration, dependency, grant, identity, entity creation, retention policy or
shared step-up change. It follows the credential-freshness correction in #387.
The supported import scope remains existing mapped metadata with exact grant
parity and explicit operator opt-ins. Full CI and the existing independent
two-installation TLS lab are separate gates. Keep issue #205 open until its
remaining acceptance criteria have been satisfied; D2/#375 remains Claude's
workstream.
