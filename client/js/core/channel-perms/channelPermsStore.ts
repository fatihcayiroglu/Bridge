// client/js/core/channel-perms/channelPermsStore.ts
// FAZ C2 — KANAL İZİNLERİ: TEK KANONİK KONTROLCÜ.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR
// ════════════════════════════════════════════════════════════════════════════
// `ChannelPermsModal.svelte` yalnızca SUNUMDUR: ~30 callback prop'u ve
// önceden üretilmiş HTML dizeleri (`matrixHtml`, `auditBody`,
// `syncChannelListHtml`) bekler ve bunları `{@html}` ile basar. Bir kontrolcü
// hiç yazılmamıştı; bu yüzden yüzey BACKEND_ONLY kaldı.
//
// GÜVENLİK KARARI: bu kontrolcü HTML ÜRETMEZ. Rol adları, kanal adları ve
// audit kayıtları kullanıcı denetimindedir; onları HTML'e gömmek doğrudan bir
// XSS yüzeyi olurdu. Kontrolcü YALNIZCA tipli veri yayar; matrisi Svelte
// işaretlemesi veriden render etmelidir (modalin `{@html}` yuvaları
// BESLENMEZ).
//
// ARKA UÇ SÖZLEŞMESİ (doğrulandı, varsayılmadı):
//   GET    /api/servers/:sid/channels/:cid/permissions  → { overrides, roles }
//   PUT    .../permissions/:roleId   { allow, deny }    → override yaz
//   DELETE .../permissions/:roleId                      → override SİL = INHERIT
//   yetki: MANAGE_CHANNELS   ·   allow/deny: BIT ALANI
//
// Arka uç ayrıca kiracı doğrulaması yapar (assertChannelInServer /
// assertRoleInServer) — istemci bunun YERİNE geçmez, yalnızca yanlış istek
// göndermemek için aynı sınırı erkenden uygular.

import { getCurrentServerFromRegistry } from '../server-settings/stores/serverSettingsStore';
import { BridgeRegistry } from '../bridge-registry.js';
import { safeApiErrorMessage } from '../api-error.ts';
import { t } from '../i18n/index.ts';

/**
 * KANAL DÜZEYİNDE anlamlı izin bitleri.
 *
 * Kanonik kaynak `server/lib/permissions.ts`tir; istemci sunucu kodunu import
 * edemediği için bitler burada AYNEN yansıtılır. Yalnız kanal override'ı
 * olarak anlamlı olanlar listelenir — MANAGE_SERVER / KICK / BAN gibi
 * sunucu-genel yetkiler kanal override'ı DEĞİLDİR ve gösterilmez.
 */
export const CHANNEL_PERMISSIONS: ReadonlyArray<{ bit: number; key: string; labelKey: string }> = [
  { bit: 1 << 0,  key: 'VIEW_CHANNELS',    labelKey: 'perm_view_channel' },
  { bit: 1 << 1,  key: 'MANAGE_CHANNELS',  labelKey: 'perm_manage_channel' },
  { bit: 1 << 8,  key: 'SEND_MESSAGES',    labelKey: 'perm_send_messages' },
  { bit: 1 << 9,  key: 'MANAGE_MESSAGES',  labelKey: 'perm_manage_messages' },
  { bit: 1 << 10, key: 'EMBED_LINKS',      labelKey: 'perm_embed_links' },
  { bit: 1 << 11, key: 'ATTACH_FILES',     labelKey: 'perm_attach_files' },
  { bit: 1 << 12, key: 'ADD_REACTIONS',    labelKey: 'perm_add_reactions' },
  { bit: 1 << 13, key: 'USE_SLASH',        labelKey: 'perm_slash_commands' },
  { bit: 1 << 14, key: 'MENTION_EVERYONE', labelKey: 'perm_mention_everyone' },
  { bit: 1 << 15, key: 'READ_HISTORY',     labelKey: 'perm_read_history' },
  { bit: 1 << 16, key: 'CONNECT',          labelKey: 'perm_connect_voice' },
  { bit: 1 << 17, key: 'SPEAK',            labelKey: 'perm_speak_voice' },
];

export interface PermRole {
  _id:  string;
  name: string;
}

export interface PermOverride {
  roleId: string;
  allow:  number;
  deny:   number;
}

/** Bir izin bitinin üç durumundan biri. */
export type PermState = 'allow' | 'deny' | 'inherit';

