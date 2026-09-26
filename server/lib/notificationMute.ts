// server/lib/notificationMute.ts
//
// SESSIZE ALMA KARARI — TEK SAHIP
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN IKI GERCEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
//
// 1. `muteUntil` HIC KARSILASTIRILMIYORDU.
//    Kullanici bir kanali "bugun 15:00'e kadar sustur" diye ayarlayabiliyor,
//    deger `notification_prefs.muteUntil` alanina yaziliyor ve API yanitinda
//    geri donuyordu — ama uygulama tarafinda HICBIR YERDE okunmuyordu.
//    Enforcement yalnizca `level === 'mute'` bakiyordu.
//
//    Sonuc: GECICI sessize alma KALICI oluyordu. Kullanici "birkac saatligine
//    sustur" dedigi kanaldan bir daha hic haber almiyordu ve bunun sebebini
//    anlamasinin bir yolu yoktu.
//
// 2. OKUNMAMIS ROZETLERI SESSIZE ALMAYI YOK SAYIYORDU.
//    Sessize alma su dort yerde tutarli bicimde uygulaniyordu:
//      · lib/notifications.ts        (bildirim kaydi)
//      · lib/pushSender.ts           (push)
//      · socket/handlers/messages-send.ts (yanit dikkati)
//      · socket/handlers/messages-send.ts (mention soket olayi)
//    ama `GET /api/notification-prefs/unread` bunu HIC dikkate almiyordu.
//    Yani kullanici kanali susturuyor, bildirim/push kesiliyor, fakat
//    okunmamis rozeti dikkat istemeye DEVAM ediyordu — sistemin kendi
//    kuralindan sapan tek nokta.
//
// ── NEDEN TEK SAHIP ───────────────────────────────────────────────────────
// Karar bes ayri yerde tekrarlanıyordu ve biri (unread) sapmisti. Kural
// artik BURADA tanimlidir; cagiranlar yalnizca sorar. Yeni bir enforcement
// noktasi eklendiginde ayni kurali yeniden yazmak gerekmez.

/** Sessize alma icin gereken en kucuk tercih sekli. */
export interface MutablePref {
  level?: string | null;
  /** Zaman damgasi; `null`/`undefined` = SURESIZ sessiz. */
  muteUntil?: number | null;
}

/**
 * Bu tercih SU AN sessize alinmis mi?
 *
 * @param pref Kanal tercihi (yoksa sessiz DEGILDIR).
 * @param now  Karsilastirma ani — testte sabitlenebilsin diye disaridan.
 */
const VALID_NOTIFICATION_LEVELS = new Set(['all', 'mentions', 'mute', 'default']);

/** Persisted notification levels are security/privacy-adjacent attention policy. */
export function normalizeNotificationLevel(value: unknown, hasPersistedPref = true): 'all' | 'mentions' | 'mute' | 'default' {
  if (!hasPersistedPref) return 'all';
  if (typeof value === 'string' && VALID_NOTIFICATION_LEVELS.has(value))
    return value as 'all' | 'mentions' | 'mute' | 'default';
  // Unknown/corrupt persisted values fail CLOSED: suppress attention rather
  // than silently interpreting an invalid preference as `all`.
  return 'mute';
}

export function isMuted(pref: MutablePref | null | undefined, now: number = Date.now()): boolean {
  if (!pref) return false;
  const normalizedLevel = normalizeNotificationLevel(pref.level, true);
  if (normalizedLevel !== 'mute') return false;

  // Invalid persisted LEVEL becomes a fail-closed indefinite mute. It has no
  // meaningful muteUntil contract because the original intent is unknown.
  if (pref.level !== 'mute') return true;

  const until = pref.muteUntil;
  // `null`/`undefined` = suresiz sessizlik (kullanici "kalici" secti).
  if (until === null || until === undefined) return true;

  // Sayi olmayan bozuk deger SURESIZ sayilir: kullanicinin acik "sustur"
  // istegini bozuk bir alan yuzunden GORMEZDEN GELMEK, yanlis yonde hata
  // yapmak olurdu (istemedigi bildirimi alir).
  if (typeof until !== 'number' || Number.isNaN(until)) return true;

  return until > now;
}

/** Sessizlik suresi dolmus mu? (temizlik/gosterim icin) */
export function isMuteExpired(pref: MutablePref | null | undefined, now: number = Date.now()): boolean {
  if (!pref || pref.level !== 'mute') return false;
  const until = pref.muteUntil;
  if (until === null || until === undefined) return false;
  if (typeof until !== 'number' || Number.isNaN(until)) return false;
  return until <= now;
}


/** Effective notification policy after channel -> server -> default inheritance. */
export interface EffectiveNotificationPref extends MutablePref {
  level: 'all' | 'mentions' | 'mute';
}

function activeLevel(
  pref: MutablePref | null | undefined,
  now: number,
): 'all' | 'mentions' | 'mute' | 'default' {
  if (!pref) return 'default';
  const level = normalizeNotificationLevel(pref.level, true);
  // A timed mute that has expired no longer owns the channel/server. Falling
  // through is important: a channel snooze should return to its server policy,
  // not silently become `all` forever.
  if (level === 'mute' && isMuteExpired(pref, now)) return 'default';
  return level;
}

/**
 * Resolve the one policy every notification surface must use.
 *
 * Channel override -> server default -> product default (`all`). Corrupt
 * persisted values normalize fail-closed to `mute` through
 * `normalizeNotificationLevel`.
 */
export function effectiveNotificationPref(
  channelPref: MutablePref | null | undefined,
  serverPref: MutablePref | null | undefined,
  now: number = Date.now(),
): EffectiveNotificationPref {
  const channelLevel = activeLevel(channelPref, now);
  if (channelLevel !== 'default') {
    return { level: channelLevel, muteUntil: channelPref?.muteUntil ?? null };
  }

  const serverLevel = activeLevel(serverPref, now);
  if (serverLevel !== 'default') {
    return { level: serverLevel, muteUntil: serverPref?.muteUntil ?? null };
  }

  return { level: 'all', muteUntil: null };
}
