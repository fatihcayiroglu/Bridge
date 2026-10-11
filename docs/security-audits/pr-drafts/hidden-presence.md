Title: Honor hidden presence in shared serializers and activity responses

Users with hidden presence still exposed status text/emoji and work activity through shared serialization, direct cached activity reads and shared-server rosters. Dedicated profile masking did not protect these alternate paths.

Mask public presence fields, preserve the owner's own fields, check current privacy before activity cache hits, omit hidden activity from rosters and suppress it in broadcast payloads.

Focused source commit: `5dae3293726cca4f245c05e165da925a868c044a`. Three files, independent of the semantic and metadata-minimization fixes. A separate branch can cherry-pick this commit from main `c517364b9289d13e16101a30d080ca51125971a5`.

Validation on the composed audit checkout:
- Five initial tests fail on main.
- Final six tests pass with visible-user and owner positive controls, warm/uncached reads, visibility transitions, roster and socket payload checks.
- Restoring main's serializer/activity route in a disposable copy makes all six fail.
- Full composed server suite: 12,011 pass, 0 skips; typechecks, lint and build pass.

The socket emitter is mocked; live room delivery and cross-node transitions remain unverified. Existing room naming is unchanged. No auth/upload route from PR 158 was edited.

Remote CI is unverified because GitHub API access is blocked. This is a prepared description, not an opened PR. Recheck active work before publishing a Draft PR; never merge without owner authorization.
