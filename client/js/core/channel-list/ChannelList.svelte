<!-- client/js/core/channel-list/ChannelList.svelte -->
<!-- channel-list.ts renderChannels DOM'unun Svelte karşılığı -->
<script lang="ts">
  import ChannelItem, { type ChannelData } from './ChannelItem.svelte';

  export interface CategoryData {
    _id: string;
    name: string;
    position: number;
    collapsed?: boolean;
  }

  interface Props {
    channels: ChannelData[];
    categories?: CategoryData[];
    collapsedCategoryKeys?: Set<string>;
    activeChannelId?: string | null;
    onSelect: (channel: ChannelData) => void;
    onOpenMenu: (channelId: string, name: string, event: MouseEvent) => void;
    onCreateChannel?: () => void;
    onCreateInCategory?: (categoryId: string, event: MouseEvent) => void;
    onToggleCategory?: (categoryKey: string) => void;
  }

  let {
    channels,
    categories = [],
    collapsedCategoryKeys = new Set<string>(),
    activeChannelId = null,
    onSelect,
    onOpenMenu,
    onCreateChannel,
    onCreateInCategory,
    onToggleCategory,
  }: Props = $props();

  const uncategorized = $derived(channels.filter(ch => !(ch as ChannelData & { categoryId?: string }).categoryId));
  const grouped = $derived.by(() => {
    const map: Record<string, ChannelData[]> = {};
    for (const ch of channels) {
      const cid = (ch as ChannelData & { categoryId?: string }).categoryId;
      if (!cid) continue;
      if (!map[cid]) map[cid] = [];
      map[cid].push(ch);
    }
    return map;
  });

  function fallbackGroups(): Record<string, ChannelData[]> {
    const map: Record<string, ChannelData[]> = {};
    for (const ch of channels) {
      const cat = (ch as ChannelData & { category?: string }).category ?? 'GENERAL';
      if (!map[cat]) map[cat] = [];
      map[cat].push(ch);
    }
    return map;
  }

  const useDbCategories = $derived(categories.length > 0);
</script>

<div class="channel-list-inner">
  {#if !useDbCategories}
    {#each Object.entries(fallbackGroups()) as [cat, chs]}
      {@const isCollapsed = collapsedCategoryKeys.has(cat)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="ch-category" role="button" tabindex="0" onclick={() => onToggleCategory?.(cat)}>
        <span class="cat-arrow" class:collapsed={isCollapsed}>▾</span>
        {cat}
        <button type="button" class="ch-add-btn" title="Add channel" onclick={(e) => { e.stopPropagation(); onCreateChannel?.(); }}>+</button>
      </div>
      {#if !isCollapsed}
        {#each chs as ch (ch._id)}
          <ChannelItem channel={ch} active={activeChannelId === ch._id} {onSelect} {onOpenMenu} />
        {/each}
      {/if}
    {/each}
  {:else}
    {#each uncategorized as ch (ch._id)}
      <ChannelItem channel={ch} active={activeChannelId === ch._id} {onSelect} {onOpenMenu} />
    {/each}

    {#each [...categories].sort((a, b) => a.position - b.position) as cat (cat._id)}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div class="ch-category" data-cat-id={cat._id} role="button" tabindex="0"
        onclick={(e) => { if ((e.target as HTMLElement).classList.contains('ch-add-btn')) return; onToggleCategory?.(cat._id); }}>
        <span class="cat-arrow">{cat.collapsed ? '▶' : '▼'}</span>
        <span class="cat-name">{cat.name}</span>
        <button type="button" class="ch-add-btn" title="Kanal Ekle"
          onclick={(e) => { e.stopPropagation(); onCreateInCategory?.(cat._id, e); }}>+</button>
      </div>
      {#if !cat.collapsed}
        <div id="cat-channels-{cat._id}">
          {#each grouped[cat._id] ?? [] as ch (ch._id)}
            <ChannelItem channel={ch} active={activeChannelId === ch._id} {onSelect} {onOpenMenu} />
          {/each}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .channel-list-inner { display: flex; flex-direction: column; }
  .ch-category {
    display: flex; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    color: var(--text-muted); padding: 8px 4px 4px; cursor: pointer;
    user-select: none;
  }
  .cat-arrow { font-size: 10px; transition: transform .2s; }
  .cat-arrow.collapsed { transform: rotate(-90deg); }
  .cat-name { flex: 1; }
  .ch-add-btn {
    background: none; border: none; cursor: pointer;
    color: var(--text-muted); font-size: 14px; padding: 0 4px;
  }
</style>
