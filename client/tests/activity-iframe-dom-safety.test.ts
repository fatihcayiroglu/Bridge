import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT = path.resolve(__dirname, '..');
const read = (name: string) => fs.readFileSync(path.join(CLIENT, 'activities', name, 'index.html'), 'utf8');

describe('standalone activity participant DOM safety', () => {
  it.each(['watch-together', 'draw-together'])('%s escapes participant initials and constrains avatar colors', (name) => {
    const src = read(name);
    expect(src).toMatch(/function safeColor\(value\)/);
    expect(src).toMatch(/\^#\[0-9a-f\]\{3,8\}\$/i);
    expect(src).toMatch(/escHtml\(\(p\.(?:name|displayName)\s*\|\|\s*'\?'\)\[0\]\.toUpperCase\(\)\)/);
    expect(src).not.toMatch(/style="background:\$\{p\.color/);
  });

  it('draw-together also normalizes the cursor CSS custom property', () => {
    const src = read('draw-together');
    expect(src).toContain('--cursor-color:${safeColor(cur.color)}');
  });
});
