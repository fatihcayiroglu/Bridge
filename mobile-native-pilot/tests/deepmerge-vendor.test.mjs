// The vendored deepmerge (vendor/deepmerge, GHSA-gcqx-w48m-w2h4) is the copy the Expo
// toolchain loads, blocks the reproduced attack, and otherwise behaves like 4.3.1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SOURCE = process.env.DEEPMERGE_UNDER_TEST ?? require.resolve('deepmerge');
const deepmerge = require(SOURCE);

test('@expo/config loads the vendored copy, pinned by the override', () => {
  const fromExpoConfig = createRequire(require.resolve('@expo/config/package.json')).resolve('deepmerge');
  assert.equal(fs.realpathSync(fromExpoConfig), fs.realpathSync(path.resolve('vendor/deepmerge/dist/cjs.js')));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.overrides.deepmerge, '$deepmerge');
  assert.equal(pkg.dependencies.deepmerge, 'file:vendor/deepmerge');
});

test('GHSA-gcqx-w48m-w2h4: a "__proto__" key never becomes the prototype of a result', () => {
  const evil = JSON.parse('{"__proto__": {"polluted": "yes"}, "a": 1}');
  for (const target of [Object.create(null), {}, JSON.parse('{"__proto__": {"polluted": "yes"}}')]) {
    const out = deepmerge(target, evil);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(out.polluted, undefined);
    assert.equal(out.a, 1);
  }
  // Nested, and through all().
  const nested = deepmerge({ n: Object.create(null) }, JSON.parse('{"n": {"__proto__": {"polluted": 1}}}'));
  assert.equal(nested.n.polluted, undefined);
  assert.equal(deepmerge.all([Object.create(null), evil]).polluted, undefined);
  assert.equal({}.polluted, undefined, 'Object.prototype untouched');
});

test('4.3.1 behaviour is unchanged for ordinary input', () => {
  const sym = Symbol('s');
  const date = new Date(0);
  const out = deepmerge({ a: { x: 1, list: [1] }, keep: 'k', [sym]: 1, d: date }, { a: { y: 2, list: [2] }, b: 3, [sym]: 2 });
  assert.deepEqual(out, { a: { x: 1, y: 2, list: [1, 2] }, keep: 'k', b: 3, [sym]: 2, d: date });
  assert.equal(out.d, date, 'dates are not merged/cloned');
  const src = { o: { v: 1 } };
  assert.notEqual(deepmerge({}, src).o, src.o, 'cloned by default');
  assert.equal(deepmerge({}, src, { clone: false }).o, src.o);
  assert.deepEqual(deepmerge([1], [2], { arrayMerge: (_t, s) => s }), [2]);
  assert.deepEqual(deepmerge({ a: { n: 1 } }, { a: { n: 2 } }, { customMerge: (k) => (k === 'a' ? (x, y) => ({ n: x.n + y.n }) : undefined) }), { a: { n: 3 } });
  assert.deepEqual(deepmerge.all([{ a: 1 }, { b: 2 }, { a: 3 }]), { a: 3, b: 2 });
  assert.throws(() => deepmerge.all('x'), /first argument should be an array/);
  // Non-enumerable / inherited target properties stay protected, as in 4.3.1.
  const proto = { inherited: { v: 1 } };
  const target = Object.create(proto);
  assert.equal(deepmerge(target, { inherited: { v: 2 } }).inherited, undefined);
  // As in 4.3.1: "constructor" is inherited by a plain target, so it is skipped;
  // "prototype" is an ordinary data key.
  assert.deepEqual(deepmerge({}, { constructor: 1, prototype: 2 }), { prototype: 2 });
});

test('the vendored file differs from upstream 4.3.1 only by the documented guard', () => {
  const src = fs.readFileSync('vendor/deepmerge/dist/cjs.js', 'utf8');
  assert.equal((src.match(/__proto__/g) || []).length >= 2, true);
  assert.match(src, /if \(key === '__proto__'\) \{\n\t\t\t\treturn\n\t\t\t\}/);
  assert.match(src, /if \(key === '__proto__' \|\| propertyIsUnsafe\(target, key\)\) \{/);
  const pkg = JSON.parse(fs.readFileSync('vendor/deepmerge/package.json', 'utf8'));
  assert.equal(pkg.version, '4.3.1-bridge.1');
  assert.ok(fs.existsSync('vendor/deepmerge/license.txt'), 'MIT licence kept');
});
