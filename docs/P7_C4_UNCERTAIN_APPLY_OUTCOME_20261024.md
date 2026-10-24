# C4 — an opaque apply error does not prove rollback

The mapped-apply route deliberately returns the same bounded
`422 PORTABLE_MAPPED_APPLY_UNAVAILABLE` for internal rollback and unknown
COMMIT acknowledgement. This prevents revealing internal token/transaction
state as an oracle. Its existing real-PostgreSQL test demonstrates that the
category update, consumed approval, snapshot barrier and audit may already
have committed when that error reaches the caller.

The UI classified this response as refused and displayed **"Nothing was
applied."** That statement contradicts the actual database outcome in the
lost-acknowledgement case. Two client regression controls fail before the
correction (36 pass, 2 fail, zero skips): the pure outcome classifier and the
mounted portability UI both report refused instead of unknown.

The client now treats only that exact opaque apply error as unknown. It
continues withdrawing the token and requiring fresh review before any retry.
Explicit input, ownership, verification and disabled-configuration responses
keep their existing classifications. The existing unknown-result notice is
neutral in all ten languages, covering either browser transport failure or
unconfirmed database acknowledgement without inventing a cause.

The server error contract, source verification, owner checks, connection
quarantine, permissions and database behavior are unchanged. No uncertain
transaction is described as successful, compensated by rollback or exposed
through a new status endpoint.

Local validation passes 146 API/proof/portability client tests across six
files and all five real-PostgreSQL atomic-apply tests, zero skips. Client
types, strict types, ESLint, all ten locale parity/usage gates and production
build pass. The existing PostgreSQL test deliberately replaces receipt of
the acknowledgement after a real COMMIT; it alone is not a broken-TCP proof.

## Real wire failure acceptance

Two additional mandatory browser checks reuse the existing multinode
`PgFaultProxy`; no new proxy or protocol implementation is added:

- B restarts with its PostgreSQL connection through that loopback proxy.
  A distinct signed snapshot and a fresh real browser owner approval are
  prepared. The proxy targets the transaction that inserts the C4 snapshot
  barrier, forwards its COMMIT and drops the database reply/connection.
- The public HTTPS API must retain its opaque 422. An independent direct
  PostgreSQL connection must prove every mapped field and exactly one
  consumption/snapshot/audit committed. The browser must say unknown, offer
  no spent token and make no false success or rollback claim.
- A fresh authenticated replay must be refused with no additional changes.
  The proxy and CA entry are removed and B's original database configuration
  is restored, including after failures.

These new wire/browser checks are authored and remain **UNVERIFIED until
their exact-head CI reports are inspected**. They extend the already-passing
six-check UI journey in #391. The old UI is also tested on an isolated
diagnostic branch; its expected failure is not proposed for merge.

Only C4's `pci_unknown` localization entry changes in each language. Claude's
channel step-up/translation work must be preserved during integration. Parent
#390 has an unresolved real Android cold-start ANR; that failure is not
dismissed or retried here. Keep the stack draft, do not merge failing PRs,
and keep #205 open for its remaining release/product acceptance gates.
