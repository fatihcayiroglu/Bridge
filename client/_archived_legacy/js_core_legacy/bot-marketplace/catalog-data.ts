// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/CatalogDataPanel.svelte
//              client/js/core/catalog-data-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/catalog-data.ts  (Sprint 91 — full catalog)
// Discord Bot Marketplace benzeri — öne çıkan botlar, kategoriler, özel bot ekleme

export interface BotListing {
  id:          string;
  name:        string;
  avatar:      string;          // emoji
  tagline:     string;
  description: string;
  category:    BotCategory;
  tags:        string[];
  commands:    string[];        // sample slash commands
  verified:    boolean;
  featured:    boolean;
  installs:    number;          // approx
  rating:      number;          // 0-5
  freeToUse:   boolean;
  inviteUrl?:  string;          // external OAuth URL
  docsUrl?:    string;
}

export type BotCategory =
  | 'moderation'
  | 'music'
  | 'fun'
  | 'utility'
  | 'economy'
  | 'games'
  | 'ai'
  | 'social'
  | 'productivity';

export const BOT_CATEGORIES: { id: BotCategory; label: string; icon: string }[] = [
  { id: 'moderation',   label: 'Moderasyon',    icon: '🛡️' },
  { id: 'music',        label: 'Müzik',         icon: '🎵' },
  { id: 'fun',          label: 'Eğlence',       icon: '🎉' },
  { id: 'utility',      label: 'Araçlar',       icon: '🔧' },
  { id: 'economy',      label: 'Ekonomi',       icon: '💰' },
  { id: 'games',        label: 'Oyunlar',       icon: '🎮' },
  { id: 'ai',           label: 'Yapay Zeka',    icon: '🤖' },
  { id: 'social',       label: 'Sosyal',        icon: '👥' },
  { id: 'productivity', label: 'Verimlilik',    icon: '📋' },
];

