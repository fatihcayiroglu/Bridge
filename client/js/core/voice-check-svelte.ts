import { mount, unmount } from 'svelte';
import VoiceCheckPanel from './VoiceCheckPanel.svelte';

let instance: ReturnType<typeof mount> | null = null;

export function mountVoiceCheck(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('voice-check-root') ?? (() => {
    const node = document.createElement('div');
    node.id = 'voice-check-root';
    document.body.appendChild(node);
    return node;
  })();
  instance = mount(VoiceCheckPanel, { target: host });
}

export function unmountVoiceCheck(): void {
  if (!instance) return;
  const mounted = instance;
  instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVoiceCheck(), { once: true });
} else {
  mountVoiceCheck();
}
document.addEventListener('bridge:socket-ready', () => mountVoiceCheck(), { once: true });
