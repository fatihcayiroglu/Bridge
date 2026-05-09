// client/js/core/channel-perms-data.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Ä°zin sabitleri ve ÅŸablon tanÄ±mlarÄ±
// channel-permissions.js'ten ayrÄ±ÅŸtÄ±rÄ±ldÄ± (v74)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
'use strict';

const PERM_GROUPS = [
  {
    label: 'ğŸ“‹ Genel',
    perms: [
      { bit: 1 << 0,  label: 'KanalÄ± GÃ¶r',        key: 'VIEW_CHANNELS',    desc: 'KanalÄ± kanal listesinde gÃ¶rÃ¼r ve iÃ§eriÄŸini okuyabilir. Bu izin kapalÄ±ysa kanal tamamen gizlenir.' },
      { bit: 1 << 1,  label: 'Kanal YÃ¶net',        key: 'MANAGE_CHANNELS',  desc: 'Kanal adÄ±nÄ±, konusunu, yavaÅŸ modu ve genel kanal ayarlarÄ±nÄ± deÄŸiÅŸtirebilir.' },
      { bit: 1 << 2,  label: 'Rol YÃ¶net',          key: 'MANAGE_ROLES',     desc: 'Sunucu rollerini oluÅŸturabilir, dÃ¼zenleyebilir ve silebilir. YÃ¼ksek yetkili bir izindir.' },
      { bit: 1 << 3,  label: 'Sunucu YÃ¶net',       key: 'MANAGE_SERVER',    desc: 'Sunucu adÄ±nÄ±, ikonunu ve genel sunucu ayarlarÄ±nÄ± deÄŸiÅŸtirebilir.' },
    ]
  },
  {
    label: 'ğŸ‘¥ Ãœyeler',
    perms: [
      { bit: 1 << 4,  label: 'Ãœye At',             key: 'KICK_MEMBERS',     desc: 'Ãœyeleri sunucudan atabilir. AtÄ±lan Ã¼yeler tekrar katÄ±labilir.' },
      { bit: 1 << 5,  label: 'Ãœye Yasakla',        key: 'BAN_MEMBERS',      desc: 'Ãœyeleri kalÄ±cÄ± olarak sunucudan yasaklayabilir. YÃ¼ksek yetkili bir iÅŸlemdir.' },
      { bit: 1 << 6,  label: 'Takma Ad YÃ¶net',     key: 'MANAGE_NICKNAMES', desc: 'DiÄŸer Ã¼yelerin sunucu iÃ§indeki gÃ¶rÃ¼nen adlarÄ±nÄ± deÄŸiÅŸtirebilir.' },
      { bit: 1 << 7,  label: 'Ãœye Sustur',         key: 'TIMEOUT_MEMBERS',  desc: 'Ãœyelere geÃ§ici konuÅŸma yasaÄŸÄ± uygulayabilir. SÃ¼re boyunca mesaj atamazlar.' },
    ]
  },
  {
    label: 'ğŸ’¬ Mesajlar',
    perms: [
      { bit: 1 << 8,  label: 'Mesaj GÃ¶nder',       key: 'SEND_MESSAGES',    desc: 'Bu kanalda yeni mesaj gÃ¶nderebilir. KapalÄ±ysa kanal salt okunur olur.' },
      { bit: 1 << 9,  label: 'Mesaj YÃ¶net',        key: 'MANAGE_MESSAGES',  desc: 'DiÄŸer Ã¼yelerin mesajlarÄ±nÄ± silebilir veya kanala sabitleyebilir.' },
      { bit: 1 << 10, label: 'Link GÃ¶m',           key: 'EMBED_LINKS',      desc: 'PaylaÅŸÄ±lan linklerin zengin Ã¶nizlemesi (embed) otomatik olarak gÃ¶sterilir.' },
      { bit: 1 << 11, label: 'Dosya YÃ¼kle',        key: 'ATTACH_FILES',     desc: 'Mesajlara dosya, gÃ¶rsel veya medya ekleyebilir.' },
      { bit: 1 << 12, label: 'Tepki Ekle',         key: 'ADD_REACTIONS',    desc: 'Mesajlara emoji tepkisi ekleyebilir. Mevcut tepkilere tÄ±klamak bunu gerektirmez.' },
      { bit: 1 << 13, label: 'Slash Komut',        key: 'USE_SLASH',        desc: '/ ile baÅŸlayan bot komutlarÄ±nÄ± bu kanalda kullanabilir.' },
      { bit: 1 << 14, label: '@everyone Etiketle', key: 'MENTION_EVERYONE', desc: '@everyone ve @here ile tÃ¼m/Ã§evrimiÃ§i Ã¼yeleri etiketleyebilir. Dikkatli kullan â€” herkese bildirim gider.' },
      { bit: 1 << 15, label: 'GeÃ§miÅŸ Oku',         key: 'READ_HISTORY',     desc: 'Kanala katÄ±lmadan Ã¶nce gÃ¶nderilmiÅŸ mesajlarÄ± gÃ¶rebilir. KapalÄ±ysa sadece yeni mesajlar gÃ¶rÃ¼nÃ¼r.' },
    ]
  },
  {
    label: 'ğŸ”Š Ses',
    perms: [
      { bit: 1 << 16, label: 'BaÄŸlan',             key: 'CONNECT',          desc: 'Ses kanallarÄ±na katÄ±labilir. KapalÄ±ysa ses kanalÄ± listede gÃ¶rÃ¼nse de girilemez.' },
      { bit: 1 << 17, label: 'KonuÅŸ',              key: 'SPEAK',            desc: 'Ses kanalÄ±nda mikrofon aÃ§abilir. KapalÄ±ysa sadece dinleyici olarak kalÄ±r.' },
      { bit: 1 << 18, label: 'Ãœye Sessize Al',     key: 'MUTE_MEMBERS',     desc: 'Ses kanalÄ±ndaki diÄŸer Ã¼yelerin mikrofonunu sunucu tarafÄ±ndan kapatabilir.' },
      { bit: 1 << 19, label: 'Ãœyeyi SaÄŸÄ±r Et',    key: 'DEAFEN_MEMBERS',   desc: 'Ãœyelerin ses kanalÄ±nÄ± duymasÄ±nÄ± sunucu tarafÄ±ndan engelleyebilir.' },
      { bit: 1 << 20, label: 'Ãœye TaÅŸÄ±',           key: 'MOVE_MEMBERS',     desc: 'BaÄŸlÄ± Ã¼yeleri farklÄ± ses kanallarÄ±na taÅŸÄ±yabilir.' },
    ]
  },
  {
    label: 'ğŸ¤– Bot',
    perms: [
      { bit: 1 << 21, label: 'Bot Komutu Kullan',  key: 'USE_BOT_COMMANDS', desc: 'Bot komutlarÄ±nÄ± bu kanalda Ã§alÄ±ÅŸtÄ±rabilir. Bot kanallarÄ±nda kÄ±sÄ±tlamak iÃ§in kullanÄ±lÄ±r.' },
    ]
  },
];

