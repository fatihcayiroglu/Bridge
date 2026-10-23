// Read-only comparison of an upgraded database and an independent fresh install.
// PG_UPGRADE_URL / PG_FRESH_URL are mandatory; never print credentials or row data.
const { Client } = require('pg');
const { createHash } = require('crypto');

const queries = {
  columns: `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default,is_identity,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`,
  constraints: `SELECT c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,k.conname`,
  indexes: `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
  functions: `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS definition,p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname,args`,
  triggers: `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,t.tgenabled,t.tgdeferrable,t.tginitdeferred
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
  table_access: `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname`,
  policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`,
};
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

async function main() {
  if (!process.env.PG_UPGRADE_URL || !process.env.PG_FRESH_URL) {
    throw new Error('PG_UPGRADE_URL and PG_FRESH_URL are required');
  }
  const clients = [process.env.PG_UPGRADE_URL, process.env.PG_FRESH_URL]
    .map(connectionString => new Client({ connectionString, connectionTimeoutMillis: 10000, query_timeout: 30000 }));
  const connected = new Set();
  const result = { status: 'PASS', catalogs: {} };
  try {
    for (const client of clients) {
      await client.connect();
      connected.add(client);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='30s'");
    }
    const identities = await Promise.all(clients.map(client => client.query(
      'SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port')));
    if (JSON.stringify(identities[0].rows) === JSON.stringify(identities[1].rows)) {
      throw new Error('Two independent databases are required');
    }
    for (const [name, sql] of Object.entries(queries)) {
      const [a, b] = await Promise.all(clients.map(client => client.query(sql)));
      const equal = JSON.stringify(a.rows) === JSON.stringify(b.rows);
      result.catalogs[name] = { upgradedCount: a.rowCount, freshCount: b.rowCount, equal,
        upgradedHash: hash(a.rows), freshHash: hash(b.rows) };
      if (!equal) result.status = 'FAIL';
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    for (const client of clients) {
      if (connected.has(client)) {
        try { await client.query('ROLLBACK'); } catch { /* A failed connection has no transaction. */ }
      }
      await client.end();
    }
  }
}

main().catch(error => {
  // Connection/parser errors can include operator-supplied URLs. Keep diagnostics
  // bounded to a SQLSTATE; the supplied databases and definitions are not logged.
  const code = typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'UNVERIFIED';
  console.error(`Schema equivalence could not be verified (${code}); two independent database URLs are required.`);
  process.exitCode = 1;
});
