// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DiscordImportParserPanel.svelte
//              client/js/core/discord-import-parser-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/discord-import-parser.ts
// Discord Import Sihirbazı — JSON parse + doğrulama mantığı
// discord-import.ts tarafından import edilir.

export interface ParsedChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  position: number;
}

export interface ParsedRole {
  id: string;
  name: string;
  color: number;
}

export interface ParsedDiscordData {
  name: string;
  icon: string;
  categories: Record<string, ParsedChannel[]>;
  roles: ParsedRole[];
  rawChannels?: ParsedChannel[];
}

export interface ImportPayload {
  name: string;
  icon: string;
  categories: Array<{ name: string; channels: ParsedChannel[] }>;
  roles: ParsedRole[];
}

/**
 * Ham Discord dışa aktarma JSON'unu Bridge-uyumlu yapıya dönüştürür.
 * Hem manuel hem de bot çıktısı formatını destekler.
 */
export function parseDiscordData(data: Record<string, unknown>): ParsedDiscordData {
  const name = (data.name as string) || 'İçe Aktarılan Sunucu';
  const icon = (data.icon as string) || '🌐';
  const roles: ParsedRole[] = ((data.roles as ParsedRole[]) || []).filter(
    (r) => r.name && r.name !== '@everyone',
  );

  // Bot çıktısı: düz channels dizisi → kategorilere grupla
  const rawChannels = (data.channels as ParsedChannel[]) || [];
  const categories: Record<string, ParsedChannel[]> = {};

  if (rawChannels.length > 0) {
    // Kategori kanallarını (type=4) bul
    const catMap: Record<string, string> = {};
    rawChannels
      .filter((c) => c.type === 4)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .forEach((c) => {
        catMap[c.id] = c.name;
        categories[c.name] = [];
      });

    // Alt kanalları kategorilere dağıt
    rawChannels
      .filter((c) => c.type !== 4)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .forEach((c) => {
        const catName = c.parent_id ? catMap[c.parent_id] || 'Genel' : 'Genel';
        if (!categories[catName]) categories[catName] = [];
        categories[catName].push(c);
      });
  } else if (data.categories && typeof data.categories === 'object') {
    // Manuel format: kategoriler doğrudan verilmiş
    Object.assign(categories, data.categories);
  }

  return { name, icon, categories, roles, rawChannels };
}

/**
 * JSON textarea içeriğini doğrular ve ParsedDiscordData döner.
 * Hata varsa string mesaj fırlatır.
 */
export function validateAndParseJSON(raw: string): ParsedDiscordData {
  if (!raw.trim()) throw new Error('JSON boş olamaz.');

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Geçersiz JSON formatı. Lütfen kontrol edin.');
  }

  if (!data.name && !data.channels && !data.categories) {
    throw new Error(
      'Tanınan bir Discord dışa aktarma formatı değil. ' +
      '"name", "channels" veya "categories" alanları bulunamadı.',
    );
  }

  return parseDiscordData(data);
}

/**
 * ParsedDiscordData + manuel kategorilerden import payload'u oluşturur.
 */
export function buildImportPayload(
  method: 'json' | 'manual',
  parsedData: ParsedDiscordData | null,
  manualCats: Array<{ name: string; channels: ParsedChannel[] }>,
  serverName: string,
  serverIcon: string,
): ImportPayload {
  if (method === 'json' && parsedData) {
    return {
      name: parsedData.name,
      icon: parsedData.icon || '🌐',
      categories: Object.entries(parsedData.categories).map(([name, channels]) => ({
        name,
        channels,
      })),
      roles: parsedData.roles || [],
    };
  }

  // Manuel mod
  return {
    name: serverName || 'Yeni Sunucu',
    icon: serverIcon || '🌐',
    categories: manualCats.map((c) => ({ name: c.name, channels: c.channels })),
    roles: [],
  };
}
