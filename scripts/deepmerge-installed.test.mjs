import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Run only in the install job after all three normal npm ci commands. Missing
// installs fail; there is no skip or synthetic dependency-resolution fallback.
for (const [scope, consumer] of [['.', 'jest-config'], ['.', '@sveltejs/vite-plugin-svelte'], ['server', 'jest-config'], ['electron', 'jest-config']]) {
  test(`${scope}/${consumer} actually resolves and executes the patched copy`, () => {
    const packageFile = path.resolve(scope, 'node_modules', consumer, 'package.json');
    assert.ok(fs.existsSync(packageFile), `required real install missing: ${scope}/${consumer}`);
    const require = createRequire(packageFile);
    const resolved = fs.realpathSync(require.resolve('deepmerge'));
    assert.equal(resolved, fs.realpathSync('vendor/deepmerge/index.cjs'));
    const merge = require('deepmerge');
    const result = merge(Object.create(null), JSON.parse('{"__proto__":{"bridgePrototypeSentinel":true},"safe":1}'));
    assert.equal(result.bridgePrototypeSentinel, undefined);
    assert.equal(result.safe, 1);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  });
}
