# Android Settings navigation — review candidate, P7 OPEN

Base: #560 at090defc733e07c8c8c6b578430830f2e49e1dfe3. Its actual backend
run40730509047 passed19/19 PostgreSQL16/Redis integration cases,121/121 handler
contracts and3/3 strict Chromium cases, zero skipped. That evidence is preserved.

Its normal-screen Android run40730509075/job122965228372 failed before all3
authentication cases, at `normal-settings-ca-install`,
`SETTINGS_CONTROL_UNAVAILABLE`:0PASS/0FAIL/3NOT EXECUTED/0skipped cases. The original
artifact is retained with SHA256
`44947130f86df027979f8f43e438bf55ff94cfbdda93eae3765d6836bd958956`.
The screenshot shows More security & privacy, Encryption & credentials, and a
foreign Pixel Launcher ANR overlay. Ten foreign Launcher dialogs were recorded;
settingsHopTaps/pinEntries/CA-file taps were all0 and lastWait was absent.
The exact failed hop or reason a particular tap was lost is NOT established.

Code review found that the first three Settings actions returned immediately
after one tap, without proving navigation. The next action could therefore
search/scroll the previous screen. Only the final CA-warning hop previously
required the next screen. This candidate applies that positive navigation
requirement to every Settings hop. A completed tap never counts as success.

The controller uses the same OS-package allowlist and exact native labels,
requires enabled, nonempty bounds, and selects actual clickable rows/containers.
A nonclickable page heading is scrolled instead of repeatedly tapped. It keeps
the existing seven-swipe budget and existing60s bounded-wait function. Repeated
source taps continue only inside that wait; a missing next control fails. PIN
handling retains the original three-prompt limit. Only the CA warning allows
case-insensitive text, and Install anyway is still clicked only in Settings.
Per-hop evidence contains fixed step names, counters and a destination boolean;
no PIN, field values, arbitrary UI text or credentials are added to this record.

The normal UI/CA installation, Chrome, real APK, strict TLS, password/factor/PKCE,
all3 native cases, process restart and revocation assertions remain unchanged.
No root/system CA injection, browser-warning bypass, acceptance rerun, deadline
increase or test skip. Bridge/Chrome ANRs remain fatal; foreign ANRs remain
bounded, recorded evidence. No recurring ANR is declared fixed.

Local new-navigation/existing UI contracts31/31 PASS,0failed/cancelled/skipped/
TODO. The combined navigation/UI/failure suite ran65 cases:63PASS/2FAIL/0skip;
the two pre-existing POSIX file-probe fixtures do not run on Windows paths.
Their initial and current failure TAPs are preserved. No tests were weakened or
skipped to turn that local result green. Mandatory Linux CI must run the full
suite with zero skips before this candidate is classified verified. Source
syntax and diff checks passed. Native qualification is still UNVERIFIED.

Independent current-parent native-binary/storage run40730509442 passed both
Android and iOS jobs (actual APK/simulator binaries and protected/encrypted
storage acceptance). It does not replace the blocked normal-screen auth journey.
P7, #209, #416, physical/OS coverage, feature parity and migration remain OPEN.
No production merge/deploy, B1 change, Capacitor retirement or user-data removal.
