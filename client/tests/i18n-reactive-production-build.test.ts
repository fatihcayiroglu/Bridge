// client/tests/i18n-reactive-production-build.test.ts
//
// Final21 Faz 19 — `t()` ÜRETİM PAKETİNDE REAKTİF Mİ?
//
// `reactive.svelte.ts` reaktifliği bir durum okumasıyla kurar. Okuma çıplak bir `_tick;`
// ifadesiydi. Üretim derlemesi `.svelte.ts` modüllerini Svelte'ten ÖNCE esbuild ile TS'den
// JS'e çevirir (esbuild-svelte, `build.initialOptions` → `minify: true`) ve yan etkisiz bir
// ifadeyi SİLER; Svelte'in `$.get()` üreteceği bir şey kalmaz. Paketteki `t()` durumu hiç
// okumuyordu: İngilizce tarayıcıda açılışta monte edilen bileşenler Türkçe kaldı, dil
// değişimi açık bileşenlere yansımadı. Diğer birim testleri geliştirme derlemesinde koştuğu
// için bunu göremez. Bu test ÜRETİM boru hattını birebir yeniden kurar.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// esbuild jsdom içinde çalışmaz (TextEncoder değişmezi); derleme ayrı bir Node sürecinde yapılır.
const COMPILE = [
  "const { transformSync } = require('esbuild');",
  "const { compileModule } = require('svelte/compiler');",
  "let src = ''; process.stdin.on('data', (d) => { src += d; }).on('end', () => {",
  // scripts/build.js üretimde `minify: true` verir; esbuild-svelte bunu TS dönüşümüne taşır.
  "  const ts = transformSync(src, { loader: 'ts', format: 'esm', minify: true, target: 'es2020' });",
  "  process.stdout.write(compileModule(ts.code, { filename: 'module.svelte.js', generate: 'client' }).js.code);",
  "});",
].join('\n');

async function productionCompile(source: string): Promise<string> {
  const r = spawnSync(process.execPath, ['-e', COMPILE], { input: source, encoding: 'utf8', cwd: resolve(__dirname, '..', '..') });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

/** Minify renames declarations (`function g(...)` + `export { g as t }`): resolve the export first. */
function localName(code: string, exported: string): string {
  for (const block of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of block[1].split(',')) {
      const [local, as] = part.trim().split(/\s+as\s+/);
      if ((as ?? local) === exported) return local;
    }
  }
  return exported;
}

function functionBody(code: string, exported: string): string {
  const name = localName(code, exported);
  const start = code.search(new RegExp(`function ${name.replace(/\$/g, '\\$')}\\(`));
  expect(start, `function ${name} not found in compiled output`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = code.indexOf('{', start); i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(start, i + 1);
  }
  throw new Error('unbalanced function body');
}

describe('reactive t() survives the production build', () => {
  it('t() and localeTag() read the locale state in the production-compiled module', async () => {
    const source = readFileSync(resolve(__dirname, '../js/core/i18n/reactive.svelte.ts'), 'utf8');
    const code = await productionCompile(source);
    expect(functionBody(code, 't')).toMatch(/\$\.get\(/);
    expect(functionBody(code, 'localeTag')).toMatch(/\$\.get\(/);
  });

  it('CONTROL: the same pipeline deletes a bare `state;` read (the shipped defect)', async () => {
    const code = await productionCompile(
      'let tick = $state(0);\nexport function bump(): void { tick++; }\nexport function t(k: string): string { tick; return k; }\n',
    );
    expect(functionBody(code, 't')).not.toMatch(/\$\.get\(/);
  });
});
