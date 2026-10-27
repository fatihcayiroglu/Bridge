# Native pilot dependency audit

Lockfile: `package-lock.json` (lockfileVersion 3; npm 10.9; Node 22). Expo SDK 57,
React Native 0.86, React 19.2.3, expo-secure-store, expo-web-browser and expo-crypto
at the SDK 57 versions. Installed by `npm ci` in CI. This covers only this isolated
pilot. No production dependency of the web, server, Electron or Capacitor apps
is changed.

`npm audit --audit-level=high` gates CI. Current result: **0 vulnerabilities**.

## Resolved: GHSA-mrhx-c7xc-m3w5 (zod)

| | |
|---|---|
| Advisory | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): memory exhaustion validating oversized constrained collections (CWE-770, high) |
| Path | expo → @expo/cli → zod 3.25.76 (affected: < 4.6.6) |
| Upstream | @expo/cli 57.x and the latest 58.1.16 both declare `zod ^3.25.76`. No patched 3.x exists. npm's own suggestion is a downgrade to expo 54, which is incompatible with SDK 57 |
| Fix | `overrides.zod = 4.6.7` (patched) in `package.json` |
| Exposure before the fix | Dev CLI / dev server only. A plain-JS Android export contains no zod; the positive control `AppRegistry` is present |

### Why the override is safe

@expo/cli uses zod in two modules:
- `DevToolsPlugin.schema.js`: plugin configuration and plugin output validation;
- `createMCPDevToolsExtensionSchema.js`: the MCP tool schema.

The APIs involved are `object`, `string`, `number`, `boolean`, `enum`, `literal`,
`array`, `union`, `min`, `optional`, `readonly`, `url`, `describe`, `strict`,
`safeParse`, `error.message` and `error.issues`. All of them exist in zod 4.

`scripts/check-expo-cli-zod.cjs` runs those two modules from the installed
@expo/cli against 16 accept/reject fixtures (validation, enums, unions, URL,
strict extra-key refusal, issue messages). Results:

| zod | Decisions as expected |
|---|---|
| 3.25.76 (baseline) | 16/16 |
| 4.6.7 (override) | 16/16 |

CI runs the check after `npm ci`.

With the override, `expo start` serves `/status` 200 and bundles Android 200.
React Native DevTools fails to start in the root container (Electron sandbox).
That failure is identical with zod 3, so it is environmental.

Not verified: MCP dev-tool plugins through an external MCP server (none is
installed here).

Revisit the override when @expo/cli itself depends on a patched zod.
