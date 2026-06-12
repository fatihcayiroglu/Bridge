// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/CommandPalettePanel.svelte
//              client/js/core/command-palette-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/command-palette.ts
// Sprint 111 — Komut Paleti (⌘K / Ctrl+K)
//
// Kullanım:
//   import { initCommandPalette } from './command-palette.js';
//   initCommandPalette(); // DOMContentLoaded'da çağır
//
// Özellikler:
//   - ⌘K / Ctrl+K ile aç/kapat
//   - Bulanık (fuzzy) arama — kısmi eşleşme destekler
//   - Ok tuşları + Enter ile klavye navigasyonu
//   - Escape ile kapat
//   - Kategoriler: Gezinme, Eylemler, Ayarlar, Son Kullanılanlar
//   - Dinamik eylem kaydı — modüller kendi komutlarını ekleyebilir

'use strict';

import { getState, getCurrentServer, getSocket } from './globals.js';
import { escHtml }                                from './utils.js';
import { t }                                      from './i18n.js';

// ── Tip Tanımları ─────────────────────────────────────────────────────────────

export interface PaletteCommand {
  id:         string;
  label:      string;
  keywords?:  string[];       // ek arama terimleri
  category:   CommandCategory;
  icon?:      string;         // emoji veya SVG string
  shortcut?:  string;         // görüntüleme amaçlı (ör. "⌘K")
  action:     () => void | Promise<void>;
  /** Komutun görünür olup olmayacağını belirler (varsayılan: true) */
  visible?:   () => boolean;
}

export type CommandCategory = 'navigate' | 'action' | 'settings' | 'recent';

// ── Dahili durum ──────────────────────────────────────────────────────────────

const registry   = new Map<string, PaletteCommand>();
const recentIds: string[] = [];
const MAX_RECENT = 5;

let overlayEl:   HTMLElement | null = null;
let inputEl:     HTMLInputElement | null = null;
let listEl:      HTMLElement | null = null;
let activeIndex  = -1;
let currentItems: PaletteCommand[] = [];

// ── Kayıt API'si ──────────────────────────────────────────────────────────────

/** Komut paleti eylemini kaydet */
export function registerCommand(cmd: PaletteCommand): void {
  registry.set(cmd.id, cmd);
}

/** Kayıtlı komutu kaldır */
export function unregisterCommand(id: string): void {
  registry.delete(id);
}

/** Tüm kayıtlı komutları döndür */
export function getCommands(): PaletteCommand[] {
  return [...registry.values()];
}

// ── Bulanık arama ─────────────────────────────────────────────────────────────

function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) return 2 + (t.startsWith(q) ? 1 : 0);
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 1 : 0;
}

function scoreCommand(cmd: PaletteCommand, query: string): number {
  const labelScore    = fuzzyScore(query, cmd.label);
  const keywordScore  = Math.max(0, ...(cmd.keywords ?? []).map(k => fuzzyScore(query, k)));
  return Math.max(labelScore, keywordScore);
}

function filterAndSort(query: string): PaletteCommand[] {
  const visible = [...registry.values()].filter(c => c.visible?.() !== false);

  if (!query.trim()) {
    // Sorgu yoksa: son kullanılanlar önce, sonra kategori sırası
    const recentSet = new Set(recentIds);
    const recent    = recentIds
      .map(id => registry.get(id))
      .filter((c): c is PaletteCommand => !!c && c.visible?.() !== false);
    const rest      = visible.filter(c => !recentSet.has(c.id));
    return [...recent, ...rest].slice(0, 20);
  }

  return visible
    .map(c => ({ cmd: c, score: scoreCommand(c, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ cmd }) => cmd)
    .slice(0, 15);
}

// ── UI ────────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  navigate: '🧭 Gezinme',
  action:   '⚡ Eylemler',
  settings: '⚙️ Ayarlar',
  recent:   '🕐 Son Kullanılanlar',
};

function categoryOf(cmd: PaletteCommand, isRecent: boolean): CommandCategory {
  return isRecent ? 'recent' : cmd.category;
}