export interface ChannelPermsSnapshot {
  serverId:  string;
  channelId: string;
  roles:     PermRole[];
  loading:   boolean;
  saving:    boolean;
  error:     string | null;
  selectedRoleId: string;
  dirty:     boolean;
  explanationLoading: boolean;
  explanationError: string | null;
  explanation: PermissionExplanationResponse | null;
  rolePreviewLoading: boolean;
  rolePreviewError: string | null;
  rolePreview: RolePreviewResponse | null;
}

export interface PermissionExplanationRow {
  key: string;
  label: string;
  allowed: boolean;
  effective: 'allowed' | 'denied';
  reasonCode: string;
  message: string;
  base: { state: 'allowed' | 'denied'; sources: string[] };
  overrides: Array<{ scope: 'everyone' | 'role' | 'member'; label: string; state: 'allowed' | 'denied' }>;
}

export interface PermissionExplanationResponse {
  channelId: string;
  subject: string;
  permissions: PermissionExplanationRow[];
}

export interface RolePreviewChannel {
  channelId: string;
  name: string;
  type: string;
  categoryId: string | null;
  visible: boolean;
  capabilities: {
    sendMessages: boolean;
    attachFiles: boolean;
    manageMessages: boolean;
    connect: boolean;
    speak: boolean;
  };
}

export interface RolePreviewResponse {
  simulation: true;
  role: { id: string; name: string };
  summary: {
    totalChannels: number;
    visibleChannels: number;
    sendableChannels: number;
    attachableChannels: number;
    manageableChannels: number;
  };
  channels: RolePreviewChannel[];
}

interface ApiResponse {
  overrides?: PermOverride[];
  roles?:     PermRole[];
}

function isPermissionExplanationResponse(value: unknown): value is PermissionExplanationResponse {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PermissionExplanationResponse>;
  return typeof row.channelId === 'string'
    && typeof row.subject === 'string'
    && Array.isArray(row.permissions)
    && row.permissions.every((permission) => permission
      && typeof permission.key === 'string'
      && typeof permission.label === 'string'
      && typeof permission.allowed === 'boolean'
      && (permission.effective === 'allowed' || permission.effective === 'denied')
      && typeof permission.reasonCode === 'string'
      && typeof permission.message === 'string'
      && permission.base != null
      && (permission.base.state === 'allowed' || permission.base.state === 'denied')
      && Array.isArray(permission.base.sources)
      && permission.base.sources.every((source) => typeof source === 'string')
      && Array.isArray(permission.overrides));
}

function isRolePreviewResponse(value: unknown): value is RolePreviewResponse {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RolePreviewResponse>;
  return row.simulation === true
    && !!row.role && typeof row.role.id === 'string' && typeof row.role.name === 'string'
    && !!row.summary
    && ['totalChannels', 'visibleChannels', 'sendableChannels', 'attachableChannels', 'manageableChannels']
      .every((key) => Number.isSafeInteger((row.summary as unknown as Record<string, unknown>)[key]))
    && Array.isArray(row.channels)
    && row.channels.every((channel) => channel
      && typeof channel.channelId === 'string'
      && typeof channel.name === 'string'
      && typeof channel.type === 'string'
      && (channel.categoryId === null || typeof channel.categoryId === 'string')
      && typeof channel.visible === 'boolean'
      && channel.capabilities != null
      && ['sendMessages', 'attachFiles', 'manageMessages', 'connect', 'speak']
        .every((key) => typeof (channel.capabilities as unknown as Record<string, unknown>)[key] === 'boolean'));
}

/**
 * Tek kontrolcü. `ChannelPermSync.svelte` (tarihsel boş kabuk) İKİNCİ bir
 * sahip olarak diriltilmez.
 */
