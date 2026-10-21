#!/usr/bin/env node
'use strict';
// Parse guarded source files so comments and line breaks cannot hide imports.
const fs = require('node:fs');
const ts = require('typescript');

function forbidden(specifier) {
  return specifier === 'svelte' || specifier.startsWith('svelte/') || /\.svelte(?:\.|[?#]|$)/.test(specifier);
}

function literal(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))) node = node.expression;
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

const violations = [];
for (const file of process.argv.slice(2)) {
  const source = fs.readFileSync(file, 'utf8');
  const kind = /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  function record(node, specifier, computed = false) {
    if (!computed && (specifier === null || !forbidden(specifier))) return;
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    violations.push(`${file}: ${line}: ${computed ? 'computed import cannot prove the Svelte boundary' : `Svelte import ${JSON.stringify(specifier)}`}`);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) record(node, literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, literal(node.moduleReference.expression));
    } else if (ts.isImportTypeNode(node)) {
      const arg = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
      record(node, literal(arg), arg !== null && literal(arg) === null);
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      const specifier = arg ? literal(arg) : null;
      record(node, specifier, specifier === null);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
process.stdout.write(violations.join('\n'));
