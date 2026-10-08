// server/lib/userUtils.ts

export interface SafeUser {
  _id: string;
  id: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
  avatarUrl: string | null;
  status?: string;
  statusText?: string;
  statusEmoji?: string;
  createdAt?: number;
  bio: string;
  website: string;
  location: string;
  pronouns: string;
  bannerColor: string;
  bannerUrl: string | null;
  badge?: string;
  isAdmin?: true;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function sanitizeUser(u: null | undefined): null;
export function sanitizeUser(u: object): SafeUser;
export function sanitizeUser(u: object | null | undefined): SafeUser | null {
  if (!u) return null;
  const row = u as Record<string, unknown>;
  return {
    _id:         asString(row._id),
    id:          asString(row._id),
    username:    asString(row.username),
    displayName: asOptionalString(row.displayName) ?? asString(row.username),
    avatarColor: asOptionalString(row.avatarColor),
    avatarUrl:   asNullableString(row.avatarUrl),
    status:      asOptionalString(row.status),
    statusText:   asOptionalString(row.statusText),
    statusEmoji:  asOptionalString(row.statusEmoji),
    createdAt:    typeof row.createdAt === 'number' ? row.createdAt : undefined,
    bio:         asString(row.bio),
    website:     asString(row.website),
    location:    asString(row.location),
    pronouns:    asString(row.pronouns),
    bannerColor: asString(row.bannerColor),
    bannerUrl:   asNullableString(row.bannerUrl),
    badge:       asOptionalString(row.badge),
    isAdmin:     row.isAdmin ? true : undefined,
  };
}

export type DmPrivacy = 'everyone' | 'friends' | 'none';
export type PresenceVisibility = 'visible' | 'hidden';
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export const DM_PRIVACY_VALUES: readonly DmPrivacy[] = ['everyone', 'friends', 'none'];
export const PRESENCE_VISIBILITY_VALUES: readonly PresenceVisibility[] = ['visible', 'hidden'];
export const PRESENCE_STATUS_VALUES: readonly PresenceStatus[] = ['online', 'idle', 'dnd', 'offline'];

// ════════════════════════════════════════════════════════════════════════════
// ALAN DIŞI DEĞERLER İÇİN TEK KANONİK YORUM
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR: bu iki sütun `TEXT NOT NULL` idi ve CHECK kısıtı YOKTU. Canlı
// bir PostgreSQL'de doğrulandı — hem TAZE KURULUM hem TAM DAĞITIM
// `dmPrivacy='nobody'` ve `presenceVisibility='Hidden'` yazmayı KABUL ediyordu.
// `migrations_pg/017` ve `026` kısıtı tanımlıyordu ama `db/postgres/schema.ts`
// sütunu ÖNCE oluşturduğu için `ADD COLUMN IF NOT EXISTS` hiç çalışmıyordu.
// Kısıt artık eklendi (bkz. `migrations_pg/044`), ama savunma tek katman olamaz.
//
// ASIL TEHLİKE OKUMA TARAFINDAYDI. DM kontrolleri ham dizgeyi kullanıyordu:
//
//     if (p && p !== 'everyone') { if (p === 'none') deny; if (p === 'friends') … }
//
// Alan dışı bir değer (`'None'`, `'nobody'`, `'NONE'`) HİÇBİR dala girmez ve
// sessizce İZİN VERİLİR — kullanıcının koyduğu gizlilik kısıtı fark edilmeden
// ortadan kalkar. Bu FAIL-OPEN bir yoldur.
//
// Çözüm: okuma tarafları ham dizgeyi değil bu normalleştiricileri kullanır;
// bilinmeyen değer TANIMLI bir sonuca eşlenir ve davranış uygulamanın geri
// kalanıyla (`sanitizeOwnUser`) AYNI olur.
//
// Güvenlik kuralı: kalıcı gizlilik/authorization verisi alan dışındaysa
// yorum EN GENİŞ erişime düşmemelidir. DB satırı burada yeniden yazılmaz; yalnız
// runtime kararı fail-closed verilir. Böylece bozuk/legacy bir değer düzeltilene
// kadar yeni DM açılışı reddedilir ve presence görünmez kalır.

/** Ham `dmPrivacy` değerini kanonik alana eşler; bilinmeyen değer fail-closed `none`. */
export function normalizeDmPrivacy(value: unknown): DmPrivacy {
  if (value === 'everyone' || value === 'friends' || value === 'none') return value;
  return 'none';
}

/** Ham `presenceVisibility` değerini kanonik alana eşler; bilinmeyen değer `hidden`. */
export function normalizePresenceVisibility(value: unknown): PresenceVisibility {
  if (value === 'visible' || value === 'hidden') return value;
  return 'hidden';
}

/** Preferred presence is private account state; unknown values fall back to online. */
export function normalizePresenceStatus(value: unknown): PresenceStatus {
  if (value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline') return value;
  return 'online';
}

export type OwnUser = SafeUser & {
  presenceVisibility: PresenceVisibility;
  dmPrivacy: DmPrivacy;
  presenceStatus: PresenceStatus;
  /** The language this person reads (Final21 Phase 16); null until the client reports it. */
  locale: string | null;
  /** Own recovery address (Settings > Security) — returned ONLY on self-auth surfaces. */
  email: string | null;
  emailVerified: boolean;
  /** P7 B2: the account has a password (SSO-only accounts do not). The hash is never returned. */
  hasPassword: boolean;
};

/** Private preferences are returned only on self-auth surfaces. */
export function sanitizeOwnUser(u: object): OwnUser {
  const row = u as Record<string, unknown>;
  return {
    ...sanitizeUser(u),
    presenceVisibility: normalizePresenceVisibility(row.presenceVisibility),
    dmPrivacy: normalizeDmPrivacy(row.dmPrivacy),
    presenceStatus: normalizePresenceStatus(row.presenceStatus),
    // Returned so the client can tell whether the server already knows the reader's language.
    locale: typeof row.locale === 'string' && row.locale ? row.locale : null,
    // Final21 UX: account recovery needs the owner to see which address resets reach.
    email: typeof row.email === 'string' && row.email ? row.email : null,
    emailVerified: row.emailVerified === true || row.emailVerified === 1 || row.emailVerified === '1' || row.emailVerified === 't',
    // P7 B2: whether the account has a password at all (SSO-only accounts do not), so
    // the owner's settings can offer deletion through a sign-in proof instead. Only the
    // fact is returned — never the hash.
    hasPassword: typeof row.password === 'string' && row.password.length > 0,
  };
}
