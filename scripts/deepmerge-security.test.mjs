import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const merge = require(process.env.DEEPMERGE_UNDER_TEST ?? path.resolve('vendor/deepmerge/index.cjs'));

test('GHSA-gcqx-w48m-w2h4: source and target prototype keys never poison a returned object', () => {
  const malicious = JSON.parse('{"__proto__":{"bridgePrototypeSentinel":"poisoned"},"safe":7}');
  for (const target of [Object.create(null), {}, malicious]) {
    const result = merge(target, malicious);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.bridgePrototypeSentinel, undefined);
    assert.equal(Object.hasOwn(result, '__proto__'), false);
    assert.equal(result.safe, 7);
  }
  assert.equal({}.bridgePrototypeSentinel, undefined);
});
test('nested and all() merges preserve the same prototype boundary', () => {
  const malicious = JSON.parse('{"__proto__":{"bridgePrototypeSentinel":"poisoned"}}');
  assert.equal(merge({ child: Object.create(null) }, { child: malicious }).child.bridgePrototypeSentinel, undefined);
  assert.equal(merge.all([Object.create(null), malicious]).bridgePrototypeSentinel, undefined);
});
test('normal config semantics preserve symbols, arrays, custom merge, cloning and special objects', () => {
  const symbol = Symbol('config'), date = new Date(0), source = { child: { value: 1 } };
  assert.deepEqual(merge({ a: { x: 1 }, list: [1], [symbol]: 1, date }, { a: { y: 2 }, list: [2], [symbol]: 2 }),
    { a: { x: 1, y: 2 }, list: [1, 2], [symbol]: 2, date });
  assert.notEqual(merge({}, source).child, source.child);
  assert.equal(merge({}, source, { clone: false }).child, source.child);
  assert.deepEqual(merge([1], [2], { arrayMerge: (_target, input) => input }), [2]);
  assert.deepEqual(merge({ a: { n: 1 } }, { a: { n: 2 } }, { customMerge: key => key === 'a' ? (a, b) => ({ n: a.n + b.n }) : undefined }), { a: { n: 3 } });
  assert.throws(() => merge.all('bad'), /first argument should be an array/);
  assert.deepEqual(source, { child: { value: 1 } });
});
test('all independent install graphs pin only the reviewed local copy', () => {
  for (const scope of ['.', 'server', 'electron']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(scope, 'package.json')));
    const lock = JSON.parse(fs.readFileSync(path.join(scope, 'package-lock.json'))).packages;
    const relative = `${scope === '.' ? '' : '../'}vendor/deepmerge`;
    assert.equal(pkg.devDependencies.deepmerge, `file:${relative}`);
    assert.equal(pkg.overrides.deepmerge, '$deepmerge');
    assert.deepEqual(Object.keys(lock).filter(key => /(^|\/)node_modules\/deepmerge$/.test(key)), ['node_modules/deepmerge']);
    assert.equal(lock['node_modules/deepmerge'].link, true);
    assert.equal(lock['node_modules/deepmerge'].resolved, relative);
    assert.equal(lock[relative].version, '4.3.1-bridge.1');
    assert.ok(!JSON.stringify(lock).includes('deepmerge/-/deepmerge-'), `${scope}: vulnerable registry tarball remains`);
  }
});
test('every consumer API range remains compatible with the reviewed 4.3.1 implementation', () => {
  for (const scope of ['.', 'server', 'electron']) {
    const lock = JSON.parse(fs.readFileSync(path.join(scope, 'package-lock.json'))).packages;
    let consumers = 0;
    for (const [name, pkg] of Object.entries(lock)) {
      if (name === '') continue;
      for (const deps of [pkg.dependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
        if (!deps?.deepmerge) continue;
        consumers++;
        const range = deps.deepmerge, match = /^\^4\.(\d+)\.(\d+)$/.exec(range);
        assert.ok(match, `${scope}/${name}: review incompatible deepmerge range ${range}`);
        const minor = Number(match[1]), patch = Number(match[2]);
        assert.ok(minor < 3 || (minor === 3 && patch <= 1), `${scope}/${name}: ${range} exceeds 4.3.1`);
      }
    }
    assert.ok(consumers > 0, `${scope}: expected real Vite/Jest consumers`);
  }
});
test('MIT license and both reviewed guards are retained in the Docker-visible entrypoint', () => {
  const source = fs.readFileSync('vendor/deepmerge/index.cjs', 'utf8');
  assert.match(source, /if \(key === '__proto__'\) \{/);
  assert.match(source, /if \(key === '__proto__' \|\| propertyIsUnsafe\(target, key\)\) \{/);
  assert.match(fs.readFileSync('vendor/deepmerge/license.txt', 'utf8'), /MIT License/);
  assert.equal(JSON.parse(fs.readFileSync('vendor/deepmerge/package.json')).main, 'index.cjs');
});
