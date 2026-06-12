// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BoostPanel.svelte
//              client/js/core/boost-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/v44/boost.ts
// Modül: Server Boost UI — boost satın alma + seviye göstergesi
'use strict';

const BOOST_TIERS = [
  { level: 0, label: 'Başlangıç',  boosts: 0,  perks: ['Temel özellikler'] },
  { level: 1, label: 'Seviye 1',   boosts: 2,  perks: ['Özel emoji (+50)', 'HD ses kalitesi', 'Özel davet arka planı'] },
  { level: 2, label: 'Seviye 2',   boosts: 7,  perks: ['Özel emoji (+100)', '256 kbps ses', 'Server banner', '50 MB dosya'] },
  { level: 3, label: 'Seviye 3',   boosts: 14, perks: ['Özel emoji (+250)', '384 kbps ses', 'Vanity URL', '100 MB dosya', 'Animasyonlu icon'] },
];

async function openBoostPanel(serverId: string): Promise<void> {
  interface Booster { displayName?: string; username?: string; boostedAt?: string; }
  let boost: { count: number; boosters: Booster[] } = { count: 0, boosters: [] };
  try {
    const r = await apiFetch(`${API}/api/servers/${serverId}/boosts`);
    if (r.ok) boost = await r.json();
  } catch {}

  const tier    = BOOST_TIERS.slice().reverse().find(t => boost.count >= t.boosts) || BOOST_TIERS[0];
  const nextTier = BOOST_TIERS.find(t => t.boosts > boost.count);
  const progress = nextTier
    ? Math.round(((boost.count - tier.boosts) / (nextTier.boosts - tier.boosts)) * 100)
    : 100;

  const modal = document.createElement('div');
  modal.id = 'boost-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card boost-card" style="max-width:500px;width:95%;max-height:88vh;overflow-y:auto;">
      <div class="boost-header">
        <div style="font-size:36px;margin-bottom:8px;">ğŸš€</div>
        <h2 style="margin:0 0 4px">Server Boost</h2>
        <div style="color:var(--text-muted);font-size:13px;">${boost.count} aktif boost</div>
      </div>

      <div class="boost-tier-badge tier-${tier.level}">
        ${tier.label}
      </div>

      ${nextTier ? `
        <div class="boost-progress-wrap">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:6px;">
            <span>${tier.label}</span><span>${nextTier.label} (${nextTier.boosts} boost)</span>
          </div>
          <div class="boost-progress-bar">
            <div class="boost-progress-fill" style="width:${progress}%"></div>
          </div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;text-align:center;">
            ${nextTier.boosts - boost.count} boost daha gerekiyor
          </div>
        </div>` : `<div style="text-align:center;color:var(--success);font-size:13px;margin:12px 0;">✅ Maksimum seviyeye ulaşıldı!</div>`}

      <div class="boost-perks">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;">âœ¨ Mevcut Ayrıcalıklar</div>
        ${tier.perks.map(p => `<div class="boost-perk-item">✅ ${p}</div>`).join('')}
        ${nextTier ? `
          <div style="font-weight:600;font-size:13px;margin:12px 0 8px;color:var(--text-muted);">ğŸ”’ ${nextTier.label} Ayrıcalıkları</div>
          ${nextTier.perks.filter(p => !tier.perks.includes(p)).map(p => `<div class="boost-perk-item locked">ğŸ”’ ${p}</div>`).join('')}
        ` : ''}
      </div>

      <button class="btn btn-primary boost-btn" onclick="sendBoost('${serverId}')">
        ğŸš€ Bu Sunucuyu Boost'la
      </button>

      ${boost.boosters?.length ? `
        <div style="margin-top:16px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:8px;">ğŸ’œ Boost'çular (${boost.boosters.length})</div>
          <div class="boost-boosters-list">
            ${boost.boosters.slice(0, 10).map(b => `
              <div class="boost-booster-item">
                <span style="font-size:16px;">ğŸ’œ</span>
                <span style="font-size:13px;">${escHtml(b.displayName || b.username)}</span>
                <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${_relBoostTime(b.boostedAt)}</span>
              </div>`).join('')}
            ${boost.boosters.length > 10 ? `<div style="font-size:12px;color:var(--text-muted);text-align:center;padding:6px;">+${boost.boosters.length - 10} kişi daha</div>` : ''}
          </div>
        </div>` : ''}

      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn" onclick="document.getElementById('boost-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function sendBoost(serverId: string): Promise<void> {
  const r = await apiFetch(`${API}/api/servers/${serverId}/boosts`, { method: 'POST' });
  const d = await r.json();
  if (!r.ok) return toast(d.error || 'Boost başarısız', 'error');
  toast('ğŸš€ Sunucu boost\'landı! Teşekkürler!', 'success');
  document.getElementById('boost-modal')?.remove();
  setTimeout(() => openBoostPanel(serverId), 300);
}

function _relBoostTime(ts: string | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 86400000)  return 'bugün';
  if (diff < 604800000) return `${Math.floor(diff/86400000)}g önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}

// Boost seviye barını header'a ekle
function injectBoostBar() {
  const header = document.querySelector('.server-header-content, .server-name-wrap');
  if (!header || document.getElementById('boost-mini-bar')) return;
  const sid = (getCurrentServer() as { _id?: string } | null)?._id;
  if (!sid) return;

  const bar = document.createElement('div');
  bar.id = 'boost-mini-bar';
  bar.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';
  bar.title = 'Server Boost';
  bar.innerHTML = `<span style="font-size:11px;color:var(--text-muted);">ğŸš€</span><div class="boost-mini-fill" id="boost-mini-fill"></div>`;
  bar.onclick = () => openBoostPanel(sid);
  header.appendChild(bar);

  apiFetch(`${API}/api/servers/${sid}/boosts`).then(async r => {
    if (!r.ok) return;
    const { count } = await r.json();
    const fill = document.getElementById('boost-mini-fill');
    if (!fill) return;
    const maxBoosts = 14;
    const pct = Math.min(100, (count / maxBoosts) * 100);
    fill.style.cssText = `height:4px;border-radius:2px;background:var(--bg-secondary);width:60px;overflow:hidden;`;
    fill.innerHTML = `<div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#a37dff,#ff73c5);border-radius:2px;transition:.4s;"></div>`;
  }).catch(() => {});
}

