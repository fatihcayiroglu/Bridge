<!-- client/js/core/EmptyServerStart.svelte -->
<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('EmptyServerStart');

  type Mode = 'home' | 'create' | 'join' | 'qr';

  interface ServerRecord {
    _id: string;
    name?: string;
  }

  interface BarcodeResult {
    rawValue?: string;
  }

  interface BarcodeDetectorLike {
    detect(source: HTMLVideoElement): Promise<BarcodeResult[]>;
  }

  type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

  let isVisible = $state(false);
  let isLoading = $state(false);
  let isSubmitting = $state(false);
  let mode = $state<Mode>('home');
  let errorMessage = $state('');
  let statusMessage = $state('');

  let serverName = $state('');
  let serverIcon = $state('🌐');
  let inviteInput = $state('');

  let videoEl: HTMLVideoElement | undefined = $state();
  let mediaStream: MediaStream | null = null;
  let scanTimer: number | null = null;
  let isScanning = $state(false);
  let cameraMessage = $state('');

  let csrfToken: string | null = null;

  function getToken(): string | null {
    try {
      return window.localStorage.getItem('token');
    } catch {
      return null;
    }
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const token = getToken();
    if (!token) throw new Error('Oturum bulunamadı. Lütfen yeniden giriş yap.');

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    return fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });
  }

  async function getCsrfToken(): Promise<string | null> {
    if (csrfToken) return csrfToken;

    try {
      const response = await request('/api/auth/csrf-token');
      if (!response.ok) return null;

      const data = await response.json() as { token?: unknown };
      csrfToken = typeof data.token === 'string' ? data.token : null;
      return csrfToken;
    } catch {
      return null;
    }
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    const csrf = await getCsrfToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (csrf) headers['X-CSRF-Token'] = csrf;

    return request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  async function responseError(response: Response): Promise<string> {
    try {
      const data = await response.json() as { error?: unknown };
      if (typeof data.error === 'string' && data.error.trim()) return data.error;
    } catch {
      // Response may be empty or non-JSON.
    }

    return `İstek başarısız oldu (${response.status}).`;
  }

  async function refreshEmptyState(): Promise<void> {
    const token = getToken();
    if (!token) {
      isVisible = false;
      return;
    }

    isLoading = true;
    errorMessage = '';

    try {
      const response = await request('/api/servers');

      if (response.status === 401) {
        isVisible = false;
        return;
      }

      if (!response.ok) throw new Error(await responseError(response));

      const servers = await response.json() as ServerRecord[];
      isVisible = Array.isArray(servers) && servers.length === 0;

      if (isVisible) {
        mode = 'home';
        statusMessage = '';
      }
    } catch (error) {
      errorMessage = error instanceof Error
        ? error.message
        : 'Sunucu listen yüklenemedi.';
      isVisible = true;
    } finally {
      isLoading = false;
    }
  }

  function extractInviteCode(value: string): string {
    const trimmed = value.trim();

    const inviteUrl = trimmed.match(/(?:bridge:\/\/invite\/|\/invite\/)([A-Za-z0-9_-]{1,64})/i);
    if (inviteUrl?.[1]) return inviteUrl[1];

    return trimmed.replace(/[^\w-]/g, '').slice(0, 64);
  }

  function selectMode(nextMode: Mode): void {
    errorMessage = '';
    statusMessage = '';

    if (mode === 'qr' && nextMode !== 'qr') stopQrScanner();
    mode = nextMode;

    if (nextMode === 'qr') void startQrScanner();
  }

  async function createServer(): Promise<void> {
    const name = serverName.trim();

    if (!name) {
      errorMessage = 'Sunucuna bir ad ver.';
      return;
    }

    isSubmitting = true;
    errorMessage = '';

    try {
      const response = await postJson('/api/servers', {
        name,
        icon: serverIcon.trim() || '🌐',
      });

      if (!response.ok) throw new Error(await responseError(response));

      statusMessage = 'Sunucun oluşturuldu. Açılıyor…';
      window.location.reload();
    } catch (error) {
      errorMessage = error instanceof Error
        ? error.message
        : 'Sunucu oluşturulamadı.';
    } finally {
      isSubmitting = false;
    }
  }

  async function joinByInvite(value = inviteInput): Promise<void> {
    const code = extractInviteCode(value);

    if (!code) {
      errorMessage = 'Geçerli bir davet kodu veya davet bağlantısı gir.';
      return;
    }

    isSubmitting = true;
    errorMessage = '';

    try {
      const response = await postJson(`/api/servers/invites/${encodeURIComponent(code)}/use`, {});

      if (!response.ok) throw new Error(await responseError(response));

      stopQrScanner();
      statusMessage = 'Sunucuya katıldın. Açılıyor…';
      window.location.reload();
    } catch (error) {
      errorMessage = error instanceof Error
        ? error.message
        : 'Sunucuya katılınamadı.';
    } finally {
      isSubmitting = false;
    }
  }

  function stopQrScanner(): void {
    isScanning = false;

    if (scanTimer !== null) {
      window.clearTimeout(scanTimer);
      scanTimer = null;
    }

    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;

    if (videoEl) videoEl.srcObject = null;
  }

  async function startQrScanner(): Promise<void> {
    stopQrScanner();
    cameraMessage = '';
    await tick();

    const Detector = (globalThis as unknown as {
      BarcodeDetector?: BarcodeDetectorCtor;
    }).BarcodeDetector;

    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      cameraMessage = 'Bu cihazda kamera ile QR tarama desteklenmiyor. Davet kodunu aşağıya yapıştırabilirsin.';
      return;
    }

    if (!videoEl) {
      cameraMessage = 'Kamera görünümü hazırlanamadı. Davet kodunu yapıştırabilirsin.';
      return;
    }

    try {
      const detector = new Detector({ formats: ['qr_code'] });

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });

      videoEl.srcObject = mediaStream;
      await videoEl.play();
      isScanning = true;

      const scanFrame = async (): Promise<void> => {
        if (!isScanning || !videoEl) return;

        try {
          const results = await detector.detect(videoEl);
          const value = results.find((result) => result.rawValue?.trim())?.rawValue;

          if (value) {
            stopQrScanner();
            inviteInput = value;
            mode = 'join';
            await joinByInvite(value);
            return;
          }
        } catch (error) {
          log.warn('QR scan frame failed', error);
        }

        if (isScanning) scanTimer = window.setTimeout(() => void scanFrame(), 250);
      };

      void scanFrame();
    } catch (error) {
      cameraMessage = error instanceof Error
        ? `Kamera açılamadı: ${error.message}`
        : 'Kamera açılamadı. Davet kodunu yapıştırabilirsin.';
      stopQrScanner();
    }
  }

  onMount(() => {
    BridgeRegistry.register('checkEmptyServerStart', refreshEmptyState);
    void refreshEmptyState();
  });

  onDestroy(() => {
    stopQrScanner();
    BridgeRegistry.unregister?.('checkEmptyServerStart');
  });
