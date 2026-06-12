// client/js/core/mention-autocomplete-svelte.ts
// Sprint 116 — MentionAutocomplete mount shim (ADR-0008 Faz 3)
// Mention otomatik tamamlama
import { mount } from 'svelte';
import MentionAutocomplete from './MentionAutocomplete.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MentionAutocompleteShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMentionAutocomplete(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('mention-autocomplete-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'mention-autocomplete-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MentionAutocomplete, { target: el, props: {} });
  log.info('MentionAutocomplete mounted via shim');
}

export function unmountMentionAutocomplete(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMentionAutocomplete(), { once: true });
} else {
  mountMentionAutocomplete();
}
document.addEventListener('bridge:socket-ready', () => mountMentionAutocomplete(), { once: true });