document.addEventListener('bridge:server-selected', injectBoostBar);
setTimeout(injectBoostBar, 1000);

// Expose globals
// ── BridgeRegistry ─────────────────────────────────────────────────────────────
BridgeRegistry.register('openBoostPanel', () => openBoostPanel());
BridgeRegistry.register('sendBoost',      () => sendBoost());

export { openBoostPanel, sendBoost };


// client/js/core/boost.ts — PATCH (Sprint 92)
// Mevcut dosyanın sonuna eklenecek blok.
// Boost tier'a göre sunucu özelliklerini gerçekten aktif eder.

// ── FEATURE GATES ─────────────────────────────────────────────────────────────

interface BoostFeatures {
  uploadLimitMB:    number;   // max upload boyutu (MB)
  audioBitrate:     number;   // ses kalitesi (kbps)
  serverBanner:     boolean;  // sunucu banner alanı görünür mü
  vanityUrl:        boolean;  // vanity URL ayarı aktif mi
  animatedIcon:     boolean;  // sunucu ikonunu animasyonlu yapabilir mi
  extraEmoji:       number;   // ek emoji slotu
}

const TIER_FEATURES: Record<number, BoostFeatures> = {
  0: { uploadLimitMB: 25,  audioBitrate: 96,  serverBanner: false, vanityUrl: false, animatedIcon: false, extraEmoji: 0   },
  1: { uploadLimitMB: 25,  audioBitrate: 128, serverBanner: false, vanityUrl: false, animatedIcon: false, extraEmoji: 50  },
  2: { uploadLimitMB: 50,  audioBitrate: 256, serverBanner: true,  vanityUrl: false, animatedIcon: false, extraEmoji: 100 },
  3: { uploadLimitMB: 100, audioBitrate: 384, serverBanner: true,  vanityUrl: true,  animatedIcon: true,  extraEmoji: 250 },
};

let _activeFeatures: BoostFeatures = TIER_FEATURES[0];
let _currentTierLevel = 0;

/**
 * Sunucu seçildiğinde veya boost güncellendiğinde çağrılır.
 * Gerçek UI öğelerini ve upload limitlerini tier'a göre ayarlar.
 */
async function applyBoostFeatures(serverId: string): Promise<void> {
  if (!serverId) return;

  let count = 0;
  try {
    const r = await apiFetch(`${API}/api/servers/${serverId}/boosts`);
    if (r.ok) { const d = await r.json(); count = d.count ?? 0; }
  } catch { /* network hatası — default'ta kal */ }

  const tier    = BOOST_TIERS.slice().reverse().find(t => count >= t.boosts) ?? BOOST_TIERS[0];
  _currentTierLevel = tier.level;
  _activeFeatures   = TIER_FEATURES[tier.level] ?? TIER_FEATURES[0];

  _applyUploadLimit(_activeFeatures.uploadLimitMB);
  _applyAudioBitrate(_activeFeatures.audioBitrate);
  _applyServerBannerGate(_activeFeatures.serverBanner);
  _applyVanityUrlGate(_activeFeatures.vanityUrl);
  _applyAnimatedIconGate(_activeFeatures.animatedIcon);

  // BridgeRegistry'e yay — ses modülü dinliyor
  BridgeRegistry.call('_setVoiceBitrate', _activeFeatures.audioBitrate);

  document.dispatchEvent(new CustomEvent('bridge:boost-features-applied', {
    detail: { tier: tier.level, features: _activeFeatures, serverId }
  }));
}