</script>

{#if isVisible}
  <div class="empty-server-backdrop" role="dialog" aria-modal="true" aria-label="Bridge başlangıç ekranı">
    <section class="empty-server-card">
      <div class="brand">🌉</div>

      {#if isLoading}
        <h1>Sunucuların kontrol ediliyor…</h1>
        <p>Bridge toplulukların hazırlanıyor.</p>
      {:else if mode === 'home'}
        <h1>Henüz bir sunucun yok</h1>
        <p class="intro">
          Kendi topluluğunu oluştur veya bir arkadaşının davetiyle mevcut bir sunucuya katıl.
        </p>

        <div class="actions">
          <button class="primary" onclick={() => selectMode('create')}>
            <span>＋</span>
            Sunucu Oluştur
          </button>
          <button class="secondary" onclick={() => selectMode('join')}>
            <span>🔗</span>
            Davet Koduyla Katıl
          </button>
          <button class="secondary" onclick={() => selectMode('qr')}>
            <span>▣</span>
            QR Kod Tara
          </button>
        </div>
      {:else if mode === 'create'}
        <button class="back" onclick={() => selectMode('home')}>← Geri</button>
        <h1>Sunucunu oluştur</h1>
        <p class="intro">İlk olarak adını ve ikonunu belirle. Sonra kanal, rol ve davetlerini yönetebilirsin.</p>

        <label for="new-server-name">Sunucu adı</label>
        <input
          id="new-server-name"
          bind:value={serverName}
          maxlength="50"
          placeholder="Örn. Oyun Ekibi"
          onkeydown={(event) => { if (event.key === 'Enter') void createServer(); }}
        />

        <label for="new-server-icon">İkon</label>
        <input
          id="new-server-icon"
          class="icon-input"
          bind:value={serverIcon}
          maxlength="10"
          placeholder="🌐"
        />

        <button class="primary" disabled={isSubmitting} onclick={() => void createServer()}>
          {isSubmitting ? 'Oluşturuluyor…' : 'Sunucu Oluştur'}
        </button>
      {:else if mode === 'join'}
        <button class="back" onclick={() => selectMode('home')}>← Geri</button>
        <h1>Sunucuya katıl</h1>
        <p class="intro">Davet kodunu veya tam davet bağlantısını yapıştır.</p>

        <label for="invite-code">Davet kodu</label>
        <input
          id="invite-code"
          bind:value={inviteInput}
          maxlength="512"
          placeholder="örn. a1b2c3d4 veya https://…/invite/a1b2c3d4"
          onkeydown={(event) => { if (event.key === 'Enter') void joinByInvite(); }}
        />

        <button class="primary" disabled={isSubmitting} onclick={() => void joinByInvite()}>
          {isSubmitting ? 'Katılınıyor…' : 'Sunucuya Katıl'}
        </button>

        <button class="text-action" onclick={() => selectMode('qr')}>Bunun yerine QR kod tara</button>
      {:else}
        <button class="back" onclick={() => selectMode('home')}>← Geri</button>
        <h1>QR kod tara</h1>
        <p class="intro">Arkadaşının Bridge davet QR kodunu kameraya göster.</p>

        <video class="scanner" bind:this={videoEl} autoplay muted playsinline></video>

        {#if cameraMessage}
          <p class="camera-message">{cameraMessage}</p>
        {:else if isScanning}
          <p class="camera-message">Kamera açık. QR kodu çerçeveye getir.</p>
        {/if}

        <button class="secondary" onclick={() => selectMode('join')}>
          Davet kodunu yapıştır
        </button>
      {/if}

      {#if errorMessage}
        <p class="message error" role="alert">{errorMessage}</p>
      {/if}

      {#if statusMessage}
        <p class="message success" role="status">{statusMessage}</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .empty-server-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(7, 9, 15, .82);
    backdrop-filter: blur(8px);
  }

  .empty-server-card {
    width: min(100%, 460px);
    padding: 34px;
    border: 1px solid rgba(126, 156, 255, .24);
    border-radius: 20px;
    background: linear-gradient(145deg, #1d2336, #131722);
    color: #f7f8ff;
    box-shadow: 0 26px 90px rgba(0, 0, 0, .55);
  }

  .brand {
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    margin-bottom: 18px;
    border-radius: 18px;
    background: rgba(95, 132, 255, .18);
    font-size: 28px;
  }

  h1 {
    margin: 0 0 10px;
    font-size: 26px;
    line-height: 1.15;
  }

  .intro {
    margin: 0 0 24px;
    color: #b8bfd1;
    line-height: 1.55;
  }

  .actions {
    display: grid;
    gap: 12px;
  }

  button {
    min-height: 46px;
    border: 0;
    border-radius: 11px;
    padding: 11px 14px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: .65;
  }

  .primary {
    width: 100%;
    color: #fff;
    background: #5865f2;
  }

  .primary:hover:not(:disabled) {
    background: #6975f7;
  }

  .secondary {
    width: 100%;
    color: #eef1ff;
    background: #2a3146;
  }

  .secondary:hover {
    background: #36405b;
  }

  .back,
  .text-action {
    min-height: auto;
    padding: 0;
    color: #aebcff;
    background: transparent;
    text-align: left;
  }

  .text-action {
    display: block;
    width: 100%;
    margin-top: 14px;
    text-align: center;
  }

  label {
    display: block;
    margin: 14px 0 7px;
    color: #dce1f5;
    font-size: 14px;
    font-weight: 700;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    min-height: 45px;
    margin-bottom: 4px;
    border: 1px solid #3d4762;
    border-radius: 10px;
    padding: 10px 12px;
    outline: none;
    background: #0f1420;
    color: #fff;
    font: inherit;
  }

  input:focus {
    border-color: #7c8aff;
    box-shadow: 0 0 0 3px rgba(88, 101, 242, .2);
  }

  .icon-input {
    max-width: 100px;
  }

  .scanner {
    width: 100%;
    min-height: 210px;
    margin: 0 0 12px;
    border-radius: 13px;
    background: #080b11;
    object-fit: cover;
  }

  .camera-message,
  .message {
    margin: 14px 0 0;
    text-align: center;
    line-height: 1.45;
  }

  .camera-message {
    color: #b8bfd1;
  }

  .message.error {
    color: #ff9d9d;
  }

  .message.success {
    color: #96ecb3;
  }
</style>
