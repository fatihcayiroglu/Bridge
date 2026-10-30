<!-- Keep the message model in its owner; release only offscreen rendering. -->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { observeMessageRow } from './message-viewport-observers';
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
    let alive = true;
    const keepInteraction = () => {
      if (!alive) return;
      retained = node.contains(document.activeElement) || Boolean(node.querySelector('[aria-modal="true"], [role="menu"]')) ||
        [...node.querySelectorAll<HTMLMediaElement>('audio,video')].some(media => !media.paused && !media.ended);
    };
    const stop = observeMessageRow(node, {
      size(size) { if (alive && rendered) height = size; },
      visibility(value) {
        if (!alive) return;
        near = value;
        if (near) forced = false;
        keepInteraction();
      },
      interaction(type) {
        if (!alive) return;
        if (type === 'bridge:message-reveal') forced = true;
        else if (type === 'play') retained = true;
        else if (type === 'focusin') keepInteraction();
        else queueMicrotask(keepInteraction);
      },
    });
    return () => { alive = false; stop(); };
  });
</script>

<div bind:this={node} class="message-viewport-row" data-message-viewport-id={messageId}
  style:height={rendered ? undefined : `${placeholderHeight}px`}>
  {#if rendered}{@render children()}{/if}
</div>

<style>
  .message-viewport-row { display: flow-root; flex: none; overflow-anchor: auto; }
</style>
