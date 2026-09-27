import { mount, unmount } from 'svelte';
import PollsPanel from './PollsPanel.svelte';
let instance: ReturnType<typeof mount> | null = null;
export function mountPollsPanel(target?: HTMLElement): void {
  if (instance) return;
  const host = target ?? document.getElementById('polls-root') ?? (() => { const el=document.createElement('div'); el.id='polls-root'; document.body.appendChild(el); return el; })();
  instance = mount(PollsPanel, { target: host });
}
export function unmountPollsPanel(): void { if (!instance) return; void unmount(instance); instance=null; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountPollsPanel(), { once:true }); else mountPollsPanel();
