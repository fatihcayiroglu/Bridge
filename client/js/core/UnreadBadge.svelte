<!-- client/js/core/UnreadBadge.svelte -->
<!-- Sprint 116 — unread.ts → Svelte 5 Runes -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';

  interface UnreadState { [channelId: string]: { count: number; mention: boolean } }

  let unread    = $state<UnreadState>({});
  let totalDms  = $state(0);

  let totalMentions = $derived(
    Object.values(unread).filter(u => u.mention).length
  );
  let totalUnread = $derived(
    Object.values(unread).reduce((s, u) => s + u.count, 0) + totalDms
  );

  function setChannelUnread(channelId: string, count: number, mention = false) {
    if (count === 0) {
      const next = { ...unread };
      delete next[channelId];
      unread = next;
    } else {
      unread = { ...unread, [channelId]: { count, mention } };
    }
    syncFavicon();
  }

  function clearChannel(channelId: string) {
    setChannelUnread(channelId, 0);
  }

  function setDmUnread(count: number) {
    totalDms = count; syncFavicon();
  }

  function syncFavicon() {
    const total = totalUnread;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (!link) return;
    link.href = total > 0 ? '/favicon-unread.ico' : '/favicon.ico';
    document.title = total > 0
      ? `(${total > 99 ? '99+' : total}) Bridge`
      : 'Bridge';
  }

  onMount(() => {
    BridgeRegistry.register('setChannelUnread', setChannelUnread);
    BridgeRegistry.register('clearChannelUnread', clearChannel);
    BridgeRegistry.register('setDmUnread', setDmUnread);
    BridgeRegistry.register('getUnreadCount', () => totalUnread);
    BridgeRegistry.register('getMentionCount', () => totalMentions);
  });
</script>

<!-- This is a headless component — renders badges via BridgeRegistry -->
{#if totalMentions > 0}
<div class="unread-badge mention" aria-label="{totalMentions} mention" role="status">
  {totalMentions > 99 ? '99+' : totalMentions}
</div>
{:else if totalUnread > 0}
<div class="unread-badge" aria-label="{totalUnread} okunmamış" role="status">
  {totalUnread > 99 ? '99+' : totalUnread}
</div>
{/if}

<style>
.unread-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--bridge-surface3, #393c40);
  color: #fff; font-size: .7rem; font-weight: 700;
  padding: 0 5px;
}
.unread-badge.mention { background: var(--bridge-danger, #f04747); }
</style>
