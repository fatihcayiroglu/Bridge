# Reviewed deepmerge 4.3.1 patch

This is the same two-guard security correction reviewed in Bridge PR #536,
commit `64931bb75f42153351ee84462e884428fb0f93e6`. Its `dist/cjs.js` is copied
unchanged as `index.cjs`; the name keeps this source in Docker contexts that
exclude generated `dist` directories. The MIT license and type declarations
are retained. The isolated React Native pilot's copy is not changed here.

GHSA-gcqx-w48m-w2h4 permits a source's own `__proto__` key to set the prototype
of a returned merge object when the target has a null prototype. The patch
never copies that key from either target or source. Ordinary merge behaviour
is preserved. This does not assert that upstream modified Object.prototype.

As of 2026-10-28, the npm registry's latest release is 4.3.1, which is affected.
Root Vite/Svelte tooling and the root/server/Electron Jest configurations use
it as a build/test dependency. Each independent installation now uses this
canonical copy through a direct dev dependency and `$deepmerge` override.
There is no advisory suppression or downgrade of Jest to an old release.

The source/lockfile tests run without installed packages. Separate installed
resolution tests verify that the actual Vite and Jest consumers load this
copy. A negative control against the original published 4.3.1 must fail the
prototype-safety assertions. Consumer version ranges are checked so a future
upgrade cannot silently force this 4.3.1 fork on an incompatible API range.

Remove the fork after a fixed upstream release is verified and the override,
lockfiles, exploit tests and container install checks are reviewed together.
Advisory: https://github.com/advisories/GHSA-gcqx-w48m-w2h4
