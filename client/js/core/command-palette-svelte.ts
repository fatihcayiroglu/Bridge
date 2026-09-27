// client/js/core/command-palette-svelte.ts
// Sprint 115 — CommandPalettePanel mount shim (ADR-0008 Faz 2)
// Faz 8.1: bu shim hiçbir yerden import edilmiyordu; app.ts artık import ediyor.
import { mount, unmount } from 'svelte';
import CommandPalettePanel from './CommandPalettePanel.svelte';

let _instance: ReturnType<typeof mount> | null = null;

export function mountCommandPalette(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('command-palette-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'command-palette-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(CommandPalettePanel, { target: el, props: {} });
}

export function unmountCommandPalette(): void {
  if (!_instance) return;
  const inst = _instance;
  _instance = null;
  void unmount(inst);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountCommandPalette(), { once: true });
} else {
  mountCommandPalette();
}
// Socket hazır olduğunda ikinci kez çağrılır; `_instance` guard'ı sayesinde
// çift mount olmaz (iki panel / iki klavye dinleyicisi oluşmaz).
document.addEventListener('bridge:socket-ready', () => mountCommandPalette(), { once: true });
