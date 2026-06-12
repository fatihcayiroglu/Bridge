// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServerSettingsPanel.svelte
//              client/js/core/server-settings-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/server-settings.ts
// ─────────────────────────────────────────────────────────────
// ADR-0008 Faz 2 — Sprint 114 GEÇİŞ DURUMU
//
// ✅ Svelte'e taşınanlar (ServerSettingsModal sekmeleri):
//    - openServerSettings   → mountServerSettingsModal() (Genel sekmesi)
//    - openEmojiManager     → EmojiTab.svelte
//    - openWebhookManager   → WebhookTab.svelte
//    - openAuditLogExport   → AuditLogTab.svelte
//    - openSSOSettings      → SsoTab.svelte
//    - openPluginManager    → PluginTab.svelte
//    - uploadServerBanner / removeServerBanner / uploadServerIconImage → MediaTab.svelte
//
// ⏳ Vanilla'da kalanlar (bu dosyada hâlâ aktif):
//    - toggleServerEmojiPicker  — mesaj kutusundaki inline picker, modal değil
//    - insertEmojiShortcode     — picker'dan metin alanına ekleme
//    - outgoing webhook / onboarding — ayrı modüller (outgoing-webhooks.ts, onboarding.ts)
//
// Legacy window.* global'ları korunuyor (onclick HTML string'leri için).
// Sprint 116'da bu dosya ~200 satıra küçülecek.
//
// Önceki adı: core/api.js
// ─────────────────────────────────────────────────────────────

import { apiFetch }                               from './api-fetch.js';
import { getAPI, currentServerChannels,
         serverEmojiCache }                        from './globals.js';
import { escHtml, toast }                         from './utils.js';
import { BridgeRegistry }                         from './bridge-registry.js';
import { mountServerSettingsModal }               from './server-settings/server-settings-svelte.js';

// Modül genelinde API sabiti
const API = getAPI();

// currentServer — BridgeRegistry üzerinden (globals.ts sprint 33 köprüsü)
function _currentServer() {
  return BridgeRegistry.get('getCurrentServer') as {
    _id: string; name: string; icon?: string;
    iconUrl?: string; bannerUrl?: string;
  } | null;
}
// Her API çağrısından önce taze değer almak için getter kullan
function getCurrentServer() { return _currentServer(); }
// Geriye-dönük uyumluluk: openServerSettings içinde yerel olarak set edilir
let currentServer = _currentServer();

// ─── SERVER EMOJI INLINE PICKER (in message box) ─────────────

interface EmojiGroup {
  name: string;
  icon: string;
  emojis: typeof serverEmojiCache;
}

function toggleServerEmojiPicker(): void {
  const existing = document.getElementById('server-emoji-picker');
  if (existing) { existing.remove(); return; }
  if (!serverEmojiCache.length) { toast('Henüz emoji yok. Sağ tıkla → Emoji Yönetimi', 'error'); return; }

  const picker = document.createElement('div');
  picker.id = 'server-emoji-picker';

  // Arama kutusu
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:6px 8px 4px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Emoji ara...';
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-size:12px;outline:none;';
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  // Scroll alanı
  const scrollArea = document.createElement('div');
  scrollArea.style.cssText = 'overflow-y:auto;max-height:260px;padding:0 4px 4px;';
  picker.appendChild(scrollArea);

  function renderEmojiGroups(filter: string = ''): void {
    scrollArea.innerHTML = '';
    // Sunucu bazlı grupla
    const groups: Record<string, EmojiGroup> = {};
    for (const e of serverEmojiCache) {
      if (filter && !e.name.includes(filter.toLowerCase())) continue;
      const key = e.serverId;
      if (!groups[key]) groups[key] = { name: e.serverName || 'Sunucu', icon: e.serverIcon || '🌐', emojis: [] };
      groups[key].emojis.push(e);
    }
    if (!Object.keys(groups).length) {
      scrollArea.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px;text-align:center;">Sonuç yok</div>';
      return;
    }
    for (const [, group] of Object.entries(groups)) {
      const label = document.createElement('div');
      label.className = 'sep-label';
      label.textContent = (group.icon + ' ' + group.name).toUpperCase();
      scrollArea.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'ep-grid';
      for (const e of group.emojis) {
        const btn = document.createElement('button');
        btn.title = ':' + e.name + ':';
        const img = document.createElement('img');
        img.src = API + e.url;
        img.alt = ':' + e.name + ':';
        img.style.cssText = 'width:28px;height:28px;object-fit:contain;border-radius:4px;';
        btn.appendChild(img);
        btn.addEventListener('click', () => { insertEmojiShortcode(':' + e.name + ':'); picker.remove(); });
        grid.appendChild(btn);
      }
      scrollArea.appendChild(grid);
    }
  }

  renderEmojiGroups();
  searchInput.addEventListener('input', () => renderEmojiGroups(searchInput.value.trim()));

  const triggerBtn = document.getElementById('server-emoji-picker-btn');
  const rect = triggerBtn?.getBoundingClientRect();
  if (rect) {
    picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    picker.style.right  = (window.innerWidth  - rect.right)  + 'px';
    picker.style.position = 'fixed';
  }
  document.body.appendChild(picker);
  searchInput.focus();
  setTimeout(() => {
    document.addEventListener('click', function h(ev: MouseEvent) {
      const target = ev.target as Node | null;
      if (!picker.contains(target) && target !== triggerBtn) {
        picker.remove();
        document.removeEventListener('click', h);
      }
    });
  }, 50);
}

