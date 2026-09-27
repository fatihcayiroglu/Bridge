<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onDestroy, onMount } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { createLogger } from './logger.js';
  import { confirmProductAction } from './product-dialog.ts';

  const log = createLogger('ServerEvents');
  const MANAGE_SERVER = 1 << 3;
  const ADMINISTRATOR = 1 << 30;
  type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;
  type Filter = 'upcoming' | 'past' | 'all';
  type Rsvp = 'interested' | 'going' | 'not_going';
  type SocketLike = { on(event: string, handler: (payload: unknown) => void): void; off?(event: string, handler: (payload: unknown) => void): void };
  interface EventRow {
    id: string; title: string; description: string; location: string; startsAt: number; endsAt: number | null;
    status: string; rsvpCount: number; myRsvp: Rsvp | null; channelId: string | null;
  }

  let visible = $state(false);
  let loading = $state(false);
  let loadingMore = $state(false);
  let creating = $state(false);
  let mutationBusy = $state('');
  let error = $state('');
  let serverId = $state('');
  let serverName = $state('');
  let filter = $state<Filter>('upcoming');
  let events = $state<EventRow[]>([]);
  let total = $state(0);
  let canManage = $state(false);
  let createOpen = $state(false);
  let editingId = $state('');
  let title = $state('');
  let description = $state('');
  let location = $state('');
  let startsAt = $state('');
  let endsAt = $state('');
  let boundSocket: SocketLike | null = null;
  let returnFocus: HTMLElement | null = null;

  function api(): ApiFetch | null { return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null; }
  function currentServer(): { _id?: string; name?: string } | null {
    try { return BridgeRegistry.call<{ _id?: string; name?: string } | null>('currentServer') ?? null; } catch { return null; }
  }
  function safeError(status: number, action: 'load' | 'rsvp' | 'create' | 'update' | 'delete'): string {
    if (status === 403) return action === 'create' || action === 'update' || action === 'delete' ? t("ui_etkinligi_yonetme_yetkin_yok", "Etkinliği yönetme yetkin yok.") : t("ui_bu_etkinlige_erisimin_yok", "Bu etkinliğe erişimin yok.");
    if (status === 404) return t("ui_etkinlik_artik_bulunamiyor", "Etkinlik artık bulunamıyor.");
    if (status === 429) return t("ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene", "Çok hızlı işlem yapılıyor. Biraz sonra tekrar dene.");
    if (action === 'rsvp') return t("ui_katilim_yaniti_kaydedilemedi", "Katılım yanıtı kaydedilemedi.");
    if (action === 'create') return t("ui_etkinlik_olusturulamadi", "Etkinlik oluşturulamadı.");
    if (action === 'update') return t("ui_etkinlik_guncellenemedi", "Etkinlik güncellenemedi.");
    if (action === 'delete') return t("ui_etkinlik_silinemedi", "Etkinlik silinemedi.");
    return t("ui_etkinlikler_yuklenemedi", "Etkinlikler yüklenemedi.");
  }
  function normalize(value: unknown): EventRow | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id : '';
    const eventTitle = typeof row.title === 'string' ? row.title : '';
    const start = Date.parse(String(row.starts_at ?? ''));
    if (!id || !eventTitle || !Number.isFinite(start)) return null;
    const rawRsvp = typeof row.my_rsvp === 'string' ? row.my_rsvp : null;
    return {
      id, title: eventTitle,
      description: typeof row.description === 'string' ? row.description : '',
      location: typeof row.location === 'string' ? row.location : '',
      startsAt: start,
      endsAt: row.ends_at ? Date.parse(String(row.ends_at)) : null,
      status: typeof row.status === 'string' ? row.status : 'scheduled',
      rsvpCount: Math.max(0, Number(row.rsvp_count) || 0),
      myRsvp: rawRsvp === 'going' || rawRsvp === 'interested' || rawRsvp === 'not_going' ? rawRsvp : null,
      channelId: typeof row.channel_id === 'string' ? row.channel_id : null,
    };
  }
  function formatDate(epoch: number): string {
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(epoch); } catch { return new Date(epoch).toLocaleString(); }
  }
  function toIso(localValue: string): string | null {
    if (!localValue) return null;
    const date = new Date(localValue);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }

  // `keepError`: bir mutasyon REDDEDİLDİKTEN sonraki zorunlu tazeleme, o
  // reddin kullanıcıya gösterilen nedenini SİLMEMELİDİR. Aksi hâlde 403/404/429
  // yanıtları sessizce yutulur: liste tazelenir, seçim geri alınır ve kullanıcı
  // neden başarısız olduğunu HİÇ göremez. Elle tazeleme, açılış, filtre ve
  // soket kaynaklı yüklemeler eski hatayı temizlemeyi sürdürür.
  async function load(reset = true, keepError = false): Promise<void> {
    const fetcher = api(); const sid = serverId;
    if (!visible || !fetcher || !sid) return;
    const offset = reset ? 0 : events.length;
    if (reset) loading = true; else loadingMore = true;
    if (!keepError) error = '';
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/events?filter=${filter}&limit=20&offset=${offset}`);
      if (!response.ok) { error = safeError(response.status, 'load'); if (reset) { events = []; total = 0; } return; }
      const body = await response.json() as { events?: unknown; total?: unknown };
      if (!visible || serverId !== sid) return;
      const page = (Array.isArray(body.events) ? body.events : []).map(normalize).filter((event): event is EventRow => event !== null);
      events = reset ? page : [...events, ...page.filter((event) => !events.some((existing) => existing.id === event.id))];
      total = Math.max(events.length, Number(body.total) || 0);
    } catch (err) { log.error('event load failed', err); if (serverId === sid) error = t("ui_etkinlikler_yuklenemedi", "Etkinlikler yüklenemedi."); }
    finally { if (reset) loading = false; else loadingMore = false; }
  }

  async function loadPermission(): Promise<void> {
    const fetcher = api(); const sid = serverId;
    canManage = false;
    if (!fetcher || !sid) return;
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/me/permissions`);
      if (!response.ok) return;
      const body = await response.json() as { permissions?: unknown };
      const permissions = Number(body.permissions) || 0;
      canManage = (permissions & ADMINISTRATOR) !== 0 || (permissions & MANAGE_SERVER) !== 0;
    } catch { canManage = false; }
  }

  async function setRsvp(event: EventRow, status: Rsvp | null): Promise<void> {
    const fetcher = api(); const sid = serverId;
    if (!fetcher || !sid || mutationBusy) return;
    mutationBusy = `rsvp:${event.id}`; error = '';
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/events/${encodeURIComponent(event.id)}/rsvp`, status
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }
        : { method: 'DELETE' });
      if (!response.ok) { error = safeError(response.status, 'rsvp'); await load(true, true); return; }
      await load(true);
    } catch (err) { log.error('event rsvp failed', err); error = t("ui_katilim_yaniti_kaydedilemedi", "Katılım yanıtı kaydedilemedi."); }
    finally { mutationBusy = ''; }
  }


  function toLocalInput(epoch: number | null): string {
    if (!epoch) return '';
    const date = new Date(epoch - new Date(epoch).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
  }
  function beginEdit(event: EventRow): void {
    if (!canManage || mutationBusy) return;
    editingId = event.id; createOpen = true; error = '';
    title = event.title; description = event.description; location = event.location;
    startsAt = toLocalInput(event.startsAt); endsAt = toLocalInput(event.endsAt);
  }
  function resetEditor(): void {
    editingId = ''; title = ''; description = ''; location = ''; startsAt = ''; endsAt = ''; createOpen = false;
  }
  async function updateEvent(): Promise<void> {
    const fetcher = api(); const sid = serverId;
    if (!fetcher || !sid || !canManage || !editingId || creating) return;
    const startIso = toIso(startsAt); const endIso = endsAt ? toIso(endsAt) : null;
    if (!title.trim()) { error = t("ui_etkinlik_adi_gerekli", "Etkinlik adı gerekli."); return; }
    if (!startIso) { error = t("ui_gecerli_bir_baslangic_zamani_sec", "Geçerli bir başlangıç zamanı seç."); return; }
    if (endIso && new Date(endIso) <= new Date(startIso)) { error = t("ui_bitis_zamani_baslangictan_sonra_olmali", "Bitiş zamanı başlangıçtan sonra olmalı."); return; }
    creating = true; error = '';
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/events/${encodeURIComponent(editingId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, location: location.trim() || undefined, startsAt: startIso, endsAt: endIso || undefined }),
      });
      if (!response.ok) { error = safeError(response.status, 'update'); await load(true, true); return; }
      resetEditor(); await load(true);
    } catch (err) { log.error('event update failed', err); error = t("ui_etkinlik_guncellenemedi", "Etkinlik güncellenemedi."); }
    finally { creating = false; }
  }
  async function deleteEvent(event: EventRow): Promise<void> {
    const fetcher = api(); const sid = serverId;
    if (!fetcher || !sid || !canManage || mutationBusy) return;
    const confirmed = await confirmProductAction({ title: t("ui_etkinligi_sil", "Etkinliği sil"), message: t('event_delete_confirm', '{title} etkinliğini kalıcı olarak silmek istiyor musun?', { title: event.title }), confirmLabel: t("msg_action_delete", "Sil"), tone: 'danger' });
    if (!confirmed) return;
    mutationBusy = `delete:${event.id}`; error = '';
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/events/${encodeURIComponent(event.id)}`, { method: 'DELETE' });
      if (!response.ok) { error = safeError(response.status, 'delete'); await load(true, true); return; }
      if (editingId === event.id) resetEditor();
      await load(true);
    } catch (err) { log.error('event delete failed', err); error = t("ui_etkinlik_silinemedi", "Etkinlik silinemedi."); }
    finally { mutationBusy = ''; }
  }

  async function createEvent(): Promise<void> {
    const fetcher = api(); const sid = serverId;
    if (!fetcher || !sid || !canManage || creating) return;
    const startIso = toIso(startsAt); const endIso = endsAt ? toIso(endsAt) : null;
    if (!title.trim()) { error = t("ui_etkinlik_adi_gerekli", "Etkinlik adı gerekli."); return; }
    if (!startIso) { error = t("ui_gecerli_bir_baslangic_zamani_sec", "Geçerli bir başlangıç zamanı seç."); return; }
    if (endsAt && !endIso) { error = t("ui_gecerli_bir_bitis_zamani_sec", "Geçerli bir bitiş zamanı seç."); return; }
    if (endIso && new Date(endIso) <= new Date(startIso)) { error = t("ui_bitis_zamani_baslangictan_sonra_olmali", "Bitiş zamanı başlangıçtan sonra olmalı."); return; }
    creating = true; error = '';
    try {
      const response = await fetcher(`/api/servers/${encodeURIComponent(sid)}/events`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || undefined, location: location.trim() || undefined, startsAt: startIso, endsAt: endIso || undefined }),
      });
      if (!response.ok) { error = safeError(response.status, 'create'); return; }
      resetEditor();
      await load(true);
    } catch (err) { log.error('event create failed', err); error = t("ui_etkinlik_olusturulamadi", "Etkinlik oluşturulamadı."); }
    finally { creating = false; }
  }

  function open(): void {
    const server = currentServer();
    if (!server?._id) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    serverId = server._id; serverName = server.name ?? t('cp_category_server', 'Sunucu'); filter = 'upcoming'; events = []; total = 0; error = ''; createOpen = false; editingId = ''; visible = true;
    void Promise.all([load(true), loadPermission()]);
  }
  function close(): void {
    visible = false; events = []; error = ''; mutationBusy = ''; createOpen = false; editingId = '';
    if (returnFocus?.isConnected) queueMicrotask(() => returnFocus?.focus());
    returnFocus = null;
  }
  function onRealtime(): void { if (visible) void load(true); }
  function bindSocket(): void {
    const next = BridgeRegistry.get<SocketLike>('socket') ?? null;
    if (next === boundSocket) return;
    if (boundSocket) for (const event of ['server:event:created','server:event:updated','server:event:deleted','server:event:rsvp']) boundSocket.off?.(event, onRealtime);
    boundSocket = next;
    if (boundSocket) for (const event of ['server:event:created','server:event:updated','server:event:deleted','server:event:rsvp']) boundSocket.on(event, onRealtime);
  }

  onMount(() => {
    BridgeRegistry.register('openServerEvents', open); BridgeRegistry.register('closeServerEvents', close); bindSocket();
    document.addEventListener('bridge:socket-ready', bindSocket); document.addEventListener('bridge:socket-reconnected', bindSocket);
  });
  onDestroy(() => {
    if (boundSocket) for (const event of ['server:event:created','server:event:updated','server:event:deleted','server:event:rsvp']) boundSocket.off?.(event, onRealtime);
    document.removeEventListener('bridge:socket-ready', bindSocket); document.removeEventListener('bridge:socket-reconnected', bindSocket);
    BridgeRegistry.unregister('openServerEvents'); BridgeRegistry.unregister('closeServerEvents');
  });
