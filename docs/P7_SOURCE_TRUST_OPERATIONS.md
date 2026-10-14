# P7 C4 — source-key trust operations (destination operator runbook)

A destination installation (B) trusts a source (A) **only** through B's
operator-pinned registry, `BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64`.
B never learns a key from an export, a Host header, DNS or a request.

This runbook covers the full lifecycle of that registry, using
`scripts/portable-trust-registry.mjs`:

- first pin;
- planned rotation with an overlap window;
- emergency revocation and re-authorisation;
- auditing.

The source side creates its signing key with
[`provision-portable-source-key.mjs`](P7_OFFLINE_SOURCE_KEY_PROVISIONING.md).

The CLI is offline and handles **public material only**:

- **No private keys.** It refuses any file that contains a private key.
- **Pins only confirmed keys.** It pins a key only when its SPKI SHA-256
  matches a fingerprint you confirmed independently.
- **Atomic, validated writes.** It writes the registry atomically and
  validates it with the server's own rules: canonical Ed25519 SPKI PEM,
  canonical UTC windows, at most 32 keys, at most 64 KiB, no duplicate
  origin+key.
- **Secret-free audit trail.** Every change appends one JSON line to
  `<registry>.audit.jsonl`. The line records the time, action, origin,
  fingerprints, windows, operator, reason and the SHA-256 of the resulting
  registry. Keys are recorded only as fingerprints.

Keep the registry in a directory owned by the operator that is not group- or
world-writable. The CLI refuses otherwise, because whoever can write that file
decides whom B trusts.

## 1. First pin (independent source verification)

1. **The source operator** runs the provisioning script and sends you two
   things: `portable-source-public.pem`, and *separately* its printed SHA-256
   fingerprint.
2. **Confirm the fingerprint over a second, independent channel.** For
   example, read it aloud on a call with a person you already know, or check
   a signed release note. A fingerprint that arrives in the same email as the
   key proves nothing.
3. **Pin the key:**

       node scripts/portable-trust-registry.mjs add \
         --registry /etc/bridge/portable/registry.json \
         --origin https://source.example \
         --public-key ./portable-source-public.pem \
         --expect-fingerprint <the independently confirmed hex> \
         --active-from 2026-10-14T00:00:00.000Z \
         --active-until 2027-04-14T00:00:00.000Z \
         --operator alice@dest --reason "initial pin, confirmed by phone with bob@source"

   If the fingerprint does not match, nothing is written.
4. **Deploy the registry.** Set the `env` output as B's secret/env value,
   enable `BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED=true`, and
   restart B:

       node scripts/portable-trust-registry.mjs env --registry /etc/bridge/portable/registry.json

## 2. Planned rotation (old and new keys overlap)

1. The source operator provisions a **new** key, and you confirm its
   fingerprint independently, exactly as in step 1.
2. **Pin the new key and shorten the old key's window to the overlap:**

       node scripts/portable-trust-registry.mjs rotate \
         --registry /etc/bridge/portable/registry.json \
         --origin https://source.example \
         --retire-fingerprint <old hex> \
         --public-key ./new-public.pem --expect-fingerprint <new hex> \
         --overlap-until 2026-10-21T00:00:00.000Z \
         --active-until 2027-10-14T00:00:00.000Z \
         --operator alice@dest --reason "scheduled rotation"

   The new key becomes active immediately.

   The CLI enforces these limits on the overlap:
   - it must end in the future;
   - it must fall within the old key's window;
   - it may last at most 30 days;
   - it must end before the new key expires.

   The old key keeps working only until the overlap ends.
3. **Redeploy B,** then tell the source operator to switch its signer.
   Exports signed with either key verify during the overlap. After the
   overlap ends, only the new key does.

   The order matters: B refuses any signature dated before a key's
   `activeFrom`. If the source switched before B deployed the rotation,
   exports signed in that gap stay refused.

## 3. Emergency revocation and re-authorisation

On suspected compromise of a source key:

    node scripts/portable-trust-registry.mjs revoke \
      --registry /etc/bridge/portable/registry.json \
      --fingerprint <compromised hex> \
      --operator alice@dest --reason "incident 2026-10-14-01"

Then **redeploy B immediately**. Revocation is unconditional. Once B
reloads the registry:

- **Every export signed by that key is refused,** including snapshots that
  were already reviewed.
- **Outstanding approvals for those snapshots are refused** at apply time,
  inside the write transaction. The live lab proves this as `P7-RT-20`.

To restore imports, the source operator provisions a **new** key. You
re-authorise it with `add`, confirming its fingerprint independently. A
revoked key is never un-revoked: the CLI has no un-revoke command.

## 4. Auditing

- **`list` shows the current state** of each key: `active`, `pending`,
  `expired` or `revoked`. Pass `--at` to see the state at another time,
  for example the end of an overlap:

      node scripts/portable-trust-registry.mjs list --registry /etc/bridge/portable/registry.json

- **`<registry>.audit.jsonl` is the change history.** Its `registrySha256`
  ties each change to the exact registry bytes that were deployed.
- **At boot, each Bridge installation logs** `portable.trust.effective`.
  The entry shows:
  - the source signing origin and **public** key fingerprint, if this
    installation exports;
  - each pinned key's origin, fingerprint, window and state;
  - whether the approval and apply stages are enabled.

  `portable.trust.warning` flags these conditions:
  - an invalid source or registry configuration;
  - no active pinned key;
  - a pinned key that expires within 14 days;
  - approval or apply enabled without a valid registry;
  - apply enabled without approval.

  These lines never contain private keys, tokens or step-up grants.
  Compare the source's logged fingerprint with B's pinned one to catch a
  signer that was swapped silently.

## What this does not do

- **No network discovery or key fetching.** That would break the
  independent-verification rule.
- **No automatic deployment.** Restarting B with the new value remains a
  deliberate operator step.
- **Origin ownership is still on you.** The CLI cannot prove a domain is
  owned by the person you spoke to. Step 2 of the first pin is your
  responsibility.

## Live evidence (federation lab, two independent installations)

`scripts/federation-lab/run.mjs --scenarios portable` changes B's registry
**only** through this tool, redeploying B after each step. A switches its
signer only after B has deployed the rotation, as this runbook requires.

| ID | Proven over real HTTPS against B's review route |
|----|--------------------------------------------------|
| P7-ROT-01 | `add` with a fingerprint that does not match is refused and writes nothing. The confirmed key is then pinned, and A's snapshot verifies. |
| P7-ROT-02 | During the overlap, B accepts a snapshot signed by the old key **and** one signed by the new key. |
| P7-ROT-03 | A's boot audit logs its new signer fingerprint, and it equals the key B pinned. Only public data appears. |
| P7-ROT-04 | After `revoke`, the old-key snapshot is refused (422) and the new key still verifies. |
| P7-ROT-05 | `registry.json.audit.jsonl` records add → rotate → revoke, bound to the deployed registry SHA-256. It contains no key material. |

This proves the lab rotation path end to end. It does not prove that a real
operator confirmed a fingerprint with a real person.
