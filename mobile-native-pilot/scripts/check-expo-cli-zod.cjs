// Compatibility check for the zod override (DEPENDENCY_AUDIT.md).
// @expo/cli 57 declares zod ^3.25.76; the pilot overrides it to a patched zod 4
// (GHSA-mrhx-c7xc-m3w5). This runs Expo's OWN zod schemas from the installed
// @expo/cli against fixtures and requires the same accept/reject decisions zod 3
// gave. It needs installed dependencies (npm ci); it is not a unit test.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

const expoDir = path.dirname(require.resolve('expo/package.json'));
const cliRoot = path.dirname(require.resolve('@expo/cli/package.json', { paths: [expoDir] }));
const server = path.join(cliRoot, 'build/src/start/server');
const zodVersion = require(require.resolve('zod/package.json', { paths: [server] })).version;
const { PluginSchema, DevToolsPluginOutputSchema } = require(path.join(server, 'DevToolsPlugin.schema.js'));
const { createMCPDevToolsExtensionSchema } = require(path.join(server, 'createMCPDevToolsExtensionSchema.js'));

const command = { name: 'reload', title: 'Reload', environments: ['cli', 'mcp'], parameters: [{ name: 'count', type: 'number' }] };
const plugin = { packageName: 'p', packageRoot: '/r', cliExtensions: { description: 'd', commands: [command], entryPoint: 'e' } };

const cases = [
  ['plugin: minimal valid', () => PluginSchema.safeParse({ packageName: 'p', packageRoot: '/r' }).success, true],
  ['plugin: full valid', () => PluginSchema.safeParse({ ...plugin, bannerTitle: true }).success, true],
  ['plugin: empty name refused (min)', () => PluginSchema.safeParse({ packageName: '', packageRoot: '/r' }).success, false],
  ['plugin: bad enum refused', () => PluginSchema.safeParse({ ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [{ ...command, environments: ['web'] }] } }).success, false],
  ['plugin: no commands refused (array min)', () => PluginSchema.safeParse({ ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } }).success, false],
  ['plugin: bannerTitle union', () => PluginSchema.safeParse({ packageName: 'p', packageRoot: '/r', bannerTitle: 3 }).success, false],
  ['plugin: refusal has message', () => typeof PluginSchema.safeParse({}).error.message === 'string', true],
  ['output: text line', () => DevToolsPluginOutputSchema.safeParse([{ type: 'text', text: 'x', level: 'info' }]).success, true],
  ['output: image url', () => DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'https://a.example/i.png' }]).success, true],
  ['output: invalid url refused', () => DevToolsPluginOutputSchema.safeParse([{ type: 'image', url: 'not a url' }]).success, false],
  ['output: unknown literal refused', () => DevToolsPluginOutputSchema.safeParse([{ type: 'video', url: 'https://a' }]).success, false],
  ['output: issues[].message', () => DevToolsPluginOutputSchema.safeParse([{ type: 'text' }]).error.issues.every((i) => typeof i.message === 'string'), true],
  ['mcp: known command', () => createMCPDevToolsExtensionSchema(plugin).safeParse({ command: 'reload', count: 2 }).success, true],
  ['mcp: unknown command refused', () => createMCPDevToolsExtensionSchema(plugin).safeParse({ command: 'nope' }).success, false],
  ['mcp: strict refuses extra keys', () => createMCPDevToolsExtensionSchema(plugin).safeParse({ command: 'reload', extra: 1 }).success, false],
  ['mcp: param type enforced', () => createMCPDevToolsExtensionSchema(plugin).safeParse({ command: 'reload', count: 'two' }).success, false],
];

let failed = 0;
for (const [name, run, expected] of cases) {
  let actual;
  try { actual = run(); } catch (error) { actual = `threw ${error && error.message}`; }
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (expected ${expected}, got ${actual})`}`);
}
console.log(`zod ${zodVersion} under @expo/cli: ${cases.length - failed}/${cases.length} decisions as expected`);
assert.equal(failed, 0);
