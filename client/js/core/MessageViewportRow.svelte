<!-- Keep the message model in its owner; release only offscreen rendering. -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  let { messageId, enabled = false, compact = false, keepFocusTarget = false, children }: {
    messageId: string; enabled?: boolean; compact?: boolean; keepFocusTarget?: boolean; children: Snippet;
  } = $props();
  let node: HTMLDivElement;
  let near = $state(false);
  let forced = $state(false);
  let retained = $state(false);
  const supported = typeof IntersectionObserver !== 'undefined' && typeof ResizeObserver !== 'undefined';
  let height = $state<number | null>(null);
  const rendered = $derived(!enabled || !supported || near || forced || retained || keepFocusTarget);
  const placeholderHeight = $derived(height ?? (compact ? 26 : 64));

  onMount(() => {
    // Browser support is a prerequisite; never hide rows without an observer.
    if (!supported) return;
    const root = node.closest('#messages-area');
    let alive = true;
    const keepInteraction = () => {
      if (!alive) return;
      retained = node.contains(document.activeElement) || Boolean(node.querySelector('[aria-modal="true"], [role="menu"]')) ||
        [...node.querySelectorAll<HTMLMediaElement>('audio,video')].some(media => !media.paused && !media.ended);
    };
    const reveal = () => { forced = true; };
    const later = () => queueMicrotask(keepInteraction);
    const play = () => { retained = true; };
    node.addEventListener('bridge:message-reveal', reveal);
    node.addEventListener('focusin', keepInteraction);
    node.addEventListener('focusout', later);
    node.addEventListener('play', play, true);
    node.addEventListener('pause', later, true);
    node.addEventListener('ended', later, true);
    const sizes = new ResizeObserver(entries => {
      if (!alive || !rendered) return;
      const size = entries[0]?.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height;
      if (Number.isFinite(size) && size > 0) height = size;
    });
    const visibility = new IntersectionObserver(entries => {
      if (!alive) return;
      for (const entry of entries) {
        near = entry.isIntersecting;
        if (near) forced = false;
        keepInteraction();
      }
    }, { root, rootMargin: '600px 0px' });
    sizes.observe(node);
    visibility.observe(node);
    return () => {
      alive = false; sizes.disconnect(); visibility.disconnect();
      node.removeEventListener('bridge:message-reveal', reveal);
      node.removeEventListener('focusin', keepInteraction);
      node.removeEventListener('focusout', later);
      node.removeEventListener('play', play, true);
      node.removeEventListener('pause', later, true);
      node.removeEventListener('ended', later, true);
    };
  });
</script>

<div bind:this={node} class="message-viewport-row" data-message-viewport-id={messageId}
  style:height={rendered ? undefined : `${placeholderHeight}px`}>
  {#if rendered}{@render children()}{/if}
</div>

<style>
  .message-viewport-row { display: flow-root; flex: none; overflow-anchor: auto; }
</style>
