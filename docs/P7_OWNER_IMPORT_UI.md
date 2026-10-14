# P7 C4 — owner-facing portable community UI

**Where it lives:** Server settings → **Move community**. Only the community
owner sees this tab, and the server still checks ownership and step-up on
every call.

**What it does:** it drives the existing default-OFF API end to end. It adds
no import capability of its own; what can be transferred is defined in
[P7_PORTABLE_IMPORT_SCOPE.md](P7_PORTABLE_IMPORT_SCOPE.md).

## Export (source owner)

**Download signed snapshot** calls `GET /portable-export/attested-pair` and
saves exactly the three signed documents: structure, permissions and
attestation.

If the installation has no signing key configured, the UI says so and asks
the owner to contact the operator. It never shows a generic error for that
case.

## Import (destination owner)

1. **Choose the file.** It is parsed defensively (at most 1 MiB, duplicate
   IDs refused). Its origin, community and signing time are shown as
   **claims**, labelled "not verified yet".
2. **Type the expected source.** The owner enters the source address and
   community ID that the source owner gave them. The values are **not**
   copied from the file. A live warning appears when they differ from the
   file's claims. The typed values, not the claims, are sent for
   verification, so a snapshot of another community is refused.
3. **Prepare the mapping.** The UI fetches the live target fingerprint and
   the owner's own structure. Each source item gets a dropdown limited to
   existing destination items of the same kind (and the same channel type).
   - Only unambiguous name matches are pre-selected.
   - Unmapped or duplicate choices block the review.
   - Nothing is ever created.
4. **Verify signature and review.** The server checks the signature against
   its operator-pinned keys and the mapping against live topology. The UI
   then shows:
   - every name that will change;
   - the fixed promise that permissions, role power, members, messages and
     files stay as they are;
   - a blocked state when roles would widen or the source has per-user or
     legacy grants. In that state there is no Approve button.
5. **Approve.** This needs an explicit consent checkbox. Approval returns a
   one-use, 120-second token.
   - The token is held **only in component memory**. It is never rendered or
     stored, and the tests check this.
   - A countdown is shown, and the approval is withdrawn when it expires.
   - If the owner's proof is too old, the server asks for a fresh one (see
     #239) and the client prompts once.
6. **Apply.** On success the UI shows the updated counts.
   - **422:** "nothing was applied; review again".
   - **No answer at all (connection dropped):** "outcome unknown". It is
     never reported as a failure. The owner is told to review again,
     because an approval can never apply twice.
   - In every case the token is discarded after the attempt.

Any change to the file, the expected source or a mapping choice invalidates
every later step. Late responses from an earlier step are ignored.

## Tests

- **`client/tests/portable-community-import.test.ts`:** parsing, origin
  validation, the suggestion rules, mapping completeness, exact request
  shapes (allow-listed keys and confirmation constants) and status
  classification.
- **`client/tests/portable-community-tab.test.ts`:**
  - non-owner view;
  - export and its disabled state;
  - invalid file;
  - claim mismatch;
  - full review → approve → apply;
  - token never in the DOM or storage;
  - "outcome unknown";
  - refused apply, unverified review and disabled installation;
  - blocked widening;
  - approval expiry;
  - invalidation on mapping change.

## Not covered here

- **No end-to-end browser run against two live installations.** The
  federation lab covers the API path between two installations (#236).
- **No native-app-specific UI checks.**
