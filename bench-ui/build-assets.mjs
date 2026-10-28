import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, 'generated');
mkdirSync(outDir, { recursive: true });
const meta = {};

for (const framework of ['svelte', 'react']) {
  const output = await build({
    entryPoints: [join(root, framework === 'react' ? 'react-entry.jsx' : 'svelte-entry.js')],
    bundle: true,
    minify: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: framework === 'svelte' ? [{
      name: 'compile-svelte',
      setup(api) {
        api.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
          contents: compile(readFileSync(path, 'utf8'), { filename: path, generate: 'client', dev: false }).js.code,
          loader: 'js',
        }));
      },
    }] : [],
  });
  if (output.outputFiles?.length !== 1) throw new Error(framework + ': expected exactly one JS bundle');
  const bytes = output.outputFiles[0].contents;
  writeFileSync(join(outDir, framework + '.js'), bytes);
  meta[framework] = { rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}
writeFileSync(join(outDir, 'bundle-meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('BUNDLE_SIZES ' + JSON.stringify(meta));
