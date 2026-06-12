#!/usr/bin/env node
/**
 * client/tests altındaki .test.js dosyalarını .test.ts'ye dönüştürür.
 *   node client/scripts/migrate-tests-to-ts.js
 *   node client/scripts/migrate-tests-to-ts.js --dry-run
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_JS = process.argv.includes('--keep-js');
const TESTS_DIR = path.join(__dirname, '..', 'tests');

function transformContent(src) {
  let out = src;
  out = out.replace(
    /^const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/gm,
    (_m, names, mod) => {
      const cleaned = names.split(',').map(n => n.trim()).join(', ');
      return `import { ${cleaned} } from '${mod}';`;
    },
  );
  out = out.replace(
    /^const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/gm,
    (_m, name, mod) => `import ${name} from '${mod}';`,
  );
  out = out.replace(/^\/\/ client\/tests\/([^\n]+\.test)\.js/m, '// client/tests/$1.ts');
  out = out.replace(/module\.exports\s*=\s*/g, 'export default ');
  return out;
}

function findTestJs(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findTestJs(full));
    else if (entry.name.endsWith('.test.js')) results.push(full);
  }
  return results;
}

const files = findTestJs(TESTS_DIR);
console.log(`Bulunan .test.js: ${files.length}`);
let converted = 0;

for (const jsFile of files) {
  const tsFile = jsFile.replace(/\.test\.js$/, '.test.ts');
  if (fs.existsSync(tsFile)) continue;
  const out = transformContent(fs.readFileSync(jsFile, 'utf8'));
  if (!DRY_RUN) {
    fs.writeFileSync(tsFile, out, 'utf8');
    if (!KEEP_JS) fs.unlinkSync(jsFile);
  }
  converted++;
  console.log(' ', path.basename(tsFile));
}

console.log(`Dönüştürülen: ${converted}${DRY_RUN ? ' (dry-run)' : ''}`);