</script>

{#if visible}
<div class="events-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="events-panel" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="events-title" use:focusTrap={{ initialFocus: '.events-close' }} onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
    <header><div><small>{t('markup_sunucu_etkinlikleri_0b1faaa', "Sunucu etkinlikleri")}</small><h2 id="events-title">{serverName}</h2></div><div class="header-actions">{#if canManage}<button type="button" class="primary" onclick={() => { if (createOpen) resetEditor(); else { editingId = ''; createOpen = true; error = ''; } }}>{createOpen ? t("ccp_cancel") : t("surface_etkinlik_olustur_6a830b")}</button>{/if}<button type="button" class="events-close secondary" onclick={close} aria-label={t('attr_etkinlikleri_kapat_9860632', "Etkinlikleri kapat")}>✕</button></div></header>
    <div class="events-toolbar" aria-label={t('attr_etkinlik_filtresi_7f5640f', "Etkinlik filtresi")}>{#each ['upcoming','past','all'] as value}<button type="button" class:active={filter === value} aria-pressed={filter === value} onclick={() => { filter = value as Filter; void load(true); }}>{value === 'upcoming' ? t("surface_yaklasan_c3e129") : value === 'past' ? t("surface_gecmis_be3bbb") : t("all")}</button>{/each}</div>
    <div class="events-body">
      {#if createOpen && canManage}<section class="create-box" aria-labelledby="event-create-title"><h3 id="event-create-title">{editingId ? t("surface_etkinligi_duzenle_e47555") : t("surface_yeni_etkinlik_3ab9c1")}</h3><input maxlength="100" bind:value={title} placeholder={t("event_name")} aria-label={t("event_name")}/><textarea maxlength="1000" rows="3" bind:value={description} placeholder={t("adm_description")} aria-label={t("adm_description")}></textarea><input maxlength="200" bind:value={location} placeholder={t("event_location_link")} aria-label={t("ui_location")}/><div class="date-row"><label>{t("audit_start")}<input type="datetime-local" bind:value={startsAt}/></label><label>{t("event_end_optional")}<input type="datetime-local" bind:value={endsAt}/></label></div><div class="create-actions"><button type="button" class="primary" disabled={creating} onclick={() => void (editingId ? updateEvent() : createEvent())}>{creating ? t("ui_saving") : editingId ? t("surface_degisiklikleri_kaydet_922350") : t("create")}</button></div></section>{/if}
      {#if error}<p class="events-error" role="alert">{error}</p>{/if}
      <div class="event-list" aria-busy={loading}>
        {#if loading && events.length === 0}<p class="events-state" role="status">{t("events_loading")}</p>{:else if !loading && events.length === 0}<p class="events-state">{t('markup_bu_filtrede_etkinlik_yok_c0575a5', "Bu filtrede etkinlik yok.")}</p>{/if}
        {#each events as event (event.id)}<article class="event-card"><div class="event-head"><div><h3>{event.title}</h3><p>{formatDate(event.startsAt)}{#if event.endsAt} – {formatDate(event.endsAt)}{/if}</p></div><span class="event-count">{t("ui_person_count", undefined, { count: event.rsvpCount })}</span></div>{#if event.description}<p class="description">{event.description}</p>{/if}{#if event.location}<p class="location">{event.location}</p>{/if}{#if canManage}<div class="event-manage"><button type="button" class="secondary" disabled={Boolean(mutationBusy)} onclick={() => beginEdit(event)}>{t("edit")}</button><button type="button" class="secondary danger" disabled={Boolean(mutationBusy)} onclick={() => void deleteEvent(event)}>{t('delete')}</button></div>{/if}<div class="rsvp-actions" aria-label={t("ui_event_rsvp_aria", undefined, { event: event.title })}>{#each [['going',t("surface_kat_lacag_m_1fd3e5")],['interested',t("surface_ilgileniyorum_edc4db")],['not_going',t("surface_kat_lmayacag_m_936246")]] as choice}<button type="button" class:active={event.myRsvp === choice[0]} aria-pressed={event.myRsvp === choice[0]} disabled={Boolean(mutationBusy)} onclick={() => void setRsvp(event, choice[0] as Rsvp)}>{choice[1]}</button>{/each}{#if event.myRsvp}<button type="button" class="secondary" disabled={Boolean(mutationBusy)} onclick={() => void setRsvp(event, null)}>{t("event_remove_response")}</button>{/if}</div></article>{/each}
      </div>
      {#if events.length < total}<button type="button" class="load-more secondary" disabled={loadingMore} onclick={() => void load(false)}>{loadingMore ? t("loading") : t("ui_show_more_count", undefined, { shown: events.length, total })}</button>{/if}
    </div>
  </div>
</div>
{/if}

<style>
.events-overlay{position:fixed;inset:0;z-index:var(--layer-modal);display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--bg-0) 82%,transparent);backdrop-filter:blur(8px)}.events-panel{display:flex;flex-direction:column;width:min(820px,100%);max-height:min(820px,calc(var(--bridge-visual-viewport-height,100dvh) - 48px));overflow:hidden;border:1px solid var(--border-strong);border-radius:var(--radius-modal);background:var(--bg-2);box-shadow:var(--shadow-xl);color:var(--text-primary)}header,.header-actions,.events-toolbar,.event-head,.rsvp-actions,.date-row{display:flex;align-items:center}header{justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border)}header small{color:var(--text-muted);font-size:var(--text-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase}header h2{margin:2px 0 0;font-size:var(--type-title)}.header-actions,.rsvp-actions,.event-manage{gap:7px}.events-toolbar{gap:4px;padding:10px 18px;border-bottom:1px solid var(--border)}button,input,textarea{font:inherit}.events-toolbar button,.secondary,.rsvp-actions button{padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg-3);color:var(--text-secondary);cursor:pointer}.events-toolbar button.active,.rsvp-actions button.active{border-color:var(--brand);background:var(--brand-muted);color:var(--text-primary)}.primary{padding:8px 12px;border:0;border-radius:var(--radius-control);background:var(--brand);color:var(--text-on-solid);font-weight:700;cursor:pointer}.events-body{padding:16px 18px max(20px,env(safe-area-inset-bottom));overflow:auto}.create-box{display:grid;gap:8px;padding:14px;margin-bottom:14px;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-1)}.create-box h3{margin:0 0 2px;font-size:var(--text-base)}input,textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg-input);color:var(--text-primary)}.date-row{gap:10px}.date-row label{display:grid;flex:1;gap:5px;color:var(--text-muted);font-size:var(--text-sm)}.create-actions{display:flex;justify-content:flex-end}.events-error{padding:9px 11px;margin:0 0 12px;border-radius:var(--radius-control);background:var(--danger-bg);color:var(--danger)}.event-list{display:grid;gap:9px}.events-state{padding:30px;text-align:center;color:var(--text-muted)}.event-card{padding:13px;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-1)}.event-head{justify-content:space-between;gap:12px}.event-head h3{margin:0;font-size:var(--text-base)}.event-head p,.description,.location{margin:5px 0 0;color:var(--text-secondary);font-size:var(--text-sm)}.event-count{flex:0 0 auto;color:var(--text-muted);font-size:var(--text-sm)}.rsvp-actions{flex-wrap:wrap;margin-top:11px}.event-manage{display:flex;justify-content:flex-end;margin-top:10px}.danger{color:var(--danger)}.load-more{display:block;margin:12px auto 0}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}button:disabled{opacity:.55;cursor:not-allowed}@media(max-width:640px){.events-overlay{padding:0}.events-panel{height:var(--bridge-visual-viewport-height,100dvh);max-height:none;border-radius:0}header{padding-top:max(16px,env(safe-area-inset-top))}.header-actions{align-items:flex-end;flex-direction:column}.date-row{align-items:stretch;flex-direction:column}.rsvp-actions{align-items:stretch;flex-direction:column}}
</style>
