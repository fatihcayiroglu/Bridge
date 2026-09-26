<!-- client/js/core/server-settings/tabs/MembersTab.svelte -->
<!--
  FAZ 8/4 — ÜYE YÖNETİMİ.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERÇEK BOŞLUK
  ════════════════════════════════════════════════════════════════════════════
  Sunucu tarafı TAMDI ve izin korumalıydı:

      GET    /api/servers/:sid/members                 → üyelik yeterli
      GET    /api/servers/:sid/roles                   → rol listesi
      POST   /api/servers/:sid/members/:uid/roles      → MANAGE_ROLES
      DELETE /api/servers/:sid/members/:uid/roles/:rid → MANAGE_ROLES

  Ayarlar modalında bir "Üyeler" sekmesi YOKTU: sunucu sahibi kimin üye
  olduğunu bir listede göremiyor, rol atayamıyordu. `MemberListPanel` yalnızca
  sohbet kenar çubuğudur ve yönetim yapmaz.

  ── YETKİ SINIRI ─────────────────────────────────────────────────────────
  ARKA UÇTA. Buradaki `MANAGE_ROLES` kontrolü YALNIZCA görünürlük içindir:
  yetkisi olmayana ölü kontrol göstermemek. Kanıtlanamayan bit yok sayılır
  (fail-closed) ve her yazma sunucuda yeniden yetkilendirilir. Sunucunun 403'ü
  istemci tarafından EZİLMEZ.