function insertEmojiShortcode(code: string): void {
  document.getElementById('server-emoji-picker')?.remove();
  const input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
  if (!input) return;
  const start: number = input.selectionStart ?? input.value.length;
  const end:   number = input.selectionEnd   ?? input.value.length;
  const val = input.value;
  input.value = val.slice(0, start) + code + ' ' + val.slice(end);
  input.setSelectionRange(start + code.length + 1, start + code.length + 1);
  input.focus();
}

// ─── SERVER EMOJI MANAGEMENT ── ✅ Svelte'e taşındı (EmojiTab.svelte) ────────
async function openEmojiManager() {
  // ServerSettingsModal'ı emoji sekmesinde aç
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal('emoji');
}




// ─── SERVER BANNER & ICON UPLOAD ──────────────────────────────
async function openServerSettings() {
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal();
}

async function saveServerSettings() {
  // Svelte GeneralTab kaydetmeyi yönetir — geriye dönük uyumluluk için modal kapat
  document.getElementById('server-settings-svelte-mount')?.remove();
  document.getElementById('server-settings-modal')?.remove();
}

async function saveServerSlug() {
  const input = document.getElementById('srv-slug-input');
  if (!input) return;
  const slug = input.value.trim();
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/slug`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Hata', 'error');
  input.value = data.slug;
  const preview = document.getElementById('srv-slug-preview');
  if (preview) preview.textContent = `Profil: ${window.location.origin}/s/${data.slug}`;
  toast(`Profil URL ayarlandı: /s/${data.slug}`, 'success');
}

async function uploadServerBanner(_input: unknown) {
  // ✅ Svelte'e taşındı — MediaTab.svelte (mountServerSettingsModal('media'))
  await mountServerSettingsModal('media');
}

async function removeServerBanner() {
  // ✅ Svelte'e taşındı — MediaTab.svelte
  await mountServerSettingsModal('media');
}

async function uploadServerIconImage(_input: unknown) {
  // ✅ Svelte'e taşındı — MediaTab.svelte
  await mountServerSettingsModal('media');
}

async function openWebhookManager() {
  // ✅ Svelte'e taşındı — WebhookTab.svelte
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal('webhooks');
}




// ── Audit Log Export ── ✅ Svelte'e taşındı (AuditLogTab.svelte) ─────────
async function openAuditLogExport() {
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal('audit');
}

// ── SSO Ayarları ── ✅ Svelte'e taşındı (SsoTab.svelte) ────────────────────
async function openSSOSettings() {
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal('sso');
}

// ── Plugin Yönetimi ── ✅ Svelte'e taşındı (PluginTab.svelte) ──────────────
async function openPluginManager() {
  currentServer = _currentServer();
  if (!currentServer) return;
  await mountServerSettingsModal('plugins');
}

// Legacy window globals — onclick HTML string'leri için (server-ui.ts vb.)
if (typeof window !== 'undefined') {
  Object.assign(window, {
    openServerSettings,
    saveServerSettings,
    saveServerSlug,
    openEmojiManager,
    openWebhookManager,
    openOutgoingWebhookManager,
    openOnboardingSettings,
    openAuditLogExport,
    openSSOSettings,
    openPluginManager,
    uploadServerBanner,
    removeServerBanner,
    uploadServerIconImage,
    toggleServerEmojiPicker,
    uploadServerEmoji,
    deleteServerEmoji,
  });
}

