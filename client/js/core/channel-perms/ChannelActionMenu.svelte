<!-- client/js/core/channel-perms/ChannelActionMenu.svelte -->
<!--
  FAZ C2 — KANAL EYLEM MENÜSÜ (kanal izinleri açıcısı).

  ════════════════════════════════════════════════════════════════════════════
  NEDEN VAR
  ════════════════════════════════════════════════════════════════════════════
  `ChannelItem.svelte:66` üç nokta butonunu YALNIZCA `onOpenMenu` verilmişse
  render eder ve `ChannelListManager.svelte:85` bunu `openChannelMenu` registry
  sahibi VARSA bağlar. O kayıt hiç yapılmamıştı → buton hiç görünmüyordu ve
  kanal izinleri yüzeyi ürüne bağlanamıyordu. Bu bileşen o TEK sahibi kurar.

  KAPSAM DÜRÜSTLÜĞÜ: menü yalnız ÇALIŞAN eylemi taşır. Yeniden adlandır / sil /
  taşı gibi maddeler burada YOKTUR — bunların istemci sahibi yoktur ve ölü
  kontrol göstermek yalan olurdu.

  YETKİ: kanal izinleri arka uçta MANAGE_CHANNELS ister
  (`routes/channelPerms/overrides.ts` — her rotada `resolvePermissions(u, sid)`).
  Aynı bit burada da aranır; KANITLANAMIYORSA madde GÖSTERİLMEZ (fail-closed).
  Bu bir yetki sınırı değil, yanıltıcı kontrol göstermeme kararıdır.

  BAĞLAM YAKALAMA (§13): menü açılırken `serverId` ve `channelId` O ANDA
  yakalanır ve kontrolcüye AYNEN geçirilir. Editör açıldıktan sonra "şu an
  hangi kanal seçili?" diye SORULMAZ — kullanıcı başka kanala geçse bile
  düzenleme açıldığı kanala aittir (kontrolcüdeki bayatlık kapısı da yazmayı
  ayrıca engeller).
