<!-- client/js/core/ChannelStagePanel.svelte -->
<!-- Sprint 116 stub → Faz 8.3: kanal sahne yönlendiricisi (stage router) -->
<!--
  ROL: Seçili kanalın TÜRÜNE göre ana içerik alanında hangi sahnenin
  görüneceğine karar verir ve metin dışı durumlar için dürüst bir ekran çizer.

  BU BİLEŞEN "GOD COMPONENT" DEĞİLDİR. Yapmadıkları:
    - mesaj çekmez            → MessageLoader
    - mesaj çizmez            → MessageListPanel
    - composer yönetmez       → MessageInputPanel
    - socket join/leave yapmaz→ MessageLoader / SocketManager
    - taslak tutmaz           → DraftManager
  Yalnızca "hangi sahne görünür" sorusunu ve o sahnenin boş/hata/izin
  durumlarını sahiplenir.

  KAYBOLAN DAVRANIŞ (ölçüldü): Ses kanalı seçildiğinde `#text-view` gizlenip
  `#voice-view` gösteriliyordu, ancak voice-view'in RENDER YÜKSEKLİĞİ 0px'ti →
  kullanıcı bomboş bir ana alan görüyordu. Hangi kanalda olduğu, neden boş
  olduğu ve ne yapabileceği hiçbir yerde yazmıyordu.

  SAHİPLİK DÜZELTMESİ: Görünüm geçişi önce ChannelListManager.selectChannel()
  içindeydi — liste bileşeni yönlendirme yapıyordu. Yönlendirme buraya alındı;
  liste yalnızca seçim yapar.
