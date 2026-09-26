/**
 * Loader-required PostgreSQL collections are architectural invariants.
 * Repository optional-chaining on one of these stores converts schema/loader
 * failure into fake empty data or a fake successful no-op. Keep required stores
 * fail-closed; only DbInstance properties explicitly marked optional may use ?.. 
 */
import fs from 'fs';
import path from 'path';

function repositorySources(): Array<{ name: string; source: string }> {
  const dir = path.join(__dirname, '..', 'db', 'repositories');
  return fs.readdirSync(dir).filter(n => n.endsWith('.ts')).map(name => ({ name, source: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

test('repositories do not optional-chain loader-required collections', () => {
  const loader = fs.readFileSync(path.join(__dirname, '..', 'db', 'loader.ts'), 'utf8');
  const iface = loader.match(/export interface DbInstance \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const required = [...iface.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*PgCollection/gm)].map(m => m[1]);
  expect(required.length).toBeGreaterThan(40);

  const violations: string[] = [];
  for (const { name, source } of repositorySources()) {
    const lines = source.split(/\r?\n/);
    for (const store of required) {
      const needle = `db.${store}?.`;
      lines.forEach((line, index) => { if (line.includes(needle)) violations.push(`${name}:${index + 1}:${store}`); });
    }
  }
  expect(violations).toEqual([]);
});
