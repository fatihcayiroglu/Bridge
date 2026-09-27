<!-- client/js/core/UnreadBadge.svelte -->
<!-- Sprint 116 — unread.ts → Svelte 5 Runes -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
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

  function normalizeCount(value: unknown): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
  }

  function setChannelUnread(channelId: string, count: number, mention = false) {
    if (typeof channelId !== 'string' || !channelId) return;
    const safeCount = normalizeCount(count);
    if (safeCount === 0) {
      const next = { ...unread };
      delete next[channelId];
      unread = next;
    } else {
      unread = { ...unread, [channelId]: { count: safeCount, mention: mention === true } };
    }
    syncFavicon();
  }

  function clearChannel(channelId: string) {
    setChannelUnread(channelId, 0);
  }

  function setDmUnread(count: number) {
    totalDms = normalizeCount(count); syncFavicon();
  }

  function syncFavicon() {
    const total = totalUnread;
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    if (link) link.href = total > 0 ? '/favicon-unread.ico' : '/favicon.ico';
    document.title = total > 0
      ? `(${total > 99 ? '99+' : total}) Bridge`
      : 'Bridge';
  }

  const getUnreadCount = () => totalUnread;
  const getMentionCount = () => totalMentions;

  const registrations = [
    ['setChannelUnread', setChannelUnread],
    ['clearChannelUnread', clearChannel],
    ['setDmUnread', setDmUnread],
    ['getUnreadCount', getUnreadCount],
    ['getMentionCount', getMentionCount],
  ] as const;

  onMount(() => {
    for (const [name, fn] of registrations) BridgeRegistry.register(name, fn);
    syncFavicon();
  });

  onDestroy(() => {
    // Delete only registrations still owned by this component. This makes
    // teardown safe even if a replacement instance was mounted while an
    // outro/async unmount was finishing.
    for (const [name, fn] of registrations) {
      if (BridgeRegistry.get(name) === fn) BridgeRegistry.unregister(name);
    }
  });
</script>

<!-- This is a headless component — renders badges via BridgeRegistry -->
{#if totalMentions > 0}
<div class="unread-badge mention" aria-label={t('unread_mentions_count_aria', undefined, { count: totalMentions })} role="status">
  {totalMentions > 99 ? '99+' : totalMentions}
</div>
{:else if totalUnread > 0}
<div class="unread-badge" aria-label={t('unread_count', '{count} okunmamış', { count: totalUnread })} role="status">
  {totalUnread > 99 ? '99+' : totalUnread}
</div>
{/if}

<style>
.unread-badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 18px; height: 18px; border-radius: 9px;
  background: var(--bridge-surface3, #2c3048);
  color: var(--text-on-solid); font-size: .7rem; font-weight: 700;
  padding: 0 5px;
}
.unread-badge.mention { background: var(--bridge-danger, #e05260); }
</style>
