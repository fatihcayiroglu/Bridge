# P7 C4 — opt-in signed community export endpoint

**Status:** Source-side read-only HTTP integration on top of the exact-snapshot
issuer merged in #213 and the pinned-key verifier in #211. **NOT an importer.**

`GET /api/servers/:sid/portable-export/attested-pair` returns three
objects: `structure`, `permissions`, and `attestation`, plus explicit
read-only flags. Both manifests are built from one PostgreSQL physical client
in a `REPEATABLE READ READ ONLY` transaction, and verified/signed by the
existing source issuer. No destination mutations or approvals exist.

## Enable only on a source deployment with an independently managed key

The endpoint is **disabled by default**. An operator must supply ALL THREE
values through the server deployment secret manager/environment, not through
the HTTP request, Host header, browser, or source export file:

- `BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED=true`
- `BRIDGE_PORTABLE_SOURCE_ORIGIN=https://actual-source.example` — an exact,
  canonical HTTPS origin (no path, query, credentials or trailing slash).
- `BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64` — canonical padded base64
  encoding of a separately provisioned Ed25519 **PKCS#8 PEM private key**.

Example local key creation (run outside application processes in a secure
provisioning environment; never add this key to source control):

```sh
openssl genpkey -algorithm Ed25519 -out bridge-source-ed25519.pem
openssl pkey -in bridge-source-ed25519.pem -pubout -out bridge-source-public.pem
base64 -w 0 bridge-source-ed25519.pem
```

Store the base64 private PEM in the deployment's restricted secret vault.
Independently verify the source's ownership and transmit only the SPKI public
key to the destination operator over a trusted, out-of-band channel. The
destination pins that key separately before verifying exports. Do not
automatically trust keys embedded in artifacts or fetched through the
untrusted source URL. **Key rotation, revocation, trust registry and a durable
snapshot replay ledger are not yet implemented.** Do not use this endpoint as
a production-wide portability guarantee until those are built.

## Authorization and safety

The route requires, in order:

1. A valid authenticated session.
2. A current source community (404 if absent).
3. The authenticated **server owner**, not a moderator or member.
4. A fresh `account.export` proof in the `sensitive-export` scope.
5. A correctly configured operator key and exact canonical origin.
6. A live PostgreSQL pool; never fall back to independent repo reads or a
   nontransactional mock.
7. Successful owner recheck inside the source PG transaction plus complete,
   bounded category/channel/role/permission reads, pair validation and
   Ed25519 signature. A missing or invalid source row aborts export.

Every response sets `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. Successful JSON is sent with a fixed
attachment filename; error responses return a generic code and never contain
the configured private key or SQL/manifest details. Rate limiting applies.
The download size is bounded. Read and signer failures return HTTP 503,
not an unsigned fallback. **The signing key never crosses the response.**

No key-provisioning API, endpoint to apply or import, one-use destination
approval, destination serializable write transaction or independent
installations' round-trip proof is added here. Signed data is not itself
authorization to migrate. Source key rotation, revocation and account/
destination security are tracked by [P7 #205](https://github.com/fatihcayiroglu/Bridge/issues/205).

## Validation

- Express route test: anonymous, missing/wrong step-up, delegated member,
  missing signer config/pool, underlying issuer failures, max response size,
  forged `Host` and no local writes.
- Config test: default-off, malformed RSA/wrong PEM, invalid source origins,
  noncanonical/oversized base64, no leaked signer details.
- Existing #213: real PostgreSQL simultaneous writer read-snapshot evidence,
  bounded source query tests and offline Ed25519 signature verification.
- The required Quality Gate, Self-host, Android and Federation workflows on
  this PR's exact head must finish successfully before any merge. A scheduled
  but trigger-skipped job is not a passed test.
