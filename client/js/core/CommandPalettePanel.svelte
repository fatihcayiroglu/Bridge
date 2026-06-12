<!-- client/js/core/CommandPalettePanel.svelte -->
<!-- Sprint 115 — command-palette.ts (548 satır) → Svelte 5 Runes (ADR-0008 Faz 2) -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('CommandPalettePanel');

  interface Command {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    category?: string;
    shortcut?: string;
    action: () => void;
    keywords?: string[];
    hidden?: boolean;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let isVisible    = $state(false);
  let query        = $state('');
  let selectedIdx  = $state(0);
  let commands     = $state<Command[]>([]);
  let inputEl = $state<HTMLInputElement | undefined>();

  // ── Derived ────────────────────────────────────────────────────────────────
  let filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const visible = commands.filter(c => !c.hidden);
    if (!q) return visible.slice(0, 12);
    return visible.filter(c =>
      c.label.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.keywords?.some(k => k.toLowerCase().includes(q))
    ).slice(0, 12);
  });

  let selectedCommand = $derived.by(() => filtered[Math.min(selectedIdx, filtered.length - 1)] ?? null);

  // ── Reset selection when query changes ────────────────────────────────────
  $effect(() => {
    query; // track
    selectedIdx = 0;
    queueMicrotask(() => inputEl?.focus());
  });

  // ── Built-in commands ──────────────────────────────────────────────────────
  const builtInCommands: Command[] = [
    {
      id: 'theme-toggle',
      label: 'Temayı Değiştir',
      description: 'Açık/karanlık mod arasında geçiş yap',
      icon: '🌙',
      category: 'Görünüm',
      shortcut: 'Ctrl+Shift+T',
      keywords: ['theme', 'dark', 'light', 'karanlık', 'aydınlık', 'tema'],
      action: () => BridgeRegistry.call('toggleTheme'),
    },
    {
      id: 'mark-all-read',
      label: 'Tümünü Okundu İşaretle',
      description: 'Tüm kanallardaki okunmamış mesajları temizle',
      icon: '✅',
      category: 'Mesajlar',
      keywords: ['read', 'unread', 'okundu', 'bildirim'],
      action: () => BridgeRegistry.call('markAllRead'),
    },
    {
      id: 'open-search',
      label: 'Aramayı Aç',
      description: 'Sunucu içi arama panelini aç',
      icon: '🔍',
      category: 'Navigasyon',
      shortcut: 'Ctrl+F',
      keywords: ['search', 'ara', 'bul', 'find'],
      action: () => {
        close();
        const sid = BridgeRegistry.get('currentServerId');
        if (sid) BridgeRegistry.call('openSearch', sid);
      },
    },
    {
      id: 'open-settings',
      label: 'Ayarları Aç',
      description: 'Kullanıcı ayarları panelini aç',
      icon: '⚙️',
      category: 'Navigasyon',
      shortcut: 'Ctrl+,',
      keywords: ['settings', 'preferences', 'ayar', 'tercih', 'profil'],
      action: () => { close(); BridgeRegistry.call('openSettings'); },
    },
    {
      id: 'status-online',
      label: 'Durumu: Çevrimiçi',
      icon: '🟢',
      category: 'Durum',
      keywords: ['online', 'çevrimiçi', 'available', 'müsait'],
      action: () => BridgeRegistry.call('setStatus', 'online'),
    },
    {
      id: 'status-idle',
      label: 'Durumu: Dışarıda',
      icon: '🟡',
      category: 'Durum',
      keywords: ['idle', 'away', 'dışarıda', 'afk'],
      action: () => BridgeRegistry.call('setStatus', 'idle'),
    },
    {
      id: 'status-dnd',
      label: 'Durumu: Rahatsız Etme',
      icon: '🔴',
      category: 'Durum',
      keywords: ['dnd', 'do not disturb', 'rahatsız etme', 'meşgul'],
      action: () => BridgeRegistry.call('setStatus', 'dnd'),
    },
    {
      id: 'mute-toggle',
      label: 'Mikrofonu Aç/Kapat',
      icon: '🎤',
      category: 'Ses',
      shortcut: 'Ctrl+Shift+M',
      keywords: ['mute', 'mikrofon', 'ses', 'audio'],
      action: () => BridgeRegistry.call('toggleMute'),
    },
    {
      id: 'deafen-toggle',
      label: 'Hoparlörü Aç/Kapat',
      icon: '🔇',
      category: 'Ses',
      shortcut: 'Ctrl+Shift+D',
      keywords: ['deafen', 'hoparlör', 'kulaklık', 'speaker'],
      action: () => BridgeRegistry.call('toggleDeafen'),
    },
    {
      id: 'copy-server-id',
      label: 'Sunucu ID\'sini Kopyala',
      icon: '📋',
      category: 'Geliştirici',
      keywords: ['copy', 'id', 'server', 'kopyala', 'geliştirici'],
      action: () => {
        const sid = BridgeRegistry.get('currentServerId');
        if (sid) navigator.clipboard.writeText(sid).then(() => BridgeRegistry.call('toast', 'ID kopyalandı', 'success'));
      },
    },
    {
      id: 'report-bug',
      label: 'Hata Bildir',
      description: 'GitHub Issues\'e git',
      icon: '🐛',
      category: 'Yardım',
      keywords: ['bug', 'report', 'hata', 'sorun', 'issue'],
      action: () => window.open('https://github.com/bridge-app/bridge/issues/new', '_blank'),
    },
    {
      id: 'keyboard-shortcuts',
      label: 'Klavye Kısayolları',
      icon: '⌨️',
      category: 'Yardım',
      keywords: ['keyboard', 'shortcuts', 'klavye', 'kısayol'],
      action: () => { close(); BridgeRegistry.call('openKeyboardShortcuts'); },
    },
  ];

  // ── Actions ────────────────────────────────────────────────────────────────
  function open() {
    commands = [...builtInCommands, ...(BridgeRegistry.get('extraCommands') ?? [])];
    isVisible = true;
    query = '';
    selectedIdx = 0;
  }

  function close() {
    isVisible = false;
    query = '';
  }

  function execute(cmd: Command) {
    try {
      cmd.action();
    } catch (err) {
      log.error('Command failed', { id: cmd.id, err });
    }
    close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!isVisible) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedCommand) execute(selectedCommand!);
        break;
    }
  }

  function onGlobalKeyDown(e: KeyboardEvent) {
    // Ctrl/Cmd + K → aç
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      isVisible ? close() : open();
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    BridgeRegistry.register('openCommandPalette', open);
    BridgeRegistry.register('closeCommandPalette', close);
  });

  // Category groups
  let groupedFiltered = $derived.by(() => {
    const items = filtered;
    const groups: Record<string, Command[]> = {};
    for (const cmd of items) {
      const cat = cmd.category ?? 'Diğer';
      (groups[cat] ??= []).push(cmd);
    }
    return groups;
  });

  let flatFiltered = $derived.by(() => filtered);
