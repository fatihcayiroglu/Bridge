<!-- client/js/core/channel-list/ChannelItem.svelte -->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  export interface ChannelData {
    _id: string;
    name: string;
    type?: string;
    nsfw?: boolean;
  }

  interface Props {
    channel: ChannelData;
    active?: boolean;
    onSelect: (channel: ChannelData) => void;
    onOpenMenu?: (channelId: string, name: string, event: MouseEvent) => void;
  }

  let { channel, active = false, onSelect, onOpenMenu }: Props = $props();

  const iconKind = $derived(
    channel.type === 'voice' ? 'voice'
    : channel.type === 'forum' ? 'forum'
    : channel.type === 'stage' ? 'stage'
    : channel.type === 'announcement' ? 'announcement'
    : 'text'
  );
</script>

<!--
  ERISILEBILIRLIK: satir ARTIK `role="button"` DEGIL.

  Onceden `role="button" tabindex="0"` tasiyan bir `div` icinde GERCEK bir
  `<button>` (kanal islemleri) duruyordu. axe bunu `serious` seviyesinde
  `nested-interactive` olarak isaretler: ic ice etkilesimli kontroller ekran
  okuyucularda her zaman duyurulmaz ve odak sirasini bozar.

  Artik kanal secimi GERCEK bir dugmedir ve "kanal islemleri" onun
  KARDESIDIR. Enter/Space'i tarayici natif olarak isler; elle keydown
  dinlemeye ve `stopPropagation` ile ic ice tiklamayi ayiklamaya gerek kalmaz.
-->
<div
  class="ch-item"
  class:active={active}
  data-id={channel._id}
  data-type={channel.type || 'text'}
>
  <button
    type="button"
    class="ch-open"
    aria-current={active ? 'page' : undefined}
    aria-label={`${channel.type === 'voice' ? t("ui_ses_kanali") : channel.type === 'stage' ? t("surface_sahne_kanal_f2a33f") : t("ui_kanal")}: ${channel.name}`}
    onclick={() => onSelect(channel)}
  >
  <span class="ch-icon" aria-hidden="true">
    {#if iconKind === 'voice'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6.8 8.5H3.5v7h3.3L11 19z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.8 6.8a7.5 7.5 0 0 1 0 10.4"/></svg>
    {:else if iconKind === 'forum'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v11H9l-4 3z"/><path d="M8 9h8M8 12h5"/></svg>
    {:else if iconKind === 'stage'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8.5a9 9 0 0 1 14 0M8 12a5 5 0 0 1 8 0"/><circle cx="12" cy="15.5" r="2"/></svg>
    {:else if iconKind === 'announcement'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 13 13-5v10L4 13z"/><path d="M7 14.2 8 19h3l-1.2-5.8M20 10v6"/></svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 3 7 21M17 3l-2 18M4 9h16M3 15h16"/></svg>
    {/if}
  </span>
  <span class="ch-name">{channel.name}</span>
  {#if channel.nsfw}
    <span class="ch-nsfw-badge" title="NSFW">18+</span>
  {/if}
  <span class="voice-count" id="vc-{channel._id}" style="display:none"></span>
  <span class="ch-unread" id="unread-{channel._id}" style="display:none"></span>
  </button>
  {#if onOpenMenu}
    <button
      type="button"
      class="ch-settings-btn"
      title={t('cli_channel_actions', 'Kanal işlemleri')}
      aria-label={t('channel_actions_named_aria', undefined, { channel: channel.name })}
      onclick={(e) => onOpenMenu(channel._id, channel.name, e)}
    ><svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button>
  {/if}
</div>

<style>
  .ch-item {
    display: flex; align-items: center; gap: 7px; min-height: 34px;
    padding: 5px 8px; margin: 1px 4px; border-radius: var(--radius-control);
    color: var(--text-muted); position: relative;
    transition: background var(--duration-fast), color var(--duration-fast);
  }
  /* Gorsel dil DEGISMEDI — icerik artik gercek bir dugmenin icinde. */
  .ch-open {
    /* WCAG 2.2 SC 2.5.8: gercek render'da 21px yuksekti. Bu, uygulamanin
       BIRINCIL gezinme kontrolu — 24px minimum saglanir. */
    min-height: 24px;
    display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0;
    font: inherit; color: inherit; text-align: start;
    background: none; border: 0; padding: 0; cursor: pointer;
    border-radius: var(--radius-control);
  }
  .ch-item::before {
    content: ''; position: absolute; left: 2px; top: 50%; width: 2px; height: 0;
    transform: translateY(-50%); border-radius: var(--r-full);
    background: var(--shell-selected-edge); transition: height var(--duration-base) var(--ease-out);
  }
  .ch-item:hover { background: var(--surface-hover); color: var(--text-2); }
  .ch-item:hover .ch-settings-btn, .ch-item:focus-within .ch-settings-btn { opacity: 1 !important; }
  .ch-item.active { background: var(--surface-selected); color: var(--text-primary); font-weight: 600; }
  /* Okunmamış mesajı olan kanal (Final21 Faz 15). `data-unread` çalışma anında
     unread-svelte.ts tarafından yazılır; derleyici görmediği için :global. */
  .ch-item:global([data-unread="true"]) { color: var(--text-primary); }
  .ch-item:global([data-unread="true"]) .ch-name { font-weight: 700; }
  .ch-item:global([data-unread="true"])::before { height: 8px; }
  .ch-item.active::before { height: 20px; }
  .ch-icon { width: 18px; height: 18px; flex-shrink: 0; }
  .ch-icon :global(svg) { display: block; width: 18px; height: 18px; }
  .ch-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ch-nsfw-badge {
    font-size: var(--type-badge); background: var(--danger); color: var(--text-on-solid);
    border-radius: 3px; padding: 1px 4px; margin-left: 4px; font-weight: 700;
  }
  .ch-settings-btn {
    width: 24px; height: 24px; opacity: 0; display: grid; place-items: center;
    background: transparent; border: none; cursor: pointer; padding: 0;
    border-radius: var(--radius-control); color: var(--text-muted);
    transition: opacity var(--duration-fast), background var(--duration-fast), color var(--duration-fast);
  }
  .ch-settings-btn:hover { background: var(--surface-pressed); color: var(--text-primary); }
  .ch-settings-btn :global(svg) { width: 15px; height: 15px; }
  @media (hover: none), (max-width: 768px) { .ch-settings-btn { opacity: 1; } }
</style>
