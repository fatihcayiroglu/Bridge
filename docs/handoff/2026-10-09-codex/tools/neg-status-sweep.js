// Tests whose every assertion on a `.status()` / `.ok()` value is negative (not.toBe / not.toEqual / toBeLessThan / toBeGreaterThan*)
// and that have no positive status assertion (toBe(N) / toEqual(N) / toBeTruthy on ok()).
const ts = require(process.argv[2]); const fs = require('fs');
for (const f of process.argv.slice(3)) {
  const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'test' && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0])) {
      const body = n.arguments[n.arguments.length - 1];
      let pos = 0, neg = 0; const negs = [];
      const walk = (m) => {
        if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression)) {
          const txt = m.getText();
          if (/^expect\([^)]*\.(status|ok)\(\)/.test(txt)) {
            if (/\.not\.|toBeLessThan|toBeGreaterThan/.test(txt)) { neg++; negs.push(txt.split('\n')[0].slice(0, 90)); }
            else if (/\.(toBe|toEqual|toBeTruthy|toContain)\(/.test(txt)) pos++;
          }
        }
        ts.forEachChild(m, walk);
      };
      walk(body);
      if (neg > 0 && pos === 0) {
        const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        console.log(`${f}:${line}\t${n.arguments[0].text}\t${negs.join(' | ')}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
