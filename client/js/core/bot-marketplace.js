// client/js/core/bot-marketplace.js
// Bot Marketplace — 20+ bot, detay modal, rating, kategori sidebar, 1 tıkla kurulum
'use strict';
import { getAPI, getCurrentServer } from './globals.js';

/* ══════════════════════════════════════════════════════════
   BOT KATALOĞU — 20 bot, tam detaylı
══════════════════════════════════════════════════════════ */
const BOT_CATALOG = [
  // ── MÜZİK ──
  { id:'bridge-music', name:'Bridge Music', author:'Bridge Team', authorVerified:true, avatar:'🎵', category:'music', tags:['müzik','eğlence'],
    description:'YouTube, Spotify, SoundCloud desteği. Sıra yönetimi, 8D audio, bass boost, lyrics gösterimi.',
    longDescription:'Bridge Music, sunucunuzda yüksek kaliteli müzik deneyimi sunar.\n\n**Desteklenen Kaynaklar:**\n• YouTube & YouTube Music\n• Spotify (playlist/albüm/şarkı)\n• SoundCloud & Bandcamp\n\n**Ses Efektleri:**\n8D audio, bass boost, nightcore, vaporwave, karaoke modu\n\n**Gelişmiş:**\nPlaylist kaydet/yükle, DJ rolü, lyrics göster',
    verified:true, featured:true, installs:12840, rating:4.8, ratingCount:3241,
    commands:['/play','/skip','/queue','/loop','/bassboost','/8d','/lyrics','/volume','/playlist'],
    permissions:['Ses Kanalına Bağlan','Konuş','Mesaj Gönder'],
    changelog:'v3.2: Spotify playlist ve lyrics eklendi', supportUrl:'#', sourceUrl:'https://github.com/bridge-bots/music' },

  { id:'rhythm-plus', name:'Rhythm+', author:'MusicDevs', authorVerified:false, avatar:'🎸', category:'music', tags:['müzik','eğlence'],
    description:'Düşük gecikmeli Ogg Opus ses kalitesi. 24/7 mod, autoplay, benzer şarkı önerileri.',
    longDescription:'Rhythm+, ses kalitesini ön plana alır.\n\n**Neden Rhythm+?**\n• 320kbps Ogg Opus kodek\n• Sıfır kesinti, otomatik reconnect\n• 24/7 çalma modu\n• Autoplay ve şarkı geçmişi',
    verified:false, featured:false, installs:4320, rating:4.5, ratingCount:812,
    commands:['/play','/pause','/resume','/np','/history','/autoplay'],
    permissions:['Ses Kanalına Bağlan','Konuş'],
    changelog:'v2.1: 24/7 mod ve autoplay eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── MODERASYON ──
  { id:'bridge-guard', name:'Bridge Guard', author:'Bridge Team', authorVerified:true, avatar:'🛡️', category:'moderation', tags:['moderasyon','güvenlik'],
    description:'AI destekli spam tespiti, raid koruması, otomatik uyarı sistemi, detaylı moderasyon logu.',
    longDescription:'Bridge Guard, sunucunuzu otomatik olarak korur.\n\n**AI Korumaları:**\n• Spam & flood tespiti (ML model)\n• Phishing link engelleme\n• Raid algılama + otomatik yavaş mod\n\n**Manuel Araçlar:**\n/ban, /kick, /timeout, /warn, /purge\n\n**Loglama:**\nCSV dışa aktarım destekli tam log',
    verified:true, featured:true, installs:38700, rating:4.9, ratingCount:7821,
    commands:['/ban','/kick','/timeout','/warn','/purge','/slowmode','/lock','/raid-mode'],
    permissions:['Üyeleri Yönet','Mesajları Yönet','Kanalları Yönet'],
    changelog:'v5.0: AI spam tespiti %94 doğrulukla yeniden yazıldı', supportUrl:'#', sourceUrl:'https://github.com/bridge-bots/guard' },

  { id:'automod-pro', name:'AutoMod Pro', author:'SafeServers', authorVerified:false, avatar:'⚙️', category:'moderation', tags:['moderasyon','otomasyon'],
    description:'Regex destekli kural motoru, link whitelist/blacklist, caps lock filtresi, hazır şablonlar.',
    longDescription:'AutoMod Pro, moderasyonu tamamen özelleştirilebilir kural motoruyla yönetir.\n\n**Kural Motoru:**\n• Regex kelime filtresi\n• Link whitelist/blacklist\n• Mention sınırı\n• Emoji spam koruması\n\n**Şablonlar:**\nGaming, eğitim, iş, 18+ hazır şablon paketleri',
    verified:false, featured:false, installs:9200, rating:4.3, ratingCount:1543,
    commands:['/rule add','/rule list','/rule test','/filter','/whitelist'],
    permissions:['Mesajları Yönet','Üyeleri Yönet'],
    changelog:'v1.8: Regex ve kural şablonları eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── YÖNETİM ──
  { id:'welcome-pro', name:'Welcome Pro', author:'Bridge Team', authorVerified:true, avatar:'👋', category:'management', tags:['yönetim','üye'],
    description:'Özelleştirilebilir karşılama, otomatik rol atama, captcha doğrulama, üye sayaç kanalı.',
    longDescription:'Welcome Pro, yeni üyeleri profesyonelce karşılar.\n\n**Karşılama:**\n• Özelleştirilebilir embed mesajı\n• DM veya kanal seçeneği\n• Kişiselleştirilmiş (avatar, ad)\n\n**Doğrulama:**\nCaptcha, tepki butonu, quiz\n\n**Otomasyon:**\nOtomatik rol, üye sayacı kanalı',
    verified:true, featured:true, installs:21000, rating:4.7, ratingCount:4102,
    commands:['/setwelcome','/setgoodbye','/autorole','/verify','/membercount'],
    permissions:['Rolleri Yönet','Mesaj Gönder','Embed Gönder'],
    changelog:'v4.1: Quiz tabanlı doğrulama eklendi', supportUrl:'#', sourceUrl:'https://github.com/bridge-bots/welcome' },

  { id:'reaction-roles', name:'Reaction Roles', author:'RoleBot', authorVerified:false, avatar:'🎭', category:'management', tags:['yönetim','rol'],
    description:'Emoji tıklayarak rol al sistemi. Normal, Unique, Verify ve Limit modları.',
    longDescription:'Reaction Roles, üyelerinizin emoji tıklayarak rol almasını sağlar.\n\n**Modlar:**\n• Normal: Tıkla al/bırak\n• Unique: Sadece bir rol\n• Verify: Onay sonrası rol\n• Limit: Kaç rol alınabileceğini sınırla',
    verified:false, featured:false, installs:15600, rating:4.6, ratingCount:2890,
    commands:['/rr create','/rr add','/rr remove','/rr list','/rr edit'],
    permissions:['Rolleri Yönet','Tepki Ver','Embed Gönder'],
    changelog:'v2.3: Limit ve Unique mod eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'ticket-system', name:'Ticket System', author:'SupportTools', authorVerified:false, avatar:'🎫', category:'management', tags:['yönetim','destek'],
    description:'Kategori bazlı destek ticket sistemi, staff atama, transcript kaydetme.',
    longDescription:'Ticket System, destek taleplerini düzenli yönetir.\n\n**Akış:**\n1. Kullanıcı butona basar\n2. Özel kanal açılır\n3. Staff atanır\n4. Sorun çözülür\n5. Transcript kaydedilir\n\n**Staff Araçları:**\n/ticket close, add, remove, transfer',
    verified:false, featured:false, installs:8700, rating:4.4, ratingCount:1234,
    commands:['/ticket panel','/ticket close','/ticket add','/ticket remove','/ticket transcript'],
    permissions:['Kanalları Yönet','Rolleri Yönet','Mesaj Gönder'],
    changelog:'v1.5: Çoklu kategori ve staff ataması eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'scheduler', name:'Scheduler', author:'TimeTools', authorVerified:false, avatar:'🗓️', category:'management', tags:['yönetim','araçlar'],
    description:'Zamanlanmış mesajlar, etkinlik hatırlatıcıları, cron syntax, 100+ timezone.',
    longDescription:'Scheduler, zamanlamayı tamamen otomatikleştirir.\n\n**Mesaj Zamanlama:**\n• Belirli tarih/saatte mesaj\n• Tekrarlı mesajlar (günlük, haftalık)\n• Cron syntax desteği\n\n**Etkinlik:**\nRSVP al, 30/15/5 dk hatırlatma\n\n**Timezone:**\n100+ zaman dilimi desteği',
    verified:false, featured:false, installs:5600, rating:4.4, ratingCount:834,
    commands:['/schedule','/remind','/event create','/event list','/timezone set'],
    permissions:['Mesaj Gönder','Embed Gönder'],
    changelog:'v1.6: Cron syntax ve tekrarlı mesajlar eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── AI ──
  { id:'bridge-ai', name:'Bridge AI', author:'Bridge Team', authorVerified:true, avatar:'🧠', category:'ai', tags:['ai','yardımcı'],
    description:'Kanal özeti, 50+ dil çevirisi, kod yardımı, görsel analiz. GPT-4, Claude, Gemini seçimi.',
    longDescription:'Bridge AI, sunucunuza native AI yetenekleri katar.\n\n**Yetenekler:**\n• Konuşma özetleme\n• 50+ dil çevirisi\n• Kod açıklama & debug\n• Görsel analiz\n• Metin düzenleme\n\n**Model Seçimi:**\nGPT-4, Claude, Gemini — kanal bazlı persona',
    verified:true, featured:true, installs:52000, rating:4.9, ratingCount:11203,
    commands:['/ask','/summarize','/translate','/code','/image','/persona set'],
    permissions:['Mesaj Gönder','Embed Gönder','Dosya Ekle'],
    changelog:'v6.0: Görsel analiz ve Claude entegrasyonu eklendi', supportUrl:'#', sourceUrl:'https://github.com/bridge-bots/ai' },

  { id:'gpt-helper', name:'GPT Helper', author:'OpenAIFans', authorVerified:false, avatar:'💬', category:'ai', tags:['ai','yardımcı'],
    description:'Kendi OpenAI API key\'inle sınırsız GPT-4 sohbeti. Thread bazlı hafıza, özel persona.',
    longDescription:'GPT Helper, kendi API key\'inizi kullanarak sınırsız AI sohbeti sunar.\n\n**Kurulum:**\nSadece API key gir, hazır.\n\n**Özellikler:**\n• Thread bazlı konuşma hafızası\n• Sistem prompt özelleştirme\n• Sıcaklık ve uzunluk ayarı\n• Kanal bazlı persona',
    verified:false, featured:false, installs:6700, rating:4.2, ratingCount:890,
    commands:['/chat','/reset','/persona','/settings'],
    permissions:['Mesaj Gönder','Thread Oluştur'],
    changelog:'v1.3: Thread bazlı hafıza eklendi', supportUrl:'#', sourceUrl:'https://github.com/openai-fans/gpt-helper' },

  // ── İSTATİSTİK ──
  { id:'stats-master', name:'Stats Master', author:'Analytics Hub', authorVerified:false, avatar:'📊', category:'stats', tags:['istatistik','yönetim'],
    description:'Sunucu istatistikleri, XP sistemi, liderlik tablosu, aktivite grafikleri, CSV/PNG export.',
    longDescription:'Stats Master, sunucunuzun büyümesini görselleştirir.\n\n**Dashboard:**\n• Günlük/haftalık/aylık mesaj grafiği\n• Kanal bazlı aktivite haritası\n• Üye trendi\n\n**XP Sistemi:**\nMesaj başına XP, seviye atlatma, seviye rolleri\n\n**Export:**\nCSV ve PNG grafik',
    verified:false, featured:false, installs:4500, rating:4.6, ratingCount:723,
    commands:['/stats server','/stats user','/leaderboard','/rank','/xp give'],
    permissions:['Mesaj Gönder','Embed Gönder','Mesaj Geçmişini Oku'],
    changelog:'v2.0: XP sistemi ve PNG export eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'logger-pro', name:'Logger Pro', author:'AuditTeam', authorVerified:false, avatar:'📋', category:'stats', tags:['istatistik','güvenlik'],
    description:'Kapsamlı sunucu logu: silinen mesajlar, üye değişiklikleri, ses hareketleri, ban/kick.',
    longDescription:'Logger Pro, sunucunuzdaki tüm olayları kaydeder.\n\n**Loglananlar:**\n• Silinen/düzenlenen mesajlar\n• Üye giriş/çıkış & rol değişiklikleri\n• Ses kanalı hareketleri\n• Ban/kick/timeout\n• Kanal & sunucu ayar değişiklikleri\n\n**Filtre:**\nKanal, kullanıcı veya olay tipi bazlı',
    verified:false, featured:false, installs:11200, rating:4.7, ratingCount:2341,
    commands:['/log set','/log ignore','/log test','/log export'],
    permissions:['Audit Logu Görüntüle','Embed Gönder'],
    changelog:'v3.0: Ses hareketleri ve CSV export eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── EĞLENCE ──
  { id:'game-night', name:'Game Night', author:'FunBots', authorVerified:false, avatar:'🎮', category:'fun', tags:['eğlence','oyun'],
    description:'Trivia, Wordle (TR/EN), şans çarkı, bilgi yarışması turnuvaları. 10.000+ soru.',
    longDescription:'Game Night, sunucunuza interaktif mini oyunlar getirir.\n\n**Oyunlar:**\n• Trivia (10.000+ soru, 15 kategori)\n• Wordle (Türkçe ve İngilizce)\n• Şans çarkı (özel ödüller)\n• Resim tahmin oyunu\n\n**Turnuva:**\nElimisyon sistemi, liderlik tablosu, ödül rolleri',
    verified:false, featured:true, installs:18400, rating:4.7, ratingCount:3812,
    commands:['/trivia','/wordle','/wheel spin','/quiz start','/tournament create'],
    permissions:['Mesaj Gönder','Embed Gönder','Rolleri Yönet'],
    changelog:'v3.1: Resim tahmin ve turnuva modu eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'economy-bot', name:'Bridge Economy', author:'EconDevs', authorVerified:false, avatar:'💰', category:'fun', tags:['eğlence','ekonomi'],
    description:'Sanal ekonomi: para kazan, mağaza kur, şirket yönet, borsa, kumar (blackjack, slot).',
    longDescription:'Bridge Economy, sunucunuza tam sanal ekonomi ekler.\n\n**Ekonomi:**\n• Günlük ödül, çalışma, soygun\n• Bankaya yatır, faiz kazan\n• Blackjack & slot\n\n**Mağaza:**\nÖzel roller, unvanlar sat\n\n**Şirket:**\nKur, hisse sat, çalışan al',
    verified:false, featured:false, installs:9100, rating:4.5, ratingCount:1876,
    commands:['/balance','/daily','/work','/shop','/buy','/rob','/company'],
    permissions:['Mesaj Gönder','Rolleri Yönet','Embed Gönder'],
    changelog:'v2.5: Şirket sistemi ve borsa eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'meme-bot', name:'Meme Factory', author:'LaughLabs', authorVerified:false, avatar:'😂', category:'fun', tags:['eğlence','meme'],
    description:'Reddit\'ten güncel memeler, Drake & diğer şablonlarla özel meme üret, GIF arama.',
    longDescription:'Meme Factory, sunucunuzu eğlenceli tutar.\n\n**Kaynaklar:**\n• Reddit hot/top memeler\n• Türkçe meme subredditler\n• Tenor & GIPHY entegrasyonu\n\n**Üretici:**\nDrake, distracted boyfriend gibi klasik şablonlara metin ekle',
    verified:false, featured:false, installs:7300, rating:4.3, ratingCount:1102,
    commands:['/meme','/gif','/meme create','/meme template'],
    permissions:['Mesaj Gönder','Dosya Ekle','Embed Gönder'],
    changelog:'v1.4: Türkçe meme subredditler eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── ARAÇLAR ──
  { id:'forms-bot', name:'Forms & Surveys', author:'FormCraft', authorVerified:false, avatar:'📝', category:'tools', tags:['araçlar','yönetim'],
    description:'Başvuru formları, anketler, koşullu sorular, otomatik DM bildirimi, staff değerlendirme.',
    longDescription:'Forms & Surveys, başvuruları ve anketleri yönetir.\n\n**Form Türleri:**\n• Çoktan seçmeli, açık uçlu, derecelendirme\n• Koşullu sorular (cevaba göre atla)\n• Dosya yükleme sorusu\n\n**Akış:**\nBaşvur → Staff değerlendir → Onayla/reddet → Otomatik bildirim',
    verified:false, featured:false, installs:3900, rating:4.3, ratingCount:567,
    commands:['/form create','/form send','/form responses','/survey'],
    permissions:['Mesaj Gönder','Embed Gönder','Thread Oluştur'],
    changelog:'v1.1: Koşullu sorular eklendi', supportUrl:'#', sourceUrl:'#' },

  // ── ENTEGRASYON ──
  { id:'github-bot', name:'GitHub Connect', author:'DevTools', authorVerified:false, avatar:'🐙', category:'integration', tags:['entegrasyon','geliştirici'],
    description:'PR, issue, commit, release ve CI/CD bildirimleri. Bridge içinden repo yönetimi.',
    longDescription:'GitHub Connect, yazılım takımları için GitHub\'ı Bridge\'e entegre eder.\n\n**Bildirimler:**\n• Pull request açıldı/kapandı/merge\n• Issue oluşturuldu/atandı\n• Yeni commit (branch seçimi)\n• Release & GitHub Actions sonucu\n\n**Komutlar:**\nBridge\'den issue aç, PR durumunu sorgula',
    verified:false, featured:false, installs:6800, rating:4.6, ratingCount:1123,
    commands:['/gh repo','/gh issues','/gh pr','/gh setup'],
    permissions:['Webhook Yönet','Mesaj Gönder','Embed Gönder'],
    changelog:'v2.2: GitHub Actions CI/CD sonuçları eklendi', supportUrl:'#', sourceUrl:'https://github.com/devtools/github-connect' },

  { id:'twitch-alerts', name:'Twitch Alerts', author:'StreamNotify', authorVerified:false, avatar:'🎯', category:'integration', tags:['entegrasyon','yayın'],
    description:'Twitch yayın başladığında otomatik bildirim. Sınırsız kanal, özel embed, anti-spam.',
    longDescription:'Twitch Alerts, topluluk üyelerinin yayınlarını otomatik duyurur.\n\n**Özellikler:**\n• Sınırsız Twitch kanalı takip\n• Özelleştirilebilir embed (oyun, izleyici)\n• Rol mention\n• Yayın bitti bildirimi\n• Anti-spam (aynı yayın için tekrar yok)',
    verified:false, featured:false, installs:14200, rating:4.5, ratingCount:2890,
    commands:['/twitch add','/twitch remove','/twitch list','/twitch test'],
    permissions:['Mesaj Gönder','Embed Gönder','Webhook Yönet'],
    changelog:'v1.7: Yayın bitti bildirimi ve VOD linki eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'youtube-notify', name:'YouTube Notify', author:'TubeWatch', authorVerified:false, avatar:'▶️', category:'integration', tags:['entegrasyon','yayın'],
    description:'YouTube kanallarından yeni video bildirimi. Thumbnail, süre, izlenme embed\'de.',
    longDescription:'YouTube Notify, takip ettiğiniz kanallarda yeni video yayınlandığında bildirim gönderir.\n\n**Kurulum:**\nYouTube URL gir, bildirim kanalı seç.\n\n**Özellikler:**\n• Thumbnail, süre, izlenme embed\n• @everyone veya özel rol mention\n• Shorts filtrele (isteğe bağlı)',
    verified:false, featured:false, installs:8900, rating:4.4, ratingCount:1456,
    commands:['/youtube add','/youtube remove','/youtube list'],
    permissions:['Mesaj Gönder','Embed Gönder'],
    changelog:'v1.3: Shorts filtreleme eklendi', supportUrl:'#', sourceUrl:'#' },

  { id:'translate-bot', name:'Auto Translate', author:'LinguaBot', authorVerified:false, avatar:'🌍', category:'integration', tags:['entegrasyon','araçlar'],
    description:'Mesajları otomatik çevir. Dil algılama, kanal bazlı hedef dil, 100+ dil desteği.',
    longDescription:'Auto Translate, çok dilli topluluklar için uçtan uca çeviri sağlar.\n\n**Özellikler:**\n• Otomatik dil algılama\n• Kanal bazlı hedef dil ayarı\n• Kullanıcı dil tercihi kaydı\n• Tepki ile manuel çeviri (🌍 emojisi)\n\n**Desteklenen:**\n100+ dil, DeepL kalitesinde çeviri',
    verified:false, featured:false, installs:5400, rating:4.3, ratingCount:678,
    commands:['/translate','/tl set-lang','/tl toggle','/tl user-lang'],
    permissions:['Mesaj Gönder','Tepki Ver','Webhook Yönet'],
    changelog:'v1.2: DeepL API ve kullanıcı dil kaydı eklendi', supportUrl:'#', sourceUrl:'#' },
];

const CATEGORIES = [
  { id:'',            icon:'🌐', label:'Tümü' },
  { id:'music',       icon:'🎵', label:'Müzik' },
  { id:'moderation',  icon:'🛡️', label:'Moderasyon' },
  { id:'management',  icon:'⚙️', label:'Yönetim' },
  { id:'ai',          icon:'🤖', label:'AI & Yardımcı' },
  { id:'stats',       icon:'📊', label:'İstatistik' },
  { id:'fun',         icon:'🎮', label:'Eğlence' },
  { id:'tools',       icon:'🔧', label:'Araçlar' },
  { id:'integration', icon:'🌐', label:'Entegrasyon' },
];

const TAG_COLORS = {
  'müzik':'#3ba55c','eğlence':'#faa61a','moderasyon':'#ed4245','güvenlik':'#ed4245',
  'yönetim':'#9b59b6','üye':'#1abc9c','istatistik':'#4f8ef7','ai':'#a78bfa',
  'yardımcı':'#a78bfa','otomasyon':'#36aaf7','rol':'#ff9a56','destek':'#ff6b8a',
  'oyun':'#43d19e','ekonomi':'#f5c518','meme':'#ff7f50','araçlar':'#7ec8e3',
  'entegrasyon':'#6495ed','geliştirici':'#6495ed','yayın':'#e91e63',
};

/* ══════════════════════════════════════════════════════════
   BOT KATALOĞU — Önce /api/bots/marketplace endpoint'inden yükle,
   hata durumunda yerel statik katalog fallback olarak kullanılır.
══════════════════════════════════════════════════════════ */

// Aktif katalog (API'den veya static fallback'ten doldurulur)
let _catalog = null;

/** API'den marketplace botlarını yükler; başarısız olursa BOT_CATALOG'u kullan */
async function loadCatalog() {
  if (_catalog) return _catalog;
  try {
    const fn  = window.apiFetch || fetch;
    const res = await fn(`${getAPI() || ''}/api/bots/marketplace?limit=100`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        // Normalize API response to match local catalog shape
        _catalog = data.map(b => ({
          id:          b._id,
          name:        b.username || b.name || 'Unknown Bot',
          author:      b.author || 'Community',
          authorVerified: b.verified || false,
          avatar:      b.icon || '🤖',
          category:    b.category || 'utility',
          tags:        b.tags || [b.category || 'utility'],
          description: b.description || '',
          longDescription: b.longDescription || b.description || '',
          verified:    b.verified || false,
          featured:    b.featured || false,
          installs:    b.serverCount || 0,
          rating:      b.rating || 0,
          ratingCount: b.ratingCount || 0,
          commands:    Array.isArray(b.commands) ? b.commands : [],
          permissions: b.permissions || [],
          changelog:   b.changelog || '',
          supportUrl:  b.supportUrl || '#',
          sourceUrl:   b.sourceUrl || '#',
        }));
        return _catalog;
      }
    }
  } catch {
    // API ulaşılamaz — fallback'e geç
  }
  _catalog = BOT_CATALOG;
  return _catalog;
}

/** Katalog hazırsa döner, yoksa BOT_CATALOG'u kullan */
function getCatalog() {
  return _catalog || BOT_CATALOG;
}
let _installedBots  = new Set(JSON.parse(localStorage.getItem('bridge-installed-bots') || '[]'));
let _activeCategory = '';
let _activeTab      = 'featured';
let _searchQuery    = '';
let _sortBy         = 'installs';
// Server-side yüklü plugin listesi (id → {name, version, description})
let _loadedPlugins  = {};

/* ── PLUGIN BRIDGE ── */
async function fetchLoadedPlugins() {
  try {
    const fn  = window.apiFetch || fetch;
    const res = await fn(`${getAPI() || ''}/api/plugins`);
    if (!res.ok) return;
    const list = await res.json();
    _loadedPlugins = {};
    for (const p of list) _loadedPlugins[p.id] = p;
  } catch {
    // Plugin servisi yoksa sessizce geç
  }
}

/* ══════════════════════════════════════════════════════════
   STYLES
══════════════════════════════════════════════════════════ */
function injectStyles() {
  if (document.getElementById('mp-styles')) return;
  const s = document.createElement('style');
  s.id = 'mp-styles';
  s.textContent = `
    #bot-marketplace-modal{position:fixed;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(4px);z-index:var(--z-modal,300);display:flex;align-items:center;justify-content:center;padding:20px}
    .mp-panel{background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--r-xl);width:min(960px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:var(--shadow-xl);overflow:hidden;animation:mpIn .24s cubic-bezier(.34,1.56,.64,1)}
    @keyframes mpIn{from{opacity:0;transform:scale(.94) translateY(20px)}to{opacity:1;transform:none}}
    .mp-header{padding:24px 28px 0;flex-shrink:0;background:var(--bg-3);border-bottom:1px solid var(--border)}
    .mp-header-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px;gap:12px}
    .mp-title{font-size:22px;font-weight:800;color:var(--text-primary);letter-spacing:-.02em;margin-bottom:3px}
    .mp-subtitle{color:var(--text-muted);font-size:13px;display:flex;align-items:center;gap:8px}
    .mp-badge{background:var(--brand-bg);border:1px solid var(--brand-border);color:var(--brand);border-radius:var(--r-full);padding:1px 8px;font-size:11px;font-weight:700}
    .mp-close{background:var(--bg-4);border:none;width:32px;height:32px;border-radius:50%;color:var(--text-muted);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;flex-shrink:0}
    .mp-close:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-controls{display:flex;gap:8px;margin-bottom:16px}
    .mp-search{flex:1;background:var(--bg-4);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:9px 14px;color:var(--text-primary);font-size:14px;font-family:var(--font-sans);outline:none;transition:.15s}
    .mp-search:focus{border-color:var(--brand)} .mp-search::placeholder{color:var(--text-muted)}
    .mp-sort{background:var(--bg-4);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:9px 12px;color:var(--text-2);font-size:13px;font-family:var(--font-sans);outline:none;cursor:pointer}
    .mp-tabs{display:flex;gap:2px}
    .mp-tab{padding:10px 18px;border:none;background:transparent;color:var(--text-muted);font-weight:600;font-size:13px;font-family:var(--font-sans);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:.15s;white-space:nowrap}
    .mp-tab.active{color:var(--brand);border-bottom-color:var(--brand)} .mp-tab:hover:not(.active){color:var(--text-primary)}
    .mp-body{display:flex;flex:1;overflow:hidden}
    .mp-sidebar{width:175px;flex-shrink:0;background:var(--bg-3);border-right:1px solid var(--border);padding:12px 8px;overflow-y:auto}
    .mp-sidebar-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--text-muted);padding:8px 8px 6px}
    .mp-cat{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;border:none;background:none;color:var(--text-2);font-size:13px;font-weight:500;font-family:var(--font-sans);cursor:pointer;border-radius:var(--r-md);transition:.12s;text-align:left}
    .mp-cat:hover{background:var(--bg-4);color:var(--text-primary)} .mp-cat.active{background:var(--brand-bg);color:var(--brand);font-weight:700}
    .mp-cat .cc{margin-left:auto;font-size:11px;color:var(--text-muted)} .mp-cat.active .cc{color:var(--brand)}
    .mp-grid-wrap{flex:1;overflow-y:auto;padding:16px 20px}
    .mp-feat-banner{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}
    .mp-feat-card{background:linear-gradient(135deg,var(--brand-bg),var(--bg-3));border:1px solid var(--brand-border);border-radius:var(--r-lg);padding:16px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;gap:8px}
    .mp-feat-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md),0 0 0 1px var(--brand)}
    .mp-feat-top{display:flex;align-items:center;gap:10px}
    .mp-feat-av{width:40px;height:40px;border-radius:var(--r-md);background:var(--bg-5);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0}
    .mp-feat-name{font-weight:700;font-size:14px;color:var(--text-primary)} .mp-feat-meta{font-size:11px;color:var(--text-muted)}
    .mp-feat-desc{font-size:12px;color:var(--text-2);line-height:1.5}
    .mp-sec-lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:10px;display:flex;align-items:center;gap:8px}
    .mp-sec-lbl::after{content:'';flex:1;height:1px;background:var(--border)}
    .mp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
    .mp-card{background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-lg);padding:16px;display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:.15s}
    .mp-card:hover{border-color:var(--brand);box-shadow:0 0 0 1px var(--brand-border),var(--shadow-sm);transform:translateY(-1px)}
    .mp-card.installed{border-color:rgba(46,204,154,.4)}
    .mp-card-top{display:flex;align-items:flex-start;gap:12px}
    .mp-card-av{width:44px;height:44px;border-radius:var(--r-md);background:var(--bg-4);display:flex;align-items:center;justify-content:center;font-size:24px;flex-shrink:0}
    .mp-card-info{flex:1;min-width:0}
    .mp-card-nr{display:flex;align-items:center;gap:5px;margin-bottom:2px}
    .mp-card-name{font-weight:700;font-size:14px;color:var(--text-primary)}
    .mp-verified{color:var(--brand);font-size:13px}
    .mp-card-meta{font-size:11px;color:var(--text-muted)}
    .mp-card-desc{font-size:12px;color:var(--text-2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .mp-card-tags{display:flex;flex-wrap:wrap;gap:4px}
    .mp-tag{font-size:10px;font-weight:700;padding:2px 7px;border-radius:var(--r-full);text-transform:uppercase;letter-spacing:.04em}
    .mp-rating{display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap}
    .mp-stars{color:#faa61a;font-size:11px}
    .mp-rating-n{font-weight:700;color:var(--text-primary)} .mp-rating-c{color:var(--text-muted)}
    .mp-card-foot{display:flex;gap:6px;margin-top:auto}
    .mp-btn-detail{flex:1;padding:8px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text-2);font-size:12px;font-weight:600;font-family:var(--font-sans);cursor:pointer;transition:.15s}
    .mp-btn-detail:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-btn-inst{flex:2;padding:8px;border:none;border-radius:var(--r-md);font-size:12px;font-weight:700;font-family:var(--font-sans);cursor:pointer;transition:.15s}
    .mp-btn-inst.add{background:var(--brand);color:#fff} .mp-btn-inst.add:hover{background:var(--brand-hover)}
    .mp-btn-inst.rem{background:rgba(46,204,154,.12);color:var(--teal);border:1px solid rgba(46,204,154,.3)}
    .mp-btn-inst.rem:hover{background:rgba(224,82,96,.12);color:var(--red);border-color:rgba(224,82,96,.3)}
    .mp-btn-inst:disabled{opacity:.5;cursor:not-allowed}
    .mp-empty{grid-column:1/-1;text-align:center;padding:48px 20px;color:var(--text-muted)}
    .mp-empty-icon{font-size:40px;opacity:.4;margin-bottom:12px}
    .mp-empty-t{font-size:15px;font-weight:600;color:var(--text-2);margin-bottom:6px}
    #mp-detail-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:350;display:flex;align-items:center;justify-content:center;padding:20px;animation:mpFi .15s ease}
    @keyframes mpFi{from{opacity:0}}
    .mp-det-panel{background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--r-xl);width:min(680px,100%);max-height:88vh;overflow-y:auto;box-shadow:var(--shadow-xl);animation:mpIn .22s cubic-bezier(.34,1.56,.64,1)}
    .mp-det-hero{padding:28px;display:flex;gap:18px;align-items:flex-start;background:linear-gradient(135deg,var(--brand-bg) 0%,var(--bg-3) 100%);border-bottom:1px solid var(--border)}
    .mp-det-av{width:72px;height:72px;border-radius:var(--r-lg);background:var(--bg-4);display:flex;align-items:center;justify-content:center;font-size:40px;flex-shrink:0;box-shadow:var(--shadow-md)}
    .mp-det-name{font-size:24px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px;color:var(--text-primary)}
    .mp-det-author{font-size:13px;color:var(--text-muted);margin-bottom:10px}
    .mp-det-stats{display:flex;gap:20px;font-size:13px}
    .mp-det-stat{text-align:center}
    .mp-det-stat-v{font-weight:800;font-size:18px;color:var(--text-primary);display:block}
    .mp-det-stat-l{color:var(--text-muted);font-size:11px}
    .mp-det-body{padding:24px 28px}
    .mp-det-sec{margin-bottom:20px}
    .mp-det-sec-t{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:10px}
    .mp-det-desc{font-size:14px;color:var(--text-2);line-height:1.7;white-space:pre-line}
    .mp-det-desc strong{color:var(--text-primary)}
    .mp-cmds{display:flex;flex-wrap:wrap;gap:6px}
    .mp-cmd{background:var(--bg-4);color:var(--brand);font-family:var(--font-mono);font-size:12px;padding:4px 10px;border-radius:var(--r-md);border:1px solid var(--brand-border)}
    .mp-perms{display:flex;flex-wrap:wrap;gap:6px}
    .mp-perm{background:rgba(224,82,96,.10);color:var(--red);font-size:12px;font-weight:600;padding:4px 10px;border-radius:var(--r-full);border:1px solid rgba(224,82,96,.25)}
    .mp-links{display:flex;gap:8px;flex-wrap:wrap}
    .mp-link{display:inline-flex;align-items:center;gap:5px;padding:7px 14px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-md);color:var(--text-2);font-size:12px;font-weight:600;text-decoration:none;transition:.15s}
    .mp-link:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-det-foot{padding:20px 28px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;background:var(--bg-3)}
    .mp-inst-big{flex:1;padding:12px;border:none;border-radius:var(--r-lg);font-size:15px;font-weight:700;font-family:var(--font-sans);cursor:pointer;transition:.15s}
    .mp-inst-big.add{background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;box-shadow:var(--shadow-brand)}
    .mp-inst-big.add:hover{transform:translateY(-1px)}
    .mp-inst-big.rem{background:rgba(46,204,154,.12);color:var(--teal);border:1.5px solid rgba(46,204,154,.4)}
    .mp-inst-big.rem:hover{background:rgba(224,82,96,.12);color:var(--red);border-color:rgba(224,82,96,.4)}
    .mp-det-cls{padding:12px 20px;background:var(--bg-4);border:1px solid var(--border);border-radius:var(--r-lg);color:var(--text-2);font-size:14px;font-weight:600;font-family:var(--font-sans);cursor:pointer;transition:.15s}
    .mp-det-cls:hover{background:var(--bg-5);color:var(--text-primary)}
    .mp-toast{position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--r-md);padding:12px 18px;font-size:14px;font-weight:600;color:var(--text-primary);box-shadow:var(--shadow-lg);max-width:340px;animation:mpFi .2s ease;transition:opacity .2s,transform .2s}
    .mp-toast.hide{opacity:0;transform:translateY(8px)}
    .mp-toast.success{border-left:4px solid var(--teal)} .mp-toast.error{border-left:4px solid var(--red)} .mp-toast.info{border-left:4px solid var(--brand)}
    @media(max-width:640px){.mp-sidebar{display:none}.mp-feat-banner{grid-template-columns:1fr}.mp-det-stats{gap:12px}}
  `;
  document.head.appendChild(s);
}

/* ══════════════════════════════════════════════════════════
   OPEN / CLOSE
══════════════════════════════════════════════════════════ */
function openBotMarketplace() {
  if (document.getElementById('bot-marketplace-modal')) return;
  injectStyles();

  // Server-side katalog + plugin listesini paralel yükle, sonra render et
  Promise.all([loadCatalog(), fetchLoadedPlugins()]).then(() => render());

  const overlay = document.createElement('div');
  overlay.id = 'bot-marketplace-modal';
  overlay.innerHTML = `
    <div class="mp-panel">
      <div class="mp-header">
        <div class="mp-header-top">
          <div>
            <div class="mp-title">🤖 Bot Marketplace</div>
            <div class="mp-subtitle">Sunucunu güçlendir — tek tıkla kur <span class="mp-badge">${getCatalog().length} bot</span></div>
          </div>
          <button class="mp-close" id="mp-close">✕</button>
        </div>
        <div class="mp-controls">
          <input class="mp-search" id="mp-search" type="text" placeholder="🔍  Bot ara..." autocomplete="off">
          <select class="mp-sort" id="mp-sort">
            <option value="installs">En Popüler</option>
            <option value="rating">En Yüksek Puan</option>
            <option value="name">A-Z</option>
          </select>
        </div>
        <div class="mp-tabs">
          <button class="mp-tab active" data-tab="featured">✨ Öne Çıkanlar</button>
          <button class="mp-tab" data-tab="all">📦 Tüm Botlar</button>
          <button class="mp-tab" data-tab="installed">✅ Yüklüler <span id="mp-inst-cnt"></span></button>
          <button class="mp-tab" data-tab="plugins">🔌 Pluginler <span id="mp-plug-cnt"></span></button>
        </div>
      </div>
      <div class="mp-body">
        <div class="mp-sidebar"><div class="mp-sidebar-lbl">Kategoriler</div><div id="mp-cats"></div></div>
        <div class="mp-grid-wrap" id="mp-grid-wrap"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('mp-close').addEventListener('click', closeMarketplace);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeMarketplace(); });
  document.addEventListener('keydown', escHandler);

  document.getElementById('mp-search').addEventListener('input', e => { _searchQuery = e.target.value; render(); });
  document.getElementById('mp-sort').addEventListener('change', e => { _sortBy = e.target.value; render(); });
  overlay.querySelectorAll('.mp-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.mp-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      _activeTab = btn.dataset.tab;
      render();
    });
  });

  buildSidebar();
  render();
  updateInstCount();
}

function escHandler(e) { if (e.key === 'Escape') closeMarketplace(); }

function closeMarketplace() {
  document.getElementById('bot-marketplace-modal')?.remove();
  document.removeEventListener('keydown', escHandler);
}

/* ── SIDEBAR ── */
function buildSidebar() {
  const el = document.getElementById('mp-cats');
  if (!el) return;
  el.innerHTML = CATEGORIES.map(c => {
    const cnt = c.id === '' ? getCatalog().length : getCatalog().filter(b => b.category === c.id).length;
    return `<button class="mp-cat${_activeCategory===c.id?' active':''}" data-cat="${c.id}">${c.icon} ${c.label}<span class="cc">${cnt}</span></button>`;
  }).join('');
  el.querySelectorAll('.mp-cat').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeCategory = btn.dataset.cat;
      el.querySelectorAll('.mp-cat').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      render();
    });
  });
}

/* ── MAIN RENDER ── */
function render() {
  const wrap = document.getElementById('mp-grid-wrap');
  if (!wrap) return;

  // ── Pluginler tab'ı ayrı render ──
  if (_activeTab === 'plugins') {
    wrap.innerHTML = '';
    const pluginList = Object.values(_loadedPlugins);
    const grid = document.createElement('div');
    grid.className = 'mp-grid';
    if (!pluginList.length) {
      grid.innerHTML = `<div class="mp-empty"><div class="mp-empty-icon">🔌</div><div class="mp-empty-t">Yüklü plugin yok</div><div class="mp-empty-s" style="font-size:13px;color:var(--text-3);margin-top:6px">Server'a plugin eklemek için <code>plugins/</code> dizinini kullanın.</div></div>`;
    } else {
      pluginList.forEach(p => {
        const card = document.createElement('div');
        card.className = 'mp-card installed';
        card.innerHTML = `
          <div class="mp-card-top">
            <div class="mp-card-av">🔌</div>
            <div class="mp-card-info">
              <div class="mp-card-nr"><span class="mp-card-name">${p.name}</span><span class="mp-verified" title="Sunucu plugini">✓</span></div>
              <div class="mp-card-meta">by ${p.author || 'Bilinmiyor'} · v${p.version || '?'}</div>
            </div>
          </div>
          <div class="mp-card-desc">${p.description || ''}</div>
          <div class="mp-card-foot" style="justify-content:flex-end">
            <span style="font-size:12px;color:var(--green);font-weight:600">✓ Aktif</span>
          </div>`;
        grid.appendChild(card);
      });
    }
    wrap.appendChild(grid);
    updateInstCount();
    return;
  }

  let bots = [...getCatalog()];
  if (_activeCategory) bots = bots.filter(b => b.category === _activeCategory);
  if (_searchQuery) { const q = _searchQuery.toLowerCase(); bots = bots.filter(b => b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q) || b.tags.some(t => t.includes(q))); }
  if (_activeTab === 'featured') bots = bots.filter(b => b.featured || b.installs > 10000);
  if (_activeTab === 'installed') bots = bots.filter(b => _installedBots.has(b.id));
  bots.sort((a,b) => _sortBy==='rating' ? b.rating-a.rating : _sortBy==='name' ? a.name.localeCompare(b.name,'tr') : b.installs-a.installs);

  wrap.innerHTML = '';

  if (_activeTab === 'featured' && !_searchQuery && !_activeCategory) {
    const featured = getCatalog().filter(b => b.featured).slice(0, 3);
    const fDiv = document.createElement('div');
    fDiv.innerHTML = `<div class="mp-sec-lbl">⭐ Öne Çıkanlar</div><div class="mp-feat-banner">${
      featured.map(b => `<div class="mp-feat-card" data-id="${b.id}">
        <div class="mp-feat-top"><div class="mp-feat-av">${b.avatar}</div><div><div class="mp-feat-name">${b.name}</div><div class="mp-feat-meta">⬇ ${b.installs.toLocaleString('tr-TR')} · ⭐ ${b.rating}</div></div></div>
        <div class="mp-feat-desc">${b.description}</div>
      </div>`).join('')
    }</div><div class="mp-sec-lbl" style="margin-top:20px">📦 Tüm Botlar</div>`;
    fDiv.querySelectorAll('.mp-feat-card').forEach(c => c.addEventListener('click', () => openDetail(c.dataset.id)));
    wrap.appendChild(fDiv);
  }

  const grid = document.createElement('div');
  grid.className = 'mp-grid';
  if (!bots.length) {
    grid.innerHTML = `<div class="mp-empty"><div class="mp-empty-icon">${_activeTab==='installed'?'📭':'🔍'}</div><div class="mp-empty-t">${_activeTab==='installed'?'Henüz yüklü bot yok':'Sonuç bulunamadı'}</div></div>`;
  } else {
    bots.forEach(b => grid.appendChild(makeCard(b)));
  }
  wrap.appendChild(grid);
}

/* ── CARD ── */
function makeCard(bot) {
  const inst       = _installedBots.has(bot.id);
  const hasPlugin  = !!_loadedPlugins[bot.id];
  const tags = bot.tags.slice(0,2).map(t => { const c = TAG_COLORS[t]||'var(--brand)'; return `<span class="mp-tag" style="background:${c}22;color:${c};border:1px solid ${c}44">${t}</span>`; }).join('');
  const stars = '★'.repeat(Math.round(bot.rating)) + '☆'.repeat(5-Math.round(bot.rating));
  const div = document.createElement('div');
  div.className = `mp-card${inst?' installed':''}`;
  div.dataset.id = bot.id;
  div.innerHTML = `
    <div class="mp-card-top">
      <div class="mp-card-av">${bot.avatar}</div>
      <div class="mp-card-info">
        <div class="mp-card-nr"><span class="mp-card-name">${bot.name}</span>${bot.verified?'<span class="mp-verified">✓</span>':''}</div>
        <div class="mp-card-meta">by ${bot.author} · ⬇ ${bot.installs.toLocaleString('tr-TR')}</div>
      </div>
    </div>
    <div class="mp-card-desc">${bot.description}</div>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div class="mp-card-tags">${tags}</div>
      <div class="mp-rating"><span class="mp-stars">${stars}</span><span class="mp-rating-n">${bot.rating}</span><span class="mp-rating-c">(${bot.ratingCount.toLocaleString('tr-TR')})</span></div>
    </div>
    <div class="mp-card-foot">
      <button class="mp-btn-detail" data-id="${bot.id}">Detaylar</button>
      <div style="display:flex;align-items:center;gap:6px">
        ${hasPlugin ? `<span style="font-size:11px;color:var(--green);font-weight:600;padding:2px 6px;background:rgba(46,204,113,.15);border-radius:4px">🔌 Plugin Aktif</span>` : ''}
        <button class="mp-btn-inst ${inst?'rem':'add'}" data-id="${bot.id}">${inst?'✓ Yüklü':'+ Ekle'}</button>
      </div>
    </div>`;
  div.querySelector('.mp-btn-detail').addEventListener('click', e => { e.stopPropagation(); openDetail(bot.id); });
  div.querySelector('.mp-btn-inst').addEventListener('click', e => { e.stopPropagation(); doToggle(bot.id, e.target); });
  div.addEventListener('click', () => openDetail(bot.id));
  return div;
}

/* ── DETAIL MODAL ── */
function openDetail(botId) {
  const bot = getCatalog().find(b => b.id === botId);
  if (!bot) return;
  document.getElementById('mp-detail-overlay')?.remove();
  const inst      = _installedBots.has(bot.id);
  const plugin    = _loadedPlugins[bot.id];
  const stars = '★'.repeat(Math.round(bot.rating)) + '☆'.repeat(5-Math.round(bot.rating));
  const desc = bot.longDescription.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  const ov = document.createElement('div');
  ov.id = 'mp-detail-overlay';
  ov.innerHTML = `
    <div class="mp-det-panel">
      <div class="mp-det-hero">
        <div class="mp-det-av">${bot.avatar}</div>
        <div style="flex:1;min-width:0">
          <div class="mp-det-name">${bot.name}${bot.verified?'<span style="color:var(--brand);font-size:18px"> ✓</span>':''}</div>
          <div class="mp-det-author">by ${bot.author}${bot.authorVerified?' · ✓ Doğrulanmış':''}</div>
          <div class="mp-det-stats">
            <div class="mp-det-stat"><span class="mp-det-stat-v">${bot.installs.toLocaleString('tr-TR')}</span><span class="mp-det-stat-l">Kurulum</span></div>
            <div class="mp-det-stat"><span class="mp-det-stat-v">${bot.rating} <span style="color:#faa61a;font-size:14px">${stars}</span></span><span class="mp-det-stat-l">${bot.ratingCount.toLocaleString('tr-TR')} değerlendirme</span></div>
            <div class="mp-det-stat"><span class="mp-det-stat-v">${bot.commands.length}</span><span class="mp-det-stat-l">Komut</span></div>
          </div>
        </div>
      </div>
      <div class="mp-det-body">
        ${plugin ? `<div class="mp-det-sec" style="background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.25);border-radius:var(--r-md);padding:12px 16px">
          <div class="mp-det-sec-t" style="color:var(--green)">🔌 Server Plugin Aktif</div>
          <div style="font-size:13px;color:var(--text-2);margin-top:4px">
            <strong>${plugin.name}</strong> v${plugin.version || '?'} — ${plugin.description || 'Açıklama yok'}
          </div>
        </div>` : ''}
        <div class="mp-det-sec"><div class="mp-det-sec-t">📝 Açıklama</div><div class="mp-det-desc">${desc}</div></div>
        <div class="mp-det-sec"><div class="mp-det-sec-t">⌨️ Komutlar</div><div class="mp-cmds">${bot.commands.map(c=>`<span class="mp-cmd">${c}</span>`).join('')}</div></div>
        <div class="mp-det-sec"><div class="mp-det-sec-t">🔐 Gerekli İzinler</div><div class="mp-perms">${bot.permissions.map(p=>`<span class="mp-perm">⚠ ${p}</span>`).join('')}</div></div>
        ${bot.changelog?`<div class="mp-det-sec"><div class="mp-det-sec-t">📋 Son Güncelleme</div><div style="font-size:13px;color:var(--text-2)">${bot.changelog}</div></div>`:''}
        <div class="mp-det-sec"><div class="mp-det-sec-t">🔗 Bağlantılar</div><div class="mp-links">
          ${bot.supportUrl!=='#'?`<a href="${bot.supportUrl}" class="mp-link" target="_blank">💬 Destek</a>`:''}
          ${bot.sourceUrl!=='#'?`<a href="${bot.sourceUrl}" class="mp-link" target="_blank">📦 Kaynak Kod</a>`:''}
        </div></div>
      </div>
      <div class="mp-det-foot">
        <button class="mp-det-cls" id="mp-det-cls">Kapat</button>
        <button class="mp-inst-big ${inst?'rem':'add'}" id="mp-det-inst" data-id="${bot.id}">${inst?'✓ Yüklü — Kaldırmak için tıkla':'+ '+bot.name+' Ekle'}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('mp-det-cls').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.getElementById('mp-det-inst').addEventListener('click', e => doToggle(bot.id, e.target, true));
}

/* ── TOGGLE INSTALL ── */
async function doToggle(botId, btn, detail=false) {
  const inst = _installedBots.has(botId);
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = '⏳';
  try {
    if (!inst) {
      if (getCurrentServer()) { try { await (window.apiFetch||fetch)(`${getAPI()||''}/api/servers/${getCurrentServer()._id}/bots/${botId}/add`,{method:'POST'}); } catch {} }
      _installedBots.add(botId);
      showToast(`✅ ${getCatalog().find(b=>b.id===botId)?.name} eklendi!`,'success');
    } else {
      if (getCurrentServer()) { try { await (window.apiFetch||fetch)(`${getAPI()||''}/api/servers/${getCurrentServer()._id}/bots/${botId}`,{method:'DELETE'}); } catch {} }
      _installedBots.delete(botId);
      showToast('Bot kaldırıldı.','info');
    }
    localStorage.setItem('bridge-installed-bots', JSON.stringify([..._installedBots]));
    const nowInst = _installedBots.has(botId);
    if (detail) {
      btn.className = `mp-inst-big ${nowInst?'rem':'add'}`;
      btn.textContent = nowInst ? '✓ Yüklü — Kaldırmak için tıkla' : `+ ${getCatalog().find(b=>b.id===botId)?.name||''} Ekle`;
    } else {
      btn.className = `mp-btn-inst ${nowInst?'rem':'add'}`;
      btn.textContent = nowInst ? '✓ Yüklü' : '+ Ekle';
    }
    const card = document.querySelector(`.mp-card[data-id="${botId}"]`);
    if (card) card.classList.toggle('installed', nowInst);
    updateInstCount();
  } catch { btn.textContent = prev; }
  btn.disabled = false;
}

function updateInstCount() {
  const el = document.getElementById('mp-inst-cnt');
  if (el) el.textContent = _installedBots.size > 0 ? ` (${_installedBots.size})` : '';
  const plugEl = document.getElementById('mp-plug-cnt');
  if (plugEl) {
    const cnt = Object.keys(_loadedPlugins).length;
    plugEl.textContent = cnt > 0 ? ` (${cnt})` : '';
  }
}

function showToast(msg, type='info') {
  const t = document.createElement('div');
  t.className = `mp-toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(()=>t.remove(),220); }, 3000);
}

/* ── PUBLIC API ── */
window.BotMarketplace = { open: openBotMarketplace, close: closeMarketplace };
window.toggleBotInstall = (id, btn) => doToggle(id, btn);
console.log(`[BotMarketplace] ${BOT_CATALOG.length} bot (statik katalog) + API bağlantısı hazır ✓`);

export {
  buildSidebar,
  closeMarketplace,
  doToggle,
  escHandler,
  fetchLoadedPlugins,
  getCatalog,
  injectStyles,
  loadCatalog,
  makeCard,
  openBotMarketplace,
  openDetail,
  render,
  showToast,
  updateInstCount,
};

export const getBotMarketplace = () => window.BotMarketplace;
