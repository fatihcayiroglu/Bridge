<!-- client/js/core/EmojiPickerPanel.svelte -->
<!--
  FAZ K/4 — COMPOSER EMOJI SECICI.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERCEK BOSLUK
  ════════════════════════════════════════════════════════════════════════════
  Composer'da emoji EKLEMENIN hicbir yolu yoktu: kabukta yalnizca "dosya ekle",
  textarea ve "gonder" vardi. `MessageRenderer` TEPKI icin kisa bir hizli set
  sunuyor ama o mesaja tepki verir, mesaj YAZMAZ.

  ── NEDEN AYRI BIR PANEL, MESAJ KUTUSUNUN ICINDE DEGIL ─────────────────────
  Composer kabugu (`index.html`) uc bileşen tarafindan paylasilir ve
  `MessageInputPanel` ona listener BAGLAR, iceriğini uretmez. Kutunun icine
  bir seçici gömmek o sınırı bozardı. Panel kendi kokunde yasar, textarea'ya
  yalnizca metin yazar.

  ── KLAVYE ────────────────────────────────────────────────────────────────
  Izgara `role="grid"` degil `listbox` olarak duyurulur: kullanicinin zihinsel
  modeli "bir sey sec"tir, "tabloda gezin" degil. Ok tuslari yine iki boyutlu
  hareket eder (satir genisligi kadar atlar), boylece gorsel duzenle tutarlidir.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import {
    EMOJI_CATEGORIES, searchEmojis, type EmojiEntry,
  } from './composer/emoji-data.ts';
  import { applyEmojiToInput } from './composer/emoji-insert.ts';

  const log = createLogger('EmojiPicker');

  const RECENT_KEY = 'bridge:recent-emojis';
  const MAX_RECENT = 16;
  /** Izgara satir genisligi — ok tuslarinin dikey atlamasi bununla ayni olmali. */
  const COLUMNS = 8;

  let isVisible = $state(false);
  let query = $state('');
  let activeCategory = $state(EMOJI_CATEGORIES[0]!.id);
  let recent = $state<string[]>([]);
  let selectedIdx = $state(0);

  let inputEl: HTMLInputElement | undefined = $state();
  let gridEl: HTMLElement | undefined = $state();
  let returnFocusEl: HTMLElement | null = null;

  // ── Veri ─────────────────────────────────────────────────────────────────
  const byChar = new Map(EMOJI_CATEGORIES.flatMap(c => c.emojis).map(e => [e.char, e]));

  let recentEntries = $derived<EmojiEntry[]>(
    recent.map(char => byChar.get(char)).filter((e): e is EmojiEntry => Boolean(e)),
  );

  let visible = $derived.by<EmojiEntry[]>(() => {
    const q = query.trim();
    if (q) return searchEmojis(q);
    if (activeCategory === 'recent') return recentEntries;
    return EMOJI_CATEGORIES.find(c => c.id === activeCategory)?.emojis.slice() ?? [];
  });

  let heading = $derived.by(() => {
    if (query.trim()) return t('emoji_search_results', '“{query}” sonuçları', { query: query.trim() });
    if (activeCategory === 'recent') return t("epp_recent", "Son kullanılanlar");
    return t(EMOJI_CATEGORIES.find(c => c.id === activeCategory)?.labelKey ?? '');
  });

  // Kategori/sorgu degisince secim basa doner; aksi halde imlec listenin
  // disinda kalir ve Enter yanlis emojiyi eklerdi.
  $effect(() => { query; activeCategory; selectedIdx = 0; });

  // ── Son kullanilanlar ────────────────────────────────────────────────────
  function loadRecent(): string[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      const clean: string[] = [];
      for (const value of parsed) {
        if (typeof value !== 'string' || !byChar.has(value) || clean.includes(value)) continue;
        clean.push(value);
        if (clean.length === MAX_RECENT) break;
      }
      return clean;
    } catch {
      // Ozel mod / bozuk kayit. Secici yine de acilmalidir.
      return [];
    }
  }

  function rememberRecent(char: string): void {
    recent = [char, ...recent.filter(c => c !== char)].slice(0, MAX_RECENT);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* kota */ }
  }

  // ── Secim ────────────────────────────────────────────────────────────────
  function pick(entry: EmojiEntry): void {
    const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    if (!applyEmojiToInput(input, entry.char)) {
      log.warn('Mesaj kutusu bulunamadi; emoji eklenemedi');
      return;
    }
    rememberRecent(entry.char);
    close();
  }

  function open(): void {
    returnFocusEl = (document.activeElement as HTMLElement | null) ?? null;
    recent = loadRecent();
    query = '';
    selectedIdx = 0;
    activeCategory = recent.length ? 'recent' : EMOJI_CATEGORIES[0]!.id;
    isVisible = true;
    queueMicrotask(() => inputEl?.focus());
  }

  function close(): void {
    if (!isVisible) return;
    isVisible = false;
    // Odak composer'a doner — kullanici yazmaya devam edebilmelidir.
    const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    if (input) input.focus();
    else if (returnFocusEl?.isConnected) returnFocusEl.focus();
    returnFocusEl = null;
  }

  function toggle(): void { isVisible ? close() : open(); }

  // ── Klavye ───────────────────────────────────────────────────────────────
  function move(delta: number): void {
    if (!visible.length) return;
    selectedIdx = Math.max(0, Math.min(visible.length - 1, selectedIdx + delta));
    queueMicrotask(() => {
      const node = gridEl?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    });
  }

  function onKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':     e.preventDefault(); close(); break;
      case 'ArrowRight': e.preventDefault(); move(1); break;
      case 'ArrowLeft':  e.preventDefault(); move(-1); break;
      case 'ArrowDown':  e.preventDefault(); move(COLUMNS); break;
      case 'ArrowUp':    e.preventDefault(); move(-COLUMNS); break;
      case 'Home':       if (visible.length) { e.preventDefault(); selectedIdx = 0; } break;
      case 'End':        if (visible.length) { e.preventDefault(); selectedIdx = visible.length - 1; } break;
      case 'Enter': {
        e.preventDefault();
        const entry = visible[selectedIdx];
        if (entry) pick(entry);
        break;
      }
    }
  }

  onMount(() => {
    BridgeRegistry.register('openEmojiPicker', open);
    BridgeRegistry.register('toggleEmojiPicker', toggle);
    BridgeRegistry.register('closeEmojiPicker', close);

    // Kabuk dugmesi: `index.html` dispatcher'i ESM registry'ye ulasamiyor
    // (SearchPanel / MessageInputPanel ile AYNI neden), bu yuzden dogrudan
    // baglanilir. Ikinci bir acici sozlesmesi kurulmaz.
    const button = document.getElementById('btn-emoji');
    button?.addEventListener('click', toggle);
    return () => button?.removeEventListener('click', toggle);
  });

  onDestroy(() => {
    for (const key of ['openEmojiPicker', 'toggleEmojiPicker', 'closeEmojiPicker']) {
      BridgeRegistry.unregister?.(key);
    }
  });