export const BOT_CATALOG: BotListing[] = [
  // ── MODERATION ───────────────────────────────────────────────────────────
  {
    id: 'guardbot', name: 'GuardBot', avatar: '🛡️',
    tagline: 'Sunucunuzu otomatik olarak koruyun',
    description: 'Spam tespiti, link filtresi, kaba dil engeli, otomatik timeout ve gelişmiş moderasyon logları. Özelleştirilebilir cezalar ve eskalasyon sistemi ile sunucunuzu 7/24 korur.',
    category: 'moderation', tags: ['spam', 'automod', 'log', 'güvenlik'],
    commands: ['/ban', '/kick', '/timeout', '/warn', '/clearwarns', '/modlog'],
    verified: true, featured: true, installs: 42000, rating: 4.8, freeToUse: true,
  },
  {
    id: 'logmaster', name: 'LogMaster', avatar: '📋',
    tagline: 'Her hareketi takip et',
    description: 'Mesaj silme/düzenleme, kanal değişiklikleri, üye giriş/çıkış, rol değişimleri, sesli kanal hareketleri — tüm olaylar belirlenmiş kanallara ayrıntılı şekilde loglanır.',
    category: 'moderation', tags: ['log', 'audit', 'takip'],
    commands: ['/setlogchannel', '/logfilter', '/logexport'],
    verified: true, featured: false, installs: 28000, rating: 4.6, freeToUse: true,
  },
  {
    id: 'antispam', name: 'AntiSpam Pro', avatar: '🚫',
    tagline: 'Spam ve flood\'u anlık engelle',
    description: 'Hızlı mesaj atma, tekrar eden içerik, davet linki paylaşımı, kötü amaçlı URL tespiti. Makine öğrenmesi tabanlı içerik analizi ile false positive\'leri minimize eder.',
    category: 'moderation', tags: ['spam', 'flood', 'url', 'ml'],
    commands: ['/antispam config', '/whitelist', '/blacklist'],
    verified: false, featured: false, installs: 15000, rating: 4.3, freeToUse: true,
  },

  // ── MUSIC ────────────────────────────────────────────────────────────────
  {
    id: 'rhythmix', name: 'Rhythmix', avatar: '🎵',
    tagline: 'En yüksek kaliteli müzik deneyimi',
    description: 'YouTube, Spotify, SoundCloud ve Apple Music desteği. 24/7 kesintisiz çalma, 5-bant ekolayzer, ses efektleri (bassboost, nightcore, vaporwave), DJ rolleri ve kuyruğa öncelik sistemi.',
    category: 'music', tags: ['youtube', 'spotify', 'soundcloud', 'dj', 'equalizer'],
    commands: ['/play', '/queue', '/skip', '/loop', '/volume', '/filter', '/lyrics'],
    verified: true, featured: true, installs: 89000, rating: 4.9, freeToUse: true,
  },
  {
    id: 'beatbot', name: 'BeatBot', avatar: '🥁',
    tagline: 'Playlist\'ler ve radio kanalları',
    description: 'Özel playlist oluşturma ve paylaşma, internet radyosu, son çalınanlar geçmişi ve favori listesi. Premium: lossless ses kalitesi ve 10-bant ekolayzer.',
    category: 'music', tags: ['playlist', 'radio', 'history', 'lossless'],
    commands: ['/playlist create', '/radio', '/history', '/favorite'],
    verified: true, featured: false, installs: 34000, rating: 4.5, freeToUse: true,
  },

  // ── FUN ──────────────────────────────────────────────────────────────────
  {
    id: 'memebot', name: 'MemeBot', avatar: '😂',
    tagline: 'Güncel memeler ve meme üretici',
    description: 'Reddit\'ten güncel memeler, özelleştirilebilir meme şablonları, gif reaksiyonları, eğlenceli komutlar (8-ball, öldür, evlen vs.), gif arama ve Tenor entegrasyonu.',
    category: 'fun', tags: ['meme', 'reddit', 'gif', 'eğlence'],
    commands: ['/meme', '/makememe', '/gif', '/8ball', '/random'],
    verified: true, featured: false, installs: 67000, rating: 4.4, freeToUse: true,
  },
  {
    id: 'rpgbot', name: 'RPG Adventure', avatar: '⚔️',
    tagline: 'Sunucunda tam bir RPG deneyimi',
    description: 'Metin tabanlı RPG: karakter oluştur, görev al, düşmanlarla savaş, item topla, loncana katıl. Seviye sistemi, beceri ağacı ve haftalık etkinlikler ile sunucunu canlı tut.',
    category: 'fun', tags: ['rpg', 'adventure', 'quest', 'level'],
    commands: ['/start', '/quest', '/fight', '/inventory', '/guild', '/stats'],
    verified: false, featured: true, installs: 23000, rating: 4.7, freeToUse: true,
  },

  // ── UTILITY ──────────────────────────────────────────────────────────────
  {
    id: 'pollbot', name: 'PollMaster', avatar: '📊',
    tagline: 'Gelişmiş anket ve oylama sistemi',
    description: 'Çoklu seçenek, tek oy, anonim oy, zamanlı anket, görsel sonuç grafikleri, CSV dışa aktarma ve rol bazlı oy kısıtlama. Düğme ve dropdown bileşenleriyle modern arayüz.',
    category: 'utility', tags: ['poll', 'vote', 'survey', 'grafik'],
    commands: ['/poll create', '/vote', '/pollend', '/pollexport'],
    verified: true, featured: false, installs: 45000, rating: 4.6, freeToUse: true,
  },
  {
    id: 'ticketbot', name: 'TicketBot', avatar: '🎫',
    tagline: 'Destek ticket sistemi',
    description: 'Kategori bazlı ticket oluşturma, otomatik rol atama, ticket log kanalı, HTML transkript ve istatistik paneli. Takım çalışması için iç not sistemi ve SLA takibi.',
    category: 'utility', tags: ['ticket', 'destek', 'support', 'transcript'],
    commands: ['/ticket create', '/ticket close', '/ticket add', '/ticket transcript'],
    verified: true, featured: true, installs: 52000, rating: 4.8, freeToUse: true,
  },
  {
    id: 'reminderbot', name: 'ReminderBot', avatar: '⏰',
    tagline: 'Hatırlatıcı ve zamanlayıcı',
    description: 'Kişisel ve kanal hatırlatıcıları, tekrarlayan görevler (günlük/haftalık/aylık), timezone desteği (100+), takvim görünümü ve DM bildirimleri.',
    category: 'utility', tags: ['reminder', 'timer', 'calendar', 'timezone'],
    commands: ['/remind', '/remind list', '/remind delete', '/timezone'],
    verified: true, featured: false, installs: 31000, rating: 4.5, freeToUse: true,
  },

  // ── ECONOMY ──────────────────────────────────────────────────────────────
  {
    id: 'coinbot', name: 'CoinBot', avatar: '🪙',
    tagline: 'Sunucu ekonomi ve ödül sistemi',
    description: 'Sanal para birimi, günlük ödül, mağaza sistemi, slot makinesi, blackjack, poker. Liderlik tablosu, rol ödülleri ve özelleştirilebilir para birimi adı.',
    category: 'economy', tags: ['coin', 'economy', 'shop', 'casino'],
    commands: ['/balance', '/daily', '/shop', '/buy', '/slots', '/leaderboard'],
    verified: true, featured: true, installs: 38000, rating: 4.5, freeToUse: true,
  },

  // ── GAMES ────────────────────────────────────────────────────────────────
  {
    id: 'triviabot', name: 'TriviaKing', avatar: '🧠',
    tagline: 'Bilgi yarışması ve quiz',
    description: '5000+ soruyla 20 kategori: bilim, tarih, spor, sinema, müzik... Zamanlı sorular, takım modu, turnuva sistemi ve haftalık şampiyonluk tablosu.',
    category: 'games', tags: ['trivia', 'quiz', 'bilgi', 'turnuva'],
    commands: ['/trivia', '/trivia category', '/trivia team', '/trivia leaderboard'],
    verified: true, featured: false, installs: 29000, rating: 4.6, freeToUse: true,
  },
  {
    id: 'chessbot', name: 'ChessBot', avatar: '♟️',
    tagline: 'Sunucuda satranç turnuvaları',
    description: 'ELO rating sistemi, turnuva desteği, lichess.org entegrasyonu, öğretici mod ve açılış veritabanı. Analiz modu ile partilerinizi inceleyin.',
    category: 'games', tags: ['satranç', 'chess', 'elo', 'turnuva'],
    commands: ['/chess challenge', '/chess stats', '/chess tournament'],
    verified: false, featured: false, installs: 14000, rating: 4.4, freeToUse: true,
  },

  // ── AI ───────────────────────────────────────────────────────────────────
  {
    id: 'aichat', name: 'AI Assistant', avatar: '🤖',
    tagline: 'GPT-4 destekli akıllı asistan',
    description: 'Soru yanıtlama, metin özetleme, kod yardımı, çeviri, yaratıcı yazarlık ve kanal bazlı bağlam hafızası. Moderatörler için içerik analizi ve zararlı içerik tespiti.',
    category: 'ai', tags: ['gpt', 'ai', 'chat', 'asistan'],
    commands: ['/ask', '/summarize', '/translate', '/code', '/imagine'],
    verified: true, featured: true, installs: 71000, rating: 4.7, freeToUse: false,
  },
  {
    id: 'imageai', name: 'ImageGen', avatar: '🎨',
    tagline: 'Yapay zeka ile görsel üretimi',
    description: 'DALL-E 3 ve Stable Diffusion entegrasyonu. Metin\'den görsel, görsel düzenleme, stil transferi ve sonsuz kanvas modu. Günlük ücretsiz 10 görsel.',
    category: 'ai', tags: ['dalle', 'stable-diffusion', 'art', 'generate'],
    commands: ['/generate', '/edit', '/style', '/upscale'],
    verified: true, featured: false, installs: 44000, rating: 4.6, freeToUse: false,
  },

  // ── SOCIAL ───────────────────────────────────────────────────────────────
  {
    id: 'levelbot', name: 'LevelUp', avatar: '⭐',
    tagline: 'Aktivite bazlı seviye ve ödül sistemi',
    description: 'Mesaj ve ses aktivitesine göre XP, özelleştirilebilir seviye rolleri, rank kartı (görsel), leaderboard, XP multiplier kanalları ve etkinlik XP boostları.',
    category: 'social', tags: ['level', 'xp', 'rank', 'rol', 'leaderboard'],
    commands: ['/rank', '/leaderboard', '/setcard', '/xp', '/rewards'],
    verified: true, featured: true, installs: 83000, rating: 4.8, freeToUse: true,
  },
  {
    id: 'welcomeplus', name: 'WelcomePlus', avatar: '👋',
    tagline: 'Gelişmiş karşılama ve çıkış mesajları',
    description: 'Özelleştirilebilir hoşgeldin kartı (görsel), DM karşılama, otomatik rol, kuralları oku doğrulaması (captcha), ayrılanlar için istatistik ve üye sayacı.',
    category: 'social', tags: ['welcome', 'karşılama', 'captcha', 'otorol'],
    commands: ['/welcome setup', '/welcome test', '/autorole', '/membercount'],
    verified: true, featured: false, installs: 56000, rating: 4.6, freeToUse: true,
  },

  // ── PRODUCTIVITY ─────────────────────────────────────────────────────────
  {
    id: 'todobot', name: 'TodoBot', avatar: '✅',
    tagline: 'Takım görev yönetimi',
    description: 'Proje bazlı görev listeleri, atama, deadline, ilerleme takibi ve haftalık durum raporu. Notion ve Trello entegrasyonu ile mevcut iş akışınıza bağlanır.',
    category: 'productivity', tags: ['todo', 'task', 'proje', 'notion', 'trello'],
    commands: ['/task create', '/task assign', '/task done', '/task list', '/standup'],
    verified: false, featured: false, installs: 18000, rating: 4.3, freeToUse: true,
  },
  {
    id: 'githubbot', name: 'GitHubLink', avatar: '🐙',
    tagline: 'GitHub entegrasyonu',
    description: 'Issue, PR, commit ve release bildirimleri. Kanal bazlı repo takibi, PR review hatırlatıcısı ve otomatik milestone güncelleme mesajları.',
    category: 'productivity', tags: ['github', 'pr', 'ci', 'dev'],
    commands: ['/github track', '/github status', '/github issues'],
    verified: true, featured: false, installs: 27000, rating: 4.5, freeToUse: true,
  },
];
