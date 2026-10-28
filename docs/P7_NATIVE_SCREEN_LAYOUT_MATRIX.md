# Bridge P7 native screen-size smoke matrix (draft)

This workflow is a **signed-out UI layout smoke**, not a statement that an
Android or iOS version or every screen size is compatible with Bridge. It builds
the **real React Native/Expo** Android APK and iOS simulator app, launches them,
and checks the visible `Bridge`, `Session: signed-out`, and browser sign-in
control. It captures screenshots and a per-profile PASS/FAIL/NOT_EXECUTED record.

The Android `pixel_6` emulator runs four **logical display overrides** on API 35:

| Profile | Pixels | Density | Approximate logical width |
| --- | --- | --- | --- |
| compact | 720 × 1440 | 360 dpi | 320 dp |
| standard phone | 1080 × 2340 | 440 dpi | 393 dp |
| large phone | 1440 × 3200 | 560 dpi | 411 dp |
| tablet-sized viewport | 1600 × 2560 | 320 dpi | 800 dp |

**Not physical sizes:** neither 6.2 nor 6.5 inches is established by `wm size`
and `wm density`. Device-specific cutouts, curved edges, hinges, manufacturer
keyboard behavior, and true tablets require additional devices. The tablet-sized
Android viewport still uses Pixel hardware.

The iOS job uses **fresh, isolated simulator devices** selected from installed
device types: small iPhone, standard iPhone, large iPhone, and iPad. It records
the exact device type and runtime; a missing family stays NOT_EXECUTED and
makes the job red. It deletes only devices created by its own run.

**Honesty contract**

- No job retries or skipped acceptance cases. Readiness polling is bounded and
  is not counted as a new test attempt. Earlier failures remain recorded.
- Every required profile must pass; FAIL or NOT_EXECUTED means the matrix is red.
  A missing simulator, screenshot, UI hierarchy, or required control is not PASS.
- Android checks the actual view hierarchy and that the required elements are
  inside the selected display bounds. iOS uses Vision OCR on a real screenshot.
- Screenshots, UI dumps/OCR, device/viewport inventory, exact source SHA,
  diagnostics, and result JSON are attached to the first GitHub Actions run.
- The normal signed-out UI uses a deliberate non-production HTTPS origin, **not**
  an authenticated backend. This does **not** validate PKCE, refreshed sessions,
  messaging, voice/video, uploads, push notifications, or account migration.
- Portrait is the only app orientation currently enabled in `app.json`.
  Landscape, split screen, foldable postures, accessibility font scaling,
  physical Android/iOS devices, and iCloud restore are **NOT COVERED**.
- The independent Android OS-version matrix (API 24/35/36/37) remains separate;
  API 37 SDK-unavailable is NOT_EXECUTED, not a device compatibility failure.

Do not merge a branch based on partial green jobs. Review the exact-head
screenshots and logs for every selected size first. Do not treat a parent PR's
green jobs as evidence for an untested new head.
