// client/js/core/unread/unread-store.ts
//
// FAZ 8/2 — OKUNMAMIŞ DURUMU (saf çekirdek).
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu okunmamışları ZATEN sayıyordu (`lib/notifications.ts:incrementUnread`
// → `unread_counts`) ve okuma ucu da vardı (`GET /api/notification-prefs/unread`,
// VIEW_CHANNELS ile süzülmüş). İstemcide ise `UnreadBadge` sözleşmesini
// (`setChannelUnread` / `getUnreadCount` / `getMentionCount`) ÇAĞIRAN kimse
// yoktu: kullanıcı nerede yeni mesaj olduğunu göremiyordu.
//
// Bu modül DOM'a ve ağa dokunmaz — yalnızca durum ve matematik. Böylece
// "yeni mesaj sayacı artırır", "kanal açılınca sıfırlanır", "bahsedilme
// önceliklidir" gibi kurallar tarayıcı olmadan test edilir.
//
// ── TEK SAYIM YERİ ────────────────────────────────────────────────────────
// Sayacın KAYNAĞI sunucudur. Bu depo yalnızca iki şey yapar: sunucudan gelen
// anlık görüntüyü tutar ve iki olay arası farkı (yeni mesaj / kanal açılışı)
// yerel olarak yansıtır. Kendi doğrusunu ÜRETMEZ; yeniden bağlanmada sunucu
// anlık görüntüsü her zaman kazanır.

export interface ChannelUnread {
  channelId: string;
  serverId: string;
  count: number;
  /** Bu kanalda çağıranı hedefleyen bir bahsetme var mı? */
  mention: boolean;
}

export interface UnreadSnapshot {
  channels: ChannelUnread[];
}

/** Kanal → sunucu eşlemesi çağırandan gelir (kanonik kanal listesi). */
export type ChannelServerLookup = (channelId: string) => string | undefined;

export class UnreadStore {
  private byChannel = new Map<string, ChannelUnread>();

  /** Sunucu anlık görüntüsü — yerel durumu TAMAMEN değiştirir. */
  replaceAll(rows: ReadonlyArray<{ channelId: string; count: number; serverId?: string; mention?: boolean }>,
             lookup: ChannelServerLookup = () => undefined): void {
    this.byChannel.clear();
    for (const row of rows) {
      const count = Number(row.count);
      if (!row.channelId || !Number.isFinite(count) || count <= 0) continue;
      this.byChannel.set(row.channelId, {
        channelId: row.channelId,
        serverId: row.serverId ?? lookup(row.channelId) ?? '',
        count,
        mention: Boolean(row.mention),
      });
    }
  }

  /**
   * Yeni mesaj geldi.
   *
   * AKTİF kanal çağıran tarafından elenir — burada "aktif" bilgisi yoktur ve
   * olmamalıdır: bu depo hangi kanalın açık olduğunu bilmez, yalnızca sayar.
   */
  increment(channelId: string, serverId: string, opts: { mention?: boolean } = {}): void {
    if (!channelId) return;
    const existing = this.byChannel.get(channelId);
    this.byChannel.set(channelId, {
      channelId,
      serverId: serverId || existing?.serverId || '',
      count: (existing?.count ?? 0) + 1,
      // Bahsetme bayrağı YAPIŞKANDIR: bir kez bahsedildiyse, kanal açılana
      // kadar sonraki sıradan mesajlar önceliği düşürmemelidir.
      mention: Boolean(existing?.mention) || Boolean(opts.mention),
    });
  }

  /** Kanal açıldı — sunucu da `GET .../messages` sırasında temizler. */
  clear(channelId: string): void {
    this.byChannel.delete(channelId);
  }

  countFor(channelId: string): number {
    return this.byChannel.get(channelId)?.count ?? 0;
  }

  hasMention(channelId: string): boolean {
    return this.byChannel.get(channelId)?.mention ?? false;
  }

  channels(): ChannelUnread[] {
    return [...this.byChannel.values()];
  }

  /** Sunucu rozeti: kanallarının toplamı. */
  serverTotal(serverId: string): number {
    let total = 0;
    for (const row of this.byChannel.values()) if (row.serverId === serverId) total += row.count;
    return total;
  }

  /** Sunucu rozeti KIRMIZI mı (bahsetme var mı)? */
  serverHasMention(serverId: string): boolean {
    for (const row of this.byChannel.values()) if (row.serverId === serverId && row.mention) return true;
    return false;
  }

  total(): number {
    let total = 0;
    for (const row of this.byChannel.values()) total += row.count;
    return total;
  }

  mentionTotal(): number {
    let total = 0;
    for (const row of this.byChannel.values()) if (row.mention) total += row.count;
    return total;
  }

  /** Sunucu kimliği sonradan öğrenilirse (kanal listesi geç yüklenir). */
  backfillServerIds(lookup: ChannelServerLookup): void {
    for (const row of this.byChannel.values()) {
      if (row.serverId) continue;
      const serverId = lookup(row.channelId);
      if (serverId) this.byChannel.set(row.channelId, { ...row, serverId });
    }
  }
}

/** Rozet metni — üç haneli sayılar yerleşimi bozmasın. */
export function badgeLabel(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}
