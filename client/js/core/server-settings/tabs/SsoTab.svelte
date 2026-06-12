<!-- client/js/core/server-settings/tabs/SsoTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openSSOSettings → Svelte 5 Runes      -->
<script lang="ts">
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';

  interface SsoCfg {
    oidc?: { enabled?: boolean };
    saml?: { enabled?: boolean };
    metadataUrl?: string;
  }

  const API = getAPI();

  let cfg     = $state<SsoCfg>({});
  let loading = $state(true);

  $effect(() => {
    apiFetch(`${API}/api/sso/config`)
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((data: SsoCfg) => { cfg = data; })
      .finally(() => { loading = false; });
  });
</script>

<div class="sso-tab">
  {#if loading}
    <div class="sso-loading">Yükleniyor…</div>
  {:else}
    <!-- Status -->
    <div class="sso-card">
      <div class="sso-section-title">Durum</div>
      <div class="sso-status-row">
        <div><b>OIDC:</b> {cfg.oidc?.enabled ? '✅ Aktif' : '⛔ Pasif'}</div>
        <div><b>SAML:</b> {cfg.saml?.enabled ? '✅ Aktif' : '⛔ Pasif'}</div>
      </div>
    </div>

    <!-- OIDC -->
    <div class="sso-card">
      <div class="sso-section-title">OIDC (OpenID Connect)</div>
      <p class="sso-hint">.env dosyasına şunları ekleyin:</p>
      <pre class="sso-pre">OIDC_ENABLED=true
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_SCOPES=openid email profile</pre>
      <p class="sso-hint" style="margin-top: 8px;">
        Giriş URL: <code class="sso-code">/api/sso/oidc/start</code>
      </p>
    </div>

    <!-- SAML -->
    <div class="sso-card">
      <div class="sso-section-title">SAML 2.0</div>
      <p class="sso-hint">.env dosyasına şunları ekleyin:</p>
      <pre class="sso-pre">SAML_ENABLED=true
SAML_ENTRY_POINT=https://idp.example.com/sso/saml
SAML_ISSUER=https://bridge.example.com</pre>
      {#if cfg.metadataUrl}
        <p class="sso-hint" style="margin-top: 8px;">
          SP Metadata:
          <a href={cfg.metadataUrl} target="_blank" rel="noopener" class="sso-link">
            {cfg.metadataUrl}
          </a>
        </p>
      {/if}
    </div>

    <div class="sso-info">
      💡 SSO ile giriş yapan kullanıcılar şifre olmadan hesap oluşturur.
      E-posta eşleşmesi ile mevcut hesaplara SSO bağlanır.
    </div>
  {/if}
</div>

<style>
  .sso-loading { color: var(--text-muted); padding: 16px 0; font-size: 13px; }
  .sso-card {
    background: var(--bg-1);
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .sso-section-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .sso-status-row    { display: flex; gap: 16px; }
  .sso-hint          { font-size: 12px; color: var(--text-muted); margin: 0 0 6px; }
  .sso-pre {
    background: var(--bg-3);
    padding: 10px;
    border-radius: 8px;
    font-size: 11px;
    overflow-x: auto;
    margin: 0;
    white-space: pre;
  }
  .sso-code {
    background: var(--bg-3);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
  }
  .sso-link  { color: var(--brand, #5865f2); }
  .sso-info {
    background: var(--bg-3);
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
</style>