// ── UPLOAD LİMİTİ ─────────────────────────────────────────────
function _applyUploadLimit(limitMB: number): void {
  // Tüm file input'larına data attribute ekle — upload handler bunu okur
  document.querySelectorAll<HTMLInputElement>('input[type="file"][data-upload-type="attachment"]')
    .forEach(el => { el.dataset.maxMb = String(limitMB); });

  // Global erişim için BridgeRegistry'e kaydet
  BridgeRegistry.call('_setUploadLimitMB', limitMB);

  // Upload butonunun tooltip'ini güncelle
  const uploadBtn = document.getElementById('upload-btn') ?? document.querySelector('.msg-input-btn.attach');
  if (uploadBtn) uploadBtn.title = `Dosya yükle (maks ${limitMB} MB)`;
}

// ── SES BİTRATE ───────────────────────────────────────────────
function _applyAudioBitrate(kbps: number): void {
  // voice.ts bu eventi dinliyor; peer connection'ı renegotiate eder
  document.dispatchEvent(new CustomEvent('bridge:voice-bitrate-change', { detail: { kbps } }));
}

// ── SERVER BANNER ─────────────────────────────────────────────
function _applyServerBannerGate(enabled: boolean): void {
  // Sunucu ayarlarındaki banner bölümünü göster/gizle
  const bannerSection = document.getElementById('server-banner-section') ??
                        document.querySelector<HTMLElement>('[data-feature="server-banner"]');
  if (!bannerSection) return;

  if (enabled) {
    bannerSection.style.display = '';
    bannerSection.removeAttribute('data-locked');
  } else {
    bannerSection.style.display = 'none';
    bannerSection.dataset.locked = '1';
  }
}

// ── VANİTY URL ─────────────────────────────────────────────────
function _applyVanityUrlGate(enabled: boolean): void {
  const vanitySection = document.getElementById('vanity-url-section') ??
                        document.querySelector<HTMLElement>('[data-feature="vanity-url"]');
  if (!vanitySection) return;
  vanitySection.style.display = enabled ? '' : 'none';
}

// ── ANİMASYONLU İKON ──────────────────────────────────────────
function _applyAnimatedIconGate(enabled: boolean): void {
  const iconInput = document.querySelector<HTMLInputElement>('input[data-upload-type="server-icon"]');
  if (!iconInput) return;
  if (enabled) {
    iconInput.accept = 'image/*';     // gif dahil
    iconInput.dataset.animated = '1';
  } else {
    iconInput.accept = 'image/png,image/jpeg,image/webp';
    delete iconInput.dataset.animated;
  }
}

// ── GETTERs (diğer modüller kullanır) ─────────────────────────
function getBoostFeatures(): BoostFeatures { return _activeFeatures; }
function getBoostTierLevel(): number       { return _currentTierLevel; }

// ── UPLOAD LIMIT CHECKER (mesaj gönderme anında kullanılır) ───
function checkUploadLimit(fileSizeBytes: number): boolean {
  const limitBytes = _activeFeatures.uploadLimitMB * 1024 * 1024;
  if (fileSizeBytes > limitBytes) {
    toast(`Dosya çok büyük. Mevcut boost seviyesinde maksimum ${_activeFeatures.uploadLimitMB} MB yüklenebilir.`, 'error');
    return false;
  }
  return true;
}

// ── OTOMATİK TETIKLE ──────────────────────────────────────────
document.addEventListener('bridge:server-selected', (e: Event) => {
  const serverId = (e as CustomEvent<{ serverId?: string }>).detail?.serverId;
  if (serverId) applyBoostFeatures(serverId);
});

// Boost satın alımından sonra yenile
document.addEventListener('bridge:boost-purchased', (e: Event) => {
  const serverId = (e as CustomEvent<{ serverId?: string }>).detail?.serverId ??
                   (BridgeRegistry.call('getCurrentServer') as { _id?: string } | null)?._id;
  if (serverId) applyBoostFeatures(serverId);
});

BridgeRegistry.register('applyBoostFeatures',  (sid: unknown) => applyBoostFeatures(sid as string));
BridgeRegistry.register('getBoostFeatures',     getBoostFeatures);
BridgeRegistry.register('getBoostTierLevel',    getBoostTierLevel);
BridgeRegistry.register('checkUploadLimit',     (bytes: unknown) => checkUploadLimit(bytes as number));

export { applyBoostFeatures, getBoostFeatures, getBoostTierLevel, checkUploadLimit };
