import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '../css/modules/modals.css'), 'utf8');

describe('shared tooltip lifecycle', () => {
  it('does not keep tooltips open merely because a clicked control retains focus', () => {
    // Mouse/touch activation often leaves a button focused after the panel it
    // opened has closed. `:focus-within` made that focus look like a fresh
    // tooltip request, leaving Inbox/Saved labels stuck under the toolbar.
    // Keyboard discoverability remains via `:focus-visible`.
    const tooltipBlock = css.slice(css.indexOf('/* TOOLTIP */'), css.indexOf('/* INVITE */'));
    expect(tooltipBlock).toContain('.tooltip:focus-visible::after');
    expect(tooltipBlock).not.toContain('.tooltip:focus-within::after');
  });

  it('keeps pointer and keyboard tooltip affordances for header and composer controls', () => {
    expect(css).toMatch(/\.channel-header \.tooltip:hover::after/);
    expect(css).toMatch(/\.channel-header \.tooltip:focus-visible::after/);
    expect(css).toMatch(/\.msg-input-box \.tooltip:hover::after/);
    expect(css).toMatch(/\.msg-input-box \.tooltip:focus-visible::after/);
  });
});
