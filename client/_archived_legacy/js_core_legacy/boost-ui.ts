// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BoostUiPanel.svelte
//              client/js/core/boost-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/boost-ui.ts — Sprint 93
// Sunucu boost paneli: tier görüntüleme, boost satın alma, vanity URL ayarı
// Sunucu ayarları modalına entegre edilir.

import { BridgeRegistry } from './bridge-registry.js';
import { apiFetch, escHtml, toast } from './utils.js';

(function () {

  const API = (window as Record<string,string>).API_BASE || '';

  // ── BOOST PANEL ──────────────────────────────────────────────────────────────
  async function renderBoostPanel(serverId: string, container: HTMLElement): Promise<void> {
    container.innerHTML = '<div class="boost-loading">Yükleniyor...</div>';

    let data: {
      count: number; tier: number; uploadLimitMB: number; audioBitrate: number;
      perks: string[]; boosters: Array<{ userId: string; boostedAt: number }>;
    };

    try {
      const r = await apiFetch(`${API}/api/v1/servers/${serverId}/boosts`);
      data = await r.json();
    } catch {
      container.innerHTML = '<p class="error-msg">Boost bilgisi alınamadı.</p>';
      return;
    }

    const TIER_LABELS = ['Boost Yok', 'Seviye 1', 'Seviye 2', 'Seviye 3'];
    const TIER_COLORS = ['var(--text-muted)', '#f47fff', '#b44df5', '#7b2ff7'];
    const TIER_THRESHOLDS = [0, 2, 7, 14];

    const nextTierBoosts = TIER_THRESHOLDS[data.tier + 1];
    const progress = nextTierBoosts ? Math.min(100, (data.count / nextTierBoosts) * 100) : 100;

    container.innerHTML = `
      <div class="boost-panel">
        <!-- Tier başlığı -->
        <div class="boost-tier-header" style="border-color:${TIER_COLORS[data.tier]}">
          <span class="boost-tier-icon">🚀</span>
          <div>
            <div class="boost-tier-label" style="color:${TIER_COLORS[data.tier]}">${TIER_LABELS[data.tier]}</div>
            <div class="boost-count">${data.count} Boost</div>
          </div>
        </div>

        <!-- Progress bar -->
        ${nextTierBoosts ? `
        <div class="boost-progress-wrap">
          <div class="boost-progress-bar">
            <div class="boost-progress-fill" style="width:${progress}%;background:${TIER_COLORS[data.tier + 1] || TIER_COLORS[data.tier]}"></div>
          </div>
          <div class="boost-progress-label">${data.count}/${nextTierBoosts} — ${TIER_LABELS[data.tier + 1]}'e ulaşmak için ${nextTierBoosts - data.count} boost daha</div>
        </div>` : '<div class="boost-max-badge">✨ Maksimum seviyeye ulaşıldı!</div>'}

        <!-- Mevcut özellikler -->
        <div class="boost-perks">
          <h4>Aktif Özellikler</h4>
          <ul>
            <li>📁 Dosya boyutu limiti: <strong>${data.uploadLimitMB} MB</strong></li>
            <li>🎙️ Ses kalitesi: <strong>${data.audioBitrate} kbps</strong></li>
            ${data.tier >= 2 ? '<li>🖼️ Sunucu banner</li>' : ''}
            ${data.tier >= 3 ? '<li>🔗 Vanity URL</li><li>✨ Animasyonlu sunucu ikonu</li>' : ''}
            ${(data.perks || []).map(p => `<li>✅ ${escHtml(p)}</li>`).join('')}
          </ul>
        </div>

        <!-- Boost butonu -->
        <button id="boost-this-server-btn" class="btn btn-boost" type="button">
          🚀 Bu Sunucuya Boost Ver
        </button>

        <!-- Vanity URL (tier 3 ise) -->
        ${data.tier >= 3 ? `
        <div class="vanity-url-section" id="vanity-section">
          <h4>🔗 Vanity URL</h4>
          <div class="vanity-input-row">
            <span class="vanity-prefix">bridge.app/</span>
            <input type="text" id="vanity-input" class="input-field" placeholder="sunucum" maxlength="32"
              pattern="[a-z0-9-]+" title="Sadece küçük harf, rakam ve tire">
            <button id="vanity-save-btn" class="btn" type="button">Kaydet</button>
          </div>
          <p class="setting-description">3–32 karakter. Küçük harf, rakam ve tire kullanabilirsiniz.</p>
        </div>` : `
        <div class="vanity-locked" data-locked="1">
          <h4>🔗 Vanity URL</h4>
          <p>Vanity URL için Seviye 3 Boost gereklidir (14 boost).</p>
        </div>`}

        <!-- Booster listesi -->
        ${data.boosters.length ? `
        <div class="boosters-list">
          <h4>Boosterlar (${data.boosters.length})</h4>
          <div class="boosters-grid">
            ${data.boosters.slice(0, 12).map(b => `
              <div class="booster-avatar" title="${b.userId}" data-uid="${b.userId}">🚀</div>
            `).join('')}
            ${data.boosters.length > 12 ? `<div class="booster-more">+${data.boosters.length - 12}</div>` : ''}
          </div>
        </div>` : ''}
      </div>
    `;

    // Boost butonu
    document.getElementById('boost-this-server-btn')?.addEventListener('click', () => boostServer(serverId, container));

    // Vanity kaydet
    document.getElementById('vanity-save-btn')?.addEventListener('click', () => saveVanityUrl(serverId));

    // Mevcut vanity URL'yi yükle
    if (data.tier >= 3) loadCurrentVanityUrl(serverId);
  }

  async function boostServer(serverId: string, container: HTMLElement): Promise<void> {
    const btn = document.getElementById('boost-this-server-btn') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Gönderiliyor...'; }

    try {
      const r = await apiFetch(`${API}/api/v1/servers/${serverId}/boosts`, { method: 'POST' });
      if (r.status === 409) { toast('Zaten bu sunucuyu boost\'lamışsınız.', 'info'); return; }
      if (!r.ok) { const e = await r.json(); toast(e.error || 'Boost gönderilemedi', 'error'); return; }
      toast('🚀 Sunucu boost\'landı!', 'success');
      document.dispatchEvent(new CustomEvent('bridge:boost-purchased', { detail: { serverId } }));
      await renderBoostPanel(serverId, container); // yenile
    } catch {
      toast('Ağ hatası', 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveVanityUrl(serverId: string): Promise<void> {
    const input = document.getElementById('vanity-input') as HTMLInputElement | null;
    const slug  = input?.value.toLowerCase().trim() || '';
    if (!slug) return;

    try {
      const r = await apiFetch(`${API}/api/v1/servers/${serverId}/vanity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vanityUrl: slug }),
      });
      const data = await r.json();
      if (!r.ok) { toast(data.error || 'Kaydedilemedi', 'error'); return; }
      toast(`✅ Vanity URL: bridge.app/${data.vanityUrl}`, 'success');
    } catch {
      toast('Ağ hatası', 'error');
    }
  }

  async function loadCurrentVanityUrl(serverId: string): Promise<void> {
    try {
      const r = await apiFetch(`${API}/api/v1/servers/${serverId}`);
      const s = await r.json();
      const input = document.getElementById('vanity-input') as HTMLInputElement | null;
      if (input && s.vanityUrl) input.value = s.vanityUrl;
    } catch { /* noop */ }
  }

  BridgeRegistry.register('renderBoostPanel', (sid: unknown, el: unknown) =>
    renderBoostPanel(sid as string, el as HTMLElement));

})();
