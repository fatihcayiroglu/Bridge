import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('soundboard schema ownership', () => {
  const fresh = read('db', 'postgres', 'schema.ts');
  const sqlMirror = read('db', 'postgres', 'schema.sql');
  const inline = read('db', 'postgres', 'migrations.ts');
  const numbered = read('db', 'migrations_pg', '059_soundboard_library.sql');
  const rollback = read('db', 'migrations_pg', 'rollback', '059_soundboard_library.down.sql');

  it.each([
    ['fresh schema', fresh],
    ['SQL mirror', sqlMirror],
    ['startup upgrade', inline],
    ['numbered migration', numbered],
  ])('%s owns durable stats, metadata, constraints, and bounded-read indexes', (_label, source) => {
    for (const token of [
      'soundboard_user_stats', 'durationSeconds', 'mimeType', 'fileSize', 'category',
      'soundboard_stats_favorite_time', 'soundboard_stats_play_time', 'soundboard_stats_scope',
      'idx_soundboard_server_page', 'idx_soundboard_server_name',
      'idx_soundboard_stats_favorites', 'idx_soundboard_stats_recent', 'idx_soundboard_stats_frequent',
    ]) expect(source).toContain(token);
  });

  it('numbered migration adds canonical server ownership and has a data-safe structural rollback', () => {
    expect(numbered).toContain('fk_soundboard_server');
    expect(numbered).toContain('ON DELETE CASCADE');
    expect(rollback).toContain('DROP TABLE IF EXISTS soundboard_user_stats');
    expect(rollback).toContain('DROP INDEX IF EXISTS idx_soundboard_server_page');
    expect(rollback).toContain('Additive sound metadata and its write constraints are intentionally retained');
    expect(rollback).not.toMatch(/DROP (?:COLUMN|CONSTRAINT)/);
  });

  it('adds upgrade constraints safely, validates clean data, and preserves dirty legacy rollout', () => {
    for (const source of [inline, numbered]) {
      for (const constraint of [
        'soundboard_name_length', 'soundboard_emoji_length', 'soundboard_category_length',
        'soundboard_duration_bounds', 'soundboard_file_size_bounds', 'fk_soundboard_server',
      ]) {
        expect(source).toMatch(new RegExp(`ADD CONSTRAINT ${constraint}[^;]*NOT VALID`));
        expect(source).toContain(`VALIDATE CONSTRAINT ${constraint}`);
      }
      expect(source).toContain("conrelid = 'soundboard'::regclass");
      expect(source).toContain('EXCEPTION WHEN check_violation');
      expect(source).toContain('EXCEPTION WHEN foreign_key_violation');
      expect(source).toMatch(/soundboard_duration_bounds CHECK \("durationSeconds" > 0 AND "durationSeconds" <= 5\) NOT VALID/);
      expect(source).not.toMatch(/soundboard_duration_bounds CHECK \("durationSeconds" IS NULL OR/);
    }
    // Clean installs have no legacy scan risk and therefore own validated
    // constraints immediately.
    expect(fresh).not.toContain('NOT VALID');
    expect(sqlMirror).not.toContain('NOT VALID');
  });

  it('runtime collection mapping and SQL identifier whitelist include every stats field', () => {
    const index = read('db', 'postgres', 'index.ts');
    const loader = read('db', 'loader.ts');
    const collection = read('db', 'postgres', 'pgCollection.ts');
    expect(index).toContain("soundboardUserStats:    'soundboard_user_stats'");
    expect(loader).toContain('soundboardUserStats:');
    expect(collection).toContain("soundboard_user_stats: ['userId', 'soundId']");
    for (const field of ['soundId', 'favorite', 'favoritedAt', 'playCount']) {
      expect(collection).toMatch(new RegExp(`['\"]${field}['\"]`));
    }
  });

  it('route has no legacy small-count ceiling and uses cursor pages instead', () => {
    const route = read('routes', 'soundboard.ts');
    expect(route).not.toMatch(/existing\.length\s*>=\s*64|Maximum 64 sounds/i);
    expect(route).toContain('decodeSoundboardCursor');
    expect(route).toContain('limit > 100');
  });
});
