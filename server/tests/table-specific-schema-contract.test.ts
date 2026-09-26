/**
 * Table-specific PostgreSQL contract guard.
 *
 * pgCollection has a global column allowlist. That prevents SQL identifier
 * injection but cannot prove that a globally valid column exists on the
 * PARTICULAR table being queried. Example regressions found in review:
 *   - bots.name / bots.createdBy while the table owns username / ownerId
 *   - notification_prefs.serverId while server-level prefs are encoded as
 *     channelId = `server:<id>`
 *   - outgoing_webhooks.active while the schema owns enabled
 *
 * This guard scans literal repository queries and compares them with the
 * canonical fresh schema + inline upgrade migrations. Dynamic Record fields
 * still require focused tests/review; this deliberately avoids pretending to
 * prove what static analysis cannot know.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const SERVER_ROOT = path.resolve(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(SERVER_ROOT, ...parts), 'utf8');

function parseTableMap(): Record<string, string> {
  const source = read('db', 'postgres', 'index.ts');
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/^\s*(\w+):\s+'([^']+)'/gm)) out[m[1]] = m[2];
  return out;
}

function parseColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const sources = [read('db', 'postgres', 'schema.ts'), read('db', 'postgres', 'migrations.ts')];

  for (const source of sources) {
    for (const m of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][\w]*)\s*\(([\s\S]*?)\n\s*\)/g)) {
      const set = out.get(m[1]) ?? new Set<string>();
      for (const line of m[2].split('\n')) {
        const col = line.trim().match(/^(?:"([^"]+)"|([a-zA-Z_][\w]*))\s+(?:TEXT|BIGINT|INTEGER|BOOLEAN|JSONB|BYTEA|NUMERIC|TIMESTAMP|SERIAL|BIGSERIAL|REAL|DOUBLE|VARCHAR)/i);
        if (col) set.add(col[1] || col[2]);
      }
      out.set(m[1], set);
    }

    for (const m of source.matchAll(/ALTER TABLE\s+([a-zA-Z_][\w]*)\s+ADD COLUMN IF NOT EXISTS\s+(?:"([^"]+)"|([a-zA-Z_][\w]*))/g)) {
      const set = out.get(m[1]) ?? new Set<string>();
      set.add(m[2] || m[3]);
      out.set(m[1], set);
    }
  }
  return out;
}

function repositoryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['dist', 'coverage', 'node_modules', '_archived_legacy'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...repositoryFiles(full));
    else if (ent.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('repository literal columns exist on their actual PostgreSQL tables', () => {
  it('has no table-specific literal query drift', () => {
    const tableMap = parseTableMap();
    const columns = parseColumns();
    const queryMethods = new Set(['find', 'findOne', 'insert', 'update', 'remove', 'count']);
    const problems: string[] = [];

    for (const file of repositoryFiles(path.join(SERVER_ROOT, 'db', 'repositories'))) {
      const sourceText = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && queryMethods.has(node.expression.name.text)) {
          const receiver = node.expression.expression;
          if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === 'db') {
            const collection = receiver.name.text;
            const table = tableMap[collection];
            const valid = table ? columns.get(table) : undefined;
            if (table && valid) {
              // arg 0 = query/document, arg 1 may be update modifier. arg 2 is
              // adapter options (e.g. { multi: true }) and is NOT a DB row.
              node.arguments.slice(0, 2).forEach(arg => {
                if (!ts.isObjectLiteralExpression(arg)) return;
                for (const prop of arg.properties) {
                  if (!(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))) continue;
                  const nameNode = prop.name;
                  const name = ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) ? nameNode.text : null;
                  if (!name || name.startsWith('$') || valid.has(name)) continue;
                  const { line } = sf.getLineAndCharacterOfPosition(prop.getStart(sf));
                  problems.push(`${path.relative(SERVER_ROOT, file)}:${line + 1} ${collection}.${name} -> ${table}`);
                }
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(problems).toEqual([]);
  });
});
