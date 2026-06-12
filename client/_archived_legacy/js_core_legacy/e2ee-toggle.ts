// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/E2eeTogglePanel.svelte
//              client/js/core/e2ee-toggle-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/e2ee-toggle.ts — Sprint 93
// E2EE production toggle UI + feature flag kontrolü
// Ayarlar modalı güvenlik sekmesine enjekte edilir.

import { BridgeRegistry } from './bridge-registry.js';
import { apiFetch } from './utils.js';

(function () {

  const API = (window as Record<string,string>).API_BASE || '';

  let _e2eeEnabled: boolean | null = null;

  // ── Feature flag kontrolü ─────────────────────────────────────────────────
  async function checkE2EEFeatureFlag(): Promise<boolean> {
    if (_e2eeEnabled !== null) return _e2eeEnabled;
    try {
      const r = await apiFetch(`${API}/api/v1/e2e/feature-status`);
      const d = await r.json() as { enabled: boolean };
      _e2eeEnabled = d.enabled;
    } catch {
      _e2eeEnabled = false;
    }
    return _e2eeEnabled;
  }

  // ── Ayarlar güvenlik sekmesine E2EE bilgi paneli ekle ─────────────────────
  async function initE2EESettingsPanel(): Promise<void> {
    const container = document.getElementById('e2ee-settings-panel') ??
                      document.querySelector<HTMLElement>('[data-e2ee-settings]');
    if (!container) return;

    const featureEnabled = await checkE2EEFeatureFlag();
    let userStatus: { enabled: boolean; hasKey: boolean } = { enabled: false, hasKey: false };

    if (featureEnabled) {
      try {
        const r = await apiFetch(`${API}/api/v1/e2e/status`);
        userStatus = await r.json();
      } catch { /* noop */ }
    }

    container.innerHTML = `
      <div class="e2ee-panel">
        <div class="e2ee-header">
          <span class="e2ee-icon">${featureEnabled ? '🔒' : '🔓'}</span>
          <div>
            <h4 class="e2ee-title">Uçtan Uca Şifreleme (E2EE)</h4>
            <p class="setting-description">
              ${featureEnabled
                ? 'Bu sunucu örneği E2EE\'yi desteklemektedir. Şifreli kanallarda mesajlar sunucu tarafından okunamaz.'
                : 'E2EE bu sunucu örneğinde şu an devre dışı bırakılmıştır. Sunucu yöneticisi <code>BRIDGE_E2EE_ENABLED=true</code> ile aktif edebilir.'}
            </p>
          </div>
          <div class="e2ee-status-badge ${featureEnabled ? 'active' : 'inactive'}">
            ${featureEnabled ? 'Aktif' : 'Devre Dışı'}
          </div>
        </div>

        ${featureEnabled ? `
        <div class="e2ee-user-status">
          <div class="setting-row">
            <div class="setting-label-wrap">
              <label class="setting-label">Şifreleme Anahtarım</label>
              <p class="setting-description">
                ${userStatus.hasKey
                  ? '✅ Genel anahtarınız kayıtlı. Şifreli kanallara katılabilirsiniz.'
                  : 'Henüz bir şifreleme anahtarınız yok. Şifreli bir kanala ilk girişinizde otomatik oluşturulur.'}
              </p>
            </div>
            ${userStatus.hasKey ? `
            <button id="e2ee-revoke-key-btn" class="btn btn-sm btn-danger" type="button">Anahtarı İptal Et</button>
            ` : ''}
          </div>

          <div class="setting-row">
            <div class="setting-label-wrap">
              <label class="setting-label">E2EE Korumalı Kanallar</label>
              <p class="setting-description">
                Kanal ayarlarından herhangi bir kanalı E2EE ile koruyabilirsiniz. Kanal yöneticisi "🔒 E2EE Aktif Et" seçeneğini kullanmalıdır.
              </p>
            </div>
          </div>
        </div>
        ` : `
        <div class="e2ee-admin-note">
          <h5>Yöneticiler İçin</h5>
          <p>E2EE'yi aktifleştirmek için <code>.env</code> dosyasına veya ortam değişkenlerine ekleyin:</p>
          <pre class="code-block">BRIDGE_E2EE_ENABLED=true</pre>
          <p>Değişiklik sunucu yeniden başlatıldıktan sonra geçerli olur.</p>
        </div>
        `}
      </div>
    `;

    // Anahtar iptal
    document.getElementById('e2ee-revoke-key-btn')?.addEventListener('click', async () => {
      if (!confirm('Şifreleme anahtarınızı iptal etmek istediğinizden emin misiniz? Mevcut E2EE kanallarına erişemeyebilirsiniz.')) return;
      await apiFetch(`${API}/api/v1/e2e/keys`, { method: 'DELETE' });
      _e2eeEnabled = null; // cache'i temizle
      initE2EESettingsPanel(); // yenile
    });
  }

  // ── E2EE durumunu profil kartında göster ─────────────────────────────────
  async function showE2EEBadgeIfEnabled(badgeEl: HTMLElement): Promise<void> {
    const enabled = await checkE2EEFeatureFlag();
    if (!enabled) { badgeEl.style.display = 'none'; return; }
    badgeEl.style.display = '';
    badgeEl.title = 'Bu kullanıcının E2EE genel anahtarı kayıtlı';
  }

  document.addEventListener('settings:tab-opened', (e: Event) => {
    if ((e as CustomEvent<{ tabId: string }>).detail?.tabId === 'privacy') {
      initE2EESettingsPanel();
    }
  });

  BridgeRegistry.register('initE2EESettingsPanel', initE2EESettingsPanel);
  BridgeRegistry.register('checkE2EEFeatureFlag',  checkE2EEFeatureFlag);
  BridgeRegistry.register('showE2EEBadgeIfEnabled', (el: unknown) => showE2EEBadgeIfEnabled(el as HTMLElement));

})();