</script>

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ep-scrim" role="presentation" onclick={close}></div>
<div
  class="ep-panel"
  role="dialog"
  aria-modal="true"
  aria-label={t('epp_pick', 'Emoji seç')}
  tabindex="-1"
  onkeydown={onKeyDown}
  use:focusTrap={{ active: isVisible, initialFocus: '.ep-search' }}
>
  <div class="ep-head">
    <input
      class="ep-search"
      bind:this={inputEl}
      bind:value={query}
      type="text"
      role="combobox"
      placeholder={t('attr_emoji_ara_6824631', "Emoji ara…")}
      aria-label={t('attr_emoji_ara_9746939', "Emoji ara")}
      aria-expanded={visible.length > 0}
      aria-controls="ep-grid"
      aria-activedescendant={visible[selectedIdx] ? `ep-item-${visible[selectedIdx]!.char}` : undefined}
      autocomplete="off"
    />
    <button type="button" class="ep-close" onclick={close} aria-label={t('epp_close', 'Emoji seçiciyi kapat')}>×</button>
  </div>

  {#if !query.trim()}
    <div class="ep-tabs" role="tablist" aria-label={t('attr_emoji_kategorileri_275f567', "Emoji kategorileri")}>
      {#if recent.length}
        <button
          type="button" class="ep-tab" class:active={activeCategory === 'recent'}
          role="tab" aria-selected={activeCategory === 'recent'} aria-label={t('epp_recent', 'Son kullanılanlar')}
          onclick={() => { activeCategory = 'recent'; }}
        >🕘</button>
      {/if}
      {#each EMOJI_CATEGORIES as category (category.id)}
        <button
          type="button" class="ep-tab" class:active={activeCategory === category.id}
          role="tab" aria-selected={activeCategory === category.id} aria-label={t(category.labelKey)}
          onclick={() => { activeCategory = category.id; }}
        >{category.icon}</button>
      {/each}
    </div>
  {/if}

  <p class="ep-heading">{heading}</p>

  {#if !visible.length}
    <p class="ep-empty">
      {query.trim() ? t("surface_eslesen_emoji_yok_4e2b30") : t("surface_burada_henuz_emoji_yok_eef55b")}
    </p>
  {:else}
    <div id="ep-grid" class="ep-grid" role="listbox" aria-label={t('attr_emoji_listesi_0818ff0', "Emoji listesi")} bind:this={gridEl}>
      {#each visible as entry, idx (entry.char)}
        <button
          type="button"
          id="ep-item-{entry.char}"
          class="ep-item"
          class:selected={idx === selectedIdx}
          role="option"
          aria-selected={idx === selectedIdx}
          aria-label={entry.name}
          title={entry.name}
          tabindex="-1"
          onclick={() => pick(entry)}
          onmousemove={() => { selectedIdx = idx; }}
        >{entry.char}</button>
      {/each}
    </div>
  {/if}

  <p class="ep-hint">
    <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> {t('markup_gezin_5afb218', "gezin ·")} <kbd>Enter</kbd> {t('markup_ekle_e627005', "ekle ·")} <kbd>Esc</kbd> {t('close')}
  </p>
</div>
{/if}

<style>
.ep-scrim {
  position: fixed;
  inset: 0;
  z-index: calc(var(--layer-modal) - 1);
}

.ep-panel {
  position: fixed;
  inset-inline-end: max(12px, env(safe-area-inset-right));
  bottom: calc(84px + env(safe-area-inset-bottom));
  z-index: var(--layer-modal);
  display: flex;
  flex-direction: column;
  width: min(340px, calc(100vw - 32px));
  max-height: min(420px, calc(var(--bridge-visual-viewport-height, 100dvh) - 160px - env(safe-area-inset-bottom)));
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-xl);
  animation: ep-in var(--duration-fast) var(--ease-out);
}

.ep-head {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: 10px 10px 6px;
}

.ep-search {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: var(--bg-input, var(--bg-3));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
}
.ep-search:focus-visible { border-color: var(--border-focus, var(--brand)); }

.ep-close {
  padding: 2px 8px;
  font-size: var(--text-lg);
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: 0;
}
.ep-close:hover { color: var(--text-primary); }

.ep-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px 6px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-faint);
}
.ep-tab {
  flex: 0 0 auto;
  padding: 5px 7px;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  opacity: .6;
}
.ep-tab:hover { background: var(--bg-3); opacity: 1; }
.ep-tab.active { background: var(--bg-3); opacity: 1; box-shadow: inset 0 -2px 0 var(--brand); }

.ep-heading {
  padding: 8px 12px 4px;
  margin: 0;
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--text-muted);
  text-transform: uppercase;
}

.ep-grid {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  padding: 0 8px 8px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ep-item {
  aspect-ratio: 1;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
}
.ep-item:hover, .ep-item.selected { background: var(--bg-modifier-selected, var(--bg-3)); }
.ep-item.selected { outline: 2px solid var(--brand); outline-offset: -2px; }

.ep-empty {
  padding: 22px 12px;
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
  text-align: center;
}

.ep-hint {
  padding: 6px 12px 9px;
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  border-top: 1px solid var(--border-faint);
}
.ep-hint kbd {
  padding: 0 4px;
  margin-inline-end: 2px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
}

@keyframes ep-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) { .ep-panel { animation: none; } }
</style>
