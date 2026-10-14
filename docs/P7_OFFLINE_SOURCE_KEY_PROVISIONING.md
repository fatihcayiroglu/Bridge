# P7 C4 — offline source signing-key provisioning

**Status:** Local operator-controlled Ed25519 key bootstrap only.
This does not automatically establish HTTPS origin ownership, remotely pin
trust, implement administrative rotation services, authorize import or close
the two-independent-TLS-deployment acceptance requirement in issue #205.

## Create a key OUTSIDE the Git repository

On a trusted POSIX (Linux/macOS) offline/provisioning host, create a
mode-0700 directory owned by the operator first. The CLI refuses Windows
because POSIX mode bits alone do not establish Windows ACL safety.
Use real HTTPS origin and explicit UTC validity dates, not these examples:

    umask 077
    mkdir -m 700 "$HOME/bridge-portable-key-20261014"
    node scripts/provision-portable-source-key.mjs \
      --out "$HOME/bridge-portable-key-20261014" \
      --origin https://source.example \
      --active-from 2026-10-14T00:00:00.000Z \
      --active-until 2027-04-14T00:00:00.000Z

All flags are required. The tool refuses malformed/noncanonical origins,
invalid/reversed dates, missing or duplicate options, existing output files,
a destination under the Bridge Git checkout, symlink output directories,
symlink overwrites, operator-foreign directories and any directory
accessible to group/world users. Failed file
writes clean up newly created partial files.

Three local files are created with permission mode 0600:
- portable-source-private.pem — Ed25519 PKCS#8 PRIVATE PEM. Protect this in
  the source deployment's restricted secret vault; never commit it or print
  it in CI, HTTP logs, issues, shell history or chat.
- portable-source-public.pem — canonical Ed25519 SPKI public PEM.
- portable-destination-registry.json — single-key PUBLIC trust registry
  template with HTTPS source origin, active interval and revoked=false.

The printed SHA-256 fingerprint is derived from the DER SPKI PUBLIC key.
It is not the source-owner review fingerprint. A destination operator MUST
independently authenticate the source's domain and operator, and compare the
fingerprint via a trusted out-of-band channel. No artifact, Host header,
DNS discovery, remote JWKS or submitted public key can bootstrap trust.

## Independently configure source and destination

The existing source export service requires:
- BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED=true
- BRIDGE_PORTABLE_SOURCE_ORIGIN set to the canonical HTTPS origin
- BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64 set to canonical padded
  base64 of the entire private PKCS#8 PEM, provided only through source
  deployment secret management.

The existing destination verifier requires:
- BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED=true
- BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64 set to canonical padded
  base64 of the PUBLIC JSON registry, installed out of band by the
  destination operator after authentication of the source.

The restricted metadata-only approval/apply routes remain separately OFF
until an operator explicitly enables
BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED=true and
BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED=true. Do not enable these merely
because this script successfully creates keys. No private PEM or approval
bearer material belongs in an untrusted HTTP request or in console output.

The CLI does NOT modify environment variables, configure a remote host,
call APIs, issue an import authorization or create new users/roles/channels.

## Planned rotation and emergency revocation

For rotation generate a NEW key in another protected directory. The
destination operator must verify its identity independently and explicitly
install a registry that includes BOTH old and new public pins with
overlapping active windows before the source operator switches its signer.
The new single-key template must not blindly replace a live multi-key
registry. Retired keys are never silently trusted.

On compromise the destination operator must mark the old registry entry
revoked=true through the existing trusted config path and replace the source
secret in a controlled deployment process. Revocation immediately rejects
even historically signed proofs from the revoked key. Maintain an auditable
operator record of fingerprints, origin, timestamps and approval, without
recording private PEMs, bearer tokens or raw user exports. This utility is
not a full key-custody, approval or revocation management system.

## Verification and limitations

    node --test scripts/provision-portable-source-key.test.js

This test also runs in the existing npm run test:release-integrity gate.
It checks real Ed25519 signatures and public/private key parity, expected
registry shape, fingerprint consistency, output permissions, invalid input
and no accidental overwrites. Nightly workflows not triggered on a PR
remain UNEXECUTED.

Still REQUIRED for https://github.com/fatihcayiroglu/Bridge/issues/205:
two separately deployed Bridge services over actual TLS, authenticated
source export, destination owner review and one-use approval, restricted
metadata apply, re-export parity, concurrent edits, outages, restart,
forged source proof and replay tests. User/message/grant migration remains
out of scope for this currently restricted API.