function renderList(items: PaletteCommand[]): void {
  if (!listEl) return;
  currentItems = items;
  activeIndex  = items.length > 0 ? 0 : -1;

  if (items.length === 0) {
    listEl.innerHTML = `<div class="cp-empty">${escHtml(t('cp_no_results') || 'Sonuç bulunamadı')}</div>`;
    return;
  }

  const recentSet = new Set(recentIds);
  let html        = '';
  let lastCat     = '';

  items.forEach((cmd, i) => {
    const cat   = categoryOf(cmd, recentSet.has(cmd.id));
    const label = CATEGORY_LABELS[cat];
    if (cat !== lastCat) {
      html    += `<div class="cp-category">${escHtml(label)}</div>`;
      lastCat  = cat;
    }
    const icon      = cmd.icon ? `<span class="cp-icon">${escHtml(cmd.icon)}</span>` : '';
    const shortcut  = cmd.shortcut ? `<span class="cp-shortcut">${escHtml(cmd.shortcut)}</span>` : '';
    const active    = i === 0 ? 'cp-item--active' : '';
    html += `
      <div class="cp-item ${active}" data-index="${i}" role="option" aria-selected="${i === 0}">
        ${icon}
        <span class="cp-label">${escHtml(cmd.label)}</span>
        ${shortcut}
      </div>`;
  });

  listEl.innerHTML = html;

  // Tıklama
  listEl.querySelectorAll<HTMLElement>('.cp-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index ?? '0', 10);
      executeItem(idx);
    });
  });
}

function setActive(idx: number): void {
  if (!listEl || currentItems.length === 0) return;
  activeIndex = Math.max(0, Math.min(idx, currentItems.length - 1));
  listEl.querySelectorAll<HTMLElement>('.cp-item').forEach((el, i) => {
    const isActive = i === activeIndex;
    el.classList.toggle('cp-item--active', isActive);
    el.setAttribute('aria-selected', String(isActive));
    if (isActive) el.scrollIntoView({ block: 'nearest' });
  });
}

function executeItem(idx: number): void {
  const cmd = currentItems[idx];
  if (!cmd) return;
  // Son kullanılanları güncelle
  const pos = recentIds.indexOf(cmd.id);
  if (pos !== -1) recentIds.splice(pos, 1);
  recentIds.unshift(cmd.id);
  if (recentIds.length > MAX_RECENT) recentIds.length = MAX_RECENT;

  close();
  void Promise.resolve(cmd.action());
}

// ── Stil ──────────────────────────────────────────────────────────────────────

const CSS = `
.cp-overlay {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,.55);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 15vh;
}
.cp-modal {
  width: min(560px, 92vw);
  background: var(--color-background-primary, #1e1f22);
  border: 1px solid var(--color-border-secondary, #3f4147);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,.6);
  display: flex; flex-direction: column;
}
.cp-search {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border-tertiary, #3f4147);
}
.cp-search-icon { font-size: 16px; opacity: .6; flex-shrink: 0; }
.cp-input {
  flex: 1; background: transparent; border: none; outline: none;
  font-size: 16px; color: var(--color-text-primary, #fff);
  caret-color: var(--color-brand, #2d9cdb);
}
.cp-input::placeholder { color: var(--color-text-muted, #87898c); }
.cp-list {
  max-height: 360px; overflow-y: auto;
  padding: 6px 0;
}
.cp-list::-webkit-scrollbar { width: 6px; }
.cp-list::-webkit-scrollbar-thumb {
  background: var(--color-border-secondary, #3f4147);
  border-radius: 3px;
}
.cp-category {
  font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--color-text-muted, #87898c);
  padding: 8px 16px 4px;
}
.cp-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 16px;
  cursor: pointer;
  border-radius: 0;
  transition: background 80ms;
}
.cp-item:hover, .cp-item--active {
  background: var(--color-background-modifier-hover, rgba(79,84,92,.32));
}
.cp-icon { font-size: 18px; flex-shrink: 0; width: 22px; text-align: center; }
.cp-label { flex: 1; font-size: 14px; color: var(--color-text-primary, #fff); }
.cp-shortcut {
  font-size: 11px; color: var(--color-text-muted, #87898c);
  background: var(--color-background-secondary, #2b2d31);
  padding: 2px 6px; border-radius: 4px;
  flex-shrink: 0;
}
.cp-empty {
  padding: 24px 16px; text-align: center;
  color: var(--color-text-muted, #87898c); font-size: 14px;
}
.cp-footer {
  display: flex; align-items: center; gap: 16px;
  padding: 8px 16px;
  border-top: 1px solid var(--color-border-tertiary, #3f4147);
  font-size: 11px; color: var(--color-text-muted, #87898c);
}
.cp-footer kbd {
  background: var(--color-background-secondary, #2b2d31);
  border: 1px solid var(--color-border-secondary, #3f4147);
  border-radius: 3px; padding: 1px 5px;
  font-family: inherit; font-size: 11px;
}
`;

