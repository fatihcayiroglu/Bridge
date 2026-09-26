// client/js/core/permalink/message-permalink.ts
//
// FAZ K+/4 — MESAJ KALICI BAĞLANTILARI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Arama bir mesaja ATLAYABİLİYORDU ama kimse bir mesaja BAĞLANTI VEREMİYORDU.
// Sohbet ürününde bu günlük bir ihtiyaçtır: "şuna bak" demenin tek yolu
// ekran görüntüsü ya da kopyala-yapıştırdı; ikisi de bağlamı kaybeder.
//
// ── NEDEN HASH ROTASI ─────────────────────────────────────────────────────
// Uygulama tek sayfalık statik bir kabuktur (`index.html`) ve sunucuda SPA
// fallback yoktur: `/servers/x/channels/y` gibi bir yol doğrudan açıldığında
// 404 döner. Hash yolu (`#/servers/...`) sunucuya HİÇ gitmez, bu yüzden
// dağıtım yapılandırmasına dokunmadan çalışır ve mevcut kabuğu bozmaz.
//
// ── YETKİ ─────────────────────────────────────────────────────────────────
// Bağlantı bir ANAHTAR DEĞİLDİR. Yalnızca "nereye gitmek istediğini" taşır;
// gidilebilirlik kanonik sahiplerce ve sunucu tarafından belirlenir. Erişimi
// olmayan biri bağlantıyı açtığında kanal listesinde kanalı bulamaz ve
// gezinme başarısız döner — bu modül hiçbir kontrolü atlamaz.

export interface MessageLocation {
  serverId: string;
  channelId: string;
  messageId: string;
}

/** Kimliklerde beklenen biçim; rota metnine güvenilmez. */
const ID = /^[A-Za-z0-9_:.-]{1,128}$/;

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

/**
 * Kalıcı bağlantı yolunu üretir (mutlak URL değil, YOL).
 *
 * Kaynak (origin) çağırana bırakılır: aynı Bridge örneği farklı adreslerden
 * (localhost, tünel, özel alan adı) sunulabilir ve buraya sabit bir adres
 * gömmek yanlış bağlantı üretirdi.
 */
export function buildPermalinkPath(loc: MessageLocation): string {
  return `#/servers/${encodeURIComponent(loc.serverId)}`
    + `/channels/${encodeURIComponent(loc.channelId)}`
    + `/messages/${encodeURIComponent(loc.messageId)}`;
}

/** Paylaşılabilir tam URL. */
export function buildPermalink(loc: MessageLocation, origin: string): string {
  // Hash'i olan bir adresten çağrılabilir; eskisi atılır.
  const base = origin.split('#')[0] ?? origin;
  return base + buildPermalinkPath(loc);
}

/**
 * Hash yolunu çözer. Tanınmayan / bozuk yol `null` döner — uydurma bir
 * hedefe gitmek, kullanıcıyı sessizce yanlış kanala götürmek olurdu.
 */
export function parsePermalink(hash: string): MessageLocation | null {
  if (!hash) return null;
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = path.split('/').filter(Boolean);

  // servers/:sid/channels/:cid/messages/:mid
  if (parts.length !== 6) return null;
  if (parts[0] !== 'servers' || parts[2] !== 'channels' || parts[4] !== 'messages') return null;

  let serverId: string, channelId: string, messageId: string;
  try {
    serverId  = decodeURIComponent(parts[1]!);
    channelId = decodeURIComponent(parts[3]!);
    messageId = decodeURIComponent(parts[5]!);
  } catch {
    // Bozuk yüzde kodlaması.
    return null;
  }

  if (!isId(serverId) || !isId(channelId) || !isId(messageId)) return null;
  return { serverId, channelId, messageId };
}

/**
 * Panoya yazar.
 *
 * `navigator.clipboard` güvenli olmayan bağlamda (http, bazı webview'ler)
 * YOKTUR. Sessizce başarısız olmak yerine sonuç raporlanır; çağıran
 * kullanıcıya bağlantıyı elle kopyalatabilir.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
