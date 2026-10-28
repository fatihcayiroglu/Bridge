# iOS native keyboard toolbar follow-up — P7 OPEN

Base integration candidate #564/#563 is preserved at
f428942c5f17ef92bf0f1ca53ea25d6817b02c1f. This focused branch avoids changing
that head while its full qualification continues.

Its earlier8c0a8ca6 actual iOS run40735922166/job122984311098 passed cancellation
but failed case2 before password input: `WebDriver sync failed (400; HTTP error)`.
Closed facts were usernameKeyboard={wasVisible:true,dismissed:false}; password
focus was not attempted and case3 was NOT EXECUTED. The original artifact is
preserved with SHA256
`97ab8df8474d4d07dd5df7c91287bed3687f1d6003feecd86c7a76f841f3033e`.

The pinned appium-webdriveragent16.17.2 implementation of
`fb_dismissKeyboardWithKeyNames` searches keys/buttons under its keyboard object;
it does not search an accessory toolbar elsewhere in the native hierarchy. That
is a concrete limitation, not proof that a Done toolbar button exists here.

This candidate first queries a native XCUITest toolbar for exactly one enabled,
visible Done button. If observed, it clicks that actual element once; ambiguity
or an invalid element id is fatal. If absent, the existing generic native command
remains and can fail. No arbitrary button, Go/Return submission, page JavaScript,
coordinate fallback or authentication shortcut. Two keyboard-absent observations,
fresh password lookup, exact active secure-field identity/type, username
integrity and all3 native cases remain mandatory. The existing60s/240s deadlines
are unchanged; no acceptance-job rerun.

The standard W3C diagnostic allowlist now includes invalid element state,
element not interactable/intercepted, stale reference and invalid selector.
Only those fixed types are exposed; response messages, arguments, unknown error
values, field values and element ids remain excluded. Toolbar evidence contains
only a count capped at2 and a selection boolean. Selection is not dismissal or
authentication success.

Local native-focus/evidence/HTTP contracts32/32 PASS,0failed/cancelled/skipped/
TODO; syntax and diff checks passed. The selector and recovery are UNVERIFIED
until exact-head native CI. P7/#209/#416, physical devices, complete OS coverage,
feature parity, performance and lossless migration remain OPEN. No main merge,
deployment, B1 changes, Capacitor retirement or user-data removal.
