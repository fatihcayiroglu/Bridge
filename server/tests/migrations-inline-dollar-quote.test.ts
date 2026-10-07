// Inline schema migrations (db/postgres/migrations.ts) run on every fresh
// install. A PL/pgSQL block whose `$$` was mangled to `$` is a syntax error
// that stops schema init entirely (found merging P7 B1: migration 080's
// inline mirror). Guard the whole file, not one block.

import fs from 'node:fs';
import path from 'node:path';

describe('inline migration SQL', () => {
  const source = fs.readFileSync(path.join(__dirname, '../db/postgres/migrations.ts'), 'utf8');

  it('every DO block is dollar-quoted with $$ (or a $tag$), never a lone $', () => {
    const opens = [...source.matchAll(/\bDO\s+(\$[A-Za-z_]*\$?)/g)].map(m => m[1]);
    expect(opens.length).toBeGreaterThan(0);
    for (const tag of opens) expect(tag).toMatch(/^\$[A-Za-z_]*\$$/);
    expect(source).not.toMatch(/\bEND\s+\$`/);
  });
});
