<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { confirmProductAction } from '../../product-dialog.ts';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { fetchMyPermissions, hasPerm, PERM_MANAGE_ROLES, PERM_MANAGE_SERVER } from '../../permissions/myPermissions.js';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';

  interface AutomodRule { _id: string; type: string; enabled?: boolean; config?: Record<string, unknown> }
  interface ReactionRule { _id: string; channelId?: string; messageId?: string; emoji?: string; roleId?: string }
  interface OutgoingHook { _id: string; name?: string; url?: string; events?: string[]; enabled?: boolean; lastStatus?: number | null; consecutiveFailures?: number }
  interface Row { _id: string; name?: string; type?: string }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');
  let perms = $state(0); let loading = $state(true); let busy = $state(''); let error = $state(''); let notice = $state('');
  let automod = $state<AutomodRule[]>([]); let reaction = $state<ReactionRule[]>([]); let hooks = $state<OutgoingHook[]>([]);
  let roles = $state<Row[]>([]); let channels = $state<Row[]>([]);
  let ruleType = $state('link_filter'); let blockedWords = $state('');
  let rrChannel = $state(''); let rrMessage = $state(''); let rrEmoji = $state(''); let rrRole = $state('');
  let hookName = $state(''); let hookUrl = $state(''); let hookEvents = $state<string[]>(['message:new']); let hookSecret = $state('');
  const EVENT_OPTIONS = ['message:new','message:delete','member:join','member:leave','channel:created','channel:deleted'];
  const RULE_TYPES = $derived.by(() => [
    ['blocked_words',t("ui_yasakli_kelimeler", "Yasaklı kelimeler")],['spam_messages',t("ui_mesaj_spami", "Mesaj spamı")],['caps_lock',t("ui_asiri_buyuk_harf", "Aşırı büyük harf")],['link_filter',t('ui_rule_link_filter','Link filtresi')],['invite_filter',t('ui_rule_invite_filter','Davet filtresi')],['mention_spam',t("ui_mention_spami", "Mention spamı")],['repeated_chars',t('ui_rule_duplicate_chars','Tekrarlı karakter')],
  ]);
  let canServer = $derived(hasPerm(perms, PERM_MANAGE_SERVER)); let canRoles = $derived(hasPerm(perms, PERM_MANAGE_ROLES));

  function safeContext(): boolean { if (!serverId || !isStillCurrentServer(serverId)) { error = t("ui_sunucu_degisti_otomasyon_verileri_yeniden_yuklenmeli", "Sunucu değişti — otomasyon verileri yeniden yüklenmeli."); return false; } return true; }
  function currentChannels(): Row[] { const rows = BridgeRegistry.call<Row[]>('getCurrentServerChannels'); return Array.isArray(rows) ? rows.filter(r => ['text','announcement'].includes(String(r.type ?? 'text'))) : []; }
  // `keepMessages`: bir mutasyondan SONRAKİ zorunlu tazeleme, o mutasyonun
  // kullanıcıya gösterilen sonucunu SİLMEMELİDİR. Aksi hâlde başarı bildirimi
  // ("kural oluşturuldu") ekrana hiç çıkmadan temizlenir ve işlem SESSİZ
  // görünür. İlk yükleme ve elle tazeleme eski mesajları temizlemeyi sürdürür.
  async function load(keepMessages = false): Promise<void> {
    loading = true; if (!keepMessages) { error = ''; notice = ''; }
    try {
      if (!safeContext()) return;
      perms = await fetchMyPermissions(serverId); channels = currentChannels();
      const roleRes = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/roles`);
      if (roleRes.ok) roles = await roleRes.json() as Row[]; else roles = [];
      if (canServer) {
        const [a,h] = await Promise.all([
          apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/automod`),
          apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/outgoing-webhooks`),
        ]);
        automod = a.ok ? await a.json() as AutomodRule[] : [];
        hooks = h.ok ? await h.json() as OutgoingHook[] : [];
      } else { automod = []; hooks = []; }
      const rr = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/reaction-roles`);
      reaction = rr.ok ? await rr.json() as ReactionRule[] : [];
      if (!rrChannel) rrChannel = channels[0]?._id ?? ''; if (!rrRole) rrRole = roles[0]?._id ?? '';
    } catch (cause) { error = safeApiErrorMessage(cause, t("ui_otomasyon_ayarlari_yuklenemedi", "Otomasyon ayarları yüklenemedi."), { report: true }); }
    finally { loading = false; }
  }
  async function req(key: string, request: () => Promise<Response>, fallback: string): Promise<boolean> {
    if (busy || !safeContext()) return false; busy = key; error = ''; notice = '';
    try { const r = await request(); if (!r.ok) { error = safeApiErrorMessage(r, fallback, { report: true }); return false; } return true; }
    catch (cause) { error = safeApiErrorMessage(cause, fallback, { report: true }); return false; }
    finally { busy = ''; }
  }
  function configFor(type: string): Record<string, unknown> {
    if (type === 'blocked_words') return { words: blockedWords.split(',').map(v=>v.trim()).filter(Boolean), action:'delete', timeoutMs:60000, logChannelId:null, exemptRoles:[] };
    return { action:'delete', timeoutMs:60000, logChannelId:null, exemptRoles:[] };
  }
  async function createAutomod(): Promise<void> {
    if (!canServer) return; if (ruleType === 'blocked_words' && !blockedWords.split(',').map(v=>v.trim()).filter(Boolean).length) { error=t("ui_en_az_bir_yasakli_kelime_girin", "En az bir yasaklı kelime girin."); return; }
    const ok = await req('automod:new', () => apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/automod`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:ruleType,enabled:true,config:configFor(ruleType)}) }), t('ui_automod_create_failed', 'AutoMod kuralı oluşturulamadı.'));
    if (ok) { blockedWords=''; notice=t("ui_automod_kurali_olusturuldu", "AutoMod kuralı oluşturuldu."); await load(true); }
  }
  async function toggleAutomod(rule: AutomodRule): Promise<void> { if (!canServer) return; const ok=await req(`automod:${rule._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/automod/${encodeURIComponent(rule._id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:rule.enabled===false})}),t('ui_automod_update_failed', 'AutoMod kuralı güncellenemedi.')); if(ok){notice=t("ui_automod_kurali_guncellendi", "AutoMod kuralı güncellendi.");await load(true);} }
  async function deleteAutomod(rule: AutomodRule): Promise<void> { if(!canServer||!await confirmProductAction({title:t("ui_automod_kuralini_sil", "AutoMod kuralını sil"),message:t("ui_bu_kurali_kalici_olarak_silmek_istiyor_musun", "Bu kuralı kalıcı olarak silmek istiyor musun?"),confirmLabel:t("msg_action_delete", "Sil"),tone:'danger'}))return; const ok=await req(`automod:del:${rule._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/automod/${encodeURIComponent(rule._id)}`,{method:'DELETE'}),t('ui_automod_delete_failed', 'AutoMod kuralı silinemedi.'));if(ok){notice=t("ui_automod_kurali_silindi", "AutoMod kuralı silindi.");await load(true);} }
  async function createReaction(): Promise<void> { if(!canRoles)return; if(!rrChannel||!rrMessage.trim()||!rrEmoji.trim()||!rrRole){error=t("ui_kanal_mesaj_kimligi_emoji_ve_rol_zorunlu", "Kanal, mesaj kimliği, emoji ve rol zorunlu.");return;} const ok=await req('rr:new',()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/reaction-roles`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:rrChannel,messageId:rrMessage.trim(),emoji:rrEmoji.trim(),roleId:rrRole})}),t('ui_reaction_role_create_failed', 'Reaction role oluşturulamadı.'));if(ok){rrMessage='';rrEmoji='';notice=t("ui_reaction_role_olusturuldu", "Reaction role oluşturuldu.");await load(true);} }
  async function deleteReaction(row:ReactionRule):Promise<void>{if(!canRoles||!await confirmProductAction({title:t("ui_reaction_role_sil", "Reaction role sil"),message:t("ui_bu_reaction_role_kuralini_silmek_istiyor_musun", "Bu reaction role kuralını silmek istiyor musun?"),confirmLabel:t("msg_action_delete", "Sil"),tone:'danger'}))return;const ok=await req(`rr:del:${row._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/reaction-roles/${encodeURIComponent(row._id)}`,{method:'DELETE'}),'Reaction role silinemedi.');if(ok){notice='Reaction role silindi.';await load(true);}}
  function toggleEvent(event:string):void{hookEvents=hookEvents.includes(event)?hookEvents.filter(x=>x!==event):[...hookEvents,event];}
  async function createHook():Promise<void>{if(!canServer)return;if(!hookName.trim()||!hookUrl.trim()||!hookEvents.length){error=t("ui_webhook_adi_url_ve_en_az_bir_event_zorunlu", "Webhook adı, URL ve en az bir event zorunlu.");return;}const ok=await req('hook:new',()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/outgoing-webhooks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:hookName.trim(),url:hookUrl.trim(),events:hookEvents,secret:hookSecret.trim()||null})}),t('ui_outgoing_webhook_create_failed', 'Giden webhook oluşturulamadı.'));if(ok){hookName='';hookUrl='';hookSecret='';notice=t("ui_giden_webhook_olusturuldu", "Giden webhook oluşturuldu.");await load(true);}}
  async function toggleHook(row:OutgoingHook):Promise<void>{if(!canServer)return;const ok=await req(`hook:${row._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/outgoing-webhooks/${encodeURIComponent(row._id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!row.enabled})}),t('ui_webhook_update_failed', 'Webhook güncellenemedi.'));if(ok){notice=t("ui_webhook_guncellendi", "Webhook güncellendi.");await load(true);}}
  async function testHook(row:OutgoingHook):Promise<void>{if(!canServer)return;const ok=await req(`hook:test:${row._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/outgoing-webhooks/${encodeURIComponent(row._id)}/test`,{method:'POST'}),t('ui_webhook_test_failed', 'Webhook testi tamamlanamadı.'));notice=ok?t("ui_webhook_test_istegi_tamamlandi", "Webhook test isteği tamamlandı."):'';if(ok)await load(true);}
  async function deleteHook(row:OutgoingHook):Promise<void>{if(!canServer||!await confirmProductAction({title:t("ui_giden_webhook_sil", "Giden webhook sil"),message:t('webhook_delete_confirm_named', '{name} kalıcı olarak silinsin mi?', { name: row.name ?? 'Webhook' }),confirmLabel:t("msg_action_delete", "Sil"),tone:'danger'}))return;const ok=await req(`hook:del:${row._id}`,()=>apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/outgoing-webhooks/${encodeURIComponent(row._id)}`,{method:'DELETE'}),'Webhook silinemedi.');if(ok){notice='Webhook silindi.';await load(true);}}
  onMount(()=>{void load();});
</script>

<section class="automation" aria-labelledby="automation-heading">
  <div class="intro"><h2 id="automation-heading">{t('markup_otomasyon_ve_entegrasyonlar_0a2c94e', "Otomasyon ve entegrasyonlar")}</h2><p>{t('markup_automod_reaction_role_ve_dis_event_webhook_larin_903cffd', "AutoMod, reaction role ve dış event webhook’larını tek yerde yönetin. Yetki her istekte sunucuda yeniden doğrulanır.")}</p></div>
  {#if loading}<p class="state" aria-live="polite">{t("automation_loading")}</p>{:else}
    {#if error}<p class="state error" role="alert">{error}</p>{/if}{#if notice}<p class="state success" role="status">{notice}</p>{/if}
    <article><h3>{t('markup_automod_145d753', "AutoMod")}</h3>{#if !canServer}<p class="state">{t('markup_manage_server_yetkisi_gerekli_b053111', "MANAGE_SERVER yetkisi gerekli.")}</p>{:else}
      <div class="form row"><select bind:value={ruleType}>{#each RULE_TYPES as entry}<option value={entry[0]}>{entry[1]}</option>{/each}</select>{#if ruleType==='blocked_words'}<input bind:value={blockedWords} placeholder={t('attr_kelime1_kelime2_8b5396b', "kelime1, kelime2")} />{/if}<button disabled={Boolean(busy)} onclick={()=>void createAutomod()}>{t('markup_kural_ekle_8ece5a0', "Kural ekle")}</button></div>
      <div class="list">{#each automod as rule (rule._id)}<div class="item"><span><strong>{RULE_TYPES.find(x=>x[0]===rule.type)?.[1]??rule.type}</strong><small>{rule.enabled===false?t("ui_kapali"):t("ui_acik")}</small></span><span class="actions"><button disabled={Boolean(busy)} onclick={()=>void toggleAutomod(rule)}>{rule.enabled===false?t("surface_ac_7205e6"):t("close")}</button><button class="danger" disabled={Boolean(busy)} onclick={()=>void deleteAutomod(rule)}>{t('delete')}</button></span></div>{:else}<p class="state">{t("automation_no_automod")}</p>{/each}</div>
    {/if}</article>
    <article><h3>{t('markup_reaction_roles_c21aed8', "Reaction Roles")}</h3>{#if !canRoles}<p class="state">{t('markup_manage_roles_yetkisi_gerekli_d364770', "MANAGE_ROLES yetkisi gerekli.")}</p>{:else}
      <div class="form grid"><select bind:value={rrChannel}>{#each channels as ch}<option value={ch._id}>#{ch.name??ch._id}</option>{/each}</select><input bind:value={rrMessage} placeholder={t('attr_mesaj_id_4396bb1', "Mesaj ID")}/><input bind:value={rrEmoji} maxlength="64" placeholder={t('srv_tab_emoji')}/><select bind:value={rrRole}>{#each roles as role}<option value={role._id}>{role.name??role._id}</option>{/each}</select><button disabled={Boolean(busy)} onclick={()=>void createReaction()}>{t('markup_kural_ekle_8ece5a0', "Kural ekle")}</button></div>
      <div class="list">{#each reaction as row (row._id)}<div class="item"><span><strong>{row.emoji??'?'}</strong><small>{t("ui_message_to_role", undefined, { message: row.messageId ?? '', role: roles.find(r=>r._id===row.roleId)?.name ?? row.roleId ?? '' })}</small></span><button class="danger" disabled={Boolean(busy)} onclick={()=>void deleteReaction(row)}>{t('delete')}</button></div>{:else}<p class="state">{t("automation_no_reaction_role")}</p>{/each}</div>
    {/if}</article>
    <article><h3>{t('markup_giden_webhooklar_291dd8c', "Giden Webhooklar")}</h3>{#if !canServer}<p class="state">{t('markup_manage_server_yetkisi_gerekli_b053111', "MANAGE_SERVER yetkisi gerekli.")}</p>{:else}
      <div class="form"><div class="grid"><input bind:value={hookName} maxlength="80" placeholder={t("whk_name")}/><input bind:value={hookUrl} type="url" placeholder="https://…"/><input bind:value={hookSecret} type="password" autocomplete="new-password" placeholder={t("automation_webhook_secret")}/></div><div class="events">{#each EVENT_OPTIONS as event}<label><input type="checkbox" checked={hookEvents.includes(event)} onchange={()=>toggleEvent(event)}/>{event}</label>{/each}</div><button disabled={Boolean(busy)} onclick={()=>void createHook()}>{t('markup_webhook_ekle_0f589d8', "Webhook ekle")}</button></div>
      <div class="list">{#each hooks as hook (hook._id)}<div class="item"><span><strong>{hook.name??'Webhook'}</strong><small>{hook.enabled?t("ui_acik"):t("ui_kapali")} · {t('automation_hook_status', undefined, { status: hook.lastStatus ?? '—', failures: hook.consecutiveFailures ?? 0 })}</small></span><span class="actions"><button disabled={Boolean(busy)} onclick={()=>void testHook(hook)}>{t('markup_test_640ab2b', "Test")}</button><button disabled={Boolean(busy)} onclick={()=>void toggleHook(hook)}>{hook.enabled?t("close"):t("surface_ac_7205e6")}</button><button class="danger" disabled={Boolean(busy)} onclick={()=>void deleteHook(hook)}>{t('delete')}</button></span></div>{:else}<p class="state">{t('markup_giden_webhook_yok_474e768', "Giden webhook yok.")}</p>{/each}</div>
    {/if}</article>
  {/if}
</section>

<style>
  .automation{display:grid;gap:14px}.intro h2,article h3{margin:0}.intro p,.state{margin:5px 0 0;color:var(--text-2);font-size:var(--type-body-sm)}article{display:grid;gap:10px;padding:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-1)}.form{display:grid;gap:8px}.row{grid-template-columns:minmax(160px,1fr) minmax(180px,1.4fr) auto}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.form input,.form select,.form button,.item button{min-height:36px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:var(--text-primary);padding:6px 9px}.form button,.item button{cursor:pointer}.events{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--text-2);font-size:var(--type-caption)}.events label{display:flex;align-items:center;gap:5px}.list{display:grid;gap:6px}.item{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control)}.item span:first-child{display:grid;gap:2px;min-width:0}.item small{color:var(--text-muted);overflow-wrap:anywhere}.actions{display:flex;gap:6px;flex-wrap:wrap}.danger{color:var(--danger)!important}.error{color:var(--danger)}.success{color:var(--success)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}@media(max-width:700px){.row,.grid{grid-template-columns:1fr}.item{align-items:flex-start;flex-direction:column}.actions{width:100%}}
</style>
