Title: Require the HTTP-signature acceptance control to return 202

The test advertised acceptance of valid signatures without the optional algorithm parameter, but accepted every response except 500. A verifier mutation that rejects those signatures still passed all 31 tests.

Require the documented production acceptance contract, exact 202. No production authentication or signature policy changes.

Focused commit: `a97a481f0cabed156855cc0c06db4283b417b8ac`; one test file, independent of other fixes. Cherry-pick onto main `c517364b9289d13e16101a30d080ca51125971a5` for a separate Draft PR.

Validation: correct production verifier + corrected assertion: 31 pass. Reject-omitted-algorithm mutation + old assertion: 31 pass (misleading). Same mutation + corrected assertion: 1 fails, 30 pass. These are executable verifier/route controls with mocked remote key fetch, not live federation interoperability evidence.

Remote CI is unverified because GitHub API access is blocked. This is a prepared description, not an opened PR. Do not merge without owner authorization.
