// server/lib/accountLifecycle.ts
//
// KİŞİSEL VERİ YAŞAM DÖNGÜSÜ — TEK KANONİK POLİTİKA
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN AÇIK BİR POLİTİKA TABLOSU
// ════════════════════════════════════════════════════════════════════════════
// Canlı şemada kullanıcıya referans veren 53 tablo vardır, ama `users`
// tablosuna giden YALNIZCA 3 yabancı anahtar vardır:
//
//     server_event_rsvp.user_id  → CASCADE
//     server_events.creator_id   → SET NULL
//     user_ap_keys.userId        → CASCADE
//
// Yani veritabanı seviyesinde İŞLEYEN BİR CASCADE YOKTUR. Düz bir
// `DELETE FROM users` 50 tabloda ASILI KALMIŞ referans bırakır: yazarı
// olmayan mesajlar, var olmayan bir kullanıcıya erişim veren üyelikler,
// sahibi olmayan yüklemeler.
//
// Bu yüzden her veri sınıfı BURADA açıkça sınıflandırılır. Yeni bir tablo
// eklenip buraya yazılmazsa `assertPolicyCoversSchema()` testi DÜŞER —
// sessizce unutulamaz.
//
// ── SINIFLAR ──────────────────────────────────────────────────────────────
//   DELETE       : satır tamamen silinir (yalnızca o kullanıcıya ait).
//   ANONYMIZE    : satır KALIR, kimlik bağı koparılır. Paylaşılan sohbet
//                  bağlamı başkalarının verisidir; silmek onların
//                  geçmişini bozar.
//   RETAIN       : güvenlik/denetim gereği korunur (moderasyon kayıtları).
//   TRANSFER_REQ : silmeden ÖNCE insan kararı gerekir (sunucu sahipliği).

/** Bir veri sınıfının hesap silinirken göreceği işlem. */
export type Disposition = 'DELETE' | 'ANONYMIZE' | 'RETAIN' | 'TRANSFER_REQUIRED';

export interface LifecycleRule {
  table: string;
  /** Kullanıcıyı işaret eden sütun(lar). */
  columns: string[];
  disposition: Disposition;
  /** Neden bu sınıf — karar gerekçesi koda gömülür. */
  why: string;
}

