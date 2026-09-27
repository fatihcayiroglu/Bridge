process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';

const serverRoot = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

describe('message/member cursor index schema contract', () => {
  it('keeps clean-install and numbered migration composite indexes aligned', () => {
    const schema = read('db', 'postgres', 'schema.ts');
    const migration = read('db', 'migrations_pg', '060_message_and_member_cursor_indexes.sql');
    for (const source of [schema, migration]) {
      expect(source).toMatch(
        /idx_messages_channel_cursor[\s\S]*ON messages\("channelId", "createdAt" DESC, _id DESC\)/,
      );
      expect(source).toMatch(
        /idx_members_server_page[\s\S]*ON members\("serverId", "joinedAt" ASC, "userId" ASC\)/,
      );
    }
    // The member index must not depend on migration 029's `banned` column;
    // otherwise an isolated 029 rollback cascades away a 060-owned object.
    const memberDefinition = migration.match(/idx_members_server_page[\s\S]*?;/)?.[0] ?? '';
    expect(memberDefinition).not.toMatch(/WHERE\s+banned/i);
  });

  it('rollback removes both migration-owned indexes explicitly', () => {
    const rollback = read('db', 'migrations_pg', 'rollback', '060_message_and_member_cursor_indexes.down.sql');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_messages_channel_cursor');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_members_server_page');
  });
});
