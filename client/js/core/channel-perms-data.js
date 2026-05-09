// client/js/core/channel-perms-data.js
// ══════════════════════════════════════════════════
// İzin sabitleri ve şablon tanımları
// channel-permissions.js'ten ayrıştırıldı (v74)
// ══════════════════════════════════════════════════
'use strict';

const PERM_GROUPS = [
  {
    label: '📋 Genel',
    perms: [
      { bit: 1 << 0,  label: 'Kanalı Gör',        key: 'VIEW_CHANNELS',    desc: 'Kanalı kanal listesinde görür ve içeriğini okuyabilir. Bu izin kapalıysa kanal tamamen gizlenir.' },
      { bit: 1 << 1,  label: 'Kanal Yönet',        key: 'MANAGE_CHANNELS',  desc: 'Kanal adını, konusunu, yavaş modu ve genel kanal ayarlarını değiştirebilir.' },
      { bit: 1 << 2,  label: 'Rol Yönet',          key: 'MANAGE_ROLES',     desc: 'Sunucu rollerini oluşturabilir, düzenleyebilir ve silebilir. Yüksek yetkili bir izindir.' },
      { bit: 1 << 3,  label: 'Sunucu Yönet',       key: 'MANAGE_SERVER',    desc: 'Sunucu adını, ikonunu ve genel sunucu ayarlarını değiştirebilir.' },
    ]
  },
  {
    label: '👥 Üyeler',
    perms: [
      { bit: 1 << 4,  label: 'Üye At',             key: 'KICK_MEMBERS',     desc: 'Üyeleri sunucudan atabilir. Atılan üyeler tekrar katılabilir.' },
      { bit: 1 << 5,  label: 'Üye Yasakla',        key: 'BAN_MEMBERS',      desc: 'Üyeleri kalıcı olarak sunucudan yasaklayabilir. Yüksek yetkili bir işlemdir.' },
      { bit: 1 << 6,  label: 'Takma Ad Yönet',     key: 'MANAGE_NICKNAMES', desc: 'Diğer üyelerin sunucu içindeki görünen adlarını değiştirebilir.' },
      { bit: 1 << 7,  label: 'Üye Sustur',         key: 'TIMEOUT_MEMBERS',  desc: 'Üyelere geçici konuşma yasağı uygulayabilir. Süre boyunca mesaj atamazlar.' },
    ]
  },
  {
    label: '💬 Mesajlar',
    perms: [
      { bit: 1 << 8,  label: 'Mesaj Gönder',       key: 'SEND_MESSAGES',    desc: 'Bu kanalda yeni mesaj gönderebilir. Kapalıysa kanal salt okunur olur.' },
      { bit: 1 << 9,  label: 'Mesaj Yönet',        key: 'MANAGE_MESSAGES',  desc: 'Diğer üyelerin mesajlarını silebilir veya kanala sabitleyebilir.' },
      { bit: 1 << 10, label: 'Link Göm',           key: 'EMBED_LINKS',      desc: 'Paylaşılan linklerin zengin önizlemesi (embed) otomatik olarak gösterilir.' },
      { bit: 1 << 11, label: 'Dosya Yükle',        key: 'ATTACH_FILES',     desc: 'Mesajlara dosya, görsel veya medya ekleyebilir.' },
      { bit: 1 << 12, label: 'Tepki Ekle',         key: 'ADD_REACTIONS',    desc: 'Mesajlara emoji tepkisi ekleyebilir. Mevcut tepkilere tıklamak bunu gerektirmez.' },
      { bit: 1 << 13, label: 'Slash Komut',        key: 'USE_SLASH',        desc: '/ ile başlayan bot komutlarını bu kanalda kullanabilir.' },
      { bit: 1 << 14, label: '@everyone Etiketle', key: 'MENTION_EVERYONE', desc: '@everyone ve @here ile tüm/çevrimiçi üyeleri etiketleyebilir. Dikkatli kullan — herkese bildirim gider.' },
      { bit: 1 << 15, label: 'Geçmiş Oku',         key: 'READ_HISTORY',     desc: 'Kanala katılmadan önce gönderilmiş mesajları görebilir. Kapalıysa sadece yeni mesajlar görünür.' },
    ]
  },
  {
    label: '🔊 Ses',
    perms: [
      { bit: 1 << 16, label: 'Bağlan',             key: 'CONNECT',          desc: 'Ses kanallarına katılabilir. Kapalıysa ses kanalı listede görünse de girilemez.' },
      { bit: 1 << 17, label: 'Konuş',              key: 'SPEAK',            desc: 'Ses kanalında mikrofon açabilir. Kapalıysa sadece dinleyici olarak kalır.' },
      { bit: 1 << 18, label: 'Üye Sessize Al',     key: 'MUTE_MEMBERS',     desc: 'Ses kanalındaki diğer üyelerin mikrofonunu sunucu tarafından kapatabilir.' },
      { bit: 1 << 19, label: 'Üyeyi Sağır Et',    key: 'DEAFEN_MEMBERS',   desc: 'Üyelerin ses kanalını duymasını sunucu tarafından engelleyebilir.' },
      { bit: 1 << 20, label: 'Üye Taşı',           key: 'MOVE_MEMBERS',     desc: 'Bağlı üyeleri farklı ses kanallarına taşıyabilir.' },
    ]
  },
  {
    label: '🤖 Bot',
    perms: [
      { bit: 1 << 21, label: 'Bot Komutu Kullan',  key: 'USE_BOT_COMMANDS', desc: 'Bot komutlarını bu kanalda çalıştırabilir. Bot kanallarında kısıtlamak için kullanılır.' },
    ]
  },
];

