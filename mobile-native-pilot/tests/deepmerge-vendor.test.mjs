// The vendored deepmerge (vendor/deepmerge, GHSA-gcqx-w48m-w2h4) is the copy the Expo
// toolchain loads, blocks the reproduced attack, and otherwise behaves like 4.3.1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Install-independent: the unit-test job runs without `npm ci`, so the vendored file is
// loaded by path and the wiring is proven from the committed lockfile `npm ci` installs.
const require = createRequire(import.meta.url);
const SOURCE = process.env.DEEPMERGE_UNDER_TEST ?? path.resolve('vendor/deepmerge/dist/cjs.js');
const deepmerge = require(SOURCE);

test('the lockfile installs only the vendored copy, for @expo/config too', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.overrides.deepmerge, '$deepmerge');
  assert.equal(pkg.dependencies.deepmerge, 'file:vendor/deepmerge');
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;
  const installs = Object.keys(lock).filter((k) => /(^|\/)node_modules\/deepmerge$/.test(k));
  assert.deepEqual(installs, ['node_modules/deepmerge'], 'one deepmerge install, hoisted (no nested registry copy)');
  assert.deepEqual(lock['node_modules/deepmerge'], { resolved: 'vendor/deepmerge', link: true });
  assert.equal(lock['vendor/deepmerge'].version, '4.3.1-bridge.1');
  assert.ok(!JSON.stringify(lock).includes('deepmerge/-/deepmerge-'), 'no registry tarball of deepmerge');
  // @expo/config declares deepmerge and has no nested copy, so it resolves the hoisted link.
  assert.ok(lock['node_modules/@expo/config'].dependencies.deepmerge);
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

// The override forces 4.3.1-bridge.1 on every dependent. If an upgrade ever declares a
// range 4.3.1 does not satisfy (e.g. ^5), npm would still force the old copy silently;
// this fails instead, so the vendored patch is re-evaluated (or removed) at that point.
test('every dependent still declares a deepmerge range that 4.3.1 satisfies', () => {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;
  const ranges = Object.entries(lock)
    .filter(([key]) => key !== '')
    .flatMap(([key, p]) => [p.dependencies, p.peerDependencies, p.optionalDependencies]
      .filter((deps) => deps && 'deepmerge' in deps).map((deps) => [key, deps.deepmerge]));
  assert.ok(ranges.length > 0, 'at least @expo/config depends on deepmerge');
  for (const [key, range] of ranges) {
    const m = /^\^4\.(\d+)\.(\d+)$/.exec(range);
    assert.ok(m, `${key} declares deepmerge "${range}": not a ^4.x.y range; re-evaluate vendor/deepmerge`);
    const [minor, patch] = [Number(m[1]), Number(m[2])];
    assert.ok(minor < 3 || (minor === 3 && patch <= 1), `${key} requires deepmerge ${range}, newer than the vendored 4.3.1`);
  }
});