-->
<script lang="ts">
  import { avatarStyle, safeHexColor } from '../../avatar-color.ts';
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { fetchMyPermissions, hasPerm, PERM_MANAGE_ROLES } from '../../permissions/myPermissions.js';
  import { safeApiErrorMessage } from '../../api-error.ts';

  interface MemberRow {
    userId?: string; _id?: string;
    username?: string; displayName?: string; nickname?: string;
    avatarColor?: string; joinedAt?: number;
    roles?: unknown;
  }
  interface RoleRow { _id: string; name: string; color?: string }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');

  let perms    = $state(0);
  let members  = $state<MemberRow[]>([]);
  let roles    = $state<RoleRow[]>([]);
  let loading  = $state(true);
  let error    = $state('');
  let notice   = $state('');
  let busyKey  = $state('');
  let filter   = $state('');

  let canManageRoles = $derived(hasPerm(perms, PERM_MANAGE_ROLES));

  /** Arama, uzun üye listelerinde tek kullanışlı gezinme yoludur. */
  let visible = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return members;
    return members.filter(m =>
      nameOf(m).toLowerCase().includes(needle) ||
      String(m.username ?? '').toLowerCase().includes(needle));
  });

  function idOf(member: MemberRow): string {
    return String(member.userId ?? member._id ?? '');
  }
  function nameOf(member: MemberRow): string {
    return member.nickname || member.displayName || member.username || idOf(member) || t('analytics_members', 'Üye');
  }
  function initials(member: MemberRow): string {
    return nameOf(member).slice(0, 2).toUpperCase();
  }
  function joinedLabel(member: MemberRow): string {
    const ts = Number(member.joinedAt);
    return Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleDateString() : '';
  }

  /** Üyenin rolleri sunucudan `roles` alanında (JSONB dizi) gelir. */
  function roleIdsOf(member: MemberRow): string[] {
    const raw = member.roles;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.map(String) : []; }
      catch { return []; }
    }
    return [];
  }

  const safeColor = (value: unknown): string => safeHexColor(value, 'var(--text-muted)');

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      // ÖLÇÜLEN KUSUR: bu iki mesaj ÜRÜN TARAFINDAN yazılmış, zaten çevrilmiş
      // ve zaten güvenli metinlerdi; ama `throw new Error(...)` ile atılıp
      // aşağıdaki `catch` içinde `safeApiErrorMessage`e veriliyorlardı.
      // O fonksiyon Response olmayan bir Error'ı sınıflandıramaz ve YEDEK
      // metni döndürür — yani kullanıcı "Sunucu seçilmedi." yerine genel
      // "Üyeler yüklenemedi." görüyordu. Mesajı doğrudan yazmak hem doğru
      // hem de ham veri sızdırmaz.
      if (!serverId) { error = t("ssm_no_server", "Sunucu seçilmedi."); return; }
      perms = await fetchMyPermissions(serverId);

      const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/members`);
      if (!isStillCurrentServer(serverId)) return;
      if (res.status === 403) { error = t("ui_bu_sunucunun_uyelerini_gorme_yetkiniz_yok", "Bu sunucunun üyelerini görme yetkiniz yok."); return; }
      if (!res.ok) { error = safeApiErrorMessage(res, t("members_load_failed", "Üyeler yüklenemedi."), { report: true }); return; }
      const data = await res.json() as MemberRow[];
      members = Array.isArray(data) ? data : [];

      // Rol listesi YALNIZCA rol yönetebilenler için gerekir; yetkisiz
      // kullanıcıya 403 üreten bir istek atmak gürültüden başka şey değil.
      if (hasPerm(perms, PERM_MANAGE_ROLES)) {
        const rolesRes = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/roles`);
        if (rolesRes.ok) {
          const list = await rolesRes.json() as RoleRow[];
          roles = Array.isArray(list) ? list : [];
        }
      }
    } catch (err) {
      error = safeApiErrorMessage(err, t("members_load_failed", "Üyeler yüklenemedi."), { report: true });
    } finally {
      loading = false;
    }
  }

  /** Ortak yazma sarmalayıcısı — her yol AYNI hata sözleşmesini kullanır. */
  async function run(key: string, label: string, request: () => Promise<Response>): Promise<boolean> {
    if (busyKey) return false;
    busyKey = key;
    error = '';
    notice = '';
    try {
      const res = await request();
      if (res.status === 403) { error = t("ui_bu_islem_icin_yetkiniz_yok", "Bu işlem için yetkiniz yok."); return false; }
      if (res.status === 429) { error = t("ui_cok_hizli_islem_yapiyorsunuz_biraz_bekleyin", "Çok hızlı işlem yapıyorsunuz. Biraz bekleyin."); return false; }
      if (!res.ok) {
        error = safeApiErrorMessage(res, t("ui_uye_islemi_tamamlanamadi", "Üye işlemi tamamlanamadı."), { report: true });
        return false;
      }
      notice = label;
      return true;
    } catch (cause) {
      error = safeApiErrorMessage(cause, t("ui_uye_islemi_tamamlanamadi", "Üye işlemi tamamlanamadı."), { report: true });
      return false;
    } finally {
      busyKey = '';
    }
  }

  async function toggleRole(member: MemberRow, role: RoleRow): Promise<void> {
    const userId = idOf(member);
    if (!userId) return;
    if (!isStillCurrentServer(serverId)) {
      error = t("ui_sunucu_degisti_uyeler_yeniden_yuklenmeli", "Sunucu değişti — üyeler yeniden yüklenmeli.");
      return;
    }
    const has = roleIdsOf(member).includes(role._id);
    const base = `${getAPI()}/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}/roles`;

    const ok = await run(
      `${userId}:${role._id}`,
      has ? t('role_removed_named', '{member} → {role} kaldırıldı', { member: nameOf(member), role: role.name }) : `${nameOf(member)} → ${role.name} verildi`,
      () => has
        ? apiFetch(`${base}/${encodeURIComponent(role._id)}`, { method: 'DELETE' })
        : apiFetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roleId: role._id }),
          }),
    );
    // Sunucu doğruyu söyler; iyimser güncelleme YOK — rol değişimi izin
    // hesabını etkiler ve yanlış gösterilmesi tehlikelidir.
    if (ok) await load();
  }

  onMount(() => { void load(); });
</script>

