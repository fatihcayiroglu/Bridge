<!-- client/js/core/ApiErrorToast.svelte -->
<!-- Sprint 116 — api-error-toast.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- API hata bildirimi -->
<!--
  Faz 8 (feature recovery): Bildirim (toast) sunucusu.

  KAYBOLAN DAVRANIŞ: `core/utils.ts` içindeki `toast()` istemcide 199 yerden
  çağrılıyor ama alıcı (`globalThis.toast`) hiçbir yerde tanımlı değildi →
  uygulamadaki TÜM kullanıcı bildirimleri sessizce yutuluyordu (yalnızca
  logger'a gidiyordu, production'da o da bastırılıyor).

  Bu bileşen alıcıyı geri getirir:
    - BridgeRegistry'ye 'toast' kaydeder (yeni window.* global YOK)
    - mevcut kabuk (#toast-container) ve mevcut CSS sınıfları (.toast/.success/
      .error) kullanılır — yeni tasarım dili tanımlanmadı
    - aynı mesajın kısa sürede tekrarı bastırılır (duplicate suppression)
    - otomatik kapanma + elle kapatma
    - unmount'ta tüm zamanlayıcılar temizlenir (leak yok)

  GÜVENLİK: mesajlar Svelte metin enterpolasyonu ile basılır (innerHTML/@html
  YOK). Uzun/teknik hata metinleri kırpılır; ham hata nesnesi gösterilmez.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ApiErrorToast');

  let { children }: { children?: Snippet } = $props();

  export type ToastType = 'info' | 'success' | 'warning' | 'error';

  interface ToastItem {
    id: number;
    message: string;
    type: ToastType;
    fading: boolean;
  }

  const DEFAULT_TIMEOUT_MS = 3000;
  const FADE_MS            = 500;
  /** Aynı mesaj bu süre içinde tekrar gelirse yeni toast açılmaz. */
  const DEDUPE_WINDOW_MS   = 1500;
  const MAX_VISIBLE        = 4;
  const MAX_LENGTH         = 200;
  const TOAST_ICONS: Record<ToastType, string> = {
    info: 'i',
    success: '✓',
    warning: '!',
    error: '×',
  };

  let toasts = $state<ToastItem[]>([]);

  let nextId = 1;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const recent = new Map<string, number>();

  function schedule(fn: () => void, ms: number): void {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  }

  function dismiss(id: number): void {
    const item = toasts.find(t => t.id === id);
    if (!item || item.fading) return;
    toasts = toasts.map(t => (t.id === id ? { ...t, fading: true } : t));
    schedule(() => { toasts = toasts.filter(t => t.id !== id); }, FADE_MS);
  }

  /** Bilinen tipler dışındaki değerler 'info' sayılır (legacy çağrılar '' geçiyor). */
  function normalizeType(value: unknown): ToastType {
    return value === 'success' || value === 'error' || value === 'warning' ? value : 'info';
  }

  function show(message: unknown, type?: unknown, timeoutMs?: unknown): void {
    const text = String(message ?? '').trim();
    if (!text) return;

    const safeText = text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
    const kind = normalizeType(type);
    const now = Date.now();

    // Duplicate bastırma — aynı mesaj+tip kısa aralıkta tekrarlanmasın.
    const key = `${kind}:${safeText}`;
    const last = recent.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    recent.set(key, now);

    const id = nextId++;
    toasts = [...toasts, { id, message: safeText, type: kind, fading: false }];

    // Ekranı boğmamak için en eskiler düşürülür.
    if (toasts.length > MAX_VISIBLE) {
      const fazla = toasts.slice(0, toasts.length - MAX_VISIBLE);
      fazla.forEach(t => dismiss(t.id));
    }

    const duration = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    schedule(() => dismiss(id), duration);
  }

  onMount(() => {
    // core/utils.ts toast() önce registry'ye bakar (yeni global üretilmez).
    BridgeRegistry.register('toast', (message: unknown, type?: unknown, timeoutMs?: unknown) => show(message, type, timeoutMs));
    BridgeRegistry.register('dismissToasts', () => { toasts = []; });
    log.info('Toast sunucusu hazır');
  });

  onDestroy(() => {
    timers.forEach(t => clearTimeout(t));
    timers.clear();
    recent.clear();
    toasts = [];
    BridgeRegistry.unregister('toast');
    BridgeRegistry.unregister('dismissToasts');
  });
</script>

{#each toasts as item (item.id)}
  <div
    class="toast {item.type}"
    class:fade-out={item.fading}
    data-toast-type={item.type}
    role={item.type === 'error' ? 'alert' : 'status'}
    aria-live={item.type === 'error' ? 'assertive' : 'polite'}
  >
    <span class="toast-icon" aria-hidden="true">{TOAST_ICONS[item.type]}</span>
    <span class="toast-text">{item.message}</span>
    <button type="button" class="toast-close" aria-label={t('attr_bildirimi_kapat_0192d8d', "Bildirimi kapat")} onclick={() => dismiss(item.id)}>×</button>
  </div>
{/each}

{@render children?.()}

<style>
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .toast-icon {
    display: grid;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    color: var(--toast-accent, var(--brand));
    font-size: var(--text-xs);
    font-weight: 800;
    line-height: 1;
    background: var(--toast-tint, var(--brand-bg));
    border: 1px solid currentColor;
    border-radius: var(--radius-pill);
    place-items: center;
  }

  .toast-text {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .toast-close {
    display: grid;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    padding: 0;
    color: var(--text-muted);
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    background: transparent;
    border: 0;
    border-radius: var(--radius-control);
    place-items: center;
  }

  .toast-close:hover { color: var(--text-primary); background: var(--bg-hover); }
  .toast-close:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }

  @media (prefers-reduced-motion: reduce) {
    .toast-close { transition: none; }
  }
</style>
