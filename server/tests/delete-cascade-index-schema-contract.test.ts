process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

// Final21 Phase 11 (F21-11-02): clean install (schema.ts, applied on every boot)
// and the numbered migration must create the same cascade-delete indexes.
// Behaviour is proven against real PostgreSQL in
// tests/pg-integration/delete-cascade-fk-index.pgtest.ts.

const serverRoot = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

describe('cascade-delete referencing-column index schema contract', () => {
  it('keeps clean-install and numbered migration indexes aligned', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const migration = read('db', 'migrations_pg', '071_delete_cascade_fk_indexes.sql');
    for (const source of [schema, migration]) {
      expect(source).toMatch(/idx_message_reports_message\s+ON message_reports\("messageId"\)/);
      expect(source).toMatch(/idx_channel_read_positions_channel\s+ON channel_read_positions\("channelId"\)/);
    }
  });

  it('rollback removes both migration-owned indexes explicitly', () => {
    const rollback = read('db', 'migrations_pg', 'rollback', '071_delete_cascade_fk_indexes.down.sql');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_message_reports_message');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_channel_read_positions_channel');
  });
});