export function createChannelPermsController(serverId: string, channelId: string) {
  // Yüklenen (sunucudaki) durum ve taslak (düzenlenen) durum ayrı tutulur;
  // `dirty` bu ikisinin farkıdır.
  let roles:    PermRole[] = [];
  let loaded    = new Map<string, { allow: number; deny: number }>();
  let draft     = new Map<string, { allow: number; deny: number }>();
  let loading   = false;
  let saving    = false;
  let error: string | null = null;
  let selectedRoleId = '';
  let explanationLoading = false;
  let explanationError: string | null = null;
  let explanation: PermissionExplanationResponse | null = null;
  let rolePreviewLoading = false;
  let rolePreviewError: string | null = null;
  let rolePreview: RolePreviewResponse | null = null;

  function maskOf(map: Map<string, { allow: number; deny: number }>, roleId: string) {
    return map.get(roleId) ?? { allow: 0, deny: 0 };
  }

  /** Bağlam hâlâ geçerli mi? Bayat sunucu/kanal yazımını engeller. */
  function contextValid(): boolean {
    if (!serverId || !channelId) return false;
    const current = getCurrentServerFromRegistry();
    if (!current) return false;
    // Geçerli sunucuyu yalnız bir kez çöz. İki ayrı registry okuması arasında
    // bağlam değişirse ilk okumanın sonucu ile ikinci nesneyi karıştırmak bir
    // TOCTOU penceresi yaratırdı.
    if (String(current._id ?? current.id ?? '') !== serverId) return false;

    // KANAL BAYATLIK KAPISI (§14). Hedef kanal HÂLÂ bu sunucunun kanal
    // listesinde olmalıdır; silinmiş ya da başka bir sunucuya ait bir kimliğe
    // yazılmaz.
    //
    // DİKKAT — "etkin kanal == düzenlenen kanal" DİYE BİR KOŞUL YOKTUR ve
    // olmamalıdır: menü, `ChannelItem` üzerinden ETKİN OLMAYAN bir kanal için
    // açılabilir (asıl kullanım budur). Yanlış kanala yazma riski zaten
    // yapısal olarak yoktur — `channelId` açılışta yakalanır ve isteğin
    // URL'sine gömülüdür; etkin kanal değişse bile URL değişmez.
    const channels = BridgeRegistry.call<Array<{ _id?: string }> | null>('getCurrentServerChannels') ?? null;
    // `null` means the registry owner cannot provide a channel inventory yet;
    // an empty array, however, is authoritative: this server has no channels.
    // Treating both values alike allowed a stale editor to save after the last
    // channel had been removed.
    if (Array.isArray(channels)
        && !channels.some(c => String(c?._id ?? '') === channelId)) return false;

    return true;
  }

  function fail(msg: string): false {
    error = msg;
    return false;
  }

  const api = {
    get snapshot(): ChannelPermsSnapshot {
      return {
        serverId, channelId, roles, loading, saving, error, selectedRoleId,
        dirty: api.isDirty(), explanationLoading, explanationError, explanation,
        rolePreviewLoading, rolePreviewError, rolePreview,
      };
    },

    /** Rolün bir izin biti için ÜÇ DURUMLU hâli. */
    stateOf(roleId: string, bit: number): PermState {
      const m = maskOf(draft, roleId);
      if ((m.allow & bit) === bit) return 'allow';
      if ((m.deny  & bit) === bit) return 'deny';
      return 'inherit';
    },

    /**
     * Üç durumlu ayar. Allow ve Deny AYNI bit için birlikte olamaz —
     * karşılıklı dışlama burada zorlanır.
     */
    setState(roleId: string, bit: number, state: PermState): void {
      const m = { ...maskOf(draft, roleId) };
      m.allow &= ~bit;
      m.deny  &= ~bit;
      if (state === 'allow') m.allow |= bit;
      if (state === 'deny')  m.deny  |= bit;
      draft.set(roleId, m);
    },

    masks(roleId: string) { return maskOf(draft, roleId); },

    isDirty(): boolean {
      const ids = new Set([...loaded.keys(), ...draft.keys()]);
      for (const id of ids) {
        const a = maskOf(loaded, id);
        const b = maskOf(draft, id);
        if (a.allow !== b.allow || a.deny !== b.deny) return true;
      }
      return false;
    },

    reset(): void {
      draft = new Map([...loaded].map(([k, v]) => [k, { ...v }]));
      error = null;
    },

    selectRole(roleId: string): void { selectedRoleId = roleId; },

    async load(): Promise<boolean> {
      if (!contextValid()) return fail(t('perm_context_invalid'));
      loading = true;
      error   = null;
      try {
        const { apiFetch } = await import('../api-fetch.js');
        const { getAPI }   = await import('../globals.js');
        const res = await apiFetch(
          `${getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions`,
        );
        if (!res.ok) {
          return fail(safeApiErrorMessage(res, t('perm_load_failed', 'Kanal izinleri yüklenemedi.'), { report: true }));
        }
        const data = await res.json() as ApiResponse;
        roles  = Array.isArray(data.roles) ? data.roles : [];
        const overrides = Array.isArray(data.overrides) ? data.overrides : [];
        loaded = new Map(overrides.map(o => [o.roleId, { allow: Number(o.allow) || 0, deny: Number(o.deny) || 0 }]));
        draft  = new Map([...loaded].map(([k, v]) => [k, { ...v }]));
        if (!selectedRoleId && roles[0]) selectedRoleId = roles[0]._id;
        return true;
      } catch (e) {
        return fail(safeApiErrorMessage(e, t('perm_load_failed', 'Kanal izinleri yüklenemedi.'), { report: true }));
      } finally {
        loading = false;
      }
    },

    async loadExplanation(): Promise<boolean> {
      if (!contextValid()) {
        explanationError = t('perm_context_invalid');
        return false;
      }
      if (explanationLoading) return false;
      explanationLoading = true;
      explanationError = null;
      try {
        const { apiFetch } = await import('../api-fetch.js');
        const { getAPI } = await import('../globals.js');
        const res = await apiFetch(
          `${getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions/explain/me`,
        );
        if (!res.ok) {
          explanationError = res.status === 403
            ? t('perm_explanation_admin_only')
            : safeApiErrorMessage(res, t('perm_explanation_failed', 'Açıklama yüklenemedi.'), { report: true });
          return false;
        }
        const data = await res.json().catch(() => null) as unknown;
        if (!isPermissionExplanationResponse(data) || data.channelId !== channelId) {
          explanationError = t('perm_explanation_invalid');
          return false;
        }
        explanation = data;
        return true;
      } catch (cause) {
        explanationError = safeApiErrorMessage(cause, t('perm_explanation_failed', 'Açıklama yüklenemedi.'), { report: true });
        return false;
      } finally {
        explanationLoading = false;
      }
    },

    async loadRolePreview(roleId: string): Promise<boolean> {
      if (!contextValid()) {
        rolePreviewError = t('perm_context_invalid');
        return false;
      }
      if (!roleId || rolePreviewLoading) return false;
      rolePreviewLoading = true;
      rolePreviewError = null;
      rolePreview = null;
      try {
        const { apiFetch } = await import('../api-fetch.js');
        const { getAPI } = await import('../globals.js');
        const res = await apiFetch(
          `${getAPI()}/api/servers/${serverId}/roles/${encodeURIComponent(roleId)}/preview`,
        );
        if (!res.ok) {
          rolePreviewError = res.status === 403
            ? t('perm_role_preview_admin_only')
            : safeApiErrorMessage(res, t('perm_role_preview_failed', 'Rol önizlemesi yüklenemedi.'), { report: true });
          return false;
        }
        const data = await res.json().catch(() => null) as unknown;
        if (!isRolePreviewResponse(data) || data.role.id !== roleId) {
          rolePreviewError = t('perm_role_preview_invalid');
          return false;
        }
        rolePreview = data;
        return true;
      } catch (cause) {
        rolePreviewError = safeApiErrorMessage(cause, t('perm_role_preview_failed', 'Rol önizlemesi yüklenemedi.'), { report: true });
        return false;
      } finally {
        rolePreviewLoading = false;
      }
    },

    /**
     * Yalnızca DEĞİŞEN rolleri yazar.
     * allow=0 && deny=0  ⇒  INHERIT  ⇒  DELETE (kanonik davranış; sıfır maske
     * PUT'lamak sahte bir "inherit" olurdu).
     */
    async save(): Promise<boolean> {
      if (saving) return false;                       // çift gönderim koruması
      if (!contextValid()) return fail(t('perm_context_changed'));
      if (!api.isDirty())  return true;

      const known = new Set(roles.map(r => r._id));
      saving = true;
      error  = null;
      try {
        const { apiFetch } = await import('../api-fetch.js');
        const { getAPI }   = await import('../globals.js');
        const base = `${getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions`;

        const ids = new Set([...loaded.keys(), ...draft.keys()]);
        for (const roleId of ids) {
          const before = maskOf(loaded, roleId);
          const after  = maskOf(draft, roleId);
          if (before.allow === after.allow && before.deny === after.deny) continue;

          // Kiracı sınırı: arka uç da doğrular, istemci yanlış istek göndermez.
          if (!known.has(roleId)) return fail(t('perm_role_wrong_server'));

          const inherit = after.allow === 0 && after.deny === 0;
          const res = inherit
            ? await apiFetch(`${base}/${encodeURIComponent(roleId)}`, { method: 'DELETE' })
            : await apiFetch(`${base}/${encodeURIComponent(roleId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allow: after.allow, deny: after.deny }),
              });

          if (!res.ok) {
            return fail(safeApiErrorMessage(res, t('perm_save_failed'), { report: true }));
          }
        }

        // Yalnızca GERÇEK başarıdan sonra kanonik durum güncellenir.
        loaded = new Map([...draft].map(([k, v]) => [k, { ...v }]));
        return true;
      } catch (e) {
        return fail(safeApiErrorMessage(e, t('perm_save_failed'), { report: true }));
      } finally {
        saving = false;
      }
    },
  };

  return api;
}
