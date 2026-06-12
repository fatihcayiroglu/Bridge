<!-- client/js/core/VoicePTTController.svelte -->
<!-- Sprint 119 Refactor: PTT mantığı VoicePanel.svelte'den ayrıldı (~150 satır tasarruf) -->
<!-- VoicePanel bu bileşeni bind: ile bağlar; PTT state ve event'ları buraya taşındı. -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createLogger } from './logger.js';

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
  function _unmute(): void {
    const r = getRtc();
    if (!r?.isInVoice()) return;
    r.setMuted(false);
    status = { ...status, active: true };
    onStatusChange?.(status);
  }

  function _mute(): void {
    const r = getRtc();
    if (!r?.isInVoice()) return;
    r.setMuted(true);
    status = { ...status, active: false };
    onStatusChange?.(status);
  }

  function _scheduleRelease(delay: number): void {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    if (delay <= 0) { _mute(); return; }
    _releaseTimer = setTimeout(_mute, delay);
  }

  // ── Klavye olay işleyicileri ─────────────────────────────────────────────────
  function _onKeyDown(e: KeyboardEvent): void {
    if (!status.enabled || !status.key || e.code !== status.key.code) return;
    // Input/textarea içindeyken PTT tetiklenmesin
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      (document.activeElement as HTMLElement)?.isContentEditable
    ) return;
    e.preventDefault();
    if (status.mode === 'hold') {
      if (status.active) return;
      if (_releaseTimer) clearTimeout(_releaseTimer);
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
  function _load(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const d = JSON.parse(localStorage.getItem('bridgePTT') ?? '{}') as Partial<PTTStatus>;
      status = {
        enabled:      d.enabled      ?? false,
        mode:         d.mode         ?? 'hold',
        key:          d.key          ?? null,
        releaseDelay: d.releaseDelay ?? 200,
        active:       false,
      };
    } catch { /* corrupt storage — ignore */ }
  }

  function _save(): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem('bridgePTT', JSON.stringify(status)); }
    catch { /* ignore */ }
  }

  // ── Public API (VoicePanel'den çağrılır) ─────────────────────────────────────
  export function setEnabled(on: boolean): void {
    if (!on && status.active) _mute();
    status = { ...status, enabled: on };
    _save();
    onStatusChange?.(status);
    log.debug({ ptt: 'enabled', on });
  }

  export function setMode(m: 'hold' | 'toggle'): void {
    if (status.active && m === 'hold') _mute();
    status = { ...status, mode: m };
    _save();
  }

  export function setReleaseDelay(ms: number): void {
    status = { ...status, releaseDelay: ms };
    _save();
  }

  export function clearKey(): void {
    if (status.active) _mute();
    status = { ...status, key: null };
    _save();
  }

  export function getStatus(): PTTStatus {
    return { ...status };
  }

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
  }

  export function startCapture(): void {
    if (capturing) return;
    capturing = true;
    document.addEventListener('keydown', _captureHandler as EventListener, true);
    log.debug({ ptt: 'capture', state: 'start' });
  }

  export function stopCapture(): void {
    document.removeEventListener('keydown', _captureHandler as EventListener, true);
    capturing = false;
    log.debug({ ptt: 'capture', state: 'stop' });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    _load();
    document.addEventListener('keydown', _onKeyDown);
    document.addEventListener('keyup',   _onKeyUp);
  });

  onDestroy(() => {
    document.removeEventListener('keydown', _onKeyDown);
    document.removeEventListener('keyup',   _onKeyUp);
    stopCapture();
    if (_releaseTimer) clearTimeout(_releaseTimer);
  });
</script>
