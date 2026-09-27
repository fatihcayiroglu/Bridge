<!-- client/js/core/ThemeManager.svelte -->
<!-- Sprint 116 stub → Tasarım Fazı 2: gerçek tema yönetimi -->
<!--
  KAYBOLAN DAVRANIŞ: Bu bileşen show/hide kaydından ibaret boş bir kabuktu.
  tokens.css beş temayı eksiksiz tanımlıyordu ama hiçbirine erişilemiyordu;
  index.html'deki tema düğmesi tanımsız `toggleTheme()` çağırıp her tıklamada
  ReferenceError fırlatıyordu.

  SORUMLULUK: yaşam döngüsü + registry sözleşmesi + mevcut #btn-theme
  düğmesine bağlanma. Tema mantığının kendisi theme-store.ts'tedir.

  UI KARARI: Yeni bir modal/seçici EKLENMEDİ. Mevcut arayüzde tek bir tema
  düğmesi var; sözleşmesi "tıkla → sonraki tema". Beş tema arasında döngü
  o düğmeye bağlandı. Erişilebilir ad her adımda güncellenir.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import {
    THEME_ICONS, THEME_LABEL_KEYS,
    applyTheme, currentTheme, getAvailableThemes, isTheme,
    nextTheme, resolveInitialTheme, writeStoredTheme, readStoredTheme,
    type ThemeId,
  } from './theme-store.js';

  const log = createLogger('ThemeManager');

  let { children }: { children?: Snippet } = $props();

  let theme = $state<ThemeId>('dark');
  let button: HTMLElement | null = null;
  let mediaQuery: MediaQueryList | null = null;

  /** Düğmenin simgesini ve erişilebilir adını aktif temaya göre günceller. */
  function syncButton(): void {
    if (!button) return;
    const label = t(THEME_LABEL_KEYS[theme]);
    const upcoming = t(THEME_LABEL_KEYS[nextTheme(theme)]);

    // `#btn-theme` owns its inline SVG. Replacing textContent here used to
    // destroy that icon on mount and silently re-introduce an emoji control.
    // Keep the visual child stable and expose the current theme as metadata.
    button.dataset.theme = theme;
    button.dataset.themeIcon = THEME_ICONS[theme];
    // Erişilebilir ad hem MEVCUT durumu hem de eylemin sonucunu söyler;
    // yalnız simge değişirse ekran okuyucu kullanıcısı ne olduğunu anlamaz.
    button.setAttribute('aria-label', t('theme_switch_aria', 'Tema: {current}. Değiştir (sıradaki: {next})', { current: label, next: upcoming }));
    button.setAttribute('title', t('theme_switch_aria', undefined, { current: label, next: upcoming }));
  }

  function setTheme(next: unknown): void {
    if (!isTheme(next)) { log.warn('Geçersiz tema yok sayıldı', next); return; }
    theme = next;
    applyTheme(next);
    writeStoredTheme(next);
    syncButton();
    // Diğer katmanlar (canvas, harici gömülüler) tepki verebilsin.
    document.dispatchEvent(new CustomEvent('bridge:theme-changed', { detail: { theme: next } }));
    log.info(`Tema: ${next}`);
  }

  function cycleTheme(): void { setTheme(nextTheme(theme)); }

  function onButtonClick(event: Event): void { event.preventDefault(); cycleTheme(); }

  /**
   * Kullanıcının AÇIK seçimi yoksa işletim sistemi tercihini izle.
   * Seçim yapıldığı anda bu dinleyici etkisiz kalır (readStoredTheme dolu).
   */
  function onSystemChange(): void {
    if (readStoredTheme()) return;
    const next = mediaQuery?.matches ? 'light' : 'dark';
    theme = next;
    applyTheme(next);
    syncButton();
  }

  onMount(() => {
    // İlk boyama script'i (index.html) temayı zaten uyguladı; buradaki okuma
    // yalnızca durumu senkronlar — yeniden uygulamak FOUC üretmez.
    theme = isTheme(currentTheme()) ? currentTheme() : resolveInitialTheme();
    applyTheme(theme);

    button = document.getElementById('btn-theme');
    button?.addEventListener('click', onButtonClick);
    syncButton();

    try {
      mediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: light)') ?? null;
      mediaQuery?.addEventListener('change', onSystemChange);
    } catch { /* matchMedia yoksa sistem takibi atlanır */ }

    BridgeRegistry.register('getTheme', () => theme);
    BridgeRegistry.register('setTheme', setTheme);
    BridgeRegistry.register('cycleTheme', cycleTheme);
    BridgeRegistry.register('getAvailableThemes', getAvailableThemes);

    log.info(`Tema yöneticisi hazır (${theme})`);
  });

  onDestroy(() => {
    button?.removeEventListener('click', onButtonClick);
    mediaQuery?.removeEventListener('change', onSystemChange);
    BridgeRegistry.unregister('getTheme');
    BridgeRegistry.unregister('setTheme');
    BridgeRegistry.unregister('cycleTheme');
    BridgeRegistry.unregister('getAvailableThemes');
  });
</script>

{@render children?.()}