const ALL_PERMS = PERM_GROUPS.flatMap(g => g.perms);

// İzin biti → label haritası (audit log ve inheritance popup'ında kullanılır)
const BIT_LABELS = {};
for (const g of PERM_GROUPS) {
  for (const p of g.perms) {
    BIT_LABELS[p.bit] = p.label;
  }
}

// ── KANAL İZİN ŞABLONLARI ────────────────────────────────────
const PERM_TEMPLATES = [
  {
    id: 'readonly',
    label: 'Salt Okunur Kanal',
    icon: '📖',
    desc: '@everyone sadece okur, yazmaz. Yetkili roller mesaj atabilir.',
    apply(rows) {
      const result = {};
      for (const row of rows) {
        if (row.isEveryone) {
          result[row._id] = { allow: (1 << 0) | (1 << 15), deny: (1 << 8) };
        } else if (row.isUser) {
          result[row._id] = { allow: 0, deny: 0 };
        } else {
          result[row._id] = { allow: (1 << 0) | (1 << 8) | (1 << 9) | (1 << 15), deny: 0 };
        }
      }
      return result;
    },
  },
  {
    id: 'announcement',
    label: 'Duyuru Kanalı',
    icon: '📣',
    desc: '@everyone sadece görür ve tepki ekler. Yöneticiler mesaj atar.',
    apply(rows) {
      const result = {};
      for (const row of rows) {
        if (row.isEveryone) {
          result[row._id] = {
            allow: (1 << 0) | (1 << 12) | (1 << 15),
            deny:  (1 << 8) | (1 << 10) | (1 << 11),
          };
        } else if (row.isUser) {
          result[row._id] = { allow: 0, deny: 0 };
        } else {
          result[row._id] = {
            allow: (1 << 0) | (1 << 8) | (1 << 9) | (1 << 10) | (1 << 11) | (1 << 14) | (1 << 15),
            deny:  0,
          };
        }
      }
      return result;
    },
  },
  {
    id: 'botchannel',
    label: 'Bot Kanalı',
    icon: '🤖',
    desc: 'Üyeler bot komutlarını burada kullanır, normal mesaj gönderimi kısıtlı.',
    apply(rows) {
      const result = {};
      for (const row of rows) {
        if (row.isEveryone) {
          result[row._id] = {
            allow: (1 << 0) | (1 << 13) | (1 << 21) | (1 << 12) | (1 << 15),
            deny:  (1 << 8) | (1 << 10) | (1 << 11),
          };
        } else {
          result[row._id] = { allow: 0, deny: 0 };
        }
      }
      return result;
    },
  },
  {
    id: 'private',
    label: 'Özel Kanal',
    icon: '🔒',
    desc: '@everyone kanalı göremez. Sadece seçili rol ve üyeler erişebilir.',
    apply(rows) {
      const result = {};
      for (const row of rows) {
        if (row.isEveryone) {
          result[row._id] = { allow: 0, deny: (1 << 0) };
        } else if (row.isUser) {
          result[row._id] = { allow: (1 << 0) | (1 << 8) | (1 << 15), deny: 0 };
        } else {
          result[row._id] = {
            allow: (1 << 0) | (1 << 8) | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 15),
            deny:  0,
          };
        }
      }
      return result;
    },
  },
];

export const channel_perms_dataReady = true;
