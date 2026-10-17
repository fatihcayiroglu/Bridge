# Android #209 — observation-only EmojiCompat probe A/B

**Diagnostic experiment only; NOT a production hotfix and NOT proof of Android release readiness.**

## Hypothesis and confounder

The prior debug-only MainActivity startup probe reflected on the AndroidX
`EmojiCompat.isConfigured()` **static** method before and after
`BridgeActivity.onCreate` and on resume. Reflective method invocation may
initialize the class, so this measurement could itself alter startup behavior.
A returned `false` is not proof that reflection was side-effect-free.

The experimental change does **not** disable WebView, modify app UI or
permission policy, edit AndroidX dependencies, or relax strict Android tests.
Only the debug-only probe now performs
`Class.forName("androidx.emoji2.text.EmojiCompat", false, getClassLoader())`.
It logs `configured=unknown`, **never** "configured=false"; the Android
PID-filtered provider evidence remains the actual FD01 assertion input.

## Controlled comparisons

- Reference: #322, unchanged probe at commit `21957a7a`, with debug-only
  `FD00` native Activity, `FD00P` AppCompat-only Activity, `FD00C`
  WebView constructor, `FD00A` attached/no-nav, `FD00N` navigation
  without attachment, `FD00W` plain about:blank WebView, and Bridge FD01.
- Experimental: #327, same Android tests and controls, but without the
  reflective static EmojiCompat method invocation.

Both should exercise Android API 34 in the same GitHub workflow and record
stable and unstable provider references at equivalent stages and process
lifetimes. The controls are **measurements**, not passes or waivers. Missing
ActivityManager provider listings are UNKNOWN. Any FD01 live provider ref,
lost L01 process or ANR01 OS event remains FAIL. A single green is not enough
to infer root cause or statistical resolution.

The #327 PR is temporarily targeted at `main` because the Mobile Android
workflow only triggers on PRs with base `main`/`develop`. This temporarily
includes the #322 diagnostic differences in its PR diff: **do not merge #327
independently or assume those controls are already on main**. Reconcile the
stack after both exact-head emulator results are collected and code reviewed.

## Acceptance and privacy

No token, user content, raw provider dump, raw PIDs or unrestricted logcat
should be exported to CI artifacts. Include only existing bounded/redacted
diagnostics. Keep #209 open pending controlled replication, actual root-cause
evidence for historical FocusEvent ANRs and process deaths, and real physical
device acceptance. If the static probe is not causal, revert/abandon this
experiment without weakening FD01/L01/ANR01.