-->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry } from '../bridge-registry.js';
  import { createLogger } from '../logger.js';
  import { clampFloatingRect } from '../floating-position.ts';
  import { canManageChannels, clearPermsCache } from '../permissions/myPermissions.ts';
  import { createChannelPermsController, type PermState } from './channelPermsStore.ts';
  import ChannelPermsEditor from './ChannelPermsEditor.svelte';

  const log = createLogger('ChannelActionMenu');

  interface CurrentServer { _id?: string; id?: string }

  // ── Menü durumu ────────────────────────────────────────────────────────────
  let menuOpen    = $state(false);
  let menuX       = $state(0);
  let menuY       = $state(0);
  // `bind:this` bu degiskeni YAZAR; duz bir `let` Svelte 5'te reaktif
  // degildir, yani menuye bagli her turetme bayat kalirdi.
  let menuEl = $state<HTMLElement | null>(null);
  let canManage   = $state(false);

  // Açılışta YAKALANAN bağlam. Sonradan yeniden çözülmez.
  let ctxServerId   = $state('');
  let ctxChannelId  = $state('');
  let ctxChannelName = $state('');

  // ── Editör durumu ──────────────────────────────────────────────────────────
  type Controller = ReturnType<typeof createChannelPermsController>;
  let controller: Controller | null = null;
  let editorOpen = $state(false);
  let version    = $state(0);          // kontrolcü düz nesnedir; render tetikleyicisi

  function snap() {
    void version;                       // reaktif bağımlılık
    return controller?.snapshot ?? null;
  }

  const roles          = $derived(snap()?.roles ?? []);
  const selectedRoleId = $derived(snap()?.selectedRoleId ?? '');
  const loading        = $derived(snap()?.loading ?? false);
  const saving         = $derived(snap()?.saving ?? false);
  const dirty          = $derived(snap()?.dirty ?? false);
  const error          = $derived(snap()?.error ?? null);
  const explanationLoading = $derived(snap()?.explanationLoading ?? false);
  const explanationError = $derived(snap()?.explanationError ?? null);
  const explanation = $derived(snap()?.explanation ?? null);
  const rolePreviewLoading = $derived(snap()?.rolePreviewLoading ?? false);
  const rolePreviewError = $derived(snap()?.rolePreviewError ?? null);
  const rolePreview = $derived(snap()?.rolePreview ?? null);

  function bump(): void { version += 1; }

  // Açılış yarışı koruması: yetki sorgusu ASENKRONDUR. Kullanıcı kanal X'e,
  // hemen ardından kanal Y'ye tıklarsa X'in geç dönen yanıtı menüyü Y'nin
  // bağlamıyla açabilirdi. Yalnız EN SON istek menüyü açabilir.
  let openSeq = 0;

  // ── Menü açma (registry sahibi) ────────────────────────────────────────────
  async function openMenu(channelId: string, name: string, event: MouseEvent): Promise<void> {
    const server = BridgeRegistry.call<CurrentServer | null>('getCurrentServer') ?? null;
    const sid = String(server?._id ?? server?.id ?? '');
    const cid = String(channelId ?? '');

    // Bağlam çözülemiyorsa menü AÇILMAZ — boş kimlikle istek üretme.
    if (!sid || !cid) {
      openSeq += 1;
      canManage = false;
      closeMenu();
      if (editorOpen) closeEditor();
      ctxServerId = '';
      ctxChannelId = '';
      ctxChannelName = '';
      return;
    }

    const seq = ++openSeq;

    // Önceki menü, yeni bağlamın asenkron yetki kanıtı gelene kadar görünür
    // kalamaz. Aksi halde eski menü düğmesi yeni ctx* değerleriyle editörü
    // yetki denetimi tamamlanmadan açabilirdi.
    canManage = false;
    closeMenu();

    ctxServerId    = sid;
    ctxChannelId   = cid;
    ctxChannelName = String(name ?? '');

    menuX = Math.round(event.clientX);
    menuY = Math.round(event.clientY);

    // Yetki kanıtlanana kadar menü maddesi gösterilmez.
    const allowed = await canManageChannels(sid);

    // Bu istek aşıldıysa (yeni tıklama ya da sunucu değişimi) HİÇBİR ŞEY yapma.
    if (seq !== openSeq) return;

    canManage = allowed;
    if (!canManage) return;             // gösterilecek çalışan eylem yok

    // Final21 UX: Esc ile kapanınca odak menüyü açan düğmeye döner (klavye kullanıcısı
    // kanal listesinde yerini kaybetmez; diğer tüm menülerle aynı sözleşme).
    menuReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuOpen = true;
    await tick();
    if (menuEl) {
      const rect = menuEl.getBoundingClientRect();
      const point = clampFloatingRect({ left: menuX, top: menuY, width: rect.width, height: rect.height, margin: 8 });
      menuX = Math.round(point.left);
      menuY = Math.round(point.top);
      await tick();
    }
    menuEl?.querySelector<HTMLButtonElement>('.cam-item')?.focus();
  }

  let menuReturnFocus: HTMLElement | null = null;
  function closeMenu(restoreFocus = false): void {
    menuOpen = false;
    const target = menuReturnFocus;
    menuReturnFocus = null;
    if (restoreFocus && target?.isConnected) target.focus();
  }

  async function openCurrentChannelPerms(): Promise<void> {
    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    const channel = BridgeRegistry.call<{ _id?: string } | null>('getCurrentChannel');
    const sid = typeof server?._id === 'string' ? server._id : '';
    const cid = typeof channel?._id === 'string' ? channel._id : '';
    if (!sid || !cid || !(await canManageChannels(sid))) return;
    ctxServerId = sid;
    ctxChannelId = cid;
    await openPerms();
  }

  // ── Editör açma ────────────────────────────────────────────────────────────
  async function openPerms(): Promise<void> {
    if (!ctxServerId || !ctxChannelId) return;
    menuOpen = false;

    // Yakalanan bağlam AYNEN geçirilir.
    controller = createChannelPermsController(ctxServerId, ctxChannelId);
    editorOpen = true;
    bump();

    await controller.load();
    bump();
  }

  function closeEditor(): void {
    editorOpen = false;
    controller = null;
    bump();
  }

  // ── Editör köprüleri ───────────────────────────────────────────────────────
  const stateOf = (roleId: string, bit: number): PermState =>
    controller?.stateOf(roleId, bit) ?? 'inherit';

  function onSelectRole(roleId: string): void { controller?.selectRole(roleId); bump(); }
  function onSetState(roleId: string, bit: number, state: PermState): void {
    controller?.setState(roleId, bit, state);
    bump();
  }
  function onReset(): void { controller?.reset(); bump(); }
  async function onExplain(): Promise<void> {
    if (!controller) return;
    await controller.loadExplanation();
    bump();
  }
  async function onPreviewRole(roleId: string): Promise<void> {
    if (!controller) return;
    await controller.loadRolePreview(roleId);
    bump();
  }
  async function onSave(): Promise<void> {
    if (!controller) return;
    const ok = await controller.save();
    bump();
    if (ok) closeEditor();              // yalnız GERÇEK başarıda kapanır
  }

  // ── Yaşam döngüsü ──────────────────────────────────────────────────────────
  /**
   * Sunucu/oturum değişimi (`bridge:load-channels` YALNIZ sunucu seçiminde
   * yayılır — ServerSwitcher.svelte:98).
   *
   * Yetki önbelleği bayat kalmamalı; ayrıca AÇIK EDİTÖR de kapatılır: bağlam
   * değiştikten sonra kontrolcünün bayatlık kapısı kaydetmeyi zaten reddeder,
   * bu yüzden editörü açık bırakmak kullanıcıya kaydedilebilirmiş izlenimi
   * veren BAYAT bir yüzey olurdu. `openSeq` artırılır ki uçuşta olan bir
   * yetki sorgusu menüyü sonradan açamasın.
   */
  const onContextChange = () => {
    openSeq += 1;
    clearPermsCache();
    canManage = false;
    closeMenu();
    if (editorOpen) closeEditor();
  };

  function onDocPointer(e: MouseEvent): void {
    if (!menuOpen) return;
    if ((e.target as HTMLElement | null)?.closest('.cam-menu')) return;
    closeMenu();
  }
  function onDocKey(e: KeyboardEvent): void {
    if (menuOpen && e.key === 'Escape') closeMenu(true);
  }

  onMount(() => {
    BridgeRegistry.register('openChannelMenu', openMenu);
    BridgeRegistry.register('openCurrentChannelPermissions', openCurrentChannelPerms);
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('bridge:load-channels', onContextChange);
    document.addEventListener('bridge:auth-success', onContextChange);
    document.addEventListener('bridge:auth-logout', onContextChange);
    log.info('Kanal eylem menüsü bağlandı');
  });

  onDestroy(() => {
    BridgeRegistry.unregister('openChannelMenu');
    BridgeRegistry.unregister('openCurrentChannelPermissions');
    document.removeEventListener('mousedown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey);
    document.removeEventListener('bridge:load-channels', onContextChange);
    document.removeEventListener('bridge:auth-success', onContextChange);
    document.removeEventListener('bridge:auth-logout', onContextChange);
  });
</script>

{#if menuOpen && canManage}
  <div class="cam-menu" role="menu" aria-label={t('cli_channel_actions', 'Kanal işlemleri')}
       bind:this={menuEl}
       style={`left:${menuX}px; top:${menuY}px`}>
    <button type="button" class="cam-item" role="menuitem" onclick={openPerms}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="10.5" width="16" height="9.5" rx="2"/>
        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>
      </svg>
      <span>{t('cam_channel_perms', 'Kanal İzinleri')}</span>
    </button>
  </div>
{/if}

{#if editorOpen}
  <ChannelPermsEditor
    channelName={ctxChannelName}
    {roles}
    {selectedRoleId}
    {loading}
    {saving}
    {dirty}
    {error}
    {explanationLoading}
    {explanationError}
    {explanation}
    {rolePreviewLoading}
    {rolePreviewError}
    {rolePreview}
    {stateOf}
    {onSelectRole}
    {onSetState}
    {onSave}
    {onReset}
    {onExplain}
    {onPreviewRole}
    onClose={closeEditor}
  />
{/if}

<style>
  .cam-menu {
    position: fixed; z-index: 1200; min-width: 190px;
    padding: 4px; display: flex; flex-direction: column; gap: 2px;
    background: var(--surface-overlay, var(--surface-content));
    border: 1px solid var(--border);
    border-radius: var(--radius-modal);
    box-shadow: var(--shadow-lg);
  }
  .cam-item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 9px; cursor: pointer; text-align: left;
    font-size: var(--text-sm); color: var(--text-2);
    background: transparent; border: none; border-radius: var(--radius-control);
  }
  .cam-item:hover { background: var(--surface-hover); color: var(--text-primary); }
  .cam-item:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
  .cam-item svg { width: 16px; height: 16px; flex-shrink: 0; }
</style>
