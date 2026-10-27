process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

// Migration 094: clean install (schema.ts, applied on every boot) and the
// numbered migration must create the same account-erasure author indexes.
// That erasure plans use them is proven against real PostgreSQL in
// tests/pg-integration/account-erasure-author-index.pgtest.ts.

const serverRoot = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

describe('account erasure author index schema contract', () => {
  it('keeps clean-install and numbered migration indexes aligned', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const migration = read('db', 'migrations_pg', '094_account_erasure_author_indexes.sql');
    for (const source of [schema, migration]) {
      expect(source).toMatch(/idx_messages_author\s+ON messages\("userId"\)/);
      expect(source).toMatch(/idx_messages_reply_quote_ref\s+ON messages\(\("replyTo"->>'_id'\)\) WHERE "replyTo" \? 'displayName'/);
      expect(source).toMatch(/idx_thread_messages_author\s+ON thread_messages\("userId"\)/);
    }
  });

  it('the indexed predicate is the one erasure filters quote headers by', () => {
    const erasure = read('lib', 'accountErasure.ts');
    expect(erasure).toMatch(/WHERE "replyTo" \? 'displayName'\s+AND "replyTo"->>'_id' IN \(SELECT _id FROM messages WHERE "userId" = \$1\)/);
  });

  it('rollback removes all three migration-owned indexes explicitly', () => {
    const rollback = read('db', 'migrations_pg', 'rollback', '094_account_erasure_author_indexes.down.sql');
    for (const name of ['idx_messages_author', 'idx_messages_reply_quote_ref', 'idx_thread_messages_author']) {
      expect(rollback).toContain(`DROP INDEX IF EXISTS ${name}`);
    }
  });
});
