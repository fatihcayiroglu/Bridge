# Native pilot dependency audit

Lockfile: `package-lock.json` (lockfileVersion 3; npm 10.9; Node 22). Expo SDK 57,
React Native 0.86, React 19.2.3, expo-secure-store ~57.0.4. Installed by `npm ci`
in CI. This lockfile covers only this isolated pilot. No production dependency
of the web, server, Electron or Capacitor apps is changed.

## Open findings (2026-10-27)

`npm audit` reports 3 high entries. All three come from one advisory:

| Advisory | Package | Path | Fixed in | Why not fixed here |
|---|---|---|---|---|
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (CWE-770, memory exhaustion on oversized constrained collections) | zod 3.25.76 | expo → @expo/cli → zod | zod 4.6.6 | `@expo/cli` (57.x and latest 58.1.16) requires `zod ^3.25.76`, and there is no patched 3.x release. npm's suggested fix is a semver-major **downgrade** to expo 54, which is incompatible with SDK 57. Overriding to zod 4 changes zod's API under the CLI. |

Exposure evidence: zod is used by `@expo/cli`'s development server
(dev-tools plugin schemas). In a plain-JS Android export
(`expo export --platform android --no-bytecode`), the positive control
`AppRegistry` occurs 5 times and `zod`/`ZodError` occur 0 times. The vulnerable
code is therefore not in the shipped app JavaScript; it runs on developer and CI
machines that run the Expo CLI.

The CI audit job stays **failing** until upstream ships a fix or the owner records
an explicit, dated risk acceptance. It is not suppressed.
