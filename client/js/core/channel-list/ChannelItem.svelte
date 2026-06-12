<!-- client/js/core/channel-list/ChannelItem.svelte -->
<script lang="ts">
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
    onOpenMenu: (channelId: string, name: string, event: MouseEvent) => void;
  }

  let { channel, active = false, onSelect, onOpenMenu }: Props = $props();

  const icon = $derived(
    channel.type === 'voice' ? '🔊'
    : channel.type === 'forum' ? '📋'
    : channel.type === 'stage' ? '🎭'
    : channel.type === 'announcement' ? '📣'
    : '#'
  );
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="ch-item"
  class:active={active}
  data-id={channel._id}
  data-type={channel.type || 'text'}
  role="button"
  tabindex="0"
  onclick={() => onSelect(channel)}
  onkeydown={(e) => { if (e.key === 'Enter') onSelect(channel); }}
>
  <span class="ch-icon">{icon}</span>
  <span class="ch-name">{channel.name}</span>
  {#if channel.nsfw}
    <span class="ch-nsfw-badge" title="NSFW">18+</span>
  {/if}
  <span class="voice-count" id="vc-{channel._id}" style="display:none"></span>
  <span class="ch-unread" id="unread-{channel._id}" style="display:none"></span>
  <button
    type="button"
    class="ch-settings-btn"
    title="Ayarlar"
    onclick={(e) => { e.stopPropagation(); onOpenMenu(channel._id, channel.name, e); }}
  >⚙️</button>
</div>

<style>
  .ch-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
  .ch-item:hover .ch-settings-btn { opacity: 1 !important; }
  .ch-item.active { background: var(--bg-modifier-selected, rgba(79,84,92,.32)); }
  .ch-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ch-nsfw-badge {
    font-size: 10px; background: #ed4245; color: #fff;
    border-radius: 3px; padding: 1px 4px; margin-left: 4px; font-weight: 700;
  }
  .ch-settings-btn {
    opacity: 0; background: none; border: none; cursor: pointer;
    padding: 2px 4px; border-radius: 4px; color: var(--text-3); font-size: 13px;
    transition: opacity .15s;
  }
</style>
