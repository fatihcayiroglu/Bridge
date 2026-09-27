<!-- client/js/core/MessageActionSheet.svelte -->
<!--
  MOBİL MESAJ EYLEM SAYFASI

  ══════════════════════════════════════════════════════════════════════════
  KAPATILAN GERÇEK KUSUR
  ══════════════════════════════════════════════════════════════════════════
  Dokunmatikte hover olmadığı için masaüstü eylem çubuğu her mesajda KALICI
  görünüyor ve `position: static` ile mesajın YANINDA yer kaplıyordu.

  ÖLÇÜM (412px telefon): 6 ikon, genişliğin ~%45'ini alıyor; metin satır
  başına üç kelimeye düşüyordu — sohbet okunaksızdı.

  Denenip REDDEDİLEN iki yol:
    · `position: absolute` → metin tam genişliği geri aldı ama çubuk mesaj
      METNİNİN ÜZERİNE bindi. Gizlenen metin, sıkışmış metinden kötüdür.
    · Eylemleri gizlemek → mesajlar için bağlam menüsü YOK; çubuk bu
      eylemlerin TEK erişim yoluydu. Gizlemek onları erişilemez yapardı.

  ÇÖZÜM: uzun basınca açılan bir eylem sayfası. Mesaj gövdesi tam genişliği
  geri alır, eylemler TALEP ÜZERİNE gelir.

  ── TASARIM KARARLARI ────────────────────────────────────────────────────
  · İş mantığı BURADA DEĞİL: eylemler dışarıdan `actions` olarak verilir ve
    masaüstü çubuğuyla AYNI kanonik işleyicileri/izin koşullarını taşır.
    Bu bileşen yetki kararı VERMEZ; yalnızca verilen eylemleri gösterir.
  · Kanonik primitifler kullanılır: `focusTrap` (odak tuzağı + odak iadesi),
    `role="menu"`, Escape, scrim tıklaması.
  · Katman kanonik jetondandır — sihirli z-index YOK.
  · Metinler i18n'den gelir.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { clampFloatingRect } from './floating-position.ts';
  import { t } from './i18n/reactive.svelte.ts';

  export interface SheetAction {
    id: string;
    /** Görünen etiket — çağıran taraf i18n'den çözer. */
    label: string;
    /** Yıkıcı eylem (silme) görsel olarak ayrışır. */
    danger?: boolean;
    run: () => void;
  }

  let {
    open = false,
    actions = [] as SheetAction[],
    /** Seçili mesajın kısa önizlemesi — kullanıcı neyi işlediğini görsün. */
    preview = '',
    /**
     * Final21 UX — masaüstü sağ tık: verilirse yüzey alttan açılan sayfa DEĞİL,
     * imlecin yanında görünen kompakt bir menüdür (görünür alana sıkıştırılır).
     * Uzun basmada null kalır; dokunmatik davranış değişmez.
     */
    anchor = null as { x: number; y: number } | null,
    onClose,
  }: {
    open?: boolean;
    actions?: SheetAction[];
    preview?: string;
    anchor?: { x: number; y: number } | null;
    onClose?: () => void;
  } = $props();

  let sheetEl = $state<HTMLDivElement | null>(null);
  let menuPos = $state<{ left: number; top: number } | null>(null);

  // Menü önce görünmez ölçülür, sonra imlecin yanına yerleştirilir. Platform
  // bağlam menüleri gibi: altta yer yoksa imlecin ÜSTÜNE (alt kenarı imleçte),
  // sağda yer yoksa SOLUNA açılır. Yalnız ekrana sığdırmak (kaydırmak) alt
  // kenardaki mesajda menüyü imlecin üzerine getiriyordu: imleç "Düzenle/Sil"
  // üstünde kalıyor, aynı noktaya bir sonraki tıklama o öğeyi çalıştırıyordu.
  // Her iki yöne de sığmayan çok küçük ekranda son güvence yine sığdırmadır.
  $effect(() => {
    if (!open || !anchor) { menuPos = null; return; }
    const point = anchor;
    void tick().then(() => {
      if (!sheetEl) return;
      const r = sheetEl.getBoundingClientRect();
      const view = window.visualViewport;
      const right = (view?.offsetLeft ?? 0) + (view?.width ?? window.innerWidth) - 8;
      const bottom = (view?.offsetTop ?? 0) + (view?.height ?? window.innerHeight) - 8;
      const left = point.x + r.width > right ? point.x - r.width : point.x;
      const top = point.y + r.height > bottom ? point.y - r.height : point.y;
      menuPos = clampFloatingRect({ left, top, width: r.width, height: r.height, margin: 8 });
    });
  });

  function close(): void { onClose?.(); }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    // role="menu" sözleşmesi: ok tuşları öğeler arasında gezer (Tab da çalışır).
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sheetEl) {
      const items = [...sheetEl.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    }
  }

  // Final21 UX — uzun basmanın PARMAK KALDIRMA tıklaması. Sayfa uzun basma sırasında açılır;
  // parmak kalktığında tarayıcının ürettiği tıklama, parmağın altına kayan öğeye düşüyordu
  // (ölçüldü: 768 ve 390 px dokunmatik profilde "Sil"/menü öğesi kendiliğinden tetiklendi;
  // parmak sayfanın üstündeyse aynı tıklama örtüye düşüp sayfayı ANINDA kapatıyordu). Son
  // mesajlar ekranın altındadır, alttan açılan sayfa da tam oraya gelir. İşaretçi tıklaması
  // yalnız işaretçi AYNI hedefte basılı başladıysa sayılır; klavye etkinleştirmesi (detail 0)
  // her zaman sayılır.
  let pressedOn: EventTarget | null = null;
  function armPress(e: PointerEvent): void { pressedOn = e.currentTarget; }
  function isDeliberate(e: MouseEvent): boolean {
    const ok = e.detail === 0 || pressedOn === e.currentTarget;
    pressedOn = null;
    return ok;
  }

  function activate(action: SheetAction): void {
    // Önce kapat, sonra çalıştır: eylem bir modal açarsa (düzenle/sil onayı)
    // iki örtü üst üste binmesin.
    close();
    action.run();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="mas-scrim"
    class:anchored={!!anchor}
    role="presentation"
    oncontextmenu={(e) => { e.preventDefault(); close(); }}
    onpointerdown={armPress}
    onclick={(e) => { if (e.target === e.currentTarget && isDeliberate(e)) close(); }}
  ></div>

  <div
    class="mas-sheet"
    class:anchored={!!anchor}
    bind:this={sheetEl}
    style={anchor ? (menuPos ? `left:${menuPos.left}px;top:${menuPos.top}px` : `left:${anchor.x}px;top:${anchor.y}px;opacity:0`) : undefined}
    role="menu"
    tabindex="-1"
    aria-label={t('msg_actions_sheet', 'Mesaj eylemleri')}
    use:focusTrap={{ initialFocus: '[role="menuitem"]' }}
  >
    {#if !anchor}
      <span class="mas-grip" aria-hidden="true"></span>
    {/if}

    {#if preview && !anchor}
      <p class="mas-preview" title={preview}>{preview}</p>
    {/if}

    {#each actions as action (action.id)}
      <button
        type="button"
        role="menuitem"
        class="mas-item"
        class:danger={action.danger}
        onpointerdown={armPress}
        onclick={(e) => { if (isDeliberate(e)) activate(action); }}
      >
        {action.label}
      </button>
    {/each}

    <!-- Masaüstü menüsünde "İptal" gereksiz: dışarı tıklama ve Esc kapatır. -->
    {#if !anchor}
      <button type="button" class="mas-item mas-cancel" role="menuitem" onpointerdown={armPress} onclick={(e) => { if (isDeliberate(e)) close(); }}>
        {t('cancel', 'İptal')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .mas-scrim {
    position: fixed;
    inset: 0;
    /* Kanonik katman — sihirli sayi YOK. */
    z-index: var(--z-modal);
    background: color-mix(in srgb, var(--bg-0) 62%, transparent);
  }

  .mas-sheet {
    position: fixed;
    inset: auto 0 0 0;
    z-index: var(--z-modal);
    display: grid;
    gap: 2px;
    max-height: 70vh;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
    border-radius: var(--radius-modal) var(--radius-modal) 0 0;
    background: var(--surface-1);
    box-shadow: var(--elevation-modal);
  }

  /* Tutamaç: alttan açılan yüzey olduğunu anlatır. */
  .mas-grip {
    justify-self: center;
    width: 36px;
    height: 4px;
    margin: 2px 0 6px;
    border-radius: var(--radius-pill);
    background: var(--border-strong);
  }

  .mas-preview {
    margin: 0 0 6px;
    padding: 0 12px 8px;
    overflow: hidden;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-muted);
    font-size: var(--text-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mas-item {
    /* Dokunma hedefi projenin mobil erişilebilirlik sözleşmesini karşılar. */
    min-height: 48px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .mas-item:hover,
  .mas-item:focus-visible { background: var(--surface-hover); }
  .mas-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }

  /* Yıkıcı eylem RENKTEN başka işaret de taşır: ayrı bir bölümde durur. */
  .mas-item.danger { color: var(--danger); }
  .mas-cancel {
    margin-top: 4px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-muted);
    font-weight: 500;
  }

  /* Masaüstü bağlam menüsü: saydam örtü (yalnız dışarı tıklamayı yakalar), imleç
     noktasında kompakt liste — alttan açılan sayfanın görsel ağırlığı yok. */
  .mas-scrim.anchored { background: transparent; }
  .mas-sheet.anchored {
    inset: auto;
    width: max-content;
    min-width: 200px;
    max-width: min(280px, calc(100vw - 16px));
    max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - 16px);
    padding: 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }
  .mas-sheet.anchored .mas-item { min-height: 32px; padding: 0 10px; font-weight: 500; }
  .mas-sheet.anchored .mas-item.danger { margin-top: 4px; }

  @media (prefers-reduced-motion: no-preference) {
    .mas-sheet { animation: mas-rise var(--duration-fast) var(--ease-out); }
    @keyframes mas-rise { from { transform: translateY(8px); opacity: .85; } }
  }
</style>
