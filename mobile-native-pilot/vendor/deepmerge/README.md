# deepmerge 4.3.1, patched for GHSA-gcqx-w48m-w2h4

Why this exists: `npm audit` (Oct 27 2026) reports GHSA-gcqx-w48m-w2h4 for deepmerge
>= 4.2.0, <= 4.3.1 with **no patched release**. In this package deepmerge is only used by
`@expo/config` at build/CLI time; it is not in the app bundle (checked against the
Android export source map). The pilot's audit gate is `--audit-level=low`, and advisories
are fixed, not suppressed, so the vulnerable code is replaced instead.

What the advisory means in 4.3.1, reproduced: merging a source with an own `"__proto__"`
key (e.g. from `JSON.parse`) into a **null-prototype** target sets the returned object's
prototype to attacker data. With ordinary targets the key was already skipped, and the
global `Object.prototype` is never modified.

The change: `__proto__` is never written to a merge result (two lines in `mergeObject`).
For ordinary targets the behaviour is unchanged. `tests/deepmerge-vendor.test.mjs`
reproduces the attack, runs upstream-behaviour checks, and verifies this copy is the one
`@expo/config` loads.

Remove this directory and the `overrides.deepmerge` entry in `package.json` as soon as
deepmerge publishes a fixed release (or `@expo/config` stops depending on it).