<div class="mem-tab">
  {#if loading}
    <p class="mem-muted">{t('sso_loading', 'Yükleniyor…')}</p>

  {:else if error && !members.length}
    <p class="mem-error" role="alert">{error}</p>

  {:else}
    {#if error}<p class="mem-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="mem-notice" role="status">{notice}</p>{/if}

    <div class="mem-head">
      <div>
        <h3>{t('mem_title', 'Üyeler')} <span class="mem-count">{members.length}</span></h3>
        <p class="mem-muted">
          {#if canManageRoles}
            {t("ui_role_manage_hint")}
          {:else}
            {t("ui_manage_roles_required")}
          {/if}
        </p>
      </div>
      <label class="mem-search">
        <span class="mem-sr-only">{t('mem_search', 'Üye ara')}</span>
        <input type="search" bind:value={filter} placeholder={t('mem_search_ph', 'Üye ara…')} />
      </label>
    </div>

    {#if !members.length}
      <p class="mem-muted">{t('mem_none', 'Bu sunucuda henüz üye yok.')}</p>
    {:else if !visible.length}
      <p class="mem-muted">{t("ui_no_member_match", undefined, { filter })}</p>
    {:else}
      <ul class="mem-list">
        {#each visible as member (idOf(member))}
          {@const assigned = roleIdsOf(member)}
          <li class="mem-row" class:busy={busyKey.startsWith(`${idOf(member)}:`)}>
            <span class="mem-avatar" style={avatarStyle(member.avatarColor)}>{initials(member)}</span>
            <span class="mem-who">
              <strong>{nameOf(member)}</strong>
              <small>
                {member.username ? `@${member.username}` : ''}
                {joinedLabel(member) ? ` · ${t('member_joined_label', undefined, { date: joinedLabel(member) })}` : ''}
              </small>
            </span>

            {#if canManageRoles && roles.length}
              <span class="mem-roles" role="group" aria-label={t('member_roles_aria', undefined, { name: nameOf(member) })}>
                {#each roles as role (role._id)}
                  <button
                    type="button"
                    class="mem-role"
                    class:on={assigned.includes(role._id)}
                    aria-pressed={assigned.includes(role._id)}
                    disabled={busyKey !== ''}
                    style={`--role-color:${safeColor(role.color)}`}
                    onclick={() => void toggleRole(member, role)}
                  >{role.name}</button>
                {/each}
              </span>
            {:else if assigned.length}
              <!-- Yetkisiz kullanıcı rolleri GÖRÜR ama değiştiremez. -->
              <span class="mem-roles">
                {#each roles.filter(r => assigned.includes(r._id)) as role (role._id)}
                  <span class="mem-role on static">{role.name}</span>
                {/each}
              </span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
.mem-tab { display: flex; flex-direction: column; gap: 4px; }
.mem-head { display: flex; gap: var(--space-3); align-items: flex-start; justify-content: space-between; padding-top: 12px; }
.mem-head h3 { margin: 0 0 2px; font-size: var(--text-base); }
.mem-count {
  padding: 0 7px;
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--bg-3);
  border-radius: 999px;
}
.mem-muted { margin: 0 0 10px; font-size: var(--text-sm); color: var(--text-muted); }

.mem-error, .mem-notice {
  padding: 8px 11px;
  margin: 10px 0 0;
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}
.mem-error  { color: var(--danger-text, var(--danger)); background: var(--danger-bg, var(--bg-3)); }
.mem-notice { color: var(--green); background: var(--green-bg); }

.mem-search input {
  min-width: 180px;
  padding: 6px 10px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: var(--bg-input, var(--bg-3));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.mem-list { padding: 0; margin: 6px 0 0; list-style: none; }
.mem-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-faint);
}
.mem-row.busy { opacity: .6; }
.mem-avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  font-size: var(--text-2xs);
  font-weight: 700;
  color: var(--text-on-solid);
  border-radius: 50%;
}
.mem-who { display: grid; flex: 1; min-width: 0; }
.mem-who strong { overflow: hidden; font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
.mem-who small { font-size: var(--text-2xs); color: var(--text-muted); }

.mem-roles { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; max-width: 55%; }
.mem-role {
  padding: 2px 9px;
  font: inherit;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.mem-role:hover:not(:disabled):not(.static) { color: var(--text-primary); background: var(--bg-4); }
.mem-role:disabled { cursor: default; opacity: .6; }
/* Atanmış rol RENKTEN başka işaret de taşır: `aria-pressed` ve kalın kenarlık. */
.mem-role.on {
  font-weight: 600;
  color: var(--role-color);
  border-color: var(--role-color);
}
.mem-role.static { cursor: default; }

.mem-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
