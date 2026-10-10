// Finds Playwright tests whose every assertion is conditional (inside if/?:/&&/catch),
// and tests with no assertion at all. Usage: node cond-sweep.js <ts-module-path> <files...>
const ts = require(process.argv[2]);
const fs = require('fs');
const files = process.argv.slice(3);
const out = [];
const isTestCall = (n) => ts.isCallExpression(n) && (
  (ts.isIdentifier(n.expression) && n.expression.text === 'test') ||
  (ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) &&
   n.expression.expression.text === 'test' && ['only','fixme','fail','slow'].includes(n.expression.name.text)));
const isAssert = (n) => {
  if (!ts.isCallExpression(n)) return false;
  let e = n.expression;
  while (ts.isPropertyAccessExpression(e) || ts.isCallExpression(e)) e = ts.isCallExpression(e) ? e.expression : e.expression;
  return ts.isIdentifier(e) && (e.text === 'expect' || e.text === 'assert');
};
for (const f of files) {
  const src = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (n) => {
    if (isTestCall(n) && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0])) {
      const body = n.arguments[n.arguments.length - 1];
      if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) {
        let total = 0, uncond = 0; const helperCalls = new Set();
        const walk = (m, cond) => {
          if (isAssert(m)) { total++; const txt = m.getText(); const trivial = /expect\(\s*page\.locator\(\s*['"](body|html)['"]\s*\)\s*\)/.test(txt) || /expect\(\s*true\s*\)/.test(txt); if (!cond && !trivial) uncond++; }
          // helper calls whose name suggests an assertion
          if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && /^(expect|assert|check|verify|ensure)/i.test(m.expression.text) && m.expression.text !== 'expect') helperCalls.add(m.expression.text);
          ts.forEachChild(m, (c) => {
            let cc = cond;
            if (ts.isIfStatement(m) && c !== m.expression) cc = true;
            if (ts.isConditionalExpression(m) && c !== m.condition) cc = true;
            if (ts.isBinaryExpression(m) && (m.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || m.operatorToken.kind === ts.SyntaxKind.BarBarToken || m.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) && c === m.right) cc = true;
            if (ts.isCatchClause(m)) cc = true;
            if ((ts.isForStatement(m) || ts.isForOfStatement(m) || ts.isForInStatement(m) || ts.isWhileStatement(m)) && c === m.statement) cc = cc; // loops: not counted as conditional
            walk(c, cc);
          });
        };
        walk(body.body, false);
        const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        if (uncond === 0) out.push({ file: f, line, name: n.arguments[0].text, total, helpers: [...helperCalls].join(',') });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}
for (const o of out) console.log(`${o.total === 0 ? 'NO-ASSERT' : 'ALL-COND '}\t${o.file}:${o.line}\t${o.total}\t${o.helpers}\t${o.name}`);