function injectStyles(): void {
  if (document.getElementById('cp-styles')) return;
  const s = document.createElement('style');
  s.id    = 'cp-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ── Aç / Kapat ────────────────────────────────────────────────────────────────

export function open(): void {
  if (overlayEl) { inputEl?.focus(); return; }

  injectStyles();

  overlayEl = document.createElement('div');
  overlayEl.className   = 'cp-overlay';
  overlayEl.setAttribute('role', 'dialog');
  overlayEl.setAttribute('aria-modal', 'true');
  overlayEl.setAttribute('aria-label', t('command_palette') || 'Komut Paleti');

  overlayEl.innerHTML = `
    <div class="cp-modal" id="cp-modal">
      <div class="cp-search">
        <span class="cp-search-icon">🔍</span>
        <input class="cp-input" id="cp-input" type="text"
               placeholder="${escHtml(t('cp_placeholder') || 'Komut ara veya Hub\'a git…')}"
               autocomplete="off" spellcheck="false" aria-autocomplete="list"
               aria-controls="cp-list" role="combobox" aria-expanded="true" />
      </div>
      <div class="cp-list" id="cp-list" role="listbox"></div>
      <div class="cp-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> Gezin</span>
        <span><kbd>↵</kbd> Çalıştır</span>
        <span><kbd>Esc</kbd> Kapat</span>
      </div>
    </div>`;

  document.body.appendChild(overlayEl);
  inputEl = overlayEl.querySelector('#cp-input');
  listEl  = overlayEl.querySelector('#cp-list');

  // Başlangıç listesi
  renderList(filterAndSort(''));
  inputEl?.focus();

  // Input değişimi
  inputEl?.addEventListener('input', () => {
    const q = inputEl?.value ?? '';
    renderList(filterAndSort(q));
    setActive(0);
  });

  // Klavye navigasyonu
  overlayEl.addEventListener('keydown', handleKeydown);

  // Overlay tıklaması (modal dışı)
  overlayEl.addEventListener('click', e => {
    if ((e.target as HTMLElement).classList.contains('cp-overlay')) close();
  });
}

export function close(): void {
  overlayEl?.remove();
  overlayEl = inputEl = listEl = null;
  activeIndex = -1;
  currentItems = [];
}

export function toggle(): void {
  overlayEl ? close() : open();
}

function handleKeydown(e: KeyboardEvent): void {
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      setActive(activeIndex + 1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setActive(activeIndex - 1);
      break;
    case 'Enter':
      e.preventDefault();
      if (activeIndex >= 0) executeItem(activeIndex);
      break;
    case 'Escape':
      e.preventDefault();
      close();
      break;
  }
}

// ── Global klavye kısayolu ─────────────────────────────────────────────────────

export function initCommandPalette(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const mod   = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key === 'k') {
      e.preventDefault();
      toggle();
    }
  });

  // Yerleşik komutları kaydet
  registerBuiltins();
}

// ── Yerleşik komutlar ─────────────────────────────────────────────────────────

