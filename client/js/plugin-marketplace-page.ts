import { BridgeRegistry } from './core/bridge-registry.ts';
import { localeTag, t } from './core/i18n/index';
import { focusTrap } from './core/a11y/focusTrap.ts';
import { apiFetch } from './core/api-fetch.ts';

interface MarketplaceBot {
  id: string;
  name: string;
  author?: string;
  avatar?: string;
  category?: string;
  description?: string;
  installs?: number;
  rating?: number;
  ratingCount?: number;
  commands?: string[];
  supportUrl?: string;
  sourceUrl?: string;
  verified?: boolean;
}

interface MarketplaceResponse {
  bots: MarketplaceBot[];
  total: number;
  limit: number;
  offset: number;
}

interface PluginSummary {
  id?: string;
  name?: string;
  description?: string;
  author?: string;
  version?: string;
}

(function () {
  const API = String((window as unknown as Record<string, unknown>).BRIDGE_API || location.origin);
  const PAGE_ACTIONS = new Set([
    'closeMktModal',
    'loadMarketplace',
    'rateMarketplaceBot',
    'showBotDetails',
    'showPluginDetails',
  ]);
  let cachedBots: MarketplaceBot[] = [];
  let cachedPlugins: PluginSummary[] = [];
  let modalTrap: ReturnType<typeof focusTrap> | null = null;

  async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
    const res = await apiFetch<T>(`${API}${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  function card(title: unknown, body: unknown, meta: unknown): string {
    return `<article class="card"><div style="font-weight:700;margin-bottom:6px">${esc(title)}</div><div class="muted">${esc(body || t('pmp_no_description', 'Açıklama yok'))}</div><div style="margin-top:8px;font-size:12px;color:var(--text-3)">${esc(meta || '')}</div></article>`;
  }

  function esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  }

  function safeExternalUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value || value === '#') return null;
    try {
      const parsed = new URL(value, location.origin);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function openModal(): void {
    const modal = document.getElementById('marketplace-modal') as HTMLElement | null;
    if (!modal) return;
    modal.style.display = 'flex';
    modalTrap?.destroy();
    modalTrap = focusTrap(modal, { active: true, initialFocus: '[data-bridge-action="closeMktModal"]' });
  }

  async function loadPlugins(q: string): Promise<void> {
    const el = document.getElementById('plugins');
    if (!el) return;
    el.innerHTML = `<div class="muted">${esc(t('loading', 'Yükleniyor…'))}</div>`;
    try {
      let list = await api<PluginSummary[]>('/api/plugins');
      if (!Array.isArray(list)) list = [];
      if (q) list = list.filter(p => `${p.name ?? ''} ${p.description ?? ''}`.toLowerCase().includes(q));
      cachedPlugins = list;
      el.innerHTML = list.length
        ? list.map((p, i) => `
          ${card(`🔌 ${p.name ?? 'Plugin'}`, p.description, `${p.author || 'unknown'} · v${p.version || '?'}`)}
          <div class="row" style="margin-top:-8px;margin-bottom:10px">
            <button class="btn" data-bridge-action="showPluginDetails" data-bridge-arg="${i}">${esc(t('markup_detaylar_2638108', 'Detaylar'))}</button>
          </div>
        `).join('')
        : `<div class="muted">${esc(t('pmp_no_plugins', 'Plugin bulunamadı.'))}</div>`;
    } catch {
      el.innerHTML = `<div class="muted">${esc(t('pmp_plugins_login_required', 'Plugin listesi için giriş yapman gerekiyor.'))}</div>`;
    }
  }

  async function loadBots(q: string): Promise<void> {
    const el = document.getElementById('bots');
    if (!el) return;
    el.innerHTML = `<div class="muted">${esc(t('loading', 'Yükleniyor…'))}</div>`;
    try {
      const params = new URLSearchParams({ limit: '60' });
      if (q) params.set('q', q);
      const data = await api<MarketplaceResponse>(`/api/bots/marketplace?${params}`);
      cachedBots = Array.isArray(data?.bots) ? data.bots : [];
      el.innerHTML = cachedBots.length
        ? cachedBots.map((b, i) => `
          <article class="card">
            <div style="font-weight:700;margin-bottom:6px">🤖 ${esc(b.name)}</div>
            <div class="muted">${esc(b.description || t('pmp_no_description', 'Açıklama yok'))}</div>
            <div class="row">
              <span class="pill">${esc(b.category || 'utility')}</span>
              <span class="pill">🌐 ${esc(t('pmp_install_count', '{count} kurulum', { count: Number(b.installs || 0).toLocaleString(localeTag()) }))}</span>
              <span class="pill">⭐ ${Number(b.rating || 0).toFixed(1)} (${Number(b.ratingCount || 0)})</span>
            </div>
            <div class="row">
              <button class="btn" data-bridge-action="showBotDetails" data-bridge-arg="${i}">${esc(t('markup_detaylar_2638108', 'Detaylar'))}</button>
            </div>
          </article>
        `).join('')
        : `<div class="muted">${esc(t('pmp_no_bots', 'Bot bulunamadı.'))}</div>`;
    } catch {
      el.innerHTML = `<div class="muted">${esc(t('pmp_bots_load_failed', 'Bot listesi yüklenemedi.'))}</div>`;
    }
  }

  BridgeRegistry.register('closeMktModal', function closeMktModal() {
    const el = document.getElementById('marketplace-modal');
    modalTrap?.destroy();
    modalTrap = null;
    if (el) el.style.display = 'none';
  });

  BridgeRegistry.register('showPluginDetails', function showPluginDetails(idx: unknown) {
    const p = cachedPlugins[Number(idx)];
    const box = document.getElementById('mkt-modal-content');
    if (!p || !box) return;
    box.innerHTML = `
      <h2>🔌 ${esc(p.name)}</h2>
      <p class="muted">${esc(p.description || t('pmp_no_description', 'Açıklama yok'))}</p>
      <div class="row">
        <span class="pill">${esc(t('pmp_author', 'Yazar: {author}', { author: String(p.author || t('pmp_unknown', 'bilinmiyor')) }))}</span>
        <span class="pill">${esc(t('pmp_version', 'Sürüm: {version}', { version: String(p.version || '?') }))}</span>
        <span class="pill">${esc(t('pmp_id', 'ID: {id}', { id: String(p.id || '-') }))}</span>
      </div>
      <p class="muted" style="margin-top:12px">${esc(t('pmp_plugin_discovery_note', 'Pluginler sunucu tarafında yüklü bileşenler olarak listelenir; bu ekran keşif içindir.'))}</p>
    `;
    openModal();
  });

  BridgeRegistry.register('showBotDetails', function showBotDetails(idx: unknown) {
    const b = cachedBots[Number(idx)];
    const box = document.getElementById('mkt-modal-content');
    if (!b || !box) return;
    const supportUrl = safeExternalUrl(b.supportUrl);
    const sourceUrl = safeExternalUrl(b.sourceUrl);
    box.innerHTML = `
      <h2>🤖 ${esc(b.name)}</h2>
      <p class="muted">${esc(b.description || t('pmp_no_description', 'Açıklama yok'))}</p>
      <div class="row">
        <span class="pill">${esc(t('pmp_category', 'Kategori: {category}', { category: String(b.category || 'utility') }))}</span>
        <span class="pill">${esc(t('pmp_command_count', 'Komut: {count}', { count: Array.isArray(b.commands) ? b.commands.length : 0 }))}</span>
        <span class="pill">${esc(t('pmp_rating', 'Puan: ⭐ {rating} ({count})', { rating: Number(b.rating || 0).toFixed(1), count: Number(b.ratingCount || 0) }))}</span>
      </div>
      <div class="row" style="margin-top:12px">
        <label style="font-size:13px;width:100%" for="mkt-rate-value">${esc(t('pmp_rate_label', 'Puan ver (1–5)'))}</label>
        <input id="mkt-rate-value" class="input-field field" type="number" min="1" max="5" step="1" value="5">
        <button class="btn btn-primary" data-bridge-action="rateMarketplaceBot" data-bridge-arg="${esc(b.id)}">${esc(t('pmp_rate_action', 'Puanla'))}</button>
        <p id="mkt-rate-status" class="muted" role="status" aria-live="polite" style="width:100%;margin:0"></p>
      </div>
      ${supportUrl ? `<p><a href="${esc(supportUrl)}" target="_blank" rel="noopener noreferrer">${esc(t('pmp_support', 'Destek'))}</a></p>` : ''}
      ${sourceUrl ? `<p><a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">${esc(t('pmp_source_code', 'Kaynak kodu'))}</a></p>` : ''}
      <p class="muted" style="margin-top:12px">${esc(t('pmp_bot_install_note', 'Bot kurulumu executable kimlik doğrulamasıyla desteklenir. Bir sunucuya kurmak veya kaldırmak için Bridge uygulamasında Bot Marketplace’i aç.'))}</p>
    `;
    openModal();
  });

  function setRatingStatus(message: string, kind: 'success' | 'error' = 'error'): void {
    const status = document.getElementById('mkt-rate-status');
    if (!status) return;
    status.textContent = message;
    status.dataset['status'] = kind;
  }

  BridgeRegistry.register('rateMarketplaceBot', async function rateMarketplaceBot(botId: unknown) {
    const input = document.getElementById('mkt-rate-value') as HTMLInputElement | null;
    const rating = input?.valueAsNumber;
    if (!Number.isSafeInteger(rating) || rating! < 1 || rating! > 5) {
      setRatingStatus(t('pmp_rate_range', 'Puan 1–5 arası tam sayı olmalı'));
      return;
    }

    setRatingStatus('');
    try {
      await api<MarketplaceBot>(`/api/bots/marketplace/${encodeURIComponent(String(botId))}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      setRatingStatus(t('pmp_rate_saved', 'Puanlama kaydedildi.'), 'success');
      await BridgeRegistry.call('loadMarketplace');
    } catch {
      // Ham fetch/HTTP hata metni kullanıcıya sızmaz. Teknik hata ağ katmanında
      // gözlenebilir; bu standalone sayfa ürün dilinde, yeniden denenebilir bir
      // durum gösterir.
      setRatingStatus(t('pmp_rate_failed', 'Puanlama başarısız. Tekrar deneyin.'));
    }
  });

  BridgeRegistry.register('loadMarketplace', async function loadMarketplace() {
    const q = (document.getElementById('q')?.value || '').trim().toLowerCase();
    await Promise.all([loadPlugins(q), loadBots(q)]);
  });

  document.getElementById('q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void BridgeRegistry.call('loadMarketplace');
  });

  // Unlike the authenticated app shell, this standalone page does not load
  // index.html's data-bridge-action dispatcher. Keep a deliberately small
  // allowlist here so every rendered control is reachable without globals or
  // inline script, while arbitrary catalog metadata cannot name an action.
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>('[data-bridge-action]');
    if (!control) return;
    const action = control.dataset['bridgeAction'];
    if (!action || !PAGE_ACTIONS.has(action)) return;
    event.preventDefault();
    const arg = control.dataset['bridgeArg'];
    if (arg === undefined) void BridgeRegistry.call(action);
    else void BridgeRegistry.call(action, arg);
  });

  document.getElementById('marketplace-modal')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) BridgeRegistry.call('closeMktModal');
  });

  document.addEventListener('keydown', (event) => {
    const modal = document.getElementById('marketplace-modal') as HTMLElement | null;
    if (event.key === 'Escape' && modal?.style.display === 'flex') {
      event.preventDefault();
      BridgeRegistry.call('closeMktModal');
    }
  });

  void BridgeRegistry.call('loadMarketplace');
})();
