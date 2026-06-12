// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServerProfilePanel.svelte
//              client/js/core/server-profile-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/server-profile.ts
// Sprint 91: Per-server profil — sunucu bazlı takma ad, avatar, bio, renk
// Discord'un "Edit Server Profile" özelliğinin karşılığı.

import { apiFetch }                    from './api-fetch.js';
import { getAPI, getMe, getCurrentServer } from './globals.js';
import { escHtml, toast }              from './utils.js';
import { BridgeRegistry }              from './bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ServerProfile {
  serverId:     string;
  userId:       string;
  nickname?:    string;
  bio?:         string;
  avatarUrl?:   string;
  bannerUrl?:   string;
  bannerColor?: string;
  pronouns?:    string;
  updatedAt?:   number;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _currentProfile: ServerProfile | null = null;
let _pendingAvatarFile: File | null       = null;
let _pendingBannerFile: File | null       = null;

// ── Open modal ────────────────────────────────────────────────────────────────

export async function openServerProfileModal(): Promise<void> {
  const server = getCurrentServer() as { _id?: string; name?: string } | null;
  if (!server?._id) return toast('Sunucu seçilmedi', 'error');

  const API    = getAPI();
  const me     = getMe() as Record<string, unknown> | null;

  // Load existing per-server profile
  try {
    const r = await apiFetch(`${API}/api/servers/${server._id}/members/me/profile`);
    _currentProfile = r.ok ? await r.json() : null;
  } catch { _currentProfile = null; }

  _pendingAvatarFile = null;
  _pendingBannerFile = null;

  document.getElementById('server-profile-modal')?.remove();

  const modal = document.createElement('div');
  modal.id        = 'server-profile-modal';
  modal.className = 'modal-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Sunucu Profilini Düzenle');

  const defaultNick    = _currentProfile?.nickname    ?? String(me?.displayName ?? me?.username ?? '');
  const defaultBio     = _currentProfile?.bio         ?? '';
  const defaultColor   = _currentProfile?.bannerColor ?? String(me?.bannerColor ?? '#2d9cdb');
  const defaultPronouns= _currentProfile?.pronouns    ?? '';
  const globalAvatarUrl= me?.avatarUrl ? `${API}${me.avatarUrl}` : null;

  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:96%;max-height:90vh;overflow-y:auto;padding:0;">
      <!-- Header -->
      <div style="padding:20px 24px 0;border-bottom:1px solid var(--border);padding-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <h2 style="margin:0;font-size:18px;font-weight:700">🎭 Sunucu Profili</h2>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-3)">${escHtml(server.name ?? '')} sunucusundaki görünümünü özelleştir</p>
        </div>
        <button class="icon-btn" onclick="document.getElementById('server-profile-modal').remove()" aria-label="Kapat">✕</button>
      </div>

      <!-- Banner area -->
      <div style="position:relative;height:90px;cursor:pointer;overflow:hidden;"
           id="sp-banner-area"
           onclick="document.getElementById('sp-banner-input').click()"
           title="Banner değiştir">
        <div id="sp-banner-bg" style="width:100%;height:100%;background:${defaultColor};transition:background .2s"></div>
        <div style="position:absolute;bottom:6px;right:10px;background:rgba(0,0,0,.55);border-radius:6px;padding:4px 10px;font-size:11px;color:#fff;">📷 Banner Değiştir</div>
        <input type="file" id="sp-banner-input" accept="image/*" style="display:none" onchange="window._spHandleBanner(event)">
      </div>

      <!-- Avatar over banner -->
      <div style="padding:0 24px;margin-top:-28px;position:relative;z-index:2;">
        <div style="position:relative;display:inline-block;cursor:pointer" onclick="document.getElementById('sp-avatar-input').click()" title="Avatar değiştir">
          <div id="sp-avatar-preview" style="width:72px;height:72px;border-radius:50%;border:4px solid var(--bg-primary);overflow:hidden;background:#2d9cdb;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff">
            ${globalAvatarUrl
              ? `<img src="${globalAvatarUrl}" style="width:100%;height:100%;object-fit:cover" id="sp-avatar-img">`
              : `<span id="sp-avatar-initials">${_initials(defaultNick)}</span>`}
          </div>
          <div style="position:absolute;bottom:0;right:0;background:#2d9cdb;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid var(--bg-primary)">✏️</div>
          <input type="file" id="sp-avatar-input" accept="image/*" style="display:none" onchange="window._spHandleAvatar(event)">
        </div>
      </div>

      <!-- Form fields -->
      <div style="padding:8px 24px 24px;">
        <div class="form-group" style="margin-top:16px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Sunucu Takma Adı</label>
          <input id="sp-nickname" type="text" maxlength="32" placeholder="Sunucuya özel görünen adın"
            value="${escHtml(defaultNick)}"
            style="width:100%;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:var(--r-md);padding:10px 14px;color:var(--text-1);font-size:14px;outline:none;box-sizing:border-box;margin-top:6px;"
            oninput="window._spUpdatePreview()">
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">Bu sadece bu sunucuda görünür. Global adın etkilenmez.</div>
        </div>

        <div class="form-group" style="margin-top:16px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Hakkımda (Bu Sunucu)</label>
          <textarea id="sp-bio" maxlength="190" rows="3" placeholder="Bu sunucu özelinde biyografin..."
            style="width:100%;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:var(--r-md);padding:10px 14px;color:var(--text-1);font-size:14px;outline:none;resize:vertical;box-sizing:border-box;margin-top:6px;">${escHtml(defaultBio)}</textarea>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px" id="sp-bio-count">${defaultBio.length}/190</div>
        </div>

        <div class="form-group" style="margin-top:16px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Zamirler</label>
          <input id="sp-pronouns" type="text" maxlength="40" placeholder="örn. o/ona, they/them"
            value="${escHtml(defaultPronouns)}"
            style="width:100%;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:var(--r-md);padding:10px 14px;color:var(--text-1);font-size:14px;outline:none;box-sizing:border-box;margin-top:6px;">
        </div>

        <div class="form-group" style="margin-top:16px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Banner Rengi</label>
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;">
            <input type="color" id="sp-banner-color" value="${defaultColor}"
              style="width:44px;height:36px;border:none;border-radius:6px;cursor:pointer;padding:2px;background:none;"
              oninput="window._spUpdateBannerColor(this.value)">
            <input type="text" id="sp-banner-color-hex" value="${defaultColor}" maxlength="7"
              style="flex:1;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:var(--r-md);padding:8px 12px;color:var(--text-1);font-size:13px;outline:none;"
              oninput="window._spSyncBannerColorHex(this.value)">
          </div>
        </div>

        <!-- Preview -->
        <div style="margin-top:20px;">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Önizleme</label>
          <div id="sp-preview-card" style="margin-top:8px;border-radius:10px;overflow:hidden;background:var(--bg-secondary);border:1px solid var(--border);"></div>
        </div>

        <!-- Footer -->
        <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;padding-top:16px;border-top:1px solid var(--border);">
          <button class="btn btn-secondary" onclick="document.getElementById('server-profile-modal').remove()">İptal</button>
          <button class="btn btn-primary" id="sp-save-btn" onclick="window._spSave('${server._id}')">💾 Kaydet</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Wire bio counter
  document.getElementById('sp-bio')?.addEventListener('input', function(this: HTMLTextAreaElement) {
    const count = document.getElementById('sp-bio-count');
    if (count) count.textContent = `${this.value.length}/190`;
    _spUpdatePreview();
  });

  _spUpdatePreview();
}

