# Shared registration precheck

The existing web username/password precheck now lives in the dependency-free
core at `@bridge/core/registration`. The web module forwards that implementation;
native consumers use the same entry point. This reuses the earlier isolated
registration work on the current P8 stack instead of creating a second validator.

The limits, error precedence, ASCII username policy and UTF-16 password length
semantics are unchanged. Passwords are not trimmed or normalized. These checks
are preliminary UI feedback; the backend still enforces registration, server
policy and all authentication/security controls.

The package exports TypeScript source for browser/native resolution and the
built CommonJS module for Node. The implementation has no React, Svelte, DOM,
storage, transport or platform dependency. The existing core build hooks remain
explicit; no postinstall compilation or dependency version changes are added.

## Validation and acceptance boundary

- Core: 12 tests passed, zero skips; 100% line/function and 96.30% branch
  coverage overall, including 100% registration branch coverage. Adversarial
  inputs cover Unicode confusables, controls, whitespace, separators, length
  boundaries, error precedence and preservation of password semantics.
- Web: all 13 existing registration-rule cases passed; client types, lint and
  production build/bundle budgets passed. Existing server-source parity checks
  remain unchanged; this is not a claim of a new backend HTTP integration test.
- Native: 27 component/adapter/contract tests passed, zero skips; all existing
  90% coverage gates, types and zero-warning lint passed. Seven added contract
  cases consume the shared registration entry point. They are not a native
  registration or authenticated-session journey.
- Electron: 51 compatibility cases and compilation passed, zero skips.
- Release packaging: 219 integrity tests passed, zero skips.

An earlier run in the preserved old registration worktree timed out in the
unmodified initial App connection test (26 passed, one failed). A later
same-source diagnostic run and this current-stack run passed all 27. The first
failure remains preserved and unexplained; this extraction is not described as
a fix for it. Recurring Android foreground/form and iOS input-mismatch failures
in the native preview remain separate unresolved acceptance requirements.

Fresh exact-head CI is required. Native registration, authenticated transport,
secure token storage, account switching and all P8 Stage B product acceptance
remain OPEN. This draft grants no production merge, release or migration cutover.
