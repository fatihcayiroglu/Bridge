<!-- client/js/core/VoicePTTController.svelte -->
<!-- Sprint 119 Refactor: PTT mantığı VoicePanel.svelte'den ayrıldı (~150 satır tasarruf) -->
<!-- VoicePanel bu bileşeni bind: ile bağlar; PTT state ve event'ları buraya taşındı. -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createLogger } from './logger.js';
  import {
    loadPttSettings, savePttSettings, PTT_CHANGED_EVENT, type PTTSettings,
  } from './voice/ptt-settings.ts';

  const log = createLogger('VoicePTTController');

  // ── Tipler ──────────────────────────────────────────────────────────────────
  interface PTTKey {
    code: string;
    label: string;
  }

  interface PTTStatus {
    enabled: boolean;
    mode: 'hold' | 'toggle';
    key: PTTKey | null;
    releaseDelay: number;
    active: boolean;
  }

  // ── Props ────────────────────────────────────────────────────────────────────
  interface Props {
    /** RTC adaptörüne erişim — VoicePanel'den geçirilir */
    getRtc: () => { isInVoice(): boolean; setMuted(m: boolean): void } | null;
    /** PTT durumu değiştiğinde ebeveyne bildir */
    onStatusChange?: (s: PTTStatus) => void;
  }

  let { getRtc, onStatusChange }: Props = $props();

  // ── State ────────────────────────────────────────────────────────────────────
  let status = $state<PTTStatus>({
    enabled: false,
    mode: 'hold',
    key: null,
    releaseDelay: 200,
    active: false,
  });

  let capturing = $state(false);

  let _releaseTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Dahili yardımcılar ───────────────────────────────────────────────────────
  /**
   * TEK bildirim yolu.
   *
   * Eskiden yalnizca `setEnabled` `onStatusChange` cagiriyordu; `setMode`,
   * `clearKey`, `setReleaseDelay` ve tus yakalama SESSIZCE degisiyordu. Bir
   * ayar arayuzu bu yuzden BAYAT durum gosterirdi (ozellikle yeni baglanan
   * tusu hic gormezdi).
   *
   * DOM olayi gereklidir: ayarlar paneli VoicePanel'in bilesen agacinda
   * DEGILDIR, dolayisiyla `onStatusChange` oraya ulasmaz. Ikinci bir PTT
   * sahibi YARATILMAZ — olay yalnizca "yeniden oku" sinyalidir.
   */
  function _notify(): void {
    onStatusChange?.(status);
    document.dispatchEvent(new CustomEvent(PTT_CHANGED_EVENT));
  }

  function _unmute(): void {
    const r = getRtc();
    if (!r?.isInVoice()) return;
    r.setMuted(false);
    status = { ...status, active: true };
    _notify();
  }

  function _mute(): void {
    const r = getRtc();
    if (!r?.isInVoice()) return;
    r.setMuted(true);
    status = { ...status, active: false };
    _notify();
  }

  function _scheduleRelease(delay: number): void {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    if (delay <= 0) { _mute(); return; }
    _releaseTimer = setTimeout(_mute, delay);
  }

  // ── Klavye olay işleyicileri ─────────────────────────────────────────────────
  function _onKeyDown(e: KeyboardEvent): void {
    if (!status.enabled || !status.key || e.code !== status.key.code) return;
    // TUS TEKRARI: tusu basili tutmak isletim sistemi tarafindan tekrarlanan
    // `keydown` uretir. `hold` modu `status.active` ile korunuyordu ama
    // `toggle` modu KORUNMUYORDU: basili tutmak sesi surekli acip kapatiyordu.
    if (e.repeat) return;
    // Input/textarea içindeyken PTT tetiklenmesin
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      (document.activeElement as HTMLElement)?.isContentEditable
    ) return;
    e.preventDefault();
    if (status.mode === 'hold') {
      // ── BEKLEYEN SUSTURMA HER DURUMDA İPTAL EDİLİR ────────────────────────
      // `releaseDelay`, tuş bırakıldıktan sonra mikrofonu bir süre daha açık
      // tutar (kelime sonlarının kesilmemesi için). Kullanıcı o pencere
      // içinde tuşa TEKRAR basarsa hâlâ konuşuyordur.
      //
      // İptal eskiden `status.active` kontrolünden SONRA geliyordu; oysa
      // gecikme boyunca `active` HÂLÂ true'dur. Bu yüzden yeniden basış erken
      // dönüyor, zamanlayıcı iptal edilmiyor ve mikrofon TUŞ BASILIYKEN
      // kapanıyordu. Sonraki `keydown` de işletim sistemi tekrarı olduğu için
      // yok sayılıyor; kullanıcı tuşu bırakana kadar sessiz kalıyordu.
      if (_releaseTimer) { clearTimeout(_releaseTimer); _releaseTimer = null; }
      if (status.active) return;
      _unmute();
    } else {
      if (status.active) _scheduleRelease(0);
      else _unmute();
    }
  }

  function _onKeyUp(e: KeyboardEvent): void {
    if (!status.enabled || !status.key || status.mode !== 'hold') return;
    if (e.code !== status.key.code) return;
    e.preventDefault();
    _scheduleRelease(status.releaseDelay);
  }

  // ── Persist ──────────────────────────────────────────────────────────────────
  // Kalicilik sahibi `voice/ptt-settings.ts`tir. Ayarlar arayuzu bu bilesen
  // MOUNT EDILMEMISKEN de yazabilsin diye ayrildi (VoicePanel yalnizca ses
  // sahnesi acildiginda mount edilir). Ikinci bir depo YOK — ayni anahtar.
  function _load(): void {
    const d = loadPttSettings();
    status = { ...d, active: false };
  }

  function _save(): void {
    const persisted: PTTSettings = {
      enabled: status.enabled, mode: status.mode,
      key: status.key, releaseDelay: status.releaseDelay,
    };
    // `savePttSettings` degisiklik olayini KENDISI yayar; `_notify` yalnizca
    // ebeveyni gunceller. Cift yayin zararsizdir (yeniden okuma tetikler).
    savePttSettings(persisted);
  }

  /**
   * DISARIDAN (ayarlar arayuzu) yapilan degisikligi al.
   *
   * Denetleyici mount edildikten SONRA kullanici Ayarlar'da tusu degistirirse
   * bu bilesen bayat kalmamalidir.
   */
  function _onExternalChange(): void {
    const d = loadPttSettings();
    const changed = d.enabled !== status.enabled || d.mode !== status.mode
      || d.key?.code !== status.key?.code || d.releaseDelay !== status.releaseDelay;
    if (!changed) return;
    // Yayin yapmadan uygula: aksi halde olay dongusu olusur.
    if (!d.enabled && status.active) _mute();
    status = { ...status, ...d };
    onStatusChange?.(status);
  }

  // ── Public API (VoicePanel'den çağrılır) ─────────────────────────────────────
  export function setEnabled(on: boolean): void {
    if (!on && status.active) _mute();
    status = { ...status, enabled: on };
    // ══════════════════════════════════════════════════════════════════════
    // KAPATILAN GERÇEK KUSUR — PTT AÇIKKEN MİKROFON AÇIK KALIYORDU
    // ══════════════════════════════════════════════════════════════════════
    // Bas-konuş açıldığında hiçbir susturma yapılmıyordu. Kullanıcı
    // "yalnızca tuşa bastığımda duyuluyorum" sanırken mikrofon AÇIK kalıyor
    // ve ilk basma/bırakma döngüsüne kadar HER ŞEY yayınlanıyordu.
    //
    // ÖLÇÜM: PTT açık ve tuşa hiç basılmamışken giden track `enabled = true`.
    //
    // Bu yalnızca bir kullanım hatası değil, GİZLİLİK sorunudur.
    //
    // SIRA ÖNEMLİ: önce KALICI YAZ, sonra sustur. `_mute()` içindeki
    // `_notify()` `bridge:ptt-changed` yayar; kalıcı kayıt henüz eski değeri
    // taşıyorsa `_onExternalChange` bayat depodan okuyup `enabled` bayrağını
    // GERİ ALIR. (Mevcut regresyon testi bunu yakaladı: `enabled` false kaldı.)
    _save();
    if (on) _mute();
    onStatusChange?.(status);
    log.debug({ ptt: 'enabled', on });
  }

  /**
   * Sese KATILIRKEN bas-konuş açıksa mikrofon kapalı başlar.
   *
   * `setEnabled` yalnızca ayar DEĞİŞTİĞİ anda çalışır ve `_mute()` seste
   * değilken hiçbir şey yapmaz. Kullanıcı bas-konuşu aramaya girmeden ÖNCE
   * yapılandırırsa (ki artık ayarlardan mümkün) katılım açık mikrofonla
   * başlardı. Kanonik `bridge:voice-joined` olayı dinlenir — yeni bir olay
   * icat edilmez.
   */
  function _onVoiceJoined(): void {
    if (!status.enabled || status.active) return;
    _mute();
  }

  export function setMode(m: 'hold' | 'toggle'): void {
    if (status.active && m === 'hold') _mute();
    status = { ...status, mode: m };
    _save();
    _notify();
  }

  export function setReleaseDelay(ms: number): void {
    status = { ...status, releaseDelay: ms };
    _save();
    _notify();
  }

  export function clearKey(): void {
    if (status.active) _mute();
    status = { ...status, key: null };
    _save();
    _notify();
  }

  export function getStatus(): PTTStatus {
    return { ...status };
  }

  /** Arayuz "tusa basin" durumunu gosterebilsin diye. */
  export function isCapturing(): boolean { return capturing; }

  // ── Tuş yakalama (capture mode) ──────────────────────────────────────────────
  function _buildLabel(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey  && !['ControlLeft',  'ControlRight' ].includes(e.code)) parts.push('Ctrl');
    if (e.altKey   && !['AltLeft',      'AltRight'     ].includes(e.code)) parts.push('Alt');
    if (e.shiftKey && !['ShiftLeft',    'ShiftRight'   ].includes(e.code)) parts.push('Shift');
    if (e.metaKey  && !['MetaLeft',     'MetaRight'    ].includes(e.code)) parts.push('Meta');
    const mods = ['ControlLeft','ControlRight','AltLeft','AltRight',
                  'ShiftLeft','ShiftRight','MetaLeft','MetaRight'];
    if (!mods.includes(e.code)) {
      parts.push(e.key === ' ' ? 'Space' : (e.key?.length === 1 ? e.key.toUpperCase() : e.key));
    }
    return parts.join('+') || e.code;
  }

  function _captureHandler(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { stopCapture(); return; }
    status = { ...status, key: { code: e.code, label: _buildLabel(e) } };
    _save();
    stopCapture();
    _notify();
  }

  export function startCapture(): void {
    if (capturing) return;
    capturing = true;
    document.addEventListener('keydown', _captureHandler as EventListener, true);
    _notify();
    log.debug({ ptt: 'capture', state: 'start' });
  }

  export function stopCapture(): void {
    document.removeEventListener('keydown', _captureHandler as EventListener, true);
    capturing = false;
    _notify();
    log.debug({ ptt: 'capture', state: 'stop' });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    _load();
    document.addEventListener('keydown', _onKeyDown);
    document.addEventListener('keyup',   _onKeyUp);
    document.addEventListener(PTT_CHANGED_EVENT, _onExternalChange);
    document.addEventListener('bridge:voice-joined', _onVoiceJoined);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', _onKeyDown);
    document.removeEventListener('keyup',   _onKeyUp);
    document.removeEventListener(PTT_CHANGED_EVENT, _onExternalChange);
    document.removeEventListener('bridge:voice-joined', _onVoiceJoined);
    stopCapture();
    if (_releaseTimer) clearTimeout(_releaseTimer);
  });
</script>