// ── Preview renderer ──────────────────────────────────────────────────────────

function _spUpdatePreview(): void {
  const nick    = (document.getElementById('sp-nickname')      as HTMLInputElement)?.value      ?? '';
  const bio     = (document.getElementById('sp-bio')           as HTMLTextAreaElement)?.value   ?? '';
  const color   = (document.getElementById('sp-banner-color')  as HTMLInputElement)?.value      ?? '#2d9cdb';
  const pronouns= (document.getElementById('sp-pronouns')      as HTMLInputElement)?.value      ?? '';
  const preview = document.getElementById('sp-preview-card');
  if (!preview) return;

  const API = getAPI();
  const me  = getMe() as Record<string, unknown> | null;

  const bannerBg  = `background:${color};`;
  const avatarUrl = me?.avatarUrl ? `${API}${me.avatarUrl}` : null;
  const avatarHtml= avatarUrl
    ? `<img src="${avatarUrl}" style="width:64px;height:64px;border-radius:50%;border:4px solid var(--bg-secondary);object-fit:cover;">`
    : `<div style="width:64px;height:64px;border-radius:50%;background:#2d9cdb;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;border:4px solid var(--bg-secondary)">${_initials(nick)}</div>`;

  preview.innerHTML = `
    <div style="height:56px;${bannerBg}"></div>
    <div style="padding:0 14px 14px;margin-top:-32px;">
      ${avatarHtml}
      <div style="margin-top:6px;">
        <div style="font-weight:700;font-size:15px;">${escHtml(nick || 'İsimsiz')}</div>
        ${pronouns ? `<div style="font-size:11px;color:var(--text-3);margin-top:1px;">${escHtml(pronouns)}</div>` : ''}
        ${bio ? `<div style="font-size:12px;color:var(--text-2);margin-top:6px;line-height:1.4;">${escHtml(bio.slice(0, 100))}${bio.length > 100 ? '…' : ''}</div>` : ''}
      </div>
    </div>`;
}
(window as Window & { _spUpdatePreview?: () => void })._spUpdatePreview = _spUpdatePreview;

