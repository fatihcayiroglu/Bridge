// CI-owned fixture only. No existing installation, database directory or user.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { requireDisposable } from './disposable.mjs';
const serverRequire = createRequire(new URL('../../server/package.json', import.meta.url));
const { Pool } = serverRequire('pg');
const bcrypt = serverRequire('bcryptjs');

const pool = new Pool({ connectionString: requireDisposable(process.env) });
let stage = 'DATABASE_PREREQUISITES';
try {
  const version = await pool.query('SHOW server_version_num');
  if (Math.floor(Number(version.rows[0].server_version_num) / 10000) !== 16) throw Error('PG16_REQUIRED');
  const existing = await pool.query('SELECT (SELECT COUNT(*) FROM users)+(SELECT COUNT(*) FROM servers)+(SELECT COUNT(*) FROM channels)+(SELECT COUNT(*) FROM messages) AS count');
  if (Number(existing.rows[0].count) !== 0) throw Error('FRESH_EMPTY_FIXTURE_DATABASE_REQUIRED');
  const stem = randomUUID();
  const user = randomUUID();
  const server = randomUUID();
  const idleChannel = randomUUID();
  const historyChannel = randomUUID();
  const username = 'perf_' + randomBytes(8).toString('hex');
  const password = randomBytes(32).toString('base64url');
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    stage = 'USER_FIXTURE';
    await client.query('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,$5)',
      [user, username, 'Disposable performance account', await bcrypt.hash(password, 12), now]);
    stage = 'SERVER_FIXTURE';
    await client.query('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,$4)',
      [server, 'Performance fixture', user, now]);
    stage = 'MEMBERSHIP_FIXTURE';
    // Current migrated schema uses (userId, serverId); legacy _id was removed.
    await client.query('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,$4)',
      [user, server, '[]', now]);
    stage = 'CHANNEL_FIXTURE';
    for (const [id, name, order] of [[idleChannel, 'idle', 0], [historyChannel, 'history-10000', 1]]) {
      await client.query('INSERT INTO channels (_id,"serverId",name,"order","createdAt") VALUES ($1,$2,$3,$4,$5)',
        [id, server, name, order, now]);
    }
    stage = 'MESSAGE_FIXTURE';
    await client.query('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), idleChannel, server, user, username, 'Performance fixture', 'Idle channel fixture', now]);
    const prefix = `perf-${stem}-`;
    await client.query('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")' +
      ' SELECT $1 || LPAD(n::text,5,\'0\'),$2,$3,$4,$5,$6,\'History fixture \' || n::text,$7::bigint+n FROM generate_series(1,10000) AS n',
      [prefix, historyChannel, server, user, username, 'Performance fixture', now - 20000]);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM messages WHERE "channelId"=$1', [historyChannel]);
    if (count.rows[0].count !== 10000) throw Error('FIXTURE_COUNT');
    await client.query('COMMIT');
    stage = 'PRIVATE_CONFIG';
    const config = { schema: 1, bridgeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      executable: '/opt/Bridge/bridge', output: path.resolve(process.env.BRIDGE_PERF_OUTPUT),
      origin: 'https://127.0.0.1:3443', user, username, password, server, idleChannel, historyChannel,
      messagePrefix: prefix, seededMessages: 10000 };
    fs.writeFileSync(process.env.BRIDGE_PERF_CONFIG, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ postgresVersion: Number(version.rows[0].server_version_num), fixtureCount: 10000, isolated: true }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
} catch (error) {
  console.error(JSON.stringify({ code: 'DISPOSABLE_PERF_FIXTURE_FAILED', stage,
    sqlState: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : null }));
  process.exitCode = 1;
} finally { await pool.end(); }