const ALL_PERMS = PERM_GROUPS.flatMap(g => g.perms);

// Ä°zin biti â†’ label haritasÄ± (audit log ve inheritance popup'Ä±nda kullanÄ±lÄ±r)
const BIT_LABELS: Record<number, string> = {};
for (const g of PERM_GROUPS) {
  for (const p of g.perms) {
    BIT_LABELS[p.bit] = p.label;
  }
}

// â”€â”€ KANAL Ä°ZÄ°N ÅABLONLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PERM_TEMPLATES = [
  {
    id: 'readonly',
    label: 'Salt Okunur Kanal',
    icon: 'ğŸ“–',
    desc: '@everyone sadece okur, yazmaz. Yetkili roller mesaj atabilir.',
    apply(rows: any[]) {
      const result: Record<string, any> = {};
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
    label: 'Duyuru KanalÄ±',
    icon: 'ğŸ“£',
    desc: '@everyone sadece gÃ¶rÃ¼r ve tepki ekler. YÃ¶neticiler mesaj atar.',
    apply(rows: any[]) {
      const result: Record<string, any> = {};
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
    label: 'Bot KanalÄ±',
    icon: 'ğŸ¤–',
    desc: 'Ãœyeler bot komutlarÄ±nÄ± burada kullanÄ±r, normal mesaj gÃ¶nderimi kÄ±sÄ±tlÄ±.',
    apply(rows: any[]) {
      const result: Record<string, any> = {};
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
    label: 'Ã–zel Kanal',
    icon: 'ğŸ”’',
    desc: '@everyone kanalÄ± gÃ¶remez. Sadece seÃ§ili rol ve Ã¼yeler eriÅŸebilir.',
    apply(rows: any[]) {
      const result: Record<string, any> = {};
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