-->
<script lang="ts">
  import { t } from "./i18n/reactive.svelte.ts";
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import StageSessionPanel from './StageSessionPanel.svelte';
  import ForumChannelPanel from './ForumChannelPanel.svelte';

  const log = createLogger('ChannelStage');

  let { children }: { children?: Snippet } = $props();

  interface StageChannel { _id: string; name?: string; type?: string }

  /**
   * Ürün gerçeği (Faz 8.3 yeniden doğrulandı): canlı REST router'ları
   * `text`, `voice`, `announcement`, `stage`, `forum` tiplerini saklayabiliyor;
   * `stage` artık voice ile aynı medya oturumuna zorlanmaz. P2 StageSessionPanel
   * server-authoritative roster/role/hand-raise kontrol düzlemini sahiplenir;
   * doğrulanmamış SFU medyası ise burada varmış gibi gösterilmez.
   */
  type StageKind = 'none' | 'text' | 'voice' | 'stage' | 'forum' | 'unsupported';

  let kind = $state<StageKind>('none');
  let channelId = $state('');
  let channelName = $state('');
  let channelType = $state('');
  /**
   * Ses yığını gerçekten yüklü mü? `webrtc.ts` class'ı ayrı kaydetse de canlı
   * sözleşme yalnız `BridgeRegistry('rtc')` içindeki INSTANCE'tır. Instance ve
   * browser sınırları hazırsa sahneyi gerçek VoicePanel çizer; aksi halde
   * dürüst unavailable durumu gösterilir.
   */
  let voiceStackReady = $state(false);

  function detectVoiceStack(): boolean {
    // Yalnız canonical INSTANCE geçerlidir. `BridgeRTC` anahtarı class object
    // tutar; onu hazır saymak class-vs-instance sessiz no-op bug'ını geri getirir.
    if (!BridgeRegistry.has('rtc')) return false;
    // Tarayıcı yeteneği: güvenli olmayan bağlamda getUserMedia/RTCPeerConnection yoktur.
    return typeof RTCPeerConnection === 'function'
      && typeof navigator?.mediaDevices?.getUserMedia === 'function';
  }

  function classify(channel: StageChannel | null): StageKind {
    if (!channel?._id) return 'none';
    const type = String(channel.type ?? 'text').toLowerCase();
    if (type === 'text' || type === 'announcement') return 'text';
    if (type === 'voice') return 'voice';
    if (type === 'stage') return 'stage';
    if (type === 'forum') return 'forum';
    return 'unsupported';
  }

  /**
   * Sahneyi seçili kanala göre günceller.
   * `#text-view` / `#voice-view` mevcut kabuktur; yeni kapsayıcı üretilmez.
   */
  function syncStage(): void {
    const channel = BridgeRegistry.get<() => StageChannel | null>('getCurrentChannel')?.() ?? null;
    kind = classify(channel);
    voiceStackReady = detectVoiceStack();
    channelId = channel?._id ?? '';
    channelName = channel?.name ?? '';
    channelType = String(channel?.type ?? '');

    const textView = document.getElementById('text-view');
    const voiceView = document.getElementById('voice-view');
    const voicePanel = document.getElementById('voice-panel');
    // Kanal yokken de metin sahnesi görünür kalır: karşılama ekranı orada.
    const showText = kind === 'text' || kind === 'none';
    if (textView) textView.style.display = showText ? 'flex' : 'none';
    if (voiceView) voiceView.style.display = showText ? 'none' : 'flex';
    // Unsupported/unavailable durumunda VoicePanel kontrolleri dürüst durum
    // mesajının yanında görünmez; tek gerçek panel unmount edilmeden saklanır.
    if (voicePanel) voicePanel.style.display = kind === 'voice' && voiceStackReady ? 'flex' : 'none';

    log.info(`Sahne: ${kind}${channelName ? ` (#${channelName})` : ''}`);
  }

  /**
   * Ses oturumu geçişi — legacy sözleşme (channel-list.ts:102 ve :174):
   *   voice kanal seçilir  → rtc.joinVoice(channelId, serverId)
   *   text kanala geçilir   → rtc.leaveVoice()  (yalnız içerideyken)
   *
   * WebRTC yeniden yazılmadı; mevcut BridgeRTC sahiplenildi. İkinci bir
   * socket mimarisi kurulmadı — join/leave sinyalleşmesi webrtc.ts'in
   * kendi `voice:join` / `voice:leave` sözleşmesinden geçer.
   */
  interface RtcApi {
    isInVoice?(): boolean;
    currentChannelId?: string;
    joinVoice?(channelId: string, serverId: string): Promise<void>;
    leaveVoice?(): void;
  }
  /**
   * ÖNEMLİ — sıra: önce `rtc` (ÖRNEK), sonra yok.
   * `BridgeRTC` anahtarı SINIFIN KENDİSİNİ tutar (webrtc.ts:634, geriye dönük
   * uyumluluk). Sınıf truthy olduğu için `get('BridgeRTC') ?? get('rtc')`
   * yazmak örneği hiçbir zaman göremez ve prototip metotları `undefined`
   * kalır → `?.` ile sessiz no-op. `globals.ts:getRtc()` de aynı sırayı
   * kullanır. Buraya `BridgeRTC` fallback'i KOYULMAZ.
   */
  function rtc(): RtcApi | null {
    return BridgeRegistry.get<RtcApi>('rtc') as RtcApi | null;
  }

  /** Aynı anda tek join; hızlı seçimlerde son istek kazanır. */
  let joiningChannelId: string | null = null;
  let desiredVoiceChannel: StageChannel | null = null;

  async function syncVoiceSession(): Promise<void> {
    const api = rtc();
    if (!api) return;

    // getUserMedia uçuşta iken ikinci join/leave başlatma. İlk join bitince
    // aşağıdaki finally son seçime uzlaştırır; böylece A→text/voice-B geçişi
    // stale server membership veya paralel MediaStream bırakmaz.
    if (joiningChannelId) return;

    const channel = desiredVoiceChannel;
    const wantVoice = Boolean(channel?._id);
    const inVoice = Boolean(api.isInVoice?.());

    // Metin kanalına geçildi ve hâlâ seste → ayrıl.
    if (!wantVoice) {
      if (inVoice) { try { api.leaveVoice?.(); } catch (err) { log.warn('leaveVoice hatası', err); } }
      joiningChannelId = null;
      return;
    }

    const channelId = channel!._id;
    // Zaten bu kanaldayız veya katılım uçuşta → tekrar deneme.
    if ((inVoice && api.currentChannelId === channelId) || joiningChannelId === channelId) return;

    // Başka bir ses kanalındaydık → önce temiz çıkış.
    if (inVoice) { try { api.leaveVoice?.(); } catch (err) { log.warn('leaveVoice hatası', err); } }

    const serverId = BridgeRegistry.get<() => { _id?: string } | null>('getCurrentServer')?.()?._id;
    if (!serverId) return;

    joiningChannelId = channelId;
    let joined = false;
    try {
      await api.joinVoice?.(channelId, serverId);
      // `joinVoice` intentionally returns without throwing when a disconnect
      // cancels an in-flight permission prompt.  Read the production owner
      // back instead of treating promise resolution as proof of membership;
      // otherwise a late getUserMedia result could resurrect "joined" UI
      // after RTC has already cleaned the socket session.
      joined = Boolean(api.isInVoice?.() && api.currentChannelId === channelId);
      // Uçuş sırasında seçim değişmediyse kullanıcıya joined duyurulur.
      if (joined && desiredVoiceChannel?._id === channelId) {
        // Kanal ADI da tasinir: kabuktaki "ses bagli" seridi hangi kanalda
        // oldugunu gosterir. Ikinci bir kanal deposu KURULMAZ — ad zaten
        // burada, kanonik secim anindadir.
        document.dispatchEvent(new CustomEvent('bridge:voice-joined', {
          detail: { channelId, channelName: channel!.name ?? '' },
        }));
      }
    } catch (err) {
      // Mikrofon reddi / cihaz yok / güvensiz bağlam. Kullanıcı sonsuz
      // "katılıyor" durumunda ASILI KALMAZ; güvenli metin gösterilir.
      const info = err as { name?: string; max?: number };
      const name = info?.name ?? '';
      const message = name === 'NotAllowedError' || name === 'SecurityError'
        ? t("ui_mikrofon_izni_verilmedi_sesli_kanala_katilinamadi", "Mikrofon izni verilmedi — sesli kanala katılınamadı.")
        : name === 'NotFoundError'
          ? t("ui_mikrofon_bulunamadi_sesli_kanala_katilinamadi", "Mikrofon bulunamadı — sesli kanala katılınamadı.")
          : name === 'VoiceChannelFullError'
            ? (Number.isFinite(info.max)
              ? t('voice_channel_full_max', 'Ses kanalı dolu — en fazla {max} kişi.', { max: Number(info.max) })
              : t('voice_channel_full', 'Ses kanalı dolu.'))
            : name === 'VoiceJoinForbiddenError'
              ? t("ui_bu_ses_kanalina_katilma_yetkin_yok", "Bu ses kanalına katılma yetkin yok.")
              : t("ui_sesli_kanala_katilinamadi", "Sesli kanala katılınamadı.");
      BridgeRegistry.get<(m: string, t?: string) => void>('toast')?.(message, 'error');
      log.warn('joinVoice başarısız', { name });
    } finally {
      joiningChannelId = null;
      // Join tamamlandığında istek artık bayatsa önce gerçek oturumu temizle,
      // sonra en son seçimi seri biçimde uygula.
      const selectionChanged = desiredVoiceChannel?._id !== channelId;
      if (!joined || selectionChanged) {
        if (api.isInVoice?.() || api.currentChannelId === channelId) {
          try { api.leaveVoice?.(); } catch (err) { log.warn('stale join cleanup hatası', err); }
        }
        // Aynı seçimin gerçek join hatasını sonsuz otomatik retry etme;
        // yalnız uçuş sırasında gelen YENİ seçimi uygula.
        if (selectionChanged && desiredVoiceChannel?._id) void syncVoiceSession();
      }
    }
  }

  function onChannelSelected(): void {
    syncStage();
    const channel = BridgeRegistry.get<() => StageChannel | null>('getCurrentChannel')?.() ?? null;
    desiredVoiceChannel = kind === 'voice' && channel?._id && voiceStackReady ? channel : null;
    void syncVoiceSession();
  }

  /**
   * Çıkışta seçili kanal özel durumdur ve aktif ses oturumu kapatılmalıdır.
   * Auth sahibi kullanıcı/sunucu/mesaj state'ini ayrı ayrı temizler; bu bileşen
   * yalnız kendi stage + voice yaşam döngüsünü sahiplenir.
   */
  function onAuthLogout(): void {
    desiredVoiceChannel = null;
    void syncVoiceSession();
    kind = 'none';
    channelId = '';
    channelName = '';
    channelType = '';
    const textView = document.getElementById('text-view');
    const voiceView = document.getElementById('voice-view');
    const voicePanel = document.getElementById('voice-panel');
    if (textView) textView.style.display = 'flex';
    if (voiceView) voiceView.style.display = 'none';
    if (voicePanel) voicePanel.style.display = 'none';
  }

  onMount(() => {
    document.addEventListener('bridge:channel-selected', onChannelSelected);
    document.addEventListener('bridge:auth-logout', onAuthLogout);
    BridgeRegistry.register('getStageKind', () => kind);
    BridgeRegistry.register('syncChannelStage', syncStage);
    syncStage();
  });

  onDestroy(() => {
    document.removeEventListener('bridge:channel-selected', onChannelSelected);
    document.removeEventListener('bridge:auth-logout', onAuthLogout);
    desiredVoiceChannel = null;
    void syncVoiceSession();
    BridgeRegistry.unregister('getStageKind');
    BridgeRegistry.unregister('syncChannelStage');
  });
</script>

<StageSessionPanel active={kind === 'stage'} {channelId} {channelName} />
<ForumChannelPanel active={kind === 'forum'} {channelId} {channelName} />

{#if kind === 'voice' && !voiceStackReady}
  <!-- Ses yığını GERÇEKTEN yoksa dürüst durum. Yığın yüklüyse bu blok hiç
       çizilmez; sahneyi VoicePanel.svelte devralır (aynı #voice-view kabuğu). -->
  <section class="stage-state" aria-labelledby="stage-state-title">
    <span class="stage-state__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M4 13h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 1-2ZM20 13h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-2Z"/><path d="m5 5 14 14"/></svg>
    </span>
    <h2 class="stage-state__title" id="stage-state-title">
      {channelName ? `#${channelName}` : t("surface_sesli_kanal_f5cbe6")}
    </h2>
    <p class="stage-state__body">
      {t('markup_sesli_sohbet_bu_tarayicida_kullanilamiyor_guvenl_dc608e6', "Sesli sohbet bu tarayıcıda kullanılamıyor. Güvenli bir bağlantı (HTTPS) ve mikrofon desteği gerekiyor.")}
    </p>
  </section>
{:else if kind === 'unsupported'}
  <section class="stage-state" aria-labelledby="stage-state-title">
    <span class="stage-state__icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 2-2.4 2.1-2.4 4M12 18h.01"/></svg>
    </span>
    <h2 class="stage-state__title" id="stage-state-title">
      {channelName ? `#${channelName}` : t("ui_kanal")}
    </h2>
    <p class="stage-state__body">
      {t("ui_channel_type_unsupported", undefined, { type: channelType || t("ui_unknown") })}
    </p>
  </section>
{/if}

{@render children?.()}

<style>
  /* Tasarım Fazı 2 token sistemi — yeni ham renk/boyut/yarıçap üretilmedi. */
  .stage-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    flex: 1;
    min-height: 0;
    padding: var(--space-8) var(--space-6);
    text-align: center;
    color: var(--text-2);
  }
  .stage-state__icon { width: 34px; height: 34px; opacity: .8; }
  .stage-state__icon svg { display: block; width: 100%; height: 100%; }
  .stage-state__title {
    margin: 0;
    font-size: var(--type-title);
    font-weight: 600;
    color: var(--text-primary);
  }
  .stage-state__body {
    margin: 0;
    max-width: 42ch;
    font-size: var(--type-body);
    line-height: 1.5;
    color: var(--text-muted);
  }
</style>
