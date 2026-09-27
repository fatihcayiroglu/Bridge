<!-- client/js/core/channel-list/ChannelList.svelte -->
<!-- channel-list.ts renderChannels DOM'unun Svelte karşılığı -->
<script lang="ts">
  import ChannelItem, { type ChannelData } from './ChannelItem.svelte';
  import { t } from '../i18n/reactive.svelte.ts';

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
    onOpenMenu?: (channelId: string, name: string, event: MouseEvent) => void;
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
  <!--
    KANAL YOK DURUMU.

    KAPATILAN GERCEK BOSLUK: sunucuda hic kanal yoksa iki dalin ikisi de BOS
    donuyordu (`fallbackGroups()` bos nesne, `categories` bos dizi) ve kenar
    cubugu tamamen bos kaliyordu. Yeni bir sunucu kuran kullanici, ne
    oldugunu ya da SIRADA NE YAPACAGINI anlatan hicbir sey gormuyordu.

    Bos durum, eylemi olan kisiye eylemi gosterir: kanal olusturma yetkisi
    olana dugme, olmayana yalnizca aciklama. Buradaki gorunurluk bir GUVENLIK
    SINIRI DEGILDIR — sunucu yetkiyi zaten dogrular; bu yalnizca yanlis bir
    umit vermemek icindir.
  -->
  {#if channels.length === 0}
    <div class="ch-empty">
      <p class="ch-empty-title">{t('channels_empty_title', 'Henüz kanal yok')}</p>
      {#if onCreateChannel}
        <p class="ch-empty-hint">{t('channels_empty_hint_admin', 'İlk kanalı oluşturarak sohbete başlayın.')}</p>
        <button type="button" class="ch-empty-cta" onclick={() => onCreateChannel?.()}>
          {t('channels_empty_cta', 'Kanal oluştur')}
        </button>
      {:else}
        <p class="ch-empty-hint">{t('channels_empty_hint_member', 'Bu sunucuda görebileceğiniz bir kanal yok.')}</p>
      {/if}
    </div>
  {:else if !useDbCategories}
    {#each Object.entries(fallbackGroups()) as [cat, chs]}
      {@const isCollapsed = collapsedCategoryKeys.has(cat)}
      <!-- ERISILEBILIRLIK: kategori basligi ARTIK `role="button"` DEGIL.
           Onceden `role="button" tabindex="0"` tasiyan bir `div` icinde
           GERCEK bir `<button>` (kanal ekle) duruyordu; axe bunu `serious`
           seviyesinde `nested-interactive` olarak isaretliyor: ic ice
           etkilesimli kontroller ekran okuyucularda her zaman duyurulmaz ve
           odak sirasini bozar. Artik acma/kapama gercek bir dugmedir ve
           "kanal ekle" onun KARDESIDIR. -->
      <div class="ch-category">
        <button
          type="button" class="cat-toggle"
          aria-expanded={!isCollapsed}
          onclick={() => onToggleCategory?.(cat)}
        >
          <span class="cat-arrow" class:collapsed={isCollapsed} aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></span>
          <span class="cat-name">{cat}</span>
        </button>
        {#if onCreateChannel}
          <button type="button" class="ch-add-btn" title={t('attr_kanal_ekle_ec976e3', "Kanal ekle")} aria-label={t('category_add_channel_aria', undefined, { category: cat })} onclick={() => onCreateChannel()}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg></button>
        {/if}
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
      {@const isCollapsed = collapsedCategoryKeys.has(cat._id)}
      <div class="ch-category" data-cat-id={cat._id}>
        <!-- `aria-controls` ancak liste GERCEKTEN cizildiginde anlamlidir;
             kapali kategoride hedef dugum yoktur ve olmayan bir id'ye isaret
             etmek ekran okuyucuya yanlis soz vermek olurdu. -->
        <button
          type="button" class="cat-toggle"
          aria-expanded={!isCollapsed}
          aria-controls={isCollapsed ? undefined : `cat-channels-${cat._id}`}
          onclick={() => onToggleCategory?.(cat._id)}
        >
          <span class="cat-arrow" class:collapsed={cat.collapsed} aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6 4 4 4-4"/></svg></span>
          <span class="cat-name">{cat.name}</span>
        </button>
        {#if onCreateInCategory}
          <button type="button" class="ch-add-btn" title={t('attr_kanal_ekle_ec976e3', "Kanal ekle")} aria-label={t('category_add_channel_aria', undefined, { category: cat.name })}
            onclick={(e) => onCreateInCategory(cat._id, e)}><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg></button>
        {/if}
      </div>
      {#if !isCollapsed}
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
  /* Kanal yok durumu — eylemi olan kisiye eylemi gosterir. */
  .ch-empty {
    display: grid;
    gap: 6px;
    padding: 18px 12px;
    text-align: center;
  }
  .ch-empty-title {
    margin: 0;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    color: var(--text-secondary);
  }
  .ch-empty-hint {
    margin: 0;
    font-size: var(--text-xs, 11px);
    line-height: 1.5;
    color: var(--text-muted);
  }
  .ch-empty-cta {
    justify-self: center;
    margin-top: 4px;
    padding: 6px 12px;
    border: 0;
    border-radius: var(--radius-md, 8px);
    background: var(--brand);
    color: var(--text-on-solid);
    font-size: var(--text-xs, 11px);
    font-weight: 650;
    cursor: pointer;
  }
  .ch-empty-cta:hover { filter: brightness(1.08); }
  .ch-empty-cta:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  .channel-list-inner { display: flex; flex-direction: column; padding-bottom: var(--space-2); }
  .ch-category {
    display: flex; align-items: center; gap: 5px; min-height: 28px;
    padding: 8px 6px 3px; border-radius: var(--radius-control);
  }
  /* Gorsel dil DEGISMEDI — yalnizca tasiyici artik gercek bir dugme. */
  .cat-toggle {
    /* WCAG 2.2 SC 2.5.8: gercek render'da 17px yuksekti. */
    min-height: 24px;
    display: flex; align-items: center; gap: 5px; flex: 1; min-width: 0;
    font: inherit;
    font-size: var(--type-caption); font-weight: 700; text-transform: uppercase;
    letter-spacing: .055em; color: var(--text-muted); text-align: start;
    cursor: pointer; user-select: none;
    background: none; border: 0; padding: 0;
    border-radius: var(--radius-control);
    transition: color var(--duration-fast);
  }
  .cat-toggle:hover { color: var(--text-2); }
  .ch-category:hover { color: var(--text-2); }
  .cat-arrow { width: 14px; height: 14px; flex-shrink: 0; transition: transform var(--duration-base) var(--ease-out); }
  .cat-arrow :global(svg) { display: block; width: 14px; height: 14px; }
  .cat-arrow.collapsed { transform: rotate(-90deg); }
  .cat-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ch-add-btn {
    width: 24px; height: 24px; display: grid; place-items: center; opacity: 0;
    background: transparent; border: none; border-radius: var(--radius-control);
    cursor: pointer; color: var(--text-muted); padding: 0;
    transition: opacity var(--duration-fast), background var(--duration-fast), color var(--duration-fast);
  }
  .ch-category:hover .ch-add-btn, .ch-category:focus-within .ch-add-btn { opacity: 1; }
  .ch-add-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
  .ch-add-btn :global(svg) { width: 15px; height: 15px; }
  @media (hover: none), (max-width: 768px) { .ch-add-btn { opacity: 1; } }
</style>
