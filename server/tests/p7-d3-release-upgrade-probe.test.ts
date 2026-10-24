process.env.NODE_ENV = 'test';

import { splitSql } from '../scripts/p7-d3-release-upgrade-probe';
import { SCHEMA } from '../db/postgres/schema';

// The D3 release-upgrade probe runs schema.ts one statement at a time; a wrong
// split would report refusals that boot never sees, or hide real ones.

describe('p7 D3 release-upgrade probe: statement splitter', () => {
  it('keeps semicolons inside quotes, comments and dollar-quoted bodies', () => {
    const sql = [
      "CREATE TABLE a (x TEXT DEFAULT ';');",
      '-- a comment; with a semicolon',
      'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN NEW; END; $$;',
      'DO $body$ BEGIN IF true THEN PERFORM 2; END IF; END $body$;',
      'CREATE INDEX i ON a(x)',
    ].join('\n');
    expect(splitSql(sql)).toEqual([
      "CREATE TABLE a (x TEXT DEFAULT ';')",
      'CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RETURN NEW; END; $$',
      'DO $body$ BEGIN IF true THEN PERFORM 2; END IF; END $body$',
      'CREATE INDEX i ON a(x)',
    ]);
  });

  it('splits the real schema.ts into whole statements', () => {
    const statements = splitSql(SCHEMA);
    expect(statements.length).toBeGreaterThan(100);
    for (const s of statements) {
      // Every dollar-quoted body opened in a statement is closed in it.
      const tags = s.match(/\$[A-Za-z_]*\$/g) ?? [];
      expect(tags.length % 2).toBe(0);
      expect(s).toMatch(/^(CREATE|ALTER|DO|DROP|COMMENT|INSERT|UPDATE|SELECT)\b/i);
    }
    // Nothing is lost: the statements cover every non-comment character.
    const strip = (x: string) => x.replace(/--[^\n]*/g, '').replace(/[\s;]/g, '');
    expect(strip(statements.join(''))).toBe(strip(SCHEMA));
  });
});