</script>

<svelte:window onkeydown={onGlobalKeyDown} />

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="cp-overlay" role="presentation" onclick={() => close()}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="cp-panel"
    role="dialog"
    aria-label="Komut Paleti"
    aria-modal="true"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeyDown}
  >
    <div class="cp-header">
      <span class="cp-icon" aria-hidden="true">⌘</span>
      <input
        class="cp-input"
        bind:this={inputEl}
        type="text"
        bind:value={query}
        placeholder="Komut ara… (Ctrl+K ile aç/kapat)"
        aria-label="Komut ara"
        aria-autocomplete="list"
        aria-controls="cp-listbox"
        aria-activedescendant={selectedCommand ? `cp-item-${selectedCommand!.id}` : undefined}
        autocomplete="off"
      />
      <button type="button" class="cp-esc" onclick={close}>ESC</button>
    </div>

    <ul id="cp-listbox" class="cp-list" role="listbox" aria-label="Komutlar">
      {#if flatFiltered.length === 0}
        <li class="cp-empty" role="option" aria-selected="false">
          "{query}" için komut bulunamadı.
        </li>
      {:else}
        {#each Object.entries(groupedFiltered) as [category, cmds]}
          <li class="cp-category" role="presentation">{category}</li>
          {#each cmds as cmd}
            {@const idx = flatFiltered.findIndex(c => c.id === cmd.id)}
            {@const isSelected = idx === selectedIdx}
            <li
              id="cp-item-{cmd.id}"
              class="cp-item {isSelected ? 'selected' : ''}"
              role="option"
              aria-selected={isSelected}
              tabindex={isSelected ? 0 : -1}
              onclick={() => execute(cmd)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); execute(cmd); } }}
              onmouseenter={() => { selectedIdx = idx; }}
            >
              {#if cmd.icon}
                <span class="cp-item-icon" aria-hidden="true">{cmd.icon}</span>
              {/if}
              <span class="cp-item-text">
                <span class="cp-item-label">{cmd.label}</span>
                {#if cmd.description}
                  <span class="cp-item-desc">{cmd.description}</span>
                {/if}
              </span>
              {#if cmd.shortcut}
                <kbd class="cp-item-shortcut">{cmd.shortcut}</kbd>
              {/if}
            </li>
          {/each}
        {/each}
      {/if}
    </ul>

    <div class="cp-footer" aria-hidden="true">
      <span><kbd>↑↓</kbd> Gezin</span>
      <span><kbd>↵</kbd> Çalıştır</span>
      <span><kbd>ESC</kbd> Kapat</span>
    </div>
  </div>
</div>
{/if}

<style>
.cp-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.55);
  display: flex; justify-content: center;
  padding-top: 60px;
  z-index: 9500;
  backdrop-filter: blur(4px);
}
.cp-panel {
  background: var(--bridge-surface, #1e2124);
  border-radius: 12px;
  width: 100%; max-width: 560px;
  max-height: min(520px, calc(100vh - 120px));
  display: flex; flex-direction: column;
  box-shadow: 0 12px 40px rgba(0,0,0,.6);
  overflow: hidden;
  border: 1px solid var(--bridge-border, #2c2f33);
}
.cp-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--bridge-border, #2c2f33);
}
.cp-icon { font-size: 1.1rem; color: var(--bridge-muted, #99aab5); }
.cp-input {
  flex: 1; background: none; border: none; outline: none;
  color: var(--bridge-text, #fff); font-size: 1rem;
}
.cp-input::placeholder { color: var(--bridge-muted, #99aab5); }
.cp-esc {
  padding: 2px 6px; border-radius: 4px;
  background: var(--bridge-surface2, #2c2f33);
  color: var(--bridge-muted, #99aab5);
  font-size: .7rem; cursor: pointer; border: none;
}
.cp-list {
  flex: 1; overflow-y: auto;
  list-style: none; padding: 4px 0; margin: 0;
}
.cp-category {
  padding: 6px 16px 2px;
  font-size: .7rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em;
  color: var(--bridge-muted, #99aab5);
}
.cp-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 16px; cursor: pointer;
  transition: background .1s;
}
.cp-item.selected, .cp-item:hover {
  background: var(--bridge-surface2, #2c2f33);
}
.cp-item-icon { font-size: 1rem; width: 22px; text-align: center; flex-shrink: 0; }
.cp-item-text { flex: 1; display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.cp-item-label { font-size: .9rem; color: var(--bridge-text, #fff); }
.cp-item-desc { font-size: .75rem; color: var(--bridge-muted, #99aab5); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-item-shortcut {
  padding: 2px 6px; border-radius: 4px; font-size: .7rem;
  background: var(--bridge-surface3, #393c40);
  color: var(--bridge-muted, #99aab5); flex-shrink: 0;
  border: none;
}
.cp-empty {
  padding: 24px 16px; text-align: center;
  color: var(--bridge-muted, #99aab5); font-size: .875rem;
}
.cp-footer {
  display: flex; gap: 16px; padding: 8px 16px;
  border-top: 1px solid var(--bridge-border, #2c2f33);
  font-size: .72rem; color: var(--bridge-muted, #99aab5);
}
.cp-footer kbd {
  padding: 1px 5px; border-radius: 4px;
  background: var(--bridge-surface2, #2c2f33);
  font-size: .7rem; border: none;
}
</style>