// ════════════════════════════════════════════════════════════════════════════
// POLİTİKA
// ════════════════════════════════════════════════════════════════════════════
export const LIFECYCLE: LifecycleRule[] = [
  // ── Kimlik ve oturum: KOŞULSUZ SİLİNİR ────────────────────────────────
  { table: 'refresh_tokens',        columns: ['userId'],   disposition: 'DELETE',
    why: 'Oturum sürdürme. Hesap gidince hiçbir anlamı yok.' },
  { table: 'oauth_tokens',          columns: ['userId'],   disposition: 'DELETE',
    why: 'Üçüncü taraf erişim jetonu — sır niteliğinde.' },
  { table: 'webauthn_credentials',  columns: ['userId'],   disposition: 'DELETE',
    why: 'Donanım anahtarı kaydı; kimlik doğrulama sırrı.' },
  { table: 'user_ap_keys',          columns: ['userId'],   disposition: 'DELETE',
    why: 'ActivityPub ÖZEL anahtarı. FK zaten CASCADE.' },
  { table: 'push_subscriptions',    columns: ['userId'],   disposition: 'DELETE',
    why: 'Cihaz bildirim adresi — kişisel.' },
  { table: 'native_push_tokens',    columns: ['userId'],   disposition: 'DELETE',
    why: 'Cihaz bildirim jetonu — kişisel.' },
  { table: 'fcm_tokens',            columns: ['userId'],   disposition: 'DELETE',
    why: 'Cihaz bildirim jetonu — kişisel.' },

  // ── Kişisel tercih ve türetilmiş durum ────────────────────────────────
  { table: 'notification_prefs',    columns: ['userId'],   disposition: 'DELETE',
    why: 'Yalnızca bu kullanıcıya ait tercih.' },
  { table: 'notification_keywords', columns: ['userId'], disposition: 'DELETE',
    why: 'Kullanıcının sunucu bazlı watch-word bildirim tercihleri; kişisel.' },
  { table: 'unread_counts',         columns: ['userId'],   disposition: 'DELETE',
    why: 'Türetilmiş okunmamış sayacı; kişisel.' },
  { table: 'channel_read_positions', columns: ['userId'], disposition: 'DELETE',
    why: 'Kullanıcının kanal başına kronolojik okuma konumu; kişisel türetilmiş durum.' },
  { table: 'saved_messages',        columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının kendi kaydettiği mesaj yer imleri; kimseyle paylaşılmaz.' },
  { table: 'message_reports',       columns: ['reporterId'], disposition: 'DELETE',
    why: 'Kullanıcının kendi gönderdiği açık/kapalı mesaj raporu; reporter FK zaten CASCADE.' },
  { table: 'soundboard_user_stats', columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının kişisel favori ve çalma geçmişi; FK zaten CASCADE.' },
  { table: 'onboarding_completions',columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının kendi tanıtım turu ilerlemesi; kimseyle paylaşılmaz.' },
  { table: 'user_badges',           columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının kendi profil rozetleri; profil gidince anlamsız.' },
  { table: 'user_connections',      columns: ['userId'],   disposition: 'DELETE',
    why: 'Bağlı hesaplar — kişisel ve sır içerebilir.' },
  { table: 'scheduled_msgs',        columns: ['userId'],   disposition: 'DELETE',
    why: 'Henüz gönderilmemiş taslak; kimse görmedi.' },
  { table: 'bot_ratings',           columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının bota verdiği kendi puanı; toplam yeniden hesaplanır.' },
  { table: 'server_event_rsvp',     columns: ['user_id'],  disposition: 'DELETE',
    why: 'Katılım beyanı; kişisel. FK zaten CASCADE.' },
  { table: 'channel_follows',       columns: ['followedByUserId'], disposition: 'DELETE',
    why: 'Kullanıcının kendi kanal takip tercihi; başkasını etkilemez.' },
  { table: 'server_boosts',         columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının sunucuya verdiği kendi destek kaydı.' },
  { table: 'canvas_strokes',        columns: ['userId'],   disposition: 'DELETE',
    why: 'Kullanıcının kendi tuval çizimleri; paylaşılan içerik değil.' },

  // ── Sosyal graf: KARŞILIKLI, İKİ YÖN DE SİLİNİR ───────────────────────
  { table: 'friendships',           columns: ['userId', 'friendId'],   disposition: 'DELETE',
    why: 'Karşılıklı bağ. Tek yön kalırsa hayalet arkadaş görünür.' },
  { table: 'blocks',                columns: ['blockerId', 'blockedId'], disposition: 'DELETE',
    why: 'Hesap gidince engelin konusu kalmaz.' },

  // ── Üyelik ve erişim: SİLİNİR (aksi hâlde hayalet erişim) ─────────────
  { table: 'members',               columns: ['userId'],   disposition: 'DELETE',
    why: 'Üyelik erişim HAKKIDIR. Kalırsa var olmayan bir kimliğe yetki verir.' },
  { table: 'group_dm_members',      columns: ['userId'],   disposition: 'DELETE',
    why: 'Grup DM üyeliği erişim hakkıdır.' },
  { table: 'channel_overrides',     columns: ['targetId'], disposition: 'DELETE',
    why: 'Kullanıcıya özel kanal izni; hedef yoksa anlamsız.' },

  // ── Paylaşılan içerik: ANONİMLEŞTİRİLİR ───────────────────────────────
  // Bu satırlar YALNIZCA silinen kullanıcının verisi DEĞİLDİR. Bir sohbet
  // karşılıklıdır; mesajları silmek KALAN kullanıcıların geçmişini deler.
  // Sektör standardı da budur: içerik kalır, kimlik bağı kopar.
  { table: 'messages',              columns: ['userId'],   disposition: 'ANONYMIZE',
    why: 'Paylaşılan sohbet bağlamı; kalan üyelerin geçmişi korunur.' },
  { table: 'dm_messages',           columns: ['userId'],   disposition: 'ANONYMIZE',
    why: 'Karşı tarafın da konuşmasıdır.' },
  { table: 'group_dm_messages',     columns: ['userId'],   disposition: 'ANONYMIZE',
    why: 'Grup sohbeti; diğer katılımcıların geçmişi.' },
  { table: 'thread_messages',       columns: ['userId'],   disposition: 'ANONYMIZE',
    why: 'Konu başlığı altındaki paylaşılan tartışma.' },
  { table: 'voice_messages',        columns: ['userId'],   disposition: 'ANONYMIZE',
    why: 'Gönderildiği sohbetin parçası.' },
  { table: 'threads',               columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Konu başlığı başkalarınca kullanılıyor olabilir.' },
  { table: 'polls',                 columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Anket sonuçları topluluğun verisidir.' },
  { table: 'invites',               columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Davet hâlâ geçerli olabilir; sunucunun işleyişine ait.' },
  { table: 'server_emojis',         columns: ['uploadedBy'], disposition: 'ANONYMIZE',
    why: 'Sunucunun varlığı; yükleyen ayrılınca emoji kaybolmamalı.' },
  { table: 'server_gifs',           columns: ['uploadedBy'], disposition: 'ANONYMIZE',
    why: 'Sunucunun ortak GIF varlığı; yükleyen ayrılınca kaybolmamalı.' },
  { table: 'soundboard',            columns: ['uploadedBy'], disposition: 'ANONYMIZE',
    why: 'Sunucunun ortak ses varlığı; yükleyen ayrılınca kaybolmamalı.' },
  { table: 'sticker_packs',         columns: ['authorId'],  disposition: 'ANONYMIZE',
    why: 'Sunucunun varlığı; çıkartmalar korunur.' },
  { table: 'server_templates',      columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Başkaları bu şablonu kullanıyor olabilir.' },
  { table: 'automod_rules',         columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Sunucu koruması çalışmaya devam etmeli.' },
  { table: 'reaction_roles',        columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Sunucu otomasyonu çalışmaya devam etmeli.' },
  { table: 'channel_bridges',       columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Köprü sunucular arası; kurucu ayrılınca kopmamalı.' },
  { table: 'outgoing_webhooks',     columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Sunucu entegrasyonu çalışmaya devam etmeli.' },
  // ── POLİTİKA BOŞLUĞU KAPATILDI ──────────────────────────────────────────
  // `webhooks` (GELEN kanal webhook'ları) ve `podcast_episodes` şemada
  // `createdBy` taşıyor ama politikada SINIFLANDIRILMAMIŞTI. Sınıflandırılmayan
  // bir tablo hesap silme sırasında ATLANIR: kullanıcı hesabını sildikten sonra
  // kişisel referansı bu satırlarda GERİDE KALIRDI (silme hakkı ihlali) ve
  // kalan referans temizlik/bütünlük işlerini de yanıltabilirdi.
  //
  // Sınıflandırma kardeş kayıtlarla aynı gerekçeye dayanır: bunlar SUNUCUYA ait
  // entegrasyon/içeriktir; kurucusu ayrılınca çalışmayı sürdürmeleri gerekir,
  // bu yüzden satır silinmez, kişisel bağ ANONİMLEŞTİRİLİR.
  { table: 'webhooks',              columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Kanal webhook entegrasyonu kurucusu ayrılınca da çalışmaya devam etmeli.' },
  { table: 'podcast_episodes',      columns: ['createdBy'], disposition: 'ANONYMIZE',
    why: 'Yayınlanmış bölüm sunucu içeriğidir; kaydı silmek diğer üyelerin '
       + 'erişimini koparırdı. Kişisel bağ anonimleştirilir.' },
  { table: 'uploads',               columns: ['userId'],    disposition: 'ANONYMIZE',
    why: 'Dosya hâlâ bir mesajda REFERANSLI olabilir. Kaydı silmek temizlik '
       + 'işinin dosyayı sahipsiz sanmasına ve SİLMESİNE yol açardı.' },
  // Final21 Faz 19: tek kural iki sütunu da ANONİMLEŞTİRİYORDU; gerekçe ise "userId satırları
  // silinir" diyordu. Kişiye GELEN bildirimler kimsenin okuyamayacağı `deleted-user` satırları
  // olarak kalıyordu. Kural gerekçesine uygun olarak ikiye ayrıldı.
  { table: 'notifications',         columns: ['userId'], disposition: 'DELETE',
    why: 'Kişiye gelen bildirimler yalnızca onun okuması içindir; alıcı gidince anlamsız.' },
  { table: 'notifications',         columns: ['actorId'], disposition: 'ANONYMIZE',
    why: 'Kişinin tetiklediği bildirim BAŞKASININ gelen kutusudur; satır kalır, kimlik bağı kopar.' },

  // ── Federasyon: uzak taraf zaten kopyaya sahip ────────────────────────
  { table: 'ap_activities',         columns: ['actorUserId', 'targetUserId'], disposition: 'ANONYMIZE',
    why: 'Federe kayıt; uzak sunucularda kopyası var.' },
  { table: 'ap_announces',          columns: ['fromUserId', 'targetUserId'],  disposition: 'ANONYMIZE',
    why: 'Federe etkileşim kaydı; uzak sunucularda kopyası bulunur.' },
  { table: 'ap_follows',            columns: ['targetUserId'], disposition: 'DELETE',
    why: 'Takip ilişkisi; hedef gidince anlamsız.' },
  { table: 'ap_likes',              columns: ['fromUserId', 'targetUserId'], disposition: 'ANONYMIZE',
    why: 'Federe etkileşim kaydı.' },
  { table: 'ap_messages',           columns: ['targetUserId'], disposition: 'ANONYMIZE',
    why: 'Federe mesaj kaydı; uzak sunucularda kopyası bulunur.' },
  { table: 'ap_outgoing_follows',   columns: ['fromUserId'], disposition: 'DELETE',
    why: 'Kullanıcının kendi başlattığı federe takip isteği.' },

  // ── Güvenlik/denetim: KORUNUR ─────────────────────────────────────────
  // Moderasyon kayıtları sunucunun GÜVENLİĞİ için tutulur: bir yasaklama
  // kaydının kimin tarafından yapıldığı, hesap silinse de sunucu
  // yöneticileri için gereklidir. Silinen kullanıcı adına değil, EYLEME
  // aittir.
  { table: 'audit_logs',            columns: ['actorId', 'targetId'], disposition: 'RETAIN',
    why: 'Moderasyon denetim izi; sunucu güvenliği gereği korunur.' },
  { table: 'client_error_events',   columns: ['user_id'], disposition: 'ANONYMIZE',
    why: 'Hata teşhisi için tutulur; kimlik bağı teşhis için gereksizdir.' },
  { table: 'bot_marketplace',       columns: ['submittedBy'], disposition: 'ANONYMIZE',
    why: 'Pazar yerindeki bot listesi başkalarınca kuruluyor olabilir; '
       + 'liste kalır, gönderen kimliği kopar.' },
  { table: 'bot_marketplace_reviews', columns: ['reviewerId'], disposition: 'RETAIN',
    why: 'Yönetici onay/ret kaydı — moderasyon denetim izidir, '
       + 'audit_logs ile aynı gerekçeyle korunur.' },

  // ── İNSAN KARARI GEREKTİRİR ───────────────────────────────────────────
  { table: 'servers',               columns: ['ownerId'], disposition: 'TRANSFER_REQUIRED',
    why: 'Bir sunucunun sahipsiz kalması KABUL EDİLEMEZ; sessiz devir de '
       + 'kabul edilemez. Silmeden önce devir veya sunucu silme gerekir.' },
  { table: 'bots',                  columns: ['ownerId'], disposition: 'TRANSFER_REQUIRED',
    why: 'Bot bir sunucuda aktif olabilir; sahibi olmadan yönetilemez.' },
  { table: 'group_dm_conversations',columns: ['ownerId'], disposition: 'TRANSFER_REQUIRED',
    why: 'Grup DM sahipliği; diğer katılımcılar konuşmayı kaybetmemeli.' },
  { table: 'server_events',         columns: ['creator_id'], disposition: 'RETAIN',
    why: 'FK zaten SET NULL; etkinlik katılımcılar için kalır.' },
];

/** Anonimleştirilmiş satırların işaret ettiği değişmez kimlik. */
export const TOMBSTONE_USER_ID = 'deleted-user';

export function rulesFor(d: Disposition): LifecycleRule[] {
  return LIFECYCLE.filter(r => r.disposition === d);
}

/** Politikanın kapsadığı tablo adları. */
export function coveredTables(): Set<string> {
  return new Set(LIFECYCLE.map(r => r.table));
}