// ── Banner color helpers ──────────────────────────────────────────────────────

function _spUpdateBannerColor(val: string): void {
  const bg  = document.getElementById('sp-banner-bg');
  const hex = document.getElementById('sp-banner-color-hex') as HTMLInputElement | null;
  if (bg)  bg.style.background = val;
  if (hex) hex.value = val;
  _spUpdatePreview();
}
(window as Window & { _spUpdateBannerColor?: (v: string) => void })._spUpdateBannerColor = _spUpdateBannerColor;

function _spSyncBannerColorHex(val: string): void {
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    const picker = document.getElementById('sp-banner-color') as HTMLInputElement | null;
    if (picker) picker.value = val;
    _spUpdateBannerColor(val);
  }
}
(window as Window & { _spSyncBannerColorHex?: (v: string) => void })._spSyncBannerColorHex = _spSyncBannerColorHex;

// ── File pickers ──────────────────────────────────────────────────────────────

function _spHandleAvatar(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('Max 8 MB', 'error'); return; }
  _pendingAvatarFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    const preview = document.getElementById('sp-avatar-preview');
    if (preview) preview.innerHTML = `<img src="${ev.target!.result}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}
(window as Window & { _spHandleAvatar?: (e: Event) => void })._spHandleAvatar = _spHandleAvatar;

function _spHandleBanner(e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Max 10 MB', 'error'); return; }
  _pendingBannerFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    const bg = document.getElementById('sp-banner-bg');
    if (bg) { bg.style.background = `url('${ev.target!.result}') center/cover no-repeat`; }
  };
  reader.readAsDataURL(file);
}
(window as Window & { _spHandleBanner?: (e: Event) => void })._spHandleBanner = _spHandleBanner;

// ── Save ──────────────────────────────────────────────────────────────────────

async function _spSave(serverId: string): Promise<void> {
  const API     = getAPI();
  const btn     = document.getElementById('sp-save-btn') as HTMLButtonElement | null;
  const nickname = (document.getElementById('sp-nickname')      as HTMLInputElement)?.value?.trim()     ?? '';
  const bio      = (document.getElementById('sp-bio')           as HTMLTextAreaElement)?.value?.trim()  ?? '';
  const pronouns = (document.getElementById('sp-pronouns')      as HTMLInputElement)?.value?.trim()     ?? '';
  const color    = (document.getElementById('sp-banner-color')  as HTMLInputElement)?.value             ?? '#2d9cdb';

  if (btn) { btn.disabled = true; btn.textContent = '⏳ Kaydediliyor...'; }

  try {
    // 1. Upload avatar if changed
    let avatarUrl: string | undefined;
    if (_pendingAvatarFile) {
      const fd = new FormData();
      fd.append('file', _pendingAvatarFile);
      const r = await apiFetch(`${API}/api/servers/${serverId}/members/me/avatar`, { method: 'POST', body: fd });
      if (r.ok) { const d = await r.json(); avatarUrl = d.avatarUrl; }
      else { toast('Avatar yüklenemedi', 'error'); }
    }

    // 2. Upload banner if changed
    let bannerUrl: string | undefined;
    if (_pendingBannerFile) {
      const fd = new FormData();
      fd.append('file', _pendingBannerFile);
      const r = await apiFetch(`${API}/api/servers/${serverId}/members/me/banner`, { method: 'POST', body: fd });
      if (r.ok) { const d = await r.json(); bannerUrl = d.bannerUrl; }
      else { toast('Banner yüklenemedi', 'error'); }
    }

    // 3. Save profile fields
    const body: Record<string, unknown> = { nickname, bio, pronouns, bannerColor: color };
    if (avatarUrl) body.avatarUrl = avatarUrl;
    if (bannerUrl) body.bannerUrl = bannerUrl;

    const r = await apiFetch(`${API}/api/servers/${serverId}/members/me/profile`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!r.ok) {
      const d = await r.json();
      toast(d.error ?? 'Profil kaydedilemedi', 'error');
      return;
    }

    _currentProfile = await r.json();
    toast('✅ Sunucu profili güncellendi', 'success');
    document.getElementById('server-profile-modal')?.remove();

    // Emit socket so other members see the update immediately
    (window as Window & { socket?: { emit: (...a: unknown[]) => void } }).socket?.emit(
      'member:profile:updated',
      { serverId, nickname, bio, pronouns, bannerColor: color, avatarUrl, bannerUrl }
    );

  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Kaydet'; }
  }
}
(window as Window & { _spSave?: (s: string) => void })._spSave = _spSave;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _initials(name: string): string {
  return (name ?? '').split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?';
}

// ── BridgeRegistry export ─────────────────────────────────────────────────────

BridgeRegistry.register('openServerProfileModal', openServerProfileModal);