function registerBuiltins(): void {
  const COMMANDS: PaletteCommand[] = [
    // ── Gezinme ──────────────────────────────────────────────────────────────
    {
      id: 'nav:friends',
      label: t('friends') || 'Arkadaşlar',
      keywords: ['friend', 'dm', 'arkadaş'],
      category: 'navigate',
      icon: '👥',
      action: async () => {
        const { openFriendsPanel } = await import('./friends.js');
        openFriendsPanel();
      },
    },
    {
      id: 'nav:explore',
      label: t('tip_discover') || 'Hub Keşfet',
      keywords: ['discover', 'explore', 'keşif', 'hub'],
      category: 'navigate',
      icon: '🌐',
      action: async () => {
        const { openDiscoverPanel } = await import('./discover.js') as { openDiscoverPanel?: () => void };
        openDiscoverPanel?.();
      },
    },
    {
      id: 'nav:add-server',
      label: t('add_join_server') || 'Hub Ekle / Katıl',
      keywords: ['new server', 'join', 'create', 'yeni sunucu', 'katıl'],
      category: 'navigate',
      icon: '➕',
      action: async () => {
        const { openAddServerModal } = await import('./server-ui.js');
        openAddServerModal();
      },
    },
    {
      id: 'nav:group-dm',
      label: t('create_group_dm') || 'Grup DM Oluştur',
      keywords: ['group', 'dm', 'grup'],
      category: 'navigate',
      icon: '💬',
      action: async () => {
        const { openCreateGroupDmModal } = await import('./group-dm-core.js');
        openCreateGroupDmModal();
      },
    },

    // ── Eylemler ──────────────────────────────────────────────────────────────
    {
      id: 'action:invite',
      label: t('create_invite') || 'Davet Oluştur',
      keywords: ['invite', 'link', 'davet', 'bağlantı'],
      category: 'action',
      icon: '🔗',
      visible: () => !!getCurrentServer(),
      action: async () => {
        const { openInviteModal } = await import('./server-ui.js');
        await openInviteModal();
      },
    },
    {
      id: 'action:roles',
      label: t('manage_roles') || 'Rolleri Yönet',
      keywords: ['role', 'permission', 'rol', 'izin'],
      category: 'action',
      icon: '🛡️',
      visible: () => {
        const s = getCurrentServer() as { ownerId?: string } | null;
        const u = getState()?.user as { _id?: string } | null;
        return !!s && s.ownerId === u?._id;
      },
      action: async () => {
        const { openRoleManager } = await import('./server-ui.js');
        await openRoleManager();
      },
    },
    {
      id: 'action:bot-marketplace',
      label: t('bot_marketplace') || 'Bot Marketplace',
      keywords: ['bot', 'uygulama', 'app', 'eklenti'],
      category: 'action',
      icon: '🤖',
      visible: () => !!getCurrentServer(),
      action: async () => {
        const { openBotMarketplace } = await import('./bot-marketplace/index.js');
        await openBotMarketplace();
      },
    },
    {
      id: 'action:soundboard',
      label: t('soundboard') || 'Soundboard',
      keywords: ['sound', 'ses', 'efekt'],
      category: 'action',
      icon: '🔊',
      visible: () => !!getCurrentServer(),
      action: async () => {
        const { openSoundboardPanel } = await import('./soundboard-ui.js');
        await openSoundboardPanel();
      },
    },
    {
      id: 'action:analytics',
      label: t('server_analytics') || 'Sunucu Analitiği',
      keywords: ['analytics', 'stats', 'istatistik', 'analitik'],
      category: 'action',
      icon: '📊',
      visible: () => {
        const s = getCurrentServer() as { ownerId?: string } | null;
        const u = getState()?.user as { _id?: string } | null;
        return !!s && s.ownerId === u?._id;
      },
      action: async () => {
        const { openServerAnalytics } = await import('./analytics.js');
        await openServerAnalytics();
      },
    },
    {
      id: 'action:webhooks',
      label: t('outgoing_webhooks') || 'Outgoing Webhooks',
      keywords: ['webhook', 'integration', 'entegrasyon'],
      category: 'action',
      icon: '🔗',
      visible: () => !!getCurrentServer(),
      action: async () => {
        const { openOutgoingWebhookManager } = await import('./outgoing-webhooks.js');
        await openOutgoingWebhookManager();
      },
    },

    // ── Ayarlar ───────────────────────────────────────────────────────────────
    {
      id: 'settings:server',
      label: t('server_settings') || 'Sunucu Ayarları',
      keywords: ['settings', 'server', 'ayarlar'],
      category: 'settings',
      icon: '⚙️',
      visible: () => {
        const s = getCurrentServer() as { ownerId?: string } | null;
        const u = getState()?.user as { _id?: string } | null;
        return !!s && s.ownerId === u?._id;
      },
      action: async () => {
        const srv = getCurrentServer() as { _id: string } | null;
        if (!srv) return;
        const mod = await import('./server-settings.js') as { openServerSettings?: (id: string) => void };
        mod.openServerSettings?.(srv._id);
      },
    },
    {
      id: 'settings:notifications',
      label: t('notification_settings') || 'Bildirim Ayarları',
      keywords: ['notification', 'bildirim', 'uyarı'],
      category: 'settings',
      icon: '🔔',
      visible: () => !!getCurrentServer(),
      action: async () => {
        const { openServerNotifSettings } = await import('./notification-prefs.js');
        openServerNotifSettings();
      },
    },
  ];

  for (const cmd of COMMANDS) {
    registerCommand(cmd);
  }
}

export default { initCommandPalette, open, close, toggle, registerCommand, unregisterCommand, getCommands };
