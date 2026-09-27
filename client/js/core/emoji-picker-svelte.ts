// client/js/core/emoji-picker-svelte.ts
// FAZ K/4 — EmojiPickerPanel mount shim.
//
// Kanonik biçim `global-search-svelte.ts` / `search-svelte.ts` ile AYNI:
// kendi kökünü üretir ve `unmount()` GERÇEKTEN çağrılır (yoksa `onDestroy`
// çalışmaz, registry kayıtları ölü bileşene işaret etmeye devam eder).

import { mount, unmount } from 'svelte';
import EmojiPickerPanel from './EmojiPickerPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountEmojiPicker(target?: HTMLElement): void {
  if (instance) return;
  const el = target ?? document.getElementById('emoji-picker-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'emoji-picker-root';
    document.body.appendChild(div);
    return div;
  })();
  instance = mount(EmojiPickerPanel, { target: el, props: {} });
}

export function unmountEmojiPicker(): void {
  if (!instance) return;
  void unmount(instance);
  instance = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountEmojiPicker(), { once: true });
} else {
  mountEmojiPicker();
}
