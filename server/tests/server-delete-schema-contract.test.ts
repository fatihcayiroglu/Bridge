import fs from 'fs';
import path from 'path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

function createTableBlocks(source: string): Array<{ table: string; body: string }> {
  const out: Array<{ table: string; body: string }> = [];
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s*\((.*?)\)\s*(?:;|`)/gis;
  for (const match of source.matchAll(re)) out.push({ table: match[1], body: match[2] });
  return out;
}

describe('server graph deletion stays aligned with the PostgreSQL schema', () => {
  it('mentions every schema table carrying a direct server/channel ownership key', () => {
    const schemaSources = [read('db/postgres/schema.ts'), read('db/postgres/migrations.ts')];
    const migrationDir = path.join(__dirname, '..', 'db', 'migrations_pg');
    for (const name of fs.readdirSync(migrationDir).filter(n => /^\d{3}_.+\.sql$/.test(n))) {
      schemaSources.push(fs.readFileSync(path.join(migrationDir, name), 'utf8'));
    }

    const scoped = new Set<string>();
    const ownershipKey = /"?(?:serverId|server_id|channelId|channel_id|sourceServerId|targetServerId|sourceChannelId|targetChannelId)"?\s+/;
    for (const source of schemaSources) {
      for (const block of createTableBlocks(source)) {
        if (ownershipKey.test(block.body)) scoped.add(block.table);
      }
    }

    const repo = read('db/repositories/ServerRepository.ts');
    const start = repo.indexOf('async deleteGraphAtomic');
    const end = repo.indexOf('\n  async getMember', start);
    const deleteOwner = repo.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const missing = [...scoped].filter(table => !deleteOwner.includes(table)).sort();
    expect(missing).toEqual([]);
  });

  it('keeps non-obvious derived/cross-tenant identities in the canonical owner', () => {
    const repo = read('db/repositories/ServerRepository.ts');
    const start = repo.indexOf('async deleteGraphAtomic');
    const end = repo.indexOf('\n  async getMember', start);
    const owner = repo.slice(start, end);
    for (const required of [
      'saved_messages', 'notification_prefs', 'channel_bridges', 'channel_follows',
      'crosspost_log', 'bot_ratings', 'server_bots', 'server_event_rsvp',
      'sticker_pack_items',
    ]) {
      // RSVP and sticker items are intentionally deleted by FK cascade through
      // server_events/sticker_packs; the owner documents that contract below.
      if (required === 'server_event_rsvp') {
        expect(read('db/postgres/schema.ts')).toMatch(/server_event_rsvp[\s\S]*?REFERENCES server_events\(id\) ON DELETE CASCADE/);
      } else if (required === 'sticker_pack_items') {
        expect(read('db/postgres/schema.ts')).toMatch(/sticker_pack_items[\s\S]*?REFERENCES sticker_packs\(_id\) ON DELETE CASCADE/);
      } else {
        expect(owner).toContain(required);
      }
    }
  });

  it('re-checks expected owner identity after SELECT FOR UPDATE', () => {
    const repo = read('db/repositories/ServerRepository.ts');
    const lock = repo.indexOf('SELECT _id, "ownerId" FROM servers WHERE _id=$1 FOR UPDATE');
    const ownerCheck = repo.indexOf("return 'owner_mismatch'", lock);
    const firstDelete = repo.indexOf('DELETE FROM', ownerCheck);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(ownerCheck).toBeGreaterThan(lock);
    expect(firstDelete).toBeGreaterThan(ownerCheck);
  });
});
